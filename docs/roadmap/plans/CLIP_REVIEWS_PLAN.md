# Clips for review: the Producer submits a scene-loop clip, the owner approves or returns it in the app (BL-241)

Sources:
- The owner, Telegram 2026-11-03: msg 4010 (the proposal: a «Клипы на проверку» queue so short scene-loop clips are approved in
  the app instead of Telegram), msg 4011 «Делай».
- ADR 0061 records the decision. Template: the weekly publishing plan (ADR 0051, commit 23bb28cc) for the shared document, the
  Content sub-tab and the badge; the storyboard takes / renders (BL-184 / BL-189) for playing a channel-folder video.

## Behaviour

1. **What a clip is.** A short video the Factory Operator rendered inside the channel's own folder (e.g.
   `03 Images/Scenes/<scene>/preview_30s.mp4`, `03 Images/Loops/Staging/x.mp4`), named by a path RELATIVE to the channel
   workspace root (Settings → Channels, this computer's folder). The Producer never writes into a channel folder; it only names a
   file that is already there.
2. **Submit (Producer, `producer_clip_review_submit`, DRAFT).** Input `{ channelId, sceneId, clipPath, note, startSec?, endSec? }`:
   - `sceneId` 1–80 characters (a free short label), `note` 1–2000 characters (what changed), both trimmed, no control characters;
   - the channel must be connected on this computer (`CHANNEL_NOT_ACTIVE`) and have a workspace folder here
     (`clip_review_workspace_unavailable`);
   - `clipPath` is resolved with the shared `workspace-exchange.resolveWorkspaceFile`: relative, `/` between folders, no empty /
     `.` / `..` segment, not absolute; its REAL path (symlinks resolved) strictly inside the workspace's real path, a regular file
     (`clip_review_file_unavailable`, details.reason);
   - extension `.mp4`, `.mov` or `.webm` only (`clip_review_not_video`);
   - duration from ffprobe (the shared `ffmpeg-host`) between 30 and 120 seconds, with 0.5 s tolerance either side
     (`clip_review_duration_out_of_range`, details.durationSeconds); no ffprobe here or an unreadable duration is refused
     (`clip_review_probe_unavailable`) -- fail closed. No size cap (a 100 MB file is fine);
   - `startSec` / `endSec` optional, both or one: `0 <= startSec < endSec <= duration` (`validation_failed`);
   - at most 50 pending clips per channel (`clip_review_too_many_pending`); the same `clipPath` already pending in the channel is
     refused (`clip_review_duplicate`, details.clipId);
   - the file's size and SHA-256 are stored with the clip (what the owner approves);
   - refused while the app is paused for a device handoff or recovery (the device mutation gate, as the Producer's other writes).
   Returns `{ clip }` with status `pending`.
3. **Withdraw (Producer, `producer_clip_review_withdraw`, DRAFT).** A pending clip of the channel leaves the queue (status
   `withdrawn`); a decided clip is refused (`clip_review_not_pending`, details.status).
4. **Read (Producer, `producer_clip_review_list` / `producer_clip_review_get`, READ).** List one channel's clips (`channelId`
   required; optional `status`, `limit` 1–200, default 50), pending first (oldest first), then the rest newest first. Each clip:
   `{ clipId, channelId, sceneId, clipPath, note, startSec, endSec, durationSeconds, sizeBytes, sha256, submittedAt, device,
   status: pending | approved | returned | withdrawn, comment, decidedAt, decidedOn }`. Get one by `clipId` (`clip_review_not_found`).
5. **The owner (Web UI only).** Контент → «Клипы»: the ACTIVE channel's clips, pending first. A row: scene, note, when submitted,
   status chip. Selecting a row expands an inline player that plays the clip from this computer's copy of the channel folder with
   HTTP Range (seek in a 100 MB file), starting at `startSec` and stopping at `endSec` (media fragment `#t=start,end`). If the file
   is not on this computer, or differs from what was submitted (size or SHA-256), the row says so. «Одобрить» and «Вернуть» with a
   comment (required for «Вернуть», optional for «Одобрить»), confirmed in the row, never a browser dialog. A badge on the tab shows
   how many clips wait.
6. **Decisions.** A decision is a record `{ id, clipId, kind: approved | returned | withdrawn, by: owner | producer, comment, device,
   at }`; the clip itself is never edited after submit. A decision on a clip that is not pending on this computer is refused
   (`clip_review_not_pending`, 409). Approval also needs this computer's file to be the submitted one (`clip_review_file_changed` /
   `clip_review_file_missing`, 409): the owner approves exactly what the Producer sent. «Вернуть» is allowed without the file.
   Every owner decision is audited on the computer it was made on (`clip:<clipId>`).
