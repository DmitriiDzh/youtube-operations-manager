import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";

// BL-277 (owner TG 4922; AGENTS.md §M): the one rule for a value cached per file "stamp" (size and times) -- a SHA-256 that pins
// what the owner approves, a preview the owner approves from, an ffprobe result. HFS+ (the T9 disk, where channel workspaces and
// media live) keeps modification times to whole seconds, so a file replaced by another of the same size within the same second
// keeps size and mtime: a cache keyed on them alone hands back the earlier file's value. Hence:
//
// - the key carries device, inode, size, mtime and ctime -- a rename-replacement (another inode) or a copy that kept an old mtime
//   (its ctime moved) always misses;
// - a value is stored only when the file was last changed (mtime and ctime) at least `COARSE_MTIME_SLACK_MS` before the clock read
//   taken just before the value was computed; a fresher file is computed every time until it is that old. Whatever replaces such a
//   file later gets a newer mtime, so the stored key can never name it;
// - with `restat`, the value is stored only when the stamp read again after the computation is the one read before it (a change
//   during the read never leaves a mixed value behind, whatever the file system keeps of ctime).
//
// Pure over its ports (store, clock, compute, restat); `statFileStamp` is the real-disk stamp for callers that have none of their
// own, and `cachedSha256OfFile` the one cached whole-file SHA-256 (stamps from the read's own descriptor).

/** How much older than "now" a file's last change must be before a value computed from it is cached (FAT keeps 2 s). */
export const COARSE_MTIME_SLACK_MS = 2_000;

/** What identifies a file's current content cheaply. `ctimeMs`, `ino`, `dev` are optional for ports that do not know them. */
export type FileStamp = { size: number; mtimeMs: number; ctimeMs?: number; ino?: number; dev?: number };

/** The minimal store: a `Map`, or an LRU with the same two methods. */
export type FileValueStore<V> = { get(key: string): V | undefined; set(key: string, value: V): void };

export function stampOf(info: Pick<Stats, "size" | "mtimeMs" | "ctimeMs" | "ino" | "dev">): FileStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino, dev: info.dev };
}

/** The file's stamp on this disk (follows symlinks, like the reads that hash it). */
export async function statFileStamp(absolutePath: string): Promise<FileStamp> {
  return stampOf(await stat(absolutePath));
}

export function fileStampKey(info: FileStamp): string {
  return [info.dev ?? "", info.ino ?? "", info.size, info.mtimeMs, info.ctimeMs ?? ""].join(":");
}

/** True when the file was last changed (mtime and, when known, ctime) at least the slack before `nowMs`; a future time is not. */
export function isSettledAt(info: FileStamp, nowMs: number): boolean {
  const last = Math.max(info.mtimeMs, info.ctimeMs ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(last) && last <= nowMs - COARSE_MTIME_SLACK_MS;
}

/**
 * The value for the file `stamp` describes: from `store` when it was computed for a settled file of exactly that stamp under
 * `scope`, else `compute()` -- stored only when the file is settled at the clock read taken here, before `compute` starts, and,
 * with `restat`, only when the stamp read after `compute` equals `stamp` (null or a throw: not stored). `stamp` must be read before
 * `compute` reads the file. A failed `compute` stores nothing.
 */
export async function cachedForFile<V>(args: {
  store: FileValueStore<V>;
  scope: string;
  stamp: FileStamp;
  now: () => number;
  compute: () => Promise<V>;
  restat?: () => Promise<FileStamp | null>;
}): Promise<V> {
  const settled = isSettledAt(args.stamp, args.now());
  const stampKey = fileStampKey(args.stamp);
  const key = `${args.scope}\u0000${stampKey}`;
  if (settled) {
    const known = args.store.get(key);
    if (known !== undefined) return known;
  }
  const value = await args.compute();
  if (settled) {
    const after = args.restat ? await args.restat().catch(() => null) : args.stamp;
    if (after && fileStampKey(after) === stampKey) args.store.set(key, value);
  }
  return value;
}

/**
 * A whole file's SHA-256 (lower-case hex), read as a stream (a multi-GB video never sits in memory), cached in `store` by the rule
 * above per path and stamp. The stamps before and after the read come from the read's own descriptor (`fstat`).
 */
export async function cachedSha256OfFile(args: { store: FileValueStore<string>; absolutePath: string; now?: () => number }): Promise<string> {
  const handle = await open(args.absolutePath, "r");
  try {
    return await cachedForFile({
      store: args.store,
      scope: args.absolutePath,
      stamp: stampOf(await handle.stat()),
      now: args.now ?? (() => Date.now()),
      compute: () =>
        new Promise<string>((resolve, reject) => {
          const hash = createHash("sha256");
          handle
            .createReadStream({ start: 0, autoClose: false })
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")))
            .on("error", reject);
        }),
      restat: async () => stampOf(await handle.stat()),
    });
  } finally {
    await handle.close();
  }
}
