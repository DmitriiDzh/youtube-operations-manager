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
   - extension `.mp4` or `.webm` only (`.mov` dropped before merge: Chrome often cannot play `video/quicktime`) (`clip_review_not_video`);
   - duration from ffprobe (the shared `ffmpeg-host`) between 5 and 300 seconds (widened before merge: the Producer's loop previews are 15–20 s), with 0.5 s tolerance either side
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
5. **The owner (Web UI only).** Медиа → «Клипы» (moved from Контент 2026-11-04, owner msg 4025): the ACTIVE channel's clips, pending first. A row: scene, note, when submitted,
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

- **AC-CR-01** A submit naming an mp4 of 5–300 s inside the channel's workspace stores a pending clip with its size and SHA-256;
  get/list return it with status `pending`, `comment: null`, `decidedAt: null`.
- **AC-CR-02** A `clipPath` with a `..` segment, an absolute path, or a backslash is refused (`clip_review_file_unavailable`);
  nothing is stored.
- **AC-CR-03** A symlink inside the workspace pointing to a file outside it is refused (`clip_review_file_unavailable`), at submit
  and when the owner's route serves it (404).
- **AC-CR-04** A non-video extension (`.txt`, `.png`, `.mkv`) is refused (`clip_review_not_video`); a missing file is refused
  (`clip_review_file_unavailable`).
- **AC-CR-05** A duration of 4 s or 301 s is refused (`clip_review_duration_out_of_range`); 4.6 s and 300.4 s are accepted; no
  ffprobe is `clip_review_probe_unavailable`. `startSec >= endSec` or `endSec > duration` is `validation_failed`.
- **AC-CR-06** A channel not connected on this computer is `CHANNEL_NOT_ACTIVE`; a channel without a workspace folder here is
  `clip_review_workspace_unavailable`. A clip id of channel A asked under channel B is `clip_review_not_found`.
- **AC-CR-07** The owner approves a pending clip: status `approved`, `decidedAt` set, an audit event written. A second decision
  (approve or return) on it is `clip_review_not_pending` (409) and writes nothing. Return without a comment is refused
  (`validation_failed`); with one, status `returned` and the comment readable by the Producer.
- **AC-CR-08** Approval of a clip whose file on this computer differs from the submitted one (size or SHA-256) is
  `clip_review_file_changed`; a missing file `clip_review_file_missing`; return still works. The owner's list marks a clip `changed` by size only (no hashing
  on every badge poll, independent review); the SHA-256 is checked at approval.
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

## BL-246 — attachments to the owner's comment (ADR 0065)

Source: the owner, Telegram 2026-11-06, msgs 4076/4078/4079 («да»).

10. **Attaching.** In the row's confirmation (approve or return) the owner can attach files to his comment: paste an image from the
    clipboard (Cmd/Ctrl+V in the comment field; a clipboard image has no name and becomes `pasted-<n>.<ext>`), drop files on the
    comment box, or «Прикрепить файл» (a real button over a hidden file input). Each file shows as a chip (an image as a thumbnail)
    with its upload progress, its error, and × to remove it. The decision button waits until every chip is uploaded; a failed chip
    must be removed first.
11. **Limits.** At most 10 files per decision; each 1 byte .. 50 MiB (52,428,800 bytes). Allowed by extension (case ignored): `.png
    .jpg .jpeg .webp .gif .pdf .txt .md .json .mp4 .webm .mov`; anything else is `clip_attachment_type_not_allowed`. The type the
    browser declares must be one of that extension's types (empty and `application/octet-stream` count as "not declared"); the file's
    first bytes must be that kind (PNG / JPEG / WebP / GIF / `%PDF-` / ISO-BMFF `ftyp` or a QuickTime atom / EBML for WebM; `.txt` /
    `.md` UTF-8 text without NUL; `.json` UTF-8 that parses as JSON) -- otherwise `clip_attachment_type_mismatch`.