7. **Two computers.** One Automerge document per channel (sync family `clip_reviews`, fixed genesis actor, flat maps `clips` and
   `decisions` from the genesis), synced like the weekly plans. The status is derived: the EARLIEST owner decision (by `at`, then
   id) counts; a Producer withdrawal counts only when no owner decision exists. So two computers that decided the same clip offline
   merge to one answer on both, and an owner decision beats a withdrawal made meanwhile.
8. **Boundaries.** Agents never approve or return: the owner's surface is used only by the Web UI's clip-review routes (source
   scan); no MCP server, agent endpoint or MCP route names it. Channel workers and the factory get no clip-review tool. Nothing
   reaches YouTube. The module `src/lib/clip-reviews/` imports no other feature module, no Google client, no network (AGENTS.md §M).
9. **Versions.** Producer API 1.15.0 (additive): four `producer-only` tools; `producer_get_capabilities` lists `clipReviewTools`;
   submit and withdraw join `draftTools`; permissions unchanged.

## Acceptance criteria

- **AC-CR-01** A submit naming an mp4 of 30–120 s inside the channel's workspace stores a pending clip with its size and SHA-256;
  get/list return it with status `pending`, `comment: null`, `decidedAt: null`.
- **AC-CR-02** A `clipPath` with a `..` segment, an absolute path, or a backslash is refused (`clip_review_file_unavailable`);
  nothing is stored.
- **AC-CR-03** A symlink inside the workspace pointing to a file outside it is refused (`clip_review_file_unavailable`), at submit
  and when the owner's route serves it (404).
- **AC-CR-04** A non-video extension (`.txt`, `.png`, `.mkv`) is refused (`clip_review_not_video`); a missing file is refused
  (`clip_review_file_unavailable`).
- **AC-CR-05** A duration of 29 s or 121 s is refused (`clip_review_duration_out_of_range`); 29.6 s and 120.4 s are accepted; no
  ffprobe is `clip_review_probe_unavailable`. `startSec >= endSec` or `endSec > duration` is `validation_failed`.
- **AC-CR-06** A channel not connected on this computer is `CHANNEL_NOT_ACTIVE`; a channel without a workspace folder here is
  `clip_review_workspace_unavailable`. A clip id of channel A asked under channel B is `clip_review_not_found`.
- **AC-CR-07** The owner approves a pending clip: status `approved`, `decidedAt` set, an audit event written. A second decision
  (approve or return) on it is `clip_review_not_pending` (409) and writes nothing. Return without a comment is refused
  (`validation_failed`); with one, status `returned` and the comment readable by the Producer.
- **AC-CR-08** Approval of a clip whose file on this computer differs from the submitted one (size or SHA-256) is
  `clip_review_file_changed`; a missing file `clip_review_file_missing`; return still works.
- **AC-CR-09** Withdraw of a pending clip makes it `withdrawn`; withdraw of a decided clip is `clip_review_not_pending`; the owner
  cannot decide a withdrawn clip.
- **AC-CR-10** Two computers: a clip submitted on the Mac is on Windows after one sync cycle; the owner returns it on Windows and the
  Mac reads `returned`. The same clip approved on the Mac at 10:00 and returned on Windows at 10:05 (offline) reads `approved` on
  both after the cycle; a withdrawal on the Mac and a return on Windows read `returned` on both.
- **AC-CR-11** The owner's video route needs a session (401), the active channel (403), a loopback request (403); a Range request
  `bytes=10-19` on a known file answers 206 with exactly those 10 bytes and `content-range: bytes 10-19/<size>`; no Range is 200
  with the whole file; an unknown clip 404.
- **AC-CR-12** No MCP server, agent endpoint, MCP route or agent-operations file names the owner's surface or its decision function;
  the owner's core is created only by the clip-review route handlers and the module's own barrel.
- **AC-CR-13** The clip-review module imports no other feature module, no Google client and no network.
- **AC-CR-14** The Producer endpoint lists exactly `producer_clip_review_submit` / `_list` / `_get` / `_withdraw`, classified
  `producer-only`; a channel worker session lists none of them; inputs are strict (an unknown field such as `status: "approved"`
  on submit is refused at input); each call is logged under its channel and answers with `forChannelId`. Producer API 1.15.0.
- **AC-CR-15** The tab badge counts the channel's pending clips; a failed read shows no badge.
- **AC-CR-16** The list shows pending first (oldest first), then decided ones newest first.

## Not in scope

- No upload, no YouTube call, no change to the clip file (the app never writes into the channel folder for this).
- No comments thread or second round on the same clip: a reworked clip is a new submission (same `sceneId`).
- No playback on a computer that does not have the file (Syncthing brings it; the row says it is missing).
