import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTempDir } from "@/test-support/temp-dir";
import { folderSize, readVolumes } from "./fs";

// BL-237: the guard's file-system reads. Sizes are bounded in time ("skip if slow"), links are not followed, a missing folder
// is empty; two places on one volume are one volume.

test("folderSize counts the files under a folder, nested, and not what a link points at", () =>
  withTempDir("disk-guard-fs-", async (dir) => {
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, "a", "one"), Buffer.alloc(1000));
    await writeFile(path.join(dir, "a", "b", "two"), Buffer.alloc(234));
    await mkdir(path.join(dir, "elsewhere"));
    await writeFile(path.join(dir, "elsewhere", "big"), Buffer.alloc(50_000));
    await symlink(path.join(dir, "elsewhere"), path.join(dir, "a", "link"));
    assert.deepEqual(await folderSize(path.join(dir, "a"), { budgetMs: 10_000 }), { bytes: 1234, complete: true });
  }));

test("folderSize stops at its time budget and says the size is incomplete", () =>
  withTempDir("disk-guard-fs-", async (dir) => {
    for (let i = 0; i < 5; i++) {
      await mkdir(path.join(dir, `d${i}`));
      await writeFile(path.join(dir, `d${i}`, "f"), Buffer.alloc(100));
    }
    // A clock that jumps a second per reading: the 1.5 s budget runs out after the first folders.
    let t = 0;
    const result = await folderSize(dir, { budgetMs: 1500, now: () => (t += 1000) });
    assert.equal(result.complete, false);
    assert.ok(result.bytes < 500, `counted ${result.bytes}`);
  }));

test("folderSize of a missing folder is 0, complete", async () => {
  assert.deepEqual(await folderSize("/nonexistent-ytm/disk-guard", { budgetMs: 1000 }), { bytes: 0, complete: true });
});

test("readVolumes: two places on the same volume are one entry with both labels and real numbers", () =>
  withTempDir("disk-guard-fs-", async (dir) => {
    await mkdir(path.join(dir, "x"));
    const volumes = await readVolumes([
      { label: "appData", path: dir },
      { label: "program", path: path.join(dir, "x") },
    ]);
    assert.equal(volumes.length, 1);
    assert.deepEqual(volumes[0].labels, ["appData", "program"]);
    assert.ok(volumes[0].totalBytes > 0 && volumes[0].freeBytes >= 0 && volumes[0].freeBytes <= volumes[0].totalBytes);
  }));

test("readVolumes throws when a place cannot be read (the guard then records the reason, never alerts)", async () => {
  await assert.rejects(() => readVolumes([{ label: "appData", path: "/nonexistent-ytm/disk-guard" }]));
});
