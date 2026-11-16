# Second video code `S<n>` for Shorts, and the one-shot recode of the WWE Shorts (BL-263, ADR 0071)

Owner (via the Producer): PRD-REQ-0194, Producer chat TG 2332 «под шортс ок» (2026-11-16); spec agreed with the Factory Operator.
Scope additions: TG 2334 (recode the unpublished WWE Shorts) and TG 4553/4555 (recode the published WWE Shorts too, locally only).
ADR: `docs/decisions/0071-short-video-code.md`. Backlog: BL-263. Amends ADR 0040 (video numbers) §2 and §4 for the `S` series.

## 1. Goal

- A second series of video codes: `VIDEO_CODE = ^(V|S)[1-9][0-9]{0,5}$` -- the bounds of today's strict V pattern (no leading zero,
  at most six digits). `V` = long (and legacy) videos, `S` = WWE Shorts.
- The **S number is the factory's**: the WWE piece number (`S-0014` → `S14`), never highest+1. A given S number is reserved as given and
  a duplicate is refused. The **next V** stays the highest known V + 1; S codes never count toward it.
- Names: folder `<MMDD> S<n> Short`; files `S<n>_release.json`, `S<n>_youtube.json`, `S<n>_cost.json`, `S<n> <Channel>.mp4`;
  manifest `video: "S14"`.
- **One-shot recode** of the 22 WWE Shorts (owner TG 2334 + TG 4553/4555): local only, never a YouTube call.

  | Published (keep their videoId) | Unpublished |
  |---|---|
  | V1=S1, V2=S2, V3=S3, V5=S4 | V6=S5, V7=S6, V8=S7, V9=S8, V10=S9, V12=S10, V13=S11, V14=S12, V15=S13, V16=S14, V17=S15, V20=S16, V21=S17, V22=S18, V23=S19, V24=S20, V25=S21, V26=S22 |

  V14 (`6Zt6kYUUMVo`) and V17 (`hrwZlxc1Y40`) are uploaded private without a date; V1–V3 and V5 are published. All four published
  ones and those two have done upload rows and a `V<n>_youtube.json`. The long WWE videos **V4, V11, V18, V19 stay V**. Other channels
  have no vertical videos and nothing of theirs changes.

## 2. Inventory (production code, `src/**` without tests; 41 sites)

"Strict" = the shared `isVideoCode`; "lenient read" = the shared `isReadableVideoCode` (§3). Every row moves to the shared module.

