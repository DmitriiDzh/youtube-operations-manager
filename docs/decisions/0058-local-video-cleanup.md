# 0058. Local video cleanup: delete the uploaded mp4 once YouTube holds it, behind a strict allowlist and a tombstone

Status: Accepted for building, stage 1 (new uploads only). Owner, Telegram 2026-10-31: msgs 3885 (go), 3891 (variant A: only videos
uploaded through YT Manager), 3893 (future uploads first, old ones later). Request FO-REQ-0051 (BL-238); the owner's earlier
decisions on when and how (Operator's chat, TG 3249/3251/3253) are quoted in the request. Plan: DEV-RESP-0047.

## Context

Each release leaves a 2–7 GB `V<n> <channel>.mp4` in `04 Videos/` on the T9 after it is uploaded. Since 2026-10-31 both live streams
play the segment libraries, so nothing on air reads those files. The owner wants the local copy deleted permanently, no Trash,
right after YouTube has finished processing it. He set a HARD rule: never touch anything else.

## Decision

1. **Own feature module** `src/lib/local-video-cleanup/` (AGENTS.md §M). Publishing, video projects and live streams do not import
   it. It reads their rows through `db.ts` only. With it off or removed, nothing else changes. It is the only code in this
   repository that deletes a channel's release file.
2. **What can be deleted (allowlist, one pattern):** `04 Videos/<MM> <EnglishMonth>/<MMDD> V<n>/V<n> <channel>.mp4`, where:
   - MM and the month name agree (`11 November`);
   - the release folder's MMDD starts with that MM;
   - V<n> is the upload's own video in both places;
   - `<channel>` is the channel folder's name without its number prefix;
   - the path is exactly the upload's `package.videoFile`.

   The file's real path must equal the path built under the workspace's real root, and no component may be a symlink (each
   component is checked with `lstat`). The file must be a regular file. Anything else is refused and logged. The build's job
   folders are not deleted: the bundle removes complete ones itself (Operator, 2026-10-31).
3. **When (all checks at the moment of deleting, each read fresh):**
   - the upload row is `done` on THIS computer, stored = total bytes, and the videoId is known;
   - it finished after the channel's switch was turned on (stage 1: future uploads only);
   - YouTube `videos.list` (`status,processingDetails,fileDetails,contentDetails`, 1 unit per ≤ 50 videos) returns the video with
     `processingStatus = succeeded` or `uploadStatus = processed`;
   - it is `public`, or `private` with a `publishAt`;
   - `fileDetails.fileSize` equals the local size. Only if YouTube gives no size: the ffprobe duration is within 2 s of
     `contentDetails.duration`;
   - the local size equals the uploaded bytes, and the sha256 equals the package's when the package has one;
   - no live rotation (any channel) names the video or the file, and no active upload names the file.

   A check that can still change (processing, privacy, date, reads off, workspace unavailable, in use) **waits** and is checked
   again later. A check that proves the file is not the uploaded one (sizes, hash, duration, path, symlink, the video missing,
   rejected or failed on YouTube) **refuses**: logged once, and that upload is never tried again.
4. **Tombstone first.** `V<n> <channel>.mp4.deleted.json` (schema `deleted-video/1`, the Operator's contract):
   - it is written to a temporary file, fsynced, renamed, its folder fsynced, then read back and compared;
   - only then is the mp4 unlinked. If the tombstone cannot be written or read back, nothing is deleted;
   - after a crash between the two steps, the next sweep finds tombstone + mp4 and completes the delete only if the tombstone
     names the same bytes and video.

   `tempDeleted` is always `[]`.
5. **Switch per channel, per computer** (`app_settings`, never synced: the file exists on one computer), off by default. It is
   set only by the owner in the Web UI; no MCP or agent path reaches it. Turning it on stores `enabledAt`.
6. **Log:**
   - every delete and refusal goes to the table `local_video_cleanup_log` (schema v116, device-local), with path, bytes, videoId and
     reason, and as a line in the channel's `99 Data Exchange/From YTM/cleanup-log.csv`. A CSV failure is noted, never a reason to
     keep the file;
   - waits are not logged; the card shows the last reason per upload;
   - the card also shows the freed GB.
7. **The sweep:** the server checks every 30 minutes, plus once 3 minutes after the start. One delete runs at a time. Restart-when-idle
   is not held: each delete is a few milliseconds and crash-safe (point 4).

## Consequences

- A deleted video cannot return to a live rotation in "published videos" mode (no local file). Rotations are checked, so a file in
  one is never deleted.
- No other module has to read the tombstone. `video-projects` keeps "published", because its state comes from `V<n>_youtube.json`,
  the registry or the upload row, never from the mp4. `package-scan` clears a package's problems once its `V<n>_youtube.json` exists,
  so the missing mp4 shows nothing. The live picker lists only files that exist.
- Not in this stage: the backfill of old videos (an owner button with a preview, and `factory_cleanup_preview` for the Operator).
  Also not in this stage: videos uploaded before YT Manager (variant B, to be discussed).

## Acceptance criteria (defined before the code, §L)

- AC-1: Every path outside pattern 2 is refused, and nothing is deleted. Examples:
  - `Live Segments/…`;
  - another Vn or channel name;
  - a month folder `2026-11` or `11 October`;
  - an MMDD of another month;
  - `..`, an absolute path, or a symlink on any component;
  - a file outside the workspace root;
  - a non-regular file.
- AC-2: The checks of point 3 follow those rules: each failing check gives its own reason, and none of them deletes.
  - Waits: processing, unlisted, private without a date, reads off, workspace unavailable, a live rotation naming it, an active upload
    of the file.
  - Refusals: YouTube size ≠ local size, local ≠ uploaded bytes, sha256 ≠ the package's, duration off by > 2 s without fileSize,
    the video not returned / rejected / failed.
- AC-3: A tombstone that fails to write or read back leaves the mp4 untouched. A successful delete leaves the tombstone with the
  contract fields and removes ONLY the mp4: every other file in the folder stays byte-identical.
- AC-4: The switch is off by default. With it off nothing is read or deleted. Uploads finished before `enabledAt` are never touched.
- AC-5: Tombstone + mp4 after a crash: the delete completes only when the tombstone matches (bytes, videoId); otherwise it is refused.
- AC-6: Every delete and refusal is logged once (DB + CSV line). A refused upload is not checked again.
