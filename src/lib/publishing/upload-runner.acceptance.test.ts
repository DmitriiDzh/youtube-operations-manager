import test from "node:test";

// BL-182 stage 2 -- the upload's acceptance, written before the runner (AGENTS.md §L; DEVELOPMENT_PLAYBOOK §6.14). Sources:
// FO-REQ-0023 §4 B4–B9 and §5; PUBLISHING_PLAN.md §2 stage 2 items 4–7 and §3; ADR 0037 (approval model, never twice, Live
// writes pause, quota buckets); owner msg 2717 (scheduled at insert); msgs 2725/2727 (UTC publish time); the YouTube Data API
// resumable-upload protocol (308 + Range, `bytes */total`, 404 = session expired). Every case runs against fakes: no test
// performs a real YouTube call (§6.11). Each todo becomes a test with hand-computed expectations when the runner is built.

// Approval binds to what the owner saw.
test.todo("AC-UP-01: the approval carries each package's manifest hash and the settings it showed; a manifest changed since is refused");
test.todo("AC-UP-01b: a package that is not ready, already has Vn_youtube.json, or already has an active job is refused at approval");
test.todo("AC-UP-01c: a publishing setting that differs between the computers refuses the approval until it is chosen in Merge");

// Dates (UPLOAD_PRIVATE / PUBLISH).
test.todo("AC-UP-02: a dated row is published at its date + the channel's UTC time; a time 15 minutes ahead or less is refused at approval");
test.todo("AC-UP-02b: publishAt is sent at insert when at least 6 h ahead, otherwise set after processing through video-details");
test.todo("AC-UP-02c: a row without a date only uploads private: no publishAt anywhere");

// Identity and Live writes.
test.todo("AC-UP-03: the channel's own connected user and assertWriteChannel pass before the first byte; a wrong channel fails before any upload call");
test.todo("AC-UP-04: Live writes off between chunks pauses the job (not failed); switched on again it continues from the stored offset");

// Never twice.
test.todo("AC-UP-05: a network cut mid-upload resumes from the offset the session reports (bytes */total), same session URI, one videos.insert begin");
test.todo("AC-UP-06: an expired session (404) starts a new one only after the channel's recent uploads show no video with this title; found -> adopted");
test.todo("AC-UP-07: a lost final response is resolved by a status query; done -> the videoId is adopted, never a second begin");
test.todo("AC-UP-12: a package another computer reports as uploading cannot be started here");

// Errors.
test.todo("AC-UP-08: quotaExceeded pauses the queue until the next Pacific midnight, uploadLimitExceeded for 24 h; shown apart; no retry before");
test.todo("AC-UP-09: processing rejected or failed stops the job with the reason, no automatic retry");

// After the upload.
test.todo("AC-UP-10: thumbnails.set, then playlistItems.insert when a playlist is set, then a read-back: title and description byte-equal, publishAt, languages, madeForKids; AI use reported as unverifiable");
test.todo("AC-UP-10b: Vn_youtube.json is written next to the package (videoId, publishAt, uploadedAt, device, result), an audit row is kept and the video is synced");
test.todo("AC-UP-11: every step's outcome is stored; after a restart the job continues at its step -- no second upload, no second thumbnail");
test.todo("AC-UP-13: one upload at a time on a computer, and it counts as busy for the idle watcher");
test.todo("AC-UP-14: no upload or schedule tool for agents or the Producer (tool classification)");