| # | Site | Today | Change |
|---|---|---|---|
| 1 | `src/lib/sync-gateway/video-reservations/contracts.ts:19` `VIDEO_NUMBER_PATTERN` | `^V[1-9][0-9]{0,5}$`, the pattern other modules import | Becomes a re-export of the shared pattern (V\|S). Report v2 rule (§5). |
| 2 | `src/lib/sync-gateway/publishing-uploads/contracts.ts:20` | `^V\d{1,6}$` | Lenient read (keeps any V row valid today valid) + strict S; report v2 rule (§5). |
| 3 | `src/lib/sync-gateway/video-costs/contracts.ts:33` | imports `VIDEO_NUMBER_PATTERN` | V\|S; report v2 rule (§5). |
| 4 | `src/lib/publishing/packages.ts:29` `RELEASE_PACKAGE_FILE_PATTERN` | `^V\d+_release\.json$` | `(V\d+\|S<strict>)_release.json` via the shared module. |
| 5 | `src/lib/publishing/packages.ts:113` manifest `video` check | `^V\d+$` | Lenient read (V as today, S strict); the manifest's `video` must equal the folder's code. |
| 6 | `src/lib/publishing/package-scan.ts:308` sort | first digit run of the code | Date, then the shared comparator (V before S on a tie of number). |
| 7 | `src/lib/workspace-videos/index.ts:98` `videoNumberOfFolder` | `^\d{4}\s+(V\d+)(?:\s\|$)`i | `(V\d+\|S<strict>)`; upper-cased as today. Feeds the scan, composer, numbering, rename, picker, cost backfill, thumbnails. |
| 8 | `src/lib/workspace-videos/adapters/upload-record.ts:19` | `^V\d+_youtube\.json$` | Same, with S. |
| 9 | `src/lib/workspace-videos/index.ts` `isNamedAfterRelease`, `releaseManifestFileName`, `uploadRecordFileName` | generic on the code string | No change (verify by test with `S14` vs `S1`). |
| 10 | `src/lib/video-projects/contracts.ts:15-16` | re-exports the V pattern | Re-export the shared module. |
| 11 | `src/lib/video-projects/numbering.ts:10` `videoNumberValue` | V pattern + `Number(slice(1))`; doubles as the validity filter of `knownNumbers` | Replaced by `parseVideoCode` → `{ series, number }`; `knownNumbers` keeps every code (an S is still "known" for duplicate refusal) but `nextVideoNumber` reads only series V. |
| 12 | `src/lib/video-projects/numbering.ts:21` `nextVideoNumber` | `V${highest+1}` over everything | Highest **V** + 1; S ignored. |
| 13 | `src/lib/video-projects/numbering.ts:131-168` conflict + `number` + sort | V only, `suggestedVideo` = next V | S conflict: no `suggestedVideo` (§4); list sort by the shared comparator; recode alias state (§6.4). |
| 14 | `src/lib/video-projects/linking.ts:12` `folderMonthDay` | `^(\d{2})(\d{2})\s+V\d+`i | Uses `videoNumberOfFolder` (V\|S). |
| 15 | `src/lib/video-projects/schemas.ts:8` + `services.ts` `reserveNext` / `renumber` | V only, always next | New `reserveGiven` for S (§4); `renumber` refuses an S code. |
| 16 | `src/lib/video-costs/adapters/cost-file.ts:7` | `^V[1-9]…_cost\.json$` | V\|S. |
| 17 | `src/lib/video-costs/services.ts:33,67,406` | V schema, `Number(slice(1))` sort | Shared schema + comparator; recode alias on totals (§6.4). |
| 18 | `src/lib/video-costs/backfill.ts:52` | V schema | Shared. |
| 19 | `src/lib/local-video-cleanup/allowlist.ts:17,27` | `^V\d+$`, `^(\d{2})(\d{2}) (V\d+)(?: Short)?$` | Lenient read with S. |
| 20 | `src/lib/publishing/release-folder-rename.ts:99` | `^V\d{1,6}$` | Shared; the new name must still carry the same code (a rename never changes the code -- that is the recode). |
| 21 | `src/lib/storyboards/schemas.ts:48` | V | Shared strict. |
| 22 | `src/lib/gemini-media/schemas.ts:67,87` | V | Shared strict. |
| 23 | `src/lib/media-generation/schemas.ts:177` | V | Shared strict. |
| 24 | `src/lib/elevenlabs-speech/schemas.ts:21,38,53` | V | Shared strict. |
| 25 | `src/lib/generation-plans/schemas.ts:180` | V | Shared strict. |
| 26 | `src/lib/live-streams/picker.ts:69-70` `releaseNumber` | `Number(slice(1))` | Shared comparator (S after V). |
| 27 | `src/lib/publishing-plans/services.ts:111,625` duplicate-by-video; `model.ts:73` fingerprint match | string equality of `video` | Unchanged for new codes (S14 ≠ V14); fingerprint match follows a recode alias when the video id is the same (§6.5). |
| 28 | `src/lib/db.ts:7368` orientation cache `video_orientations` | keyed by code | Recode moves the key (§6.3). |
| 29 | `src/mcp/factory-server.ts:1747` `factory_release_folder_rename` input | `^V\d{1,6}$` | Shared strict. |
| 30 | `src/mcp/factory-server.ts:1960` `factory_video_get_cost` input | V | Shared strict. |
| 31 | `src/mcp/factory-server.ts` `factory_video_create` | no number input | Optional `video` (S only) (§4). New tool `factory_release_recode` (§6). Descriptions say `V49` / `S14`. |
| 32 | `src/mcp/worker-factory-tools.ts` `agent_video_create` / `_list` / `_get_cost` | V via the core | Same core: S input on create (§4). |
| 33 | `src/mcp/server.ts:599` `producer_upload_queue_add` `video` | free string ≤ 32, checked by the scan | Description `V61 or S14`; works through rows 4–7. |
| 34 | `src/app/api/social/slot/route.ts:14` | `^V\d+$` | Lenient read. |
| 35 | `src/app/api/channels/[channelId]/videos/[videoId]/thumbnail/route.ts:27` `vn` | `^V\d{1,6}$` | Shared strict. |
| 36 | `src/components/content-manager.tsx:146` `vn` sort | `Number(slice(1))` | Shared comparator. |
| 37 | `src/components/content-video-extras.ts:56` "two numbers naming one video: the higher one" | relies on list order | Recoded V entries carry no `youtubeVideoId` (§6.4), so the S code is shown. |
| 38 | `src/components/live-stream-add-videos-dialog.tsx` | shows `vNumber` | Display only; no change. |
| 39 | `src/lib/ui-text/locales/*/content.ts` (`content.column.vn` «Vn», `publishingNewPackage.noFolders` `<MMDD Vn>`), `localVideoCleanup.ts` (`"V<n> <channel>.mp4"`) | V wording | Wording "V/S" in every language (§H). |
| 40 | MCP/API descriptions and `docs/interfaces.md` (`videoNumber` `^V[1-9][0-9]{0,5}$`, `factory_video_create`, `MMDD Vn`, `Vn_release.json`) | V | Updated text; Factory/Agent/Producer version notes (§8). |
| 41 | `src/lib/sync-gateway/{storyboards,package-reviews,publishing-plans}` `video` strings (Automerge) | unvalidated string | No change; an older build displays S as text (§5). |

