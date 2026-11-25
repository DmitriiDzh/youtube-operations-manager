import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cachedForFile, statFileStamp } from "@/lib/file-fingerprint";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createExchangeFs, resolveWorkspaceFile } from "@/lib/workspace-exchange";
import { createLruCache, type LruCache } from "./lru";

// BL-272 (ADR 0076; moved from clip-reviews' files adapter, ADR 0061 §3): a review item's file on this computer -- the shared
// workspace rule (`workspace-exchange`) and a SHA-256 of the file, remembered per path and file stamp so an owner's list does not
// hash an unchanged file on every read -- BL-277: by the shared `file-fingerprint` rule (a file changed in the last 2 s, or replaced
// by a rename, is hashed again; HFS+ keeps whole-second mtimes).

/** A file resolved inside the channel workspace (absolute: never sent to the browser or an agent). */
export type ResolvedReviewFile = { path: string; bytes: number };

/** The shared workspace rule's arguments (the set-time folder check re-run at use time, errors as plain `Error`). */
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

/**
 * `relativePath` relative to the workspace, no `..` or absolute path, its real path strictly inside the workspace's real path, a
 * regular file; `{ ok: false, reason }` otherwise (the file missing included).
 */
export async function resolveReviewFile(workspace: string, relativePath: string): Promise<({ ok: true } & ResolvedReviewFile) | { ok: false; reason: string }> {
  try {
    const file = await resolveWorkspaceFile({ ...workspaceRuleArgs(workspace), relativePath });
    return { ok: true, path: file.path, bytes: file.bytes };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** How many file hashes the process remembers (least recently used dropped first). */
export const REVIEW_HASH_CACHE_MAX = 500;
// The key changed from the earlier clear-all Map so a process still holding one (dev hot reload) starts a fresh cache.
const HASH_KEY = Symbol.for("ytom.reviewItems.hashesLru");
type Holder = typeof globalThis & { [HASH_KEY]?: LruCache<string> };
const holder = globalThis as Holder;

/** The file's SHA-256 (hex), cached per path and file stamp by the `file-fingerprint` rule (LRU, `REVIEW_HASH_CACHE_MAX` entries). */
export async function hashReviewFile(absolutePath: string): Promise<string> {
  const stamp = await statFileStamp(absolutePath);
  const cache = (holder[HASH_KEY] ??= createLruCache<string>(REVIEW_HASH_CACHE_MAX));
  return cachedForFile({
    store: cache,
    scope: absolutePath,
    stamp,
    now: () => Date.now(),
    compute: () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(absolutePath)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolve(hash.digest("hex")))
          .on("error", reject);
      }),
  });
}
