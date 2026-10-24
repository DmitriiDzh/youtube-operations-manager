import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeUploadRecordFile } from "./adapters/upload-record";

// BL-221 (CONTENT_UX_PLAN.md stage B, acceptance 4): the record goes only into a folder inside the channel workspace, under a
// `Vn_youtube.json` name; the owner's link never replaces an existing record; nothing half-written is left behind.

async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "ytm-upload-record-"));
  await mkdir(path.join(root, "ws", "04 Videos", "10 October", "1011 V52"), { recursive: true });
  return root;
}

test("BL-221: the record is written whole into the Vn folder; exclusive refuses an existing one and keeps it", async () => {
  const root = await workspace();
  try {
    const ws = path.join(root, "ws");
    const rel = "04 Videos/10 October/1011 V52/V52_youtube.json";
    await writeUploadRecordFile(ws, rel, { videoId: "abcdefghijk" }, { exclusive: true });
    const file = path.join(ws, ...rel.split("/"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { videoId: "abcdefghijk" });
    await assert.rejects(writeUploadRecordFile(ws, rel, { videoId: "zzzzzzzzzzz" }, { exclusive: true }), /already exists/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { videoId: "abcdefghijk" });
    // The upload runner (not exclusive) may replace its own record.
    await writeUploadRecordFile(ws, rel, { videoId: "zzzzzzzzzzz" });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { videoId: "zzzzzzzzzzz" });
    assert.deepEqual((await readdir(path.dirname(file))).filter((n) => n.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BL-221: a name other than Vn_youtube.json, the workspace root, and a folder reached outside the workspace are refused", async () => {
  const root = await workspace();
  try {
    const ws = path.join(root, "ws");
    await assert.rejects(writeUploadRecordFile(ws, "04 Videos/10 October/1011 V52/notes.json", {}), /Not an upload record name/);
    await assert.rejects(writeUploadRecordFile(ws, "V52_youtube.json", {}), /outside the channel workspace/);
    await mkdir(path.join(root, "elsewhere"));
    await symlink(path.join(root, "elsewhere"), path.join(ws, "04 Videos", "escape"));
    await assert.rejects(writeUploadRecordFile(ws, "04 Videos/escape/V52_youtube.json", {}), /outside the channel workspace/);
    await assert.rejects(writeUploadRecordFile(ws, "../elsewhere/V52_youtube.json", {}), /outside the channel workspace/);
    assert.deepEqual(await readdir(path.join(root, "elsewhere")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