Not a video code (excluded): `plan-review-screen.tsx:1473` (`C14/V04` is a generation-plan item key), `content-sort.ts` (generic
`numeric` compare). Analytics joins by video id, not by code (`src/lib/analytics/**`, milestones, search terms): unaffected.

## 3. One shared module

New `src/lib/shared-video-code/` (AGENTS §M, the `shared-video-presence` / `shared-video-localizations` naming; no dependencies;
`sync-gateway` may import it like `shared-domain`). It owns every rule about a code; nothing else writes a code regex.

- `VIDEO_CODE_PATTERN` = `^(V|S)[1-9][0-9]{0,5}$`; `VIDEO_SERIES = ["V", "S"]`.
- `isVideoCode(s)` -- strict, for every **input** (MCP, routes, reservations, recode) and every new contract.
- `isReadableVideoCode(s)` -- for **readers of existing files and reports**: today's lenient V spellings (`V\d{1,6}`) plus strict S.
  Decision: readers do **not** tighten V. Today's file readers accept `V07`/`V0`; tightening them could hide an existing package or
  invalidate a whole peer report. S never had a legacy, so it is strict everywhere.
- `parseVideoCode(s)` → `{ series: "V" | "S", number } | null`; `compareVideoCodes(a, b)` → V before S, then number (numeric:
  `S2 < S10`); a `desc` helper for highest-first lists.
- `videoCodeOfFolder(name)` stays exported from `workspace-videos` (folder rules live there) but uses this module's pattern.

## 4. Numbering and reservations

- `factory_video_create` / `agent_video_create` gain optional `video`. Absent → the next **V** as today. `video` given → it must be a
  strict **S** code (a given V is refused, `validation_failed` reason `v_numbers_are_given`: the V series stays YTM's own).
- An S is refused as `video_number_taken` (409, `details.source`: `reservation` | `folder` | `upload` | `upload_record` |
  `registry`) when any source the list reads already knows it on this channel: any computer's reservation (cancelled ones included
  -- a code is never given twice), a folder, `video_registry.csv`, an upload row here, a peer's upload report, a `_youtube.json`.
