import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCostFiles } from "./adapters/cost-file";
import type { VideoCostFile } from "./contracts";

// BL-194 stage 3 (VIDEO_COST_PLAN.md §2 stage 3, criterion 6): Vn_cost.json goes into the video's own folder inside the channel
// workspace, whole (no temporary file left), and never outside it.

const doc = { schema: "ytm.video-cost", schemaVersion: 1, video: "V49" } as unknown as VideoCostFile;

test("BL-194: the cost file is written whole into the video folder and read back; outside the workspace or another name is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "video-cost-file-"));
  try {
    const workspace = path.join(root, "ws");
    const folder = path.join(workspace, "04 Videos", "10 October", "1017 V49");
    await mkdir(folder, { recursive: true });
    await mkdir(path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), path.join(workspace, "04 Videos", "link"));
    const files = createCostFiles(async () => workspace);

    await files.write("UC1", "04 Videos/10 October/1017 V49/V49_cost.json", doc);
    assert.deepEqual(await readdir(folder), ["V49_cost.json"], "no temporary file left");
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, "V49_cost.json"), "utf8")), doc);
    assert.deepEqual(await files.read("UC1", "04 Videos/10 October/1017 V49/V49_cost.json"), doc);
    assert.equal(await files.read("UC1", "04 Videos/10 October/1017 V49/V50_cost.json"), null);

    await assert.rejects(files.write("UC1", "04 Videos/link/V49_cost.json", doc), /outside/);
    await assert.rejects(files.write("UC1", "04 Videos/10 October/1017 V49/V49_youtube.json", doc), /Not a cost file name/);
    await assert.rejects(files.write("UC1", "V49_cost.json", doc), /Not a cost file name/);
    assert.deepEqual(await readdir(path.join(root, "elsewhere")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Independent review: the hash cache of older runs lives for the process, not per request (each request builds its own backfill).
test("BL-194: two backfill file readers share one hash cache, so a video is read once per process", async () => {
  const { createBackfillFiles, processHashCache } = await import("./adapters/backfill-files");
  const root = await mkdtemp(path.join(os.tmpdir(), "video-cost-hash-"));
  try {
    const folder = path.join(root, "04 Videos", "0928 V39");
    await mkdir(folder, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(folder, "bar.mp4"), "abc");
    processHashCache().clear();
    const first = await createBackfillFiles(async () => root).hashOf("UC1", "04 Videos/0928 V39/bar.mp4");
    // sha256("abc"), worked out independently.
    assert.equal(first, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(processHashCache().size, 1);
    // Mark the cached value: a second reader that answers with the mark took it from the cache instead of reading the file.
    const [key] = processHashCache().keys();
    processHashCache().set(key, "cached");
    assert.equal(await createBackfillFiles(async () => root).hashOf("UC1", "04 Videos/0928 V39/bar.mp4"), "cached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
