// BL-238 (ADR 0058 §2, §4): the file side of the cleanup -- the ONLY place in this repository that deletes a channel's release
// file. Every path is the workspace's real root plus the release's relative path, walked component by component with lstat (no
// symlink anywhere, folders all the way, a regular file at the end); the tombstone is durable and read back before the unlink, and
// the unlink re-checks the file's identity and the allowlist right before it runs.

import { createReadStream } from "node:fs";
import { lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isAllowedReleaseVideo } from "../allowlist";
import { TOMBSTONE_SCHEMA, TOMBSTONE_SUFFIX, type VideoTombstone } from "../contracts";
import type { LocalFileFacts } from "../decide";

/** A tombstone is a few hundred bytes. */
const TOMBSTONE_MAX_BYTES = 64 * 1024;

export type InspectedFile = LocalFileFacts & { absolutePath?: string; identity?: { dev: number; ino: number } };

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" || (error as NodeJS.ErrnoException | undefined)?.code === "ENOTDIR";

/** Parses a tombstone; null when it is not one of ours (`deleted-video/1` with the contract's fields). */
export function parseTombstone(text: string): VideoTombstone | null {
  try {
    const value = JSON.parse(text) as Partial<VideoTombstone>;
    if (value?.schema !== TOMBSTONE_SCHEMA || typeof value.file !== "string" || typeof value.bytes !== "number" || typeof value.youtubeVideoId !== "string") return null;
    return value as VideoTombstone;
  } catch {
    return null;
  }
}

/**
 * The release file at `relativePath` under the workspace: `unavailable` when the workspace is not reachable (the T9 not mounted --
 * never "nothing to delete"), `symlink` when any component is one, `not_a_file` when the end is not a regular file, `missing` when
 * it is not there (with its tombstone, when one is), else `file` with its size, identity and tombstone.
 */
export async function inspectReleaseFile(workspace: string, relativePath: string): Promise<InspectedFile> {
  const root = await realpath(workspace).catch(() => null);
  if (!root) return { kind: "unavailable" };
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory()) return { kind: "unavailable" };
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return { kind: "not_a_file" };
  let current = root;
  for (const [i, segment] of segments.entries()) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        if (i < segments.length - 1) return { kind: "missing", tombstone: null };
        return { kind: "missing", tombstone: await readTombstone(current) };
      }
      return { kind: "unavailable" };
    }
    if (info.isSymbolicLink()) return { kind: "symlink" };
    if (i < segments.length - 1 && !info.isDirectory()) return { kind: "not_a_file" };
    if (i === segments.length - 1) {
      if (!info.isFile()) return { kind: "not_a_file" };
      // Belt and braces: the real path is exactly the one walked (no symlink, no case-folding surprise to another file).
      const real = await realpath(current).catch(() => null);
      if (real !== current) return { kind: "symlink" };
      return { kind: "file", bytes: info.size, tombstone: await readTombstone(current), absolutePath: current, identity: { dev: info.dev, ino: info.ino } };
    }
  }
  return { kind: "not_a_file" };
}

async function readTombstone(videoPath: string): Promise<VideoTombstone | null> {
  const tombstonePath = `${videoPath}${TOMBSTONE_SUFFIX}`;
  const info = await lstat(tombstonePath).catch(() => null);
  if (!info || !info.isFile() || info.size > TOMBSTONE_MAX_BYTES) return null;
  return parseTombstone(await readFile(tombstonePath, "utf8").catch(() => ""));
}

/** The file's SHA-256 (hex), streamed. */
export function sha256OfFile(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(absolutePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function fsyncPath(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Writes the tombstone next to the video durably -- a temporary file written and fsynced, renamed into place, the folder fsynced
 * -- then reads it back. Throws when any step fails or the read-back differs: the caller then deletes nothing.
 */
export async function writeTombstone(videoPath: string, tombstone: VideoTombstone): Promise<void> {
  const target = `${videoPath}${TOMBSTONE_SUFFIX}`;
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  const text = `${JSON.stringify(tombstone, null, 2)}\n`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await fsyncPath(path.dirname(target)).catch(() => undefined); // not every file system lets a folder be fsynced
  const back = parseTombstone(await readFile(target, "utf8"));
  if (!back || JSON.stringify(back) !== JSON.stringify(tombstone)) throw new Error("the tombstone read back differs from the one written");
}

/**
 * Deletes the release video -- only when the path still passes the allowlist, it is still the same regular file (device, inode,
 * size) that was checked, and its tombstone is in place. Throws otherwise; never deletes anything but that one file.
 */
export async function unlinkReleaseVideo(args: {
  workspace: string;
  relativePath: string;
  video: string;
  channelName: string;
  expected: { dev: number; ino: number; bytes: number; videoId: string };
}): Promise<void> {
  if (!isAllowedReleaseVideo(args.relativePath, args.video, args.channelName)) throw new Error("path not allowed");
  const now = await inspectReleaseFile(args.workspace, args.relativePath);
  if (now.kind !== "file" || !now.absolutePath || !now.identity) throw new Error(`the file is no longer a plain file (${now.kind})`);
  if (now.identity.dev !== args.expected.dev || now.identity.ino !== args.expected.ino || now.bytes !== args.expected.bytes) throw new Error("the file changed since it was checked");
  if (!now.tombstone || now.tombstone.youtubeVideoId !== args.expected.videoId || now.tombstone.bytes !== args.expected.bytes) throw new Error("the tombstone is not in place");
  await unlink(now.absolutePath);
}
