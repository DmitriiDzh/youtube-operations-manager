import path from "node:path";
import { DomainError } from "./contracts";
import type { OperationsWorkspaceFileEntry, OperationsWorkspaceFileResult, OperationsWorkspaceListResult } from "./contracts";
import {
  getOperationsFileInputSchema,
  getOperationsFileOutputSchema,
  listOperationsFilesInputSchema,
  listOperationsFilesOutputSchema,
  parseWithSchema,
} from "./schemas";

// Owner spec §17's "the agent should receive only explicitly cataloged/authorized assets" logic,
// applied here to files instead of assets: only text-ish, small, clearly-instructional file types
// are ever returned. A binary/executable/config-secret file extension is never included, even if
// the operator put one in the configured folder.
const ALLOWED_EXTENSIONS = [".md", ".txt", ".json", ".yaml", ".yml"];
const MAX_DEPTH = 6;
const MAX_FILES = 300;
export const MAX_FILE_BYTES = 200_000;

function hasAllowedExtension(name: string): boolean {
  return ALLOWED_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

function isDotEntry(name: string): boolean {
  return name.startsWith(".");
}

/** True when `child` is `parent` itself or a descendant of it. Both arguments MUST already be
 * fully resolved (`realpath`'d) absolute paths -- this function does no resolution of its own.
 * Uses `path.relative`, never a naive `startsWith` prefix check: `/x/instr-evil` would pass a
 * prefix check against `/x/instr` despite not actually being inside it. */
export function isPathInsideOrEqual(parent: string, child: string): boolean {
  if (parent === child) {
    return true;
  }
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function overlapsAppDataDir(realCandidateBase: string, appDataDir: string): boolean {
  return isPathInsideOrEqual(appDataDir, realCandidateBase) || isPathInsideOrEqual(realCandidateBase, appDataDir);
}

export type WorkspacePathValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Set-time validation for the Settings API (`POST /api/settings`) -- the ONLY place the
 * operations-workspace path can ever be set (never an agent-callable MCP tool or CLI command,
 * per this module's own threat model). Reuses the identical `isPathInsideOrEqual`/appDataDir
 * check the read path (`resolveRealConfiguredBase` above) re-runs on every single request --
 * this is deliberately not the only enforcement point (a directory valid at set time could be
 * re-symlinked to something unsafe later), just the earliest, most helpful place to reject an
 * obviously bad value with a clear reason before it is ever saved.
 */
export async function validateWorkspacePath(
  candidatePath: string,
  deps: Pick<ServiceDependencies, "realpath" | "stat" | "appDataDir">
): Promise<WorkspacePathValidationResult> {
  if (!path.isAbsolute(candidatePath)) {
    return { ok: false, reason: "path must be absolute" };
  }

  let realCandidate: string;
  try {
    realCandidate = await deps.realpath(candidatePath);
  } catch {
    return { ok: false, reason: "path does not exist or is not accessible" };
  }

  const candidateStat = await deps.stat(realCandidate);
  if (!candidateStat.isDirectory) {
    return { ok: false, reason: "path is not a directory" };
  }

  let realAppDataDir: string;
  try {
    realAppDataDir = await deps.realpath(deps.appDataDir);
  } catch {
    realAppDataDir = path.resolve(deps.appDataDir);
  }
  if (overlapsAppDataDir(realCandidate, realAppDataDir)) {
    return { ok: false, reason: "path overlaps this application's own app-data directory" };
  }

  return { ok: true };
}

/** Rejects anything that isn't a plain, single-level-or-deeper relative path with no way to
 * escape its own segments syntactically -- checked BEFORE any filesystem call, as a first,
 * cheap layer ahead of the real, authoritative `realpath`-based containment check below (defense
 * in depth: a syntactic check alone is never sufficient, matching the lesson already recorded in
 * RISK-58 for URL validation -- one layer alone is not enough). Splits on both `/` and `\\`
 * regardless of host platform, since a malicious input might use either separator. */
function isSyntacticallySafeRelativePath(value: string): boolean {
  if (value.includes("\0") || path.isAbsolute(value)) {
    return false;
  }
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 && !segments.includes("..") && !segments.includes(".");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export type ServiceDependencies = {
  /** `null` when the operator has not configured a workspace path. */
  getConfiguredPath(): Promise<string | null>;
  /** This process's own app-data directory (RISK-07: plaintext OAuth tokens live under it) --
   * injected rather than imported directly so tests can point it at an arbitrary temp path. */
  appDataDir: string;
  realpath(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<{ isDirectory: boolean; isSymbolicLink: boolean; isFile: boolean }>;
  stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; sizeBytes: number }>;
  readFileHead(path: string, maxBytes: number): Promise<{ content: string; truncated: boolean }>;
};

/**
 * `resolveRealConfiguredBase` re-runs the appDataDir-overlap check on every call (not just once
 * at Settings-set time) -- the configured directory could be re-symlinked to point somewhere
 * unsafe at any point after it was validated and saved, per this module's own threat model.
 */
async function resolveRealConfiguredBase(deps: ServiceDependencies): Promise<string> {
  const configuredPath = await deps.getConfiguredPath();
  if (!configuredPath) {
    throw new DomainError({ code: "OPERATIONS_WORKSPACE_UNAVAILABLE", message: "no workspace path configured" });
  }
  let realBase: string;
  try {
    realBase = await deps.realpath(configuredPath);
  } catch {
    throw new DomainError({
      code: "OPERATIONS_WORKSPACE_UNAVAILABLE",
      message: "the configured operations-workspace path does not exist or is not accessible",
    });
  }
  // `appDataDir` must be resolved through the SAME `realpath` call as `realBase` before
  // comparing them -- comparing a resolved path against an unresolved one silently breaks
  // containment detection on any system where the app-data path passes through a symlink (e.g.
  // macOS's `/tmp` -> `/private/tmp`, or a symlinked home directory), a real bug this module's
  // own test suite caught empirically (three tests failed against real temp directories before
  // this fix -- `realpath`'d vs. non-`realpath`'d string comparison never matched).
  let realAppDataDir: string;
  try {
    realAppDataDir = await deps.realpath(deps.appDataDir);
  } catch {
    realAppDataDir = path.resolve(deps.appDataDir);
  }
  if (overlapsAppDataDir(realBase, realAppDataDir)) {
    throw new DomainError({
      code: "OPERATIONS_WORKSPACE_UNAVAILABLE",
      message: "the configured operations-workspace path overlaps this application's own app-data directory",
    });
  }
  const baseStat = await deps.stat(realBase);
  if (!baseStat.isDirectory) {
    throw new DomainError({
      code: "OPERATIONS_WORKSPACE_UNAVAILABLE",
      message: "the configured operations-workspace path is not a directory",
    });
  }
  return realBase;
}

async function walk(
  deps: ServiceDependencies,
  realDir: string,
  relativePrefix: string,
  depth: number,
  realBase: string,
  out: OperationsWorkspaceFileEntry[],
  budget: { filesLeft: number }
): Promise<boolean> {
  if (depth > MAX_DEPTH) {
    return true;
  }
  let names: string[];
  try {
    names = await deps.readdir(realDir);
  } catch {
    // The directory vanished between listing its parent and descending into it -- skip silently,
    // matching this codebase's established "never fabricate" convention (e.g. content-proposals'
    // listProposalArtifacts silently drops a link whose asset is somehow missing).
    return false;
  }

  let truncated = false;
  for (const name of [...names].sort()) {
    if (isDotEntry(name)) {
      continue;
    }
    if (budget.filesLeft <= 0) {
      return true;
    }

    const entryPath = path.join(realDir, name);
    let realEntryPath: string;
    try {
      const entryLstat = await deps.lstat(entryPath);
      if (entryLstat.isSymbolicLink) {
        realEntryPath = await deps.realpath(entryPath);
        if (!isPathInsideOrEqual(realBase, realEntryPath) || realEntryPath === realBase) {
          // Escapes the configured workspace -- skip silently, never error the whole listing.
          continue;
        }
      } else {
        realEntryPath = entryPath;
      }
    } catch {
      continue; // dangling symlink or a permission error on this one entry -- skip it, not fatal
    }

    const entryStat = await deps.stat(realEntryPath);
    const relPath = toPosixPath(path.join(relativePrefix, name));

    if (entryStat.isDirectory) {
      out.push({ path: relPath, isDirectory: true, sizeBytes: null });
      budget.filesLeft -= 1;
      const childTruncated = await walk(deps, realEntryPath, relPath, depth + 1, realBase, out, budget);
      truncated = truncated || childTruncated;
    } else if (entryStat.isFile && hasAllowedExtension(name)) {
      out.push({ path: relPath, isDirectory: false, sizeBytes: entryStat.sizeBytes });
      budget.filesLeft -= 1;
    }
  }
  return truncated;
}

export function createOperationsInstructionsServices(deps: ServiceDependencies) {
  return {
    async listOperationsFiles(input: unknown): Promise<OperationsWorkspaceListResult> {
      parseWithSchema(listOperationsFilesInputSchema, input, "list operations files input");

      const configuredPath = await deps.getConfiguredPath();
      if (!configuredPath) {
        return parseWithSchema(listOperationsFilesOutputSchema, { configured: false }, "list operations files output");
      }

      const realBase = await resolveRealConfiguredBase(deps);
      const files: OperationsWorkspaceFileEntry[] = [];
      const truncated = await walk(deps, realBase, "", 0, realBase, files, { filesLeft: MAX_FILES });

      return parseWithSchema(
        listOperationsFilesOutputSchema,
        { configured: true, files, truncated },
        "list operations files output"
      );
    },

    async getOperationsFile(input: unknown): Promise<OperationsWorkspaceFileResult> {
      const parsedInput = parseWithSchema(getOperationsFileInputSchema, input, "get operations file input");

      const configuredPath = await deps.getConfiguredPath();
      if (!configuredPath) {
        return parseWithSchema(getOperationsFileOutputSchema, { configured: false }, "get operations file output");
      }

      const realBase = await resolveRealConfiguredBase(deps);

      if (!isSyntacticallySafeRelativePath(parsedInput.path) || !hasAllowedExtension(parsedInput.path)) {
        throw new DomainError({ code: "OPERATIONS_FILE_NOT_AVAILABLE", message: "requested path is not available" });
      }
      if (parsedInput.path.split(/[\\/]+/).some((segment) => isDotEntry(segment))) {
        throw new DomainError({ code: "OPERATIONS_FILE_NOT_AVAILABLE", message: "requested path is not available" });
      }

      const joined = path.join(realBase, parsedInput.path);
      let realCandidate: string;
      try {
        realCandidate = await deps.realpath(joined);
      } catch {
        throw new DomainError({ code: "OPERATIONS_FILE_NOT_AVAILABLE", message: "requested path is not available" });
      }

      if (!isPathInsideOrEqual(realBase, realCandidate) || realCandidate === realBase) {
        throw new DomainError({ code: "OPERATIONS_FILE_NOT_AVAILABLE", message: "requested path is not available" });
      }

      const candidateStat = await deps.stat(realCandidate);
      if (!candidateStat.isFile) {
        throw new DomainError({ code: "OPERATIONS_FILE_NOT_AVAILABLE", message: "requested path is not available" });
      }

      const { content, truncated } = await deps.readFileHead(realCandidate, MAX_FILE_BYTES);

      return parseWithSchema(
        getOperationsFileOutputSchema,
        { configured: true, path: toPosixPath(parsedInput.path), content, truncated },
        "get operations file output"
      );
    },
  };
}

export type OperationsInstructionsServices = ReturnType<typeof createOperationsInstructionsServices>;