12. **Names.** NFC; only the last segment after `/` or `\`; control characters removed; `< > : " | ? *` become `_`; whitespace runs one
    space; leading / trailing dots and spaces trimmed; `..`+ runs become one `.`; a Windows device name (`CON`, `PRN`, `AUX`, `NUL`,
    `COM1-9`, `LPT1-9`) gets a leading `_`; the name before the extension at most 100 characters; the extension lowercased; an empty
    name becomes `file-<n>` (n = the file's place, 1-based). Names that collide ignoring case get `-2`, `-3`, ... in order.
13. **Upload (staging).** The panel sends each file to this computer's app data (never the channel folder: Syncthing must never carry
    a half-finished file) in pieces of at most 4 MiB, because every `/api` request passes the proxy, which keeps only the first 40 MB of
    a body and silently drops the rest (`next.config.ts`). `POST .../clip-reviews/[clipId]/uploads` `{ name, type, size, sha256 }`
    (the browser's SHA-256) → `{ uploadId, name, mime }`; `PUT .../uploads/[uploadId]?offset=<n>` the next piece (refused at another
    offset or past the size: `clip_attachment_upload_offset`); the last piece checks the kind (item 11) and the SHA-256
    (`clip_attachment_upload_corrupt`) and drops the upload when either fails; `DELETE .../uploads/[uploadId]` drops it. An upload
    belongs to one clip of one channel; staged uploads older than 24 h are removed.
14. **Writing.** `POST .../decision` `{ action, comment?, attachments?: [uploadId] }`. Before anything is written: the clip pending,
    approval's file check, at most 10 uploads, each complete and of this clip, kind and SHA-256 again. Then the decision's id is made,
    the files are copied to `<workspace>/99 Data Exchange/From YTM/clip-reviews/<clipId>/<decisionId>/<name>` (the folders made by the
    shared `workspace-exchange` rule: plain folders, real path inside the workspace) under a temporary name, their size and SHA-256
    checked, and renamed; only then is the decision recorded. If a copy, a check or the record fails, the decision folder is removed
    and nothing is recorded (all or nothing). The staged uploads are removed after the record.
15. **The record.** The decision gains `attachments: [{ path, name, mime, size, sha256 }]` (`path` relative to the workspace, `/`
    between folders); a decision without attachments has no such field. Older builds read the document without a schema (the maps
    are copied, the views pick named fields), so they ignore it.
