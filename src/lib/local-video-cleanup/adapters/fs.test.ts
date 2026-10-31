import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTempDir } from "@/test-support/temp-dir";
import type { VideoTombstone } from "../contracts";
import { inspectReleaseFile, parseTombstone, sha256OfFile, unlinkReleaseVideo, writeTombstone } from "./fs";

// BL-238 (ADR 0058). On a real folder: AC-1 a symlink on any component, a folder or a missing workspace is never "a file to
// delete"; AC-3 the tombstone is durable and read back, and a delete removes ONLY the mp4 (every other file stays byte-identical).

const REL = "04 Videos/11 November/1105 V72/V72 Tropico Jazz.mp4";

async function release(root: string) {
  const ws = path.join(root, "01 Tropico Jazz");
  const folder = path.join(ws, "04 Videos", "11 November", "1105 V72");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "V72 Tropico Jazz.mp4"), "video-bytes");
  for (const name of ["V72_release.json", "V72_youtube.json", "V72_Report.txt", "Thumbnail_V72_A.jpg"]) await writeFile(path.join(folder, name), `content of ${name}`);
  await mkdir(path.join(folder, "localizations"));
  await writeFile(path.join(folder, "localizations", "de.json"), "{}");
  await mkdir(path.join(ws, "04 Videos", "Live Segments"), { recursive: true });
  await writeFile(path.join(ws, "04 Videos", "Live Segments", "seg-1.mp4"), "segment");
  return { ws, folder };
}

const tombstoneFor = (bytes: number): VideoTombstone => ({
  schema: "deleted-video/1",
  file: "V72 Tropico Jazz.mp4",
  bytes,
  sha256: null,
  durationSec: 1,
  youtubeVideoId: "fF-lZ2yR9aw",
  privacyStatus: "public",
  publishAt: null,
  deletedAt: "2026-11-05T10:00:00.000Z",
  deletedBy: "ytm-cleanup",
  tempDeleted: [],
});

async function digestTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = createHash("sha256").update(await readFile(full)).digest("hex");
  }
  return out;
}

test("AC-1: the release file is a file with its size; the workspace missing is 'unavailable', never 'missing'", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { ws } = await release(root);
    const found = await inspectReleaseFile(ws, REL);
    assert.equal(found.kind, "file");
    assert.equal(found.kind === "file" && found.bytes, "video-bytes".length);
    assert.deepEqual(await inspectReleaseFile(path.join(root, "not mounted"), REL), { kind: "unavailable" });
    assert.deepEqual(await inspectReleaseFile(ws, "04 Videos/11 November/1105 V72/V99 Tropico Jazz.mp4"), { kind: "missing", tombstone: null });
  }));

test("AC-1: a symlink on any component (the file, its release folder, its month folder) is refused", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { ws, folder } = await release(root);
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(path.join(elsewhere, "real.mp4"), "other");
    // the file itself
    await symlink(path.join(elsewhere, "real.mp4"), path.join(folder, "V73 Tropico Jazz.mp4"));
    assert.equal((await inspectReleaseFile(ws, "04 Videos/11 November/1105 V72/V73 Tropico Jazz.mp4")).kind, "symlink");
    // the release folder
    await mkdir(path.join(elsewhere, "1106 V74"));
    await writeFile(path.join(elsewhere, "1106 V74", "V74 Tropico Jazz.mp4"), "x");
    await symlink(path.join(elsewhere, "1106 V74"), path.join(ws, "04 Videos", "11 November", "1106 V74"));
    assert.equal((await inspectReleaseFile(ws, "04 Videos/11 November/1106 V74/V74 Tropico Jazz.mp4")).kind, "symlink");
    // the month folder
    await mkdir(path.join(elsewhere, "12 December", "1201 V80"), { recursive: true });
    await writeFile(path.join(elsewhere, "12 December", "1201 V80", "V80 Tropico Jazz.mp4"), "x");
    await symlink(path.join(elsewhere, "12 December"), path.join(ws, "04 Videos", "12 December"));
    assert.equal((await inspectReleaseFile(ws, "04 Videos/12 December/1201 V80/V80 Tropico Jazz.mp4")).kind, "symlink");
  }));

