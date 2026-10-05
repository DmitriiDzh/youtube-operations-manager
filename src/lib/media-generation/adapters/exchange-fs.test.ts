import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createExchangeLocalFs } from "./exchange-fs";

// FO-REQ-0002: the manifest appears under its final name only complete (`<name>.part` -> rename), like the media files.

test("writeFileAtomic leaves only the final file with the full text, replacing an earlier manifest and a stale .part", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-exchange-fs-"));
  try {
    const target = path.join(dir, "manifest.json");
    await writeFile(target, "old");
    await writeFile(`${target}.part`, "left by a killed attempt");
    await createExchangeLocalFs().writeFileAtomic(target, '{"status":"done"}\n');
    assert.equal(await readFile(target, "utf8"), '{"status":"done"}\n');
    assert.deepEqual(await readdir(dir), ["manifest.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeFileAtomic into a folder that does not exist fails and creates nothing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ytm-exchange-fs-"));
  try {
    await assert.rejects(createExchangeLocalFs().writeFileAtomic(path.join(dir, "gone", "manifest.json"), "{}"));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
