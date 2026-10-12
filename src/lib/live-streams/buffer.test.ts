import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MediaProbe } from "@/lib/ffmpeg-host";
import { createBufferFs } from "./adapters/buffer-fs";
import { createLiveStreamBuffer, type BufferFs, type BufferVideo } from "./buffer";

// BL-176 acceptance, docs/roadmap/plans/LIVE_STREAMS_PLAN.md §4.1 "Buffer" (rotation A, B, C, depth 2), on real temporary
// folders: the originals folder stands in for the T9, the buffer folder for the internal disk.

const A = "AAAAAAAAAA1";
const B = "BBBBBBBBBB2";
const C = "CCCCCCCCCC3";
const GB = 1024 ** 3;

const PROBE: MediaProbe = {
  durationSeconds: 7382.3,
  sizeBytes: null,
  video: { codec: "h264", width: 1920, height: 1080, frameRate: 30 },
  audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  audioStreams: 1,
  videoStreams: 1,
};

const VIDEOS: BufferVideo[] = [A, B, C].map((videoId) => ({ videoId, originalPath: `04 Videos/${videoId}.mp4`, videoDurationSeconds: 7382 }));

async function withFolders(
  run: (ctx: { originals: string; root: string; t9: { mounted: boolean }; events: string[]; buffer: ReturnType<typeof createLiveStreamBuffer>; listBuffer: () => Promise<string[]> }) => Promise<void>,
  options: { fs?: Partial<BufferFs>; probe?: Partial<MediaProbe>; freeBytes?: number } = {}
) {
  const base = await mkdtemp(path.join(os.tmpdir(), "live-buffer-"));
  const originals = path.join(base, "T9");
  const root = path.join(base, "buffer");
  try {
    await (await import("node:fs/promises")).mkdir(path.join(originals, "04 Videos"), { recursive: true });
    for (const id of [A, B, C]) await writeFile(path.join(originals, "04 Videos", `${id}.mp4`), `original ${id}`);
    const t9 = { mounted: true };
    const events: string[] = [];
    const realFs = createBufferFs();
    const buffer = createLiveStreamBuffer({
      fs: { ...realFs, freeBytes: async () => options.freeBytes ?? 30 * GB, ...options.fs },
      bufferRoot: root,
      async resolveOriginal(_channelId, relativePath) {
        if (!t9.mounted) return { ok: false, workspaceMissing: true, detail: "the workspace folder does not exist or is not accessible" };
        const file = path.join(originals, relativePath);
        const size = await realFs.size(file);
        return size === null ? { ok: false, workspaceMissing: false, detail: "missing" } : { ok: true, path: file, bytes: size };
      },
      probe: async () => ({ ...PROBE, ...options.probe }),
      event: async (_channelId, kind, detail) => {
        events.push(`${kind}:${String(detail.videoId)}`);
      },
      now: () => 0,
    });
    const listBuffer = async () => (await readdir(path.join(root, "UC1")).catch(() => [])).sort();
    await run({ originals, root, t9, events, buffer, listBuffer });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const at = (currentIndex: number, extra: Partial<{ nextPassFirst: string | null; depth: number; refuseBelowBytes: number }> = {}) => ({
  order: [A, B, C],
  currentIndex,
  nextPassFirst: A,
  depth: 2,
  refuseBelowBytes: 5 * GB,
  videos: VIDEOS,
  ...extra,
});

test("buffer: while A plays, the buffer holds A and B (copied in that order)", () =>
  withFolders(async ({ buffer, listBuffer, events }) => {
    const result = await buffer.sync("UC1", at(0));
    assert.deepEqual(result.copied, [A, B]);
    assert.equal(result.missing, null);
    assert.deepEqual(await listBuffer(), [`${A}.mp4`, `${B}.mp4`]);
    assert.deepEqual(events, [`buffer_copied:${A}`, `buffer_copied:${B}`]);
  }));

test("buffer: after the encoder moves to B, A is deleted and C is copied; B stays", () =>
  withFolders(async ({ buffer, listBuffer }) => {
    await buffer.sync("UC1", at(0));
    const result = await buffer.sync("UC1", at(1));
    assert.deepEqual([result.removed, result.copied], [[A], [C]]);
    assert.deepEqual(await listBuffer(), [`${B}.mp4`, `${C}.mp4`]);
  }));

test("buffer: an interrupted copy leaves only a .part file, which is never listed and is removed at the next sync", () =>
  withFolders(
    async ({ buffer, listBuffer, root }) => {
      const first = await buffer.sync("UC1", at(0));
      assert.equal(first.missing?.reason, "copy_failed");
      assert.deepEqual(first.present, [], "nothing under a final name");
      // A crash mid-copy (the process died, so nothing cleaned up) leaves a .part behind.
      await writeFile(path.join(root, "UC1", `${A}.mp4.part`), "half");
      assert.deepEqual(await listBuffer(), [`${A}.mp4.part`]);
    },
    {
      fs: {
        copy: async (_from, to) => {
          await writeFile(to, "half");
          throw new Error("disk unplugged");
        },
      },
    }
  ));

test("buffer: a leftover .part is removed before copying", () =>
  withFolders(async ({ buffer, listBuffer, root }) => {
    await (await import("node:fs/promises")).mkdir(path.join(root, "UC1"), { recursive: true });
    await writeFile(path.join(root, "UC1", `${C}.mp4.part`), "stale");
    await buffer.sync("UC1", at(0));
    assert.deepEqual(await listBuffer(), [`${A}.mp4`, `${B}.mp4`]);
  }));

test("buffer: a copy that would leave less than the refuse level free is not started", () =>
  withFolders(
    async ({ buffer, listBuffer }) => {
      const result = await buffer.sync("UC1", at(0));
      assert.equal(result.missing?.reason, "disk_full");
      assert.deepEqual(await listBuffer(), [], "not even a .part");
    },
    { freeBytes: 5 * GB }
  ));

test("buffer: the T9 is missing when C is due -- A and B are kept to replay, C reported missing; back -> C copied, A removed", () =>
  withFolders(async ({ buffer, listBuffer, t9 }) => {
    await buffer.sync("UC1", at(0));
    t9.mounted = false;
    const down = await buffer.sync("UC1", at(1));
    assert.deepEqual(down.missing, { videoId: C, reason: "source_unavailable", detail: "the workspace folder does not exist or is not accessible" });
    assert.deepEqual(down.removed, []);
    assert.deepEqual(await listBuffer(), [`${A}.mp4`, `${B}.mp4`], "A stays until C replaces it");
    t9.mounted = true;
    const up = await buffer.sync("UC1", at(1));
    assert.deepEqual([up.copied, up.removed, up.missing], [[C], [A], null]);
    assert.deepEqual(await listBuffer(), [`${B}.mp4`, `${C}.mp4`]);
  }));

test("buffer: a copy refused for disk space frees the unwanted copies first and tries again", () => {
  let free = 6 * GB - 1; // below the 5 GB refuse level once a copy is counted
  return withFolders(
    async ({ buffer, listBuffer }) => {
      await buffer.sync("UC1", at(0));
      free = 5 * GB; // a full disk: C does not fit until A is gone
      const result = await buffer.sync("UC1", at(1));
      assert.deepEqual([result.removed, result.copied, result.missing], [[A], [C], null]);
      assert.deepEqual(await listBuffer(), [`${B}.mp4`, `${C}.mp4`]);
    },
    {
      fs: {
        freeBytes: async (dir) => {
          const names: string[] = await readdir(dir).catch(() => []);
          // Removing A gives its space back.
          return names.includes(`${A}.mp4`) ? free : free + GB;
        },
      },
    }
  );
});

test("buffer: a copy whose size differs, or whose probe fails the checks, is discarded", () =>
  withFolders(
    async ({ buffer, listBuffer }) => {
      const result = await buffer.sync("UC1", at(0));
      assert.deepEqual([result.missing?.videoId, result.missing?.reason], [A, "check_failed"]);
      assert.deepEqual(await listBuffer(), []);
    },
    { probe: { durationSeconds: 7000 } }
  ));

test("buffer: on the last video of a pass the first of the next pass is copied", () =>
  withFolders(async ({ buffer, listBuffer }) => {
    const result = await buffer.sync("UC1", at(2, { nextPassFirst: B }));
    assert.deepEqual(result.copied, [C, B]);
    assert.deepEqual(await listBuffer(), [`${B}.mp4`, `${C}.mp4`]);
  }));
