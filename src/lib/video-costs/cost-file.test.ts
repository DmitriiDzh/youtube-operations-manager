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
