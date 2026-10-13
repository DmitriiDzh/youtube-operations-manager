import test from "node:test";

// BL-182 stage 2 -- the upload's acceptance, written before the runner (AGENTS.md §L; DEVELOPMENT_PLAYBOOK §6.14). Sources:
// FO-REQ-0023 §4 B4–B9 and §5; PUBLISHING_PLAN.md §2 stage 2 items 4–7 and §3; ADR 0037 (approval model, never twice, Live
// writes pause, quota buckets); owner msg 2717 (scheduled at insert); msgs 2725/2727 (UTC publish time); the YouTube Data API
// resumable-upload protocol (308 + Range, `bytes */total`, 404 = session expired). Every case runs against fakes: no test
// performs a real YouTube call (§6.11). Each todo becomes a test with hand-computed expectations when its part is built.
// Built and tested: AC-UP-01, 01b, 01c, 02 in upload-approval.test.ts; AC-UP-02b/c, 03–11, 13 in upload-runner.test.ts.

// Approval binds to what the owner saw.

// Dates (UPLOAD_PRIVATE / PUBLISH).

// Identity and Live writes.

// Never twice.
test.todo("AC-UP-12: a package another computer reports as uploading cannot be started here");

// Errors.

// After the upload.
test.todo("AC-UP-14: no upload or schedule tool for agents or the Producer (tool classification)");