- **S conflict** (two computers reserved the same S offline, inside the sync delay): it is shown as today's conflict. `renumber`
  refuses an S (there is no "next S" -- the number is the factory's); the losing computer's reservation is cancelled by the owner
  (existing `/cancel`) or by the Operator re-creating the right piece. Nothing links to a disputed S (`video_in_dispute`, unchanged).
- V numbers burnt by the recode stay burnt: each recoded V keeps a cancelled reservation (§6.3), so after the recode the next long
  WWE video is **V27**, never V6.

## 5. Sync compatibility and rollout

Three per-device report families validate the code: `publishing-uploads`, `video-reservations`, `video-costs`. Their schemas are
`.strict()` and a report is parsed whole: **one S row makes an older build refuse the entire report**, keep that peer's last accepted
report and list the peer as skipped (`per-device-report` `mergeIncoming`). That would also blind the older build to the peer's **V**
uploads in progress (the "uploading on <host>" guard).

- Rule (BL-229 precedent, plans report v6 only when it carries a form): each of the three reports is written as **version 2 only when
  it holds at least one S code**, else version 1 exactly as today. Readers accept 1 and 2. An older build then says "version 2 is
  newer than this app understands; update the app on this device" instead of "invalid".
- Automerge families (`storyboards.video`, `package-reviews` decisions' `video`, `publishing-plans` fingerprints) carry the code as
  an unvalidated string: an older build shows S as text. An older build's package scan does not see S packages at all
  (`RELEASE_PACKAGE_FILE_PATTERN`), so its plan would show those slots as awaiting a package.
- No app build of the peer is visible to YTM today, so the gate is the release order (also a TECHNICAL_DEBT entry at implementation):
  1. BL-263 merged and live on the **Mac and Windows** (restart-when-idle; Windows build).
  2. The Operator checks both versions (Settings → О программе / `factory_restart_status`), then pins factory bundle **2.5.44** for
     WWE only (writes S, reads both).
  3. The WWE worker chain finishes what is in flight.
  4. `factory_release_recode` dry run ×22, then real ×22 (§6), on the computer that holds each video's upload rows.
  5. The worker re-packages the unpublished ones with S codes where needed; the owner reviews them in Media as usual.

## 6. The recode: `factory_release_recode`

Modelled on BL-261 (`src/lib/publishing/release-folder-rename.ts`): a new `src/lib/publishing/release-recode.ts` with ports, wired in
`factory-server.ts`. Factory endpoint only (the Operator); no Producer, worker or owner path. **No YouTube call**; the YouTube title,
description and metadata are untouched.

Input `{ channelId, video: "V14", newCode: "S12", dryRun? }` → `{ dryRun, video, newCode, from, to, files: [{from,to}], manifest:
{ fields, oldSha256, newSha256 }, records: { youtube, cost }, rows: { uploads, reservations, jobs, plans, storyboards, socialJobs,
orientation }, peerLinks, changed, readBack: verified | mismatch | null, recoveredFrom? }`.

### 6.1 Refusals (all checked before anything changes; the dry run runs them all)

- `release_recode_invalid`: `video` not a V code, `newCode` not a strict S code.
- `release_recode_not_found` / `_ambiguous`: as BL-261 (channel connected here with a workspace, fresh scan, exactly one package of
  `video` in its own `04 Videos/<month>/<MMDD V… >` folder). The package is looked up only in **this** channel's workspace, and every
  upload row or record it moves must name this `channelId`: another channel is never touched.
- `release_recode_not_short`: the folder name does not end in ` Short` (BL-261 convention), or the frame is known and horizontal
  (BL-259 orientation, read now or remembered). An unknown frame with the ` Short` suffix is allowed (a published package's mp4 may
  have been deleted by BL-238) and reported. **Publishing state is not a refusal** (owner TG 4553/4555).
- `release_recode_target_exists`: `newCode` known from any source of §4, or the target folder / any target file exists.
- `release_recode_busy`: BL-261's reasons -- an upload here sending/processing/finishing/paused or leased; a peer upload not finished;
  a cross-post uploading the file; the file in a live rotation or source map; a file-system refusal.
- `release_recode_elsewhere`: a peer reports **any** upload row of `video` (finished included). Run it on that computer: only it can
  move those rows, and a peer row left on V would let that computer think the S package was never uploaded.
- `release_recode_approval_standing`: the package is **not** uploaded and the owner has a standing approval of its current manifest
  (package review, or a weekly-plan slot approval whose fingerprint names this manifest). The manifest SHA-256 changes, so the
  approval would silently stop counting; refused rather than revoked. Today none exists (WWE packages are `owner_review_pending`,
  no slot approved). An uploaded package's approvals are history and do not block.

### 6.2 What changes, in order (journal + backups, compensated in reverse on failure)

0. Journal `<app data>/release-recode/<channelId>/<video>-<ts>.json` (planned steps, done marks) and backups of the original
   `_release.json`, `_youtube.json`, `_cost.json` and a JSON snapshot of every DB row it will change; `assertMutationAllowed`.
1. Rename, inside the old folder, every file named after the release (`isNamedAfterRelease(name, "V14")`: `V14_*`, `V14 <Channel>.mp4`,
   `V14.*`) to the same name with `S12`. Files not named after the code (thumbnails like `thumb_a.jpg`) stay.
2. Rewrite `S12_release.json` (atomic replace): `video` → `S12`, and `files.video`, `files.thumbnail`, `thumbnails[].file` where they
   name a renamed file. **Free text (title, description, localizations, tags) is never rewritten.** The video `sha256`, `slotId`
   and every other field stay. The manifest's own SHA-256 changes (reported old/new).
3. Rewrite `S12_youtube.json` and `S12_cost.json`: only a `video` field equal to `V14`; `videoId` stays.
4. Rename the folder `<MMDD> V14 Short` → `<MMDD> S12 Short`.
5. One DB transaction (`src/lib/db.ts` `recodeVideoRows`, the shared persistence layer that owns all these tables):
   - `publishing_uploads`: `video`, `manifest_path`, `manifest_sha256` (the new manifest's), `package_json` (paths + `video`) -- the
     row moves to the new manifest version, so it still counts as tried/uploaded and is never offered again; `video_id` stays;
   - `video_reservations`: this computer's V14 row → `cancelled`, `replacedBy: "S12"` (inserted as cancelled if this computer has
     none); a new `S12` row `in_work` with the V14 working title;
   - links: `media_jobs.video`, `gemini_media_jobs.video`, `elevenlabs_speech_jobs.video`, `generation_plans.video`,
     `social_post_jobs.video`;
   - the `video_orientations` setting key V14 → S12.
   Kept as history (not rewritten): `local_video_cleanup_log`, audit entries, package-review decisions, plan decisions.
6. Storyboards whose `video` is V14 → S12 (Automerge, syncs).
7. Invalidate the scan caches; publish this computer's uploads, reservations and costs reports now.
8. Read back: the scan finds `S12` in `<MMDD> S12 Short` with manifest `video` S12 and the expected new SHA-256; the old folder and
   every `V14*` name are gone; the upload rows name S12, the new SHA and the same `video_id`; the list shows S12 with that
   `youtubeVideoId` and V14 as recoded; the next V is unchanged. Audit `release.recoded` (`release.recode_failed` on failure).

A failure at any step undoes the done steps in reverse (files renamed back, JSON restored from the backup, the transaction not
committed or restored from the snapshot) and answers `release_recode_busy` with the step; a failed undo answers
`release_recode_rollback_failed` with the journal path. A crash leaves the journal: the next call for that channel first undoes it
from the backups (`recoveredFrom`), then runs as new. One recode at a time per process (BL-261's queue).

### 6.3 How the other computer learns it

- Files: Syncthing carries the renamed folder and files.
- `publishing-uploads` report: the V14 row disappears, an S12 row appears (version 2: §5).
- `video-reservations` report: V14 `cancelled` with `replacedBy: "S12"`, S12 `in_work`.
- `video-costs` report: this computer's runs now under S12.
- The peer's **own** rows that name V14 (its jobs, a reservation of V14 it made itself) are not edited from here -- a device speaks
  only for its own report. They follow a **recode alias** at read time (§6.4). The dry run lists such peer links (`peerLinks`).

### 6.4 Recode alias (shared rule in `video-projects`)

A **V** code that any computer reports as cancelled with `replacedBy` an **S** code is recoded (a conflict renumber is always V→V,
so V→S is unambiguous; no schema change). Then:
- the list shows it with state `recoded` (→ S code), never in dispute, without `youtubeVideoId` (so Content shows the S code), even
  when another computer still reports it in work or `video_registry.csv` still names it;
- cost totals count runs linked to it (any computer) under the S code;
- nothing new links to it (`video_not_found` reason `recoded`, details name the S code); it still counts toward the next V.

### 6.5 Plans and reviews

- Released weekly-plan slots (V1–V3, V5 published; V14/V17 have no approved slot): the fingerprint match (`publishing-plans/model.ts`)
  treats an approval naming V-code + old manifest as the same package when the recode alias maps it to the current S code **and the
  video id is the same** (the video id is the identity, AGENTS §F). Slots stay released and covered.
- Package review: the decisions stay as history. An unpublished recoded package has a new manifest SHA-256, so it is
  `owner_review_pending` again (it already is). An uploaded one stays unaffected (BL-257 AC-PR-06).
- `video_registry.csv` is the factory's file (YTM only reads it): the Operator updates its V→S rows; until then the alias hides them.

## 7. Sorting and display

- The code is shown as is (`S14`); no extra label.
- Highest-first lists (Ролики / `factory_video_list`, Content's «Vn» column, cost lists): V block first, then S, each by number
  descending, numerically (`S10` above `S2`). Ascending lists (the live picker): V then S, each ascending.
- Date-ordered views (План недели, Календарь, Релизы, the package scan): by date; on a tie, the shared comparator.

## 8. API versions (current: Factory 1.48.0, Agent 4.20.0, Producer 1.21.0; one bump each for the one merge)

- **Factory 1.49.0:** codes `V<n>` or `S<n>` everywhere a video number is taken or returned; `factory_video_create.video` (S only),
  `video_number_taken`; new WRITE tool `factory_release_recode` with the `release_recode_*` errors. Additive.
- **Agent 4.21.0:** `agent_video_create.video` (S only, the same core); S codes in `agent_video_list` / `_get_cost` and the
  publishing calendar. Additive.
- **Producer 1.22.0:** S codes in `agent_get_publishing_calendar`, `producer_upload_queue_*` and wake file names
  (`REVIEW-DECISION-package-S14-…`). Additive.

## 9. Stages (one branch `feature/bl-263-short-video-code`, one merge)

1. **Shared code + readers.** `src/lib/shared-video-code/`; rows 1–10, 14, 16–30, 34–41 of §2; report v2 rule (§5); sorting (§7);
   texts en/ru/…; before tightening anything, a read-only check of both computers' folders and DB for non-canonical V codes (the
   decision in §3 keeps V readers lenient regardless). S packages scan, upload, get reviewed, planned, cleaned up and costed.
2. **Numbering and reservations.** `parseVideoCode` in numbering, next V ignores S, `reserveGiven` for S, `video_number_taken`, S
   conflicts without renumber, recode alias rule (§6.4) and the plan fingerprint alias (§6.5); MCP inputs (rows 31–33); API bumps.
3. **Recode.** `release-recode.ts`, `db.ts` `recodeVideoRows`, storyboard relink port, journal/backup/rollback, `factory_release_recode`,
   docs (interfaces, SYSTEM_MAP, ARCHITECTURE, TECHNICAL_DEBT entry for the version gate, ADR index).

## 10. Acceptance (written before the code)

Codes and files
- AC-SC-01 `S1`, `S14`, `S999999`, `V1`, `V49` are codes; `S0`, `S01`, `S1000000`, `X5`, `s14` as input, `SV1`, `` are refused
  (`validation_failed`) on every MCP/route input (factory_video_create, `videoNumber`, get_cost, folder rename, recode, thumbnail
  `vn`, social slot).
- AC-SC-02 A folder `1120 S14 Short` with `S14_release.json` (`video: "S14"`) and `S14 WWE.mp4` scans like a V package: ready
  states, problems, orientation, review gate, plan, queue add, upload, `S14_youtube.json` written, cleanup allowlist, cost file.
- AC-SC-03 A manifest whose `video` is `S14` in a folder of `S15`, or `S014`, is a problem (`field_invalid`), never uploaded.
- AC-SC-04 Every existing V package, upload row, reservation and report scans and validates exactly as before (same states,
  problems and SHA-256s); a legacy `V07` folder read today is still read.
- AC-SC-05 `S14 WWE.mp4` is named after S14, not after S1; `V14 WWE.mp4` is not named after S14.

Numbering
- AC-SC-06 Channel with V1..V26 known and S5..S22 folders: `factory_video_create {}` → `V27`; S folders never raise it.
- AC-SC-07 `factory_video_create { video: "S23" }` → S23 reserved; again `S23` → `video_number_taken` (source reservation);
  `S12` when a folder `… S12 Short` exists → `video_number_taken` (folder); a cancelled S23 reservation still refuses S23.
- AC-SC-08 `factory_video_create { video: "V30" }` → `validation_failed` (`v_numbers_are_given`).
- AC-SC-09 Two computers holding S23 in work → conflict shown, `video_in_dispute` on links, `renumber` refused for S.

Sync
- AC-SC-10 Reports without S codes are version 1 byte-for-byte as today; with one S row, version 2; a reader of this build accepts
  both; a v1-only reader refuses v2 with "newer than this app understands".

Sorting
- AC-SC-11 `[S10, V2, S2, V10]` highest first → `V10, V2, S10, S2`; ascending → `V2, V10, S2, S10`.

Recode
- AC-SC-12 Dry run of V14→S12 changes nothing (files, DB, reports byte-identical) and lists folder, files, manifest fields, old/new
  SHA-256, row counts and peer links.
- AC-SC-13 Real V14→S12: folder `<MMDD> S12 Short`, `S12_release.json` with `video` S12 and file fields renamed, title/description/
  localizations byte-identical, `S12_youtube.json` with `6Zt6kYUUMVo`; the upload row names S12, the new manifest SHA-256 and
  `6Zt6kYUUMVo`; the S12 package is uploaded and cannot be queued again (`upload_already_tried` / not offered); read-back verified.
- AC-SC-14 Published V1→S1: done upload row and `_youtube.json` move to S1 with the same video id; the released slot stays released
  and the day covered; Content shows `S1` for that video id; no YouTube call is made (gateway inventory: none).
- AC-SC-15 After the recode, `factory_video_create {}` still gives V27; V14 is listed as recoded → S12, refuses new links
  (`video_not_found` reason `recoded`), and counts toward the next V.
- AC-SC-16 Refused: V4 (folder without ` Short`) and a ` Short` folder whose frame is horizontal → `release_recode_not_short`;
  `newCode` S12 already reserved / foldered → `release_recode_target_exists`; a V of another channel or a channel not connected →
  `release_recode_not_found`; `S5` as `video` or `V5` as `newCode` → `release_recode_invalid`.
- AC-SC-17 Refused while uploading here (incl. a leased queued row), while the peer reports any upload row of the code
  (`release_recode_elsewhere`), while a cross-post uploads it, while it is in a live rotation; an unuploaded package with a standing
  owner approval → `release_recode_approval_standing`.
- AC-SC-18 A failure injected after each step class (file rename, manifest write, record write, folder rename, DB transaction,
  storyboard relink) leaves folder, files, rows and reports exactly as before; a failed undo → `release_recode_rollback_failed`
  with the journal path.
- AC-SC-19 A crash after step 4 (journal left): the next call restores the original state from the backups, reports
  `recoveredFrom`, then runs normally.
- AC-SC-20 On the peer (fixture reports): the uploads report shows S12 uploaded and no V14; its own job linked to V14 counts in S12's
  cost; its own in-work V14 reservation shows as recoded, not in dispute.
- AC-SC-21 Only the Factory endpoint has `factory_release_recode` (boundaries test: no Producer, worker or Web route).

## 11. Non-goals

- No YouTube write of any kind (title, description, metadata untouched).
- No recode outside the 22 listed WWE Shorts by policy; the tool itself refuses long videos and other channels.
- No arbitrary per-channel prefixes. Recommended: only `V` and `S`. A general prefix list would need a per-channel setting, a
  prefix in every report and folder rule and its own "next" rule per prefix -- not the same cost, and nobody asked for it. The shared
  module keeps the series list in one place if a third ever comes.
- No change to how V numbers are given; no renumbering of the long videos V4, V11, V18, V19.
- No change to the Automerge family formats.

## 12. Open questions

1. Which computer holds the upload rows (and reservations) of V1–V3, V5, V14, V17 -- the Mac? The recode runs there
   (`release_recode_elsewhere` otherwise).
2. Should `agent_video_create` (channel worker agents) also take a given S, or only the Factory? The plan gives both (one core).
3. The Operator updates `video_registry.csv` (V→S) after the recode? YTM only reads it; the alias hides stale rows.
4. Confirm: after the recode the next long WWE video is V27 (V1–V26 stay burnt; "a number is never given twice").
5. The thumbnails of the WWE packages: are any named after the code (`V14_thumb.jpg`)? They are renamed and the manifest follows;
   say if a different rule is wanted.