test("AC-1: a folder named like the video, and '..' in the path, are not files to delete", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { ws, folder } = await release(root);
    await mkdir(path.join(folder, "V75 Tropico Jazz.mp4"));
    assert.equal((await inspectReleaseFile(ws, "04 Videos/11 November/1105 V72/V75 Tropico Jazz.mp4")).kind, "not_a_file");
    assert.equal((await inspectReleaseFile(ws, "04 Videos/11 November/../11 November/1105 V72/V72 Tropico Jazz.mp4")).kind, "not_a_file");
  }));

test("AC-3: the tombstone is written durably and read back; it parses only as deleted-video/1", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { folder } = await release(root);
    const video = path.join(folder, "V72 Tropico Jazz.mp4");
    await writeTombstone(video, tombstoneFor(11));
    const text = await readFile(`${video}.deleted.json`, "utf8");
    assert.deepEqual(parseTombstone(text), tombstoneFor(11));
    assert.equal(parseTombstone('{"schema":"other"}'), null);
    assert.equal(parseTombstone("not json"), null);
    assert.ok(!(await readdir(folder)).some((n) => n.includes(".tmp-")), "no temporary file left");
  }));

test("AC-3: a tombstone that cannot be written throws, and the mp4 stays", { skip: process.getuid?.() === 0 ? "root ignores permissions" : false }, () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { folder } = await release(root);
    const video = path.join(folder, "V72 Tropico Jazz.mp4");
    await chmod(folder, 0o555);
    try {
      await assert.rejects(() => writeTombstone(video, tombstoneFor(11)));
    } finally {
      await chmod(folder, 0o755);
    }
    assert.equal((await stat(video)).size, 11);
  }));

test("AC-3: the delete removes ONLY the mp4 -- every other file of the release and the library stays byte-identical", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { ws, folder } = await release(root);
    const video = path.join(folder, "V72 Tropico Jazz.mp4");
    const found = await inspectReleaseFile(ws, REL);
    assert.ok(found.kind === "file" && found.identity);
    await writeTombstone(video, tombstoneFor(11));
    const before = await digestTree(ws);
    await unlinkReleaseVideo({ workspace: ws, relativePath: REL, video: "V72", channelName: "Tropico Jazz", expected: { ...found.identity, bytes: 11, videoId: "fF-lZ2yR9aw" } });
    const after = await digestTree(ws);
    const gone = Object.keys(before).filter((k) => !(k in after));
    assert.deepEqual(gone, [path.join("04 Videos", "11 November", "1105 V72", "V72 Tropico Jazz.mp4")]);
    for (const [k, v] of Object.entries(after)) assert.equal(v, before[k], k);
    assert.deepEqual(await inspectReleaseFile(ws, REL), { kind: "missing", tombstone: tombstoneFor(11) });
  }));

test("the unlink refuses: no tombstone, another tombstone, a changed file, a path outside the allowlist", () =>
  withTempDir("cleanup-fs-", async (root) => {
    const { ws, folder } = await release(root);
    const video = path.join(folder, "V72 Tropico Jazz.mp4");
    const found = await inspectReleaseFile(ws, REL);
    assert.ok(found.kind === "file" && found.identity);
    const args = { workspace: ws, relativePath: REL, video: "V72", channelName: "Tropico Jazz", expected: { ...found.identity, bytes: 11, videoId: "fF-lZ2yR9aw" } };
    await assert.rejects(() => unlinkReleaseVideo(args), /tombstone/);
    await writeTombstone(video, { ...tombstoneFor(11), youtubeVideoId: "otherVideo1" });
    await assert.rejects(() => unlinkReleaseVideo(args), /tombstone/);
    await writeTombstone(video, tombstoneFor(11));
    await assert.rejects(() => unlinkReleaseVideo({ ...args, expected: { ...args.expected, bytes: 12 } }), /changed/);
    await assert.rejects(() => unlinkReleaseVideo({ ...args, expected: { ...args.expected, ino: args.expected.ino + 1 } }), /changed/);
    await assert.rejects(() => unlinkReleaseVideo({ ...args, relativePath: "04 Videos/Live Segments/seg-1.mp4" }), /not allowed/);
    await assert.rejects(() => unlinkReleaseVideo({ ...args, channelName: "Japan Countryside Music" }), /not allowed/);
    assert.equal((await stat(video)).size, 11, "still there");
    assert.equal(await sha256OfFile(video), createHash("sha256").update("video-bytes").digest("hex"));
  }));
