import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isFinishedRecodeJournal, listPendingRecodeJournals, releaseRecodeJournalDir, releaseRecodeJournalPath } from "./index";

// BL-263 review (HIGH 1, MEDIUM 2): a journal is finished when it says completed or every step is done -- never undone, never listed as
// pending; any other journal (an unreadable one too) is pending.

test("BL-263: finished journals are completed or have every step done; others are pending", () => {
  assert.equal(isFinishedRecodeJournal({ done: [], completed: true }), true);
  assert.equal(isFinishedRecodeJournal({ done: ["files", "manifest", "records", "folder", "rows", "storyboards"] }), true);
  assert.equal(isFinishedRecodeJournal({ done: ["files", "manifest", "records", "folder", "rows"] }), false);
  assert.equal(isFinishedRecodeJournal({}), false);
});

test("BL-263: listPendingRecodeJournals lists this channel's unfinished journals only (an unreadable one counts)", async () => {
  const app = await mkdtemp(path.join(tmpdir(), "recode-journals-"));
  try {
    const dir = releaseRecodeJournalDir(app, "UC_wwe");
    await mkdir(dir, { recursive: true });
    assert.equal(releaseRecodeJournalPath(app, "UC_wwe", "V14", new Date(5)), path.join(dir, "V14-5.json"));
    await writeFile(path.join(dir, "V14-1.json"), JSON.stringify({ video: "V14", newCode: "S12", startedAt: "2026-11-16T12:00:00.000Z", done: ["files"] }));
    await writeFile(path.join(dir, "V15-2.json"), JSON.stringify({ video: "V15", newCode: "S13", done: ["files"], completed: true }));
    await writeFile(path.join(dir, "V16-3.json"), "{ not json");
    await mkdir(releaseRecodeJournalDir(app, "UC_other"), { recursive: true });
    await writeFile(path.join(releaseRecodeJournalDir(app, "UC_other"), "V1-1.json"), JSON.stringify({ video: "V1", newCode: "S1", done: [] }));
    assert.deepEqual(await listPendingRecodeJournals(app, "UC_wwe"), [
      { journal: path.join(dir, "V14-1.json"), video: "V14", newCode: "S12", startedAt: "2026-11-16T12:00:00.000Z", done: ["files"] },
      { journal: path.join(dir, "V16-3.json"), video: "V16", newCode: "", startedAt: null, done: [] },
    ]);
    assert.deepEqual(await listPendingRecodeJournals(app, "UC_none"), []);
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});