16. **Showing.** The owner's list gives each clip `decisionId` and the deciding record's attachments, each with `index` and `file: ok |
    missing | changed` (size only, as for clips). Images show as thumbnails (click opens the full size in a new tab); other files as
    links; a missing one says «файл ещё не пришёл», a changed one «файл изменён». `GET .../clip-reviews/[clipId]/attachments/
    [decisionId]/[index]` serves one to a loopback request only (`local-file-response`): the stored path must be exactly the decision
    folder plus one name; it is resolved again with the shared rule (plain folders, the real file strictly inside the decision
    folder's real path, a regular file); a missing file is 404 `clip_attachment_missing`, a different size or SHA-256 409
    `clip_attachment_changed`. Text files are sent as `text/plain; charset=utf-8`.
17. **Producer.** `producer_clip_review_get` / `_list` give each clip `attachments` (the deciding owner decision's, `[]` otherwise):
    `{ path, name, mime, size, sha256 }`. Producer API 1.19.0, additive. The Producer gets no way to add attachments.

### Acceptance criteria (BL-246)

- **AC-CR-17** Limits: 10 uploads in one decision are recorded with 10 attachments; 11 are `clip_attachment_too_many` and nothing is
  written or recorded. A size of 52,428,800 bytes is accepted at staging; 52,428,801 and 0 are `clip_attachment_too_large` /
  `validation_failed`.
- **AC-CR-18** Types: `.svg`, `.exe`, `.html` and a name without an extension are `clip_attachment_type_not_allowed`; a `.png`
  declared `application/pdf` is `clip_attachment_type_mismatch`; a `.png` whose bytes start `%PDF-` is refused at its last piece
  (`clip_attachment_type_mismatch`); a `.json` that does not parse and a `.txt` with a NUL byte are refused the same way; a real PNG
  declared `""` is accepted as `image/png`.
- **AC-CR-19** Names (by hand from item 12): `photo.PNG` → `photo.png`; `../../etc/passwd.png` → `passwd.png`;
  `C:\Users\x\shot.jpg` → `shot.jpg`; `a<NUL>b<US>.txt` → `ab.txt`; `what?<now>.md` → `what__now_.md`; `..png` (1st) → `file-1.png`;
  `CON.txt` → `_CON.txt`; 300 × `x` + `.pdf` → 100 × `x` + `.pdf`; `  report   final .pdf` → `report final.pdf`; `a...b.json` →
  `a.b.json`; `e` + U+0301 + `.txt` → `é.txt`; the 2nd pasted PNG → `pasted-2.png`; `[shot.png, Shot.png, shot.png]` →
  `[shot.png, Shot-2.png, shot-3.png]`.
- **AC-CR-20** Writing: a return with `hello` (5 bytes) as `note.txt` puts exactly those bytes at `99 Data Exchange/From
  YTM/clip-reviews/<clipId>/<decisionId>/note.txt`, leaves no temporary file, and records `{ path: "99 Data Exchange/From
  YTM/clip-reviews/<clipId>/<decisionId>/note.txt", name: "note.txt", mime: "text/plain", size: 5, sha256:
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" }`; the staged upload is gone.
- **AC-CR-21** All or nothing: when recording the decision fails, the decision folder is removed and no decision exists; when the copy
  of the 3rd of 3 files fails, no file of the decision remains and nothing is recorded; a refusal before writing (`not pending`,
  approval with the clip file missing) creates no folder.
- **AC-CR-22** Serving: 401 without a session, 403 for another channel than the active one, 403 for a non-loopback request; an `ok`
  attachment is sent whole with its type; a stored path outside its decision folder (another decision's folder, `03 Images/x.png`, a
  `..` segment) is 404 `clip_attachment_not_found`; a symlink in the decision folder to a file outside is refused (404); a missing
  file is 404 `clip_attachment_missing`; same size other bytes 409 `clip_attachment_changed`.
- **AC-CR-23** The owner's list carries `decisionId` and each attachment's `index` and `file` (missing when not here, changed when the
  size differs).
- **AC-CR-24** Compatibility: a decision stored without `attachments` reads `attachments: []` in the owner's list and in the Producer's
  get and list.
- **AC-CR-25** The Producer's get and list include the deciding owner decision's attachments `{ path, name, mime, size, sha256 }`; a
  pending or withdrawn clip has `[]`. Producer API 1.19.0; the Producer's clip tools are still exactly submit / list / get / withdraw.
- **AC-CR-26** Channel and clip: staging, a piece, a decision or an attachment of a clip of channel A asked under channel B is
  `clip_review_not_found`; an upload staged for clip X used in a decision on clip Y is `clip_attachment_upload_unknown`.
- **AC-CR-27** Staging: a piece at a wrong offset or past the declared size is `clip_attachment_upload_offset`; a last piece whose
  SHA-256 differs from the declared one is `clip_attachment_upload_corrupt` and drops the upload; a decision naming an unfinished
  upload is `clip_attachment_upload_incomplete`; staged uploads older than 24 h are removed when a new one is staged.

## Not in scope

- No upload, no YouTube call, no change to the clip file. Since BL-246 (ADR 0065) the app writes into the channel folder only the
  owner's comment attachments, under `99 Data Exchange/From YTM/clip-reviews/`.
- No comments thread or second round on the same clip: a reworked clip is a new submission (same `sceneId`).
- No playback on a computer that does not have the file (Syncthing brings it; the row says it is missing).
