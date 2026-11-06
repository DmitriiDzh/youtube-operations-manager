import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { detectFfmpeg, probeMedia, type FfmpegTools } from "@/lib/ffmpeg-host";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import type { ResolvedClipFile } from "../contracts";

// BL-241 (ADR 0061 §3): the clip files on this computer -- the shared workspace rule (`workspace-exchange`), the shared ffprobe
// (`ffmpeg-host`) and a SHA-256 of the file, remembered per path, size and modification time so the owner's list does not hash an
// unchanged 100 MB file on every read.

/** The shared workspace rule's arguments for this module (the set-time folder check re-run at use time, errors as plain `Error`). */
export function workspaceRuleArgs(workspace: string) {
  return {
    workspace,
    fs: createExchangeFs(),
    validateWorkspacePath: async (candidate: string): Promise<{ ok: true } | { ok: false; reason: string }> => {
      const result = await validateOperatorDirectoryPath(candidate);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
    isPathInsideOrEqual,
    unavailable: (reason: string) => new Error(reason),
  };
}

export async function resolveClipFile(workspace: string, relativePath: string): Promise<({ ok: true } & ResolvedClipFile) | { ok: false; reason: string }> {
  try {
    const file = await resolveWorkspaceFile({ ...workspaceRuleArgs(workspace), relativePath });
    return { ok: true, path: file.path, bytes: file.bytes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

const FFMPEG_KEY = Symbol.for("ytom.clipReviews.ffmpeg");
const HASH_KEY = Symbol.for("ytom.clipReviews.hashes");
type Holder = typeof globalThis & { [FFMPEG_KEY]?: Promise<FfmpegTools | null>; [HASH_KEY]?: Map<string, string> };
const holder = globalThis as Holder;

export async function probeClipDurationSeconds(absolutePath: string): Promise<number | null> {
  const tools = await (holder[FFMPEG_KEY] ??= detectFfmpeg());
  if (!tools) {
    holder[FFMPEG_KEY] = undefined; // look again next time (ffmpeg may be installed meanwhile)
    return null;
  }
  const probe = await probeMedia(tools, absolutePath).catch(() => null);
  return probe?.durationSeconds ?? null;
}

export async function hashClipFile(absolutePath: string): Promise<string> {
  const info = await stat(absolutePath);
  const key = `${absolutePath}\u0000${info.size}\u0000${info.mtimeMs}`;
  const cache = (holder[HASH_KEY] ??= new Map());
  const known = cache.get(key);
  if (known) return known;
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  const sha = hash.digest("hex");
  if (cache.size > 500) cache.clear();
  cache.set(key, sha);
  return sha;
}
