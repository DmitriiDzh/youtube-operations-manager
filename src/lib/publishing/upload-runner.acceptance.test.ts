import test from "node:test";

// BL-182 stage 2 -- the upload's acceptance, written before the runner (AGENTS.md §L; DEVELOPMENT_PLAYBOOK §6.14). Sources:
// FO-REQ-0023 §4 B4–B9 and §5; PUBLISHING_PLAN.md §2 stage 2 items 4–7 and §3; ADR 0037 (approval model, never twice, Live
// writes pause, quota buckets); owner msg 2717 (scheduled at insert); msgs 2725/2727 (UTC publish time); the YouTube Data API
// resumable-upload protocol (308 + Range, `bytes */total`, 404 = session expired). Every case runs against fakes: no test
// performs a real YouTube call (§6.11). Each todo becomes a test with hand-computed expectations when its part is built.
// Built and tested in upload-runner.test.ts: AC-UP-02b/c, 03, 04, 05, 06, 07, 08, 09, 10, 10b, 11, 13.

// Approval binds to what the owner saw.
test.todo("AC-UP-01: the approval carries each package's manifest hash and the settings it showed; a manifest changed since is refused");
test.todo("AC-UP-01b: a package that is not ready, already has Vn_youtube.json, or already has an active job is refused at approval");
test.todo("AC-UP-01c: a publishing setting that differs between the computers refuses the approval until it is chosen in Merge");

// Dates (UPLOAD_PRIVATE / PUBLISH).
test.todo("AC-UP-02: a dated row is published at its date + the channel's UTC time; a time 15 minutes ahead or less is refused at approval");

// Identity and Live writes.

// Never twice.
test.todo("AC-UP-12: a package another computer reports as uploading cannot be started here");

// Errors.

// After the upload.
test.todo("AC-UP-14: no upload or schedule tool for agents or the Producer (tool classification)");
