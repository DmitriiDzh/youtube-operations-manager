import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { detectFfmpeg, probeMedia, type FfmpegTools, type MediaProbe } from "@/lib/ffmpeg-host";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import { createWorkspaceVideoFiles } from "@/lib/workspace-videos";
import { LIBRARY_FOLDER, type LibraryDependencies } from "../library";

// BL-234 (FO-REQ-0048, ADR 0056): the segment library's reads in the channel workspace -- the folder's file names, a sidecar's text,
// a file through the workspace rule (its real path inside the workspace), ffprobe with a cache per path, size and modification time.
// Read-only: no write, rename or delete of any library file exists here.

type WorkspaceLookup = (channelId: string) => Promise<{ configured: false } | { configured: true; path: string }>;

const holder = globalThis as typeof globalThis & { [key: symbol]: unknown };
const PROBE_CACHE_KEY = Symbol.for("ytom.liveStreams.libraryProbeCache");
const PROBE_CACHE_MAX = 2000;

export function createLibraryFiles(
  getWorkspace: WorkspaceLookup
): Pick<LibraryDependencies, "listLibrary" | "readText" | "resolve" | "probe"> & { readBytes(channelId: string, relativePath: string, maxBytes: number): Promise<Uint8Array | null> } {
  const files = createWorkspaceVideoFiles();
  const cache = (holder[PROBE_CACHE_KEY] ??= new Map<string, MediaProbe>()) as Map<string, MediaProbe>;
  let tools: Promise<FfmpegTools | null> | null = null;

  async function resolve(channelId: string, relativePath: string): Promise<{ path: string; bytes: number } | null> {
    const workspace = await getWorkspace(channelId);
    if (!workspace.configured) return null;
    try {
      const file = await resolveWorkspaceFile({
        workspace: workspace.path,
        relativePath,
        fs: createExchangeFs(),
        validateWorkspacePath: validateOperatorDirectoryPath,
        isPathInsideOrEqual,
        unavailable: (reason) => new Error(reason),
      });
      return { path: file.path, bytes: file.bytes };
    } catch {
      return null;
    }
  }

  return {
    async listLibrary(channelId) {
      const workspace = await getWorkspace(channelId);
      if (!workspace.configured) return { ok: false, reason: "workspace_not_configured" };
      const valid = await validateOperatorDirectoryPath(workspace.path);
      if (!valid.ok) return { ok: false, reason: "workspace_unavailable" };
      const root = await realpath(workspace.path).catch(() => null);
      if (!root) return { ok: false, reason: "workspace_unavailable" };
      try {
        const entries = await readdir(path.join(root, ...LIBRARY_FOLDER.split("/")), { withFileTypes: true });
        // Regular files only: a symlink is never followed out of the workspace (every read goes through the workspace rule too).
        return { ok: true, names: entries.filter((e) => e.isFile()).map((e) => e.name) };
      } catch (error) {
        return { ok: false, reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "library_missing" : "workspace_unavailable" };
      }
    },
    resolve,
    /** A poster's bytes (a few hundred kilobytes); null when missing, unreadable or larger than `maxBytes`. */
    async readBytes(channelId, relativePath, maxBytes) {
      const file = await resolve(channelId, relativePath);
      if (!file || file.bytes > maxBytes) return null;
      return files.readHead(file.path, maxBytes).catch(() => null);
    },
    async readText(channelId, relativePath, maxBytes) {
      const file = await resolve(channelId, relativePath);
      if (!file) return null;
      return files.readText(file.path, maxBytes).catch(() => null);
    },
    async probe(file) {
      const info = await stat(file);
      const key = `${file}|${info.size}|${info.mtimeMs}`;
      const cached = cache.get(key);
      if (cached) return cached;
      tools ??= detectFfmpeg();
      const found = await tools;
      if (!found) {
        tools = null; // look again next time (ffmpeg may be installed meanwhile)
        throw new Error("ffmpeg/ffprobe is not installed on this computer");
      }
      const probe = await probeMedia(found, file);
      if (cache.size >= PROBE_CACHE_MAX) cache.clear();
      cache.set(key, probe);
      return probe;
    },
  };
}
