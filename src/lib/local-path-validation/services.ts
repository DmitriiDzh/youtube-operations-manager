import path from "node:path";

/**
 * Shared set-time validation for an operator-configured local directory path (`AGENTS.md` §M --
 * extracted 2026-09-30, Phase 11, `docs/roadmap/plans/PHASE_11_PLAN.md` §1, from
 * `src/lib/operations-instructions/services.ts` where it was first written for Phase 7 slice I).
 * Two feature modules now need exactly this check -- the global operations-workspace path and
 * Phase 11's per-channel workspace paths -- so it lives here rather than one feature module
 * reaching into the other. Moved verbatim; `operations-instructions/services.ts` re-exports these
 * names unchanged so its existing callers/tests did not have to change.
 */

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

/** Both arguments MUST already be `realpath`'d (see `isPathInsideOrEqual`). An ancestor of the
 * app-data directory counts as overlapping too -- it would expose the app-data directory (which
 * holds plaintext OAuth tokens, `docs/TECHNICAL_DEBT.md` RISK-07) underneath the configured path. */
export function overlapsAppDataDir(realCandidateBase: string, appDataDir: string): boolean {
  return isPathInsideOrEqual(appDataDir, realCandidateBase) || isPathInsideOrEqual(realCandidateBase, appDataDir);
}

export type WorkspacePathValidationResult = { ok: true } | { ok: false; reason: string };

export type PathValidationDependencies = {
  /** This process's own app-data directory -- injected so tests can point it at a temp path. */
  appDataDir: string;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
};

/**
 * Set-time validation: the candidate must be absolute, exist, be a directory, and not overlap
 * this application's own app-data directory (equal, inside, or an ancestor). `appDataDir` is
 * resolved through the SAME `realpath` as the candidate before comparing -- comparing a resolved
 * path against an unresolved one silently breaks containment detection wherever the app-data
 * path passes through a symlink (e.g. macOS's `/tmp` -> `/private/tmp`).
 */
export async function validateWorkspacePath(
  candidatePath: string,
  deps: PathValidationDependencies
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

  let candidateStat: { isDirectory: boolean };
  try {
    candidateStat = await deps.stat(realCandidate);
  } catch {
    return { ok: false, reason: "path does not exist or is not accessible" };
  }
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
