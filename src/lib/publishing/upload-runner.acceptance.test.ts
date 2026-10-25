import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// BL-182 stage 2 -- the upload's acceptance, written before the runner (AGENTS.md §L; DEVELOPMENT_PLAYBOOK §6.14). Sources:
// FO-REQ-0023 §4 B4–B9 and §5; PUBLISHING_PLAN.md §2 stage 2 items 4–7 and §3; ADR 0037 (approval model, never twice, Live
// writes pause, quota buckets); owner msgs 3510/3511 (2026-10-25, FO-REQ-0040 item 4: the publish time last, after the thumbnail,
// the playlist and the read-back -- this replaces msg 2717's "scheduled at insert", so AC-UP-02b changed and AC-UP-02d was added);
// msgs 2725/2727 (UTC publish time); the YouTube Data API
// resumable-upload protocol (308 + Range, `bytes */total`, 404 = session expired). Every case runs against fakes: no test
// performs a real YouTube call (§6.11). This file keeps the list and checks that each criterion still has its test.
//
// AC-UP-01   the approval binds to each manifest's hash and the settings shown; anything changed refuses it whole
// AC-UP-01b  not ready, already uploaded or already queued is refused
// AC-UP-01c  settings that differ between the computers refuse the approval until chosen in Merge
// AC-UP-02   a dated row is published at its time, more than 15 minutes ahead; a row without a date only uploads
// AC-UP-02b  publishAt never at insert: written through video-details after the upload; within 15 minutes then -> not written
// AC-UP-02d  order: insert private without a date -> thumbnail, playlist -> read-back -> only then the date, itself read back; a
//            failed thumbnail, playlist or read-back withholds the date (private, unscheduled, the step's error on the job); a
//            resumed job writes the date once
// AC-UP-02c  no date: no publishAt anywhere
// AC-UP-03   the identity check passes before the first byte; a wrong channel fails before any upload call
// AC-UP-04   Live writes off pauses (not fails); on again it continues from the stored offset
// AC-UP-05   a cut connection resumes from what the session holds; one session, one video
// AC-UP-06   an expired session restarts only when no video with the title is among the newest uploads; found -> adopted
// AC-UP-07   a lost final answer is resolved by a status query; never a second begin
// AC-UP-08   quotaExceeded pauses until the quota day resets, uploadLimitExceeded 24 h; no retry before
// AC-UP-09   processing rejected or failed stops the job with the reason
// AC-UP-10   thumbnail, playlist, read-back (byte-equal texts, publishAt, languages, flags), the upload record
// AC-UP-11   a restart continues at its step: no second upload, thumbnail or playlist item
// AC-UP-12   a package another computer reports as uploading cannot be started here
// AC-UP-13   one upload at a time, busy for the idle watcher
// AC-UP-14   no upload or schedule tool for agents or the Producer

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRITERIA = ["AC-UP-01", "AC-UP-01b", "AC-UP-01c", "AC-UP-02", "AC-UP-02b", "AC-UP-02c", "AC-UP-02d", "AC-UP-03", "AC-UP-04", "AC-UP-05", "AC-UP-06", "AC-UP-07", "AC-UP-08", "AC-UP-09", "AC-UP-10", "AC-UP-11", "AC-UP-12", "AC-UP-13", "AC-UP-14"];
const TEST_FILES = ["upload-approval.test.ts", "upload-runner.test.ts", "no-agent-upload-tool.test.ts"];

test("every upload acceptance criterion has a test that names it", async () => {
  const names = (await Promise.all(TEST_FILES.map((file) => readFile(path.join(HERE, file), "utf8"))))
    .flatMap((content) => [...content.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]));
  const missing = CRITERIA.filter((id) => !names.some((name) => new RegExp(`${id}(?![0-9a-z])`).test(name)));
  assert.deepEqual(missing, []);
});
