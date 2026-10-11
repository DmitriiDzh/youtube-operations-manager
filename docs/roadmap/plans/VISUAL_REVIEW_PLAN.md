# Review of generated images and video, phase 1 (BL-175, FO-REQ-0018 §A–§D)

Status: IN PROGRESS (branch `feature/visual-review`). Owner's go: Telegram 2026-10-11 msg 2538 («Ок» to "Берём фазу 1 в работу
(BL-175)?"). Reply to the Operator: DEV-RESP-0021. Phase 2 (§E–§F) and phase 3 (§G) are not part of this plan.

## 1. Facts (code read 2026-10-11, `dev` 9a7720a; the Mac's database read-only)

- The audition, reference and re-check routes already serve png/jpg/jpeg/webp/mp4/webm (`AUDITION_CONTENT_TYPES`); the screen
  feeds every file to `MediaReviewPlayer` (wavesurfer, audio only).
- "Waiting" is `verdict === null` in about twenty places (progress, services, the review screen, `plan-card-model.ts`).
- `items[].accepted` counts only in-app attempts (`inAppAttempts`): an attempt reported only by an external stage can wait and
  be rejected, but never counts as accepted (DEV-RESP-0020 §2).
- Markers are `{ start, end?, note }`, strict in `schemas.ts` and at every level of the plans report (v4). About ten places
  rebuild a marker as `{ start, end ?? null, note ?? null }`.
- The reasons are a constant of the screen (10 music chips, English values shown translated).
- Live data: the Mac has two plans (`R-0001-S1-music`, `R-0001-S1-tropico`); every attempt of both is an app job (`job:` refs),
  so counting external attempts and picks changes none of their numbers. No visual plan exists yet.
- The audit of the live screen (2026-10-11): three columns (player and verdict ~540 px wide at 1440 px, auto-check, queue). Too
  narrow for a picture: the grid, the loupe and compare need the whole window.

## 2. Design

### 2.1 Media kind of an entry

`media: "audio" | "image" | "video" | null` on every review entry, from the file it plays (an accepted revision's, else the
latest reported `auditionFile`, else the job output), by extension (`AUDITION_CONTENT_TYPES`). The other computer derives it the
same way from the entry it already receives (`currentFile`, stage `auditionFile`, `jobOutput`): no new report field.

### 2.2 Picks and «ни один не подходит» (schema v84, device-local, on the plan's owning computer)

- **Pick target of an item:** `pickTarget` when the item sets it (new optional item field, 1..targetCount), else
  `targetCount` for `until_accepted`, else 1 (`fixed`: its `targetCount` is how many attempts to generate).
- **Table `generation_plan_picks`:** one row per (plan, item, kind, attempt): `kind` `pick` (attempt) or `none_fits` (item,
  attempt `''`), `active`, `note`, `device`, `at` (ISO, milliseconds), `covered` (none-fits: the attempt refs it covers).
  Withdrawing sets `active = 0` and keeps the row and its time, so "newer wins" also holds against a withdrawal.
- **Actions** (owner, Web UI; `POST …/pick` `{ itemKey, attemptRef?, action: pick | unpick | none_fits | clear_none_fits,
  note? }`), under the plan's lock:
  - **pick:** the attempt must be in the review queue and not rejected by its current owner verdict (refused
    `plan_mismatch`, `details.reason: "rejected"`). A pick clears an active none-fits. When the item already has `pickTarget`
    active picks, the oldest one is withdrawn (with a target of 1: the pick moves).
  - **unpick:** withdraws an active pick.
  - **none_fits** (note required, ≤ 2000): withdraws the item's active picks; covers the attempts the queue lists for the item
    at that moment.
  - **clear_none_fits.**
- **Reject vs pick:** an owner verdict `rejected` on a picked attempt withdraws its pick in the same lock (the screen asks
  first with `ConfirmDialog`) -- also a rejection that arrives later from the other computer or answers a re-check (the
  rejection is the explicit word). A pick on a rejected attempt (a stored verdict, or one on its way from the other computer) is
  refused; the screen disables «Выбрать» there.
- **Not a verdict:** a pick writes no result row and no verdict history; `plan_verdict_exists` / `replace` are untouched.
- **Events (recorded):** `owner_pick { itemKey, attemptRef, device, note?, overridesValidator? }`,
  `owner_unpick { itemKey, attemptRef, device, reason: withdrawn | moved | rejected | none_fits }`,
  `owner_none_fits { itemKey, note, device, attempts }`, `owner_none_fits { itemKey, device, cleared: true }`.
  `overridesValidator: true` when the stage before the review rejected the attempt.

### 2.3 Counting (progress, todo, queue, badge)

- **Decided item:** an active none-fits, or as many active picks as its pick target.
- **Entry flags:** `picked` (an active pick), `notChosen` (no verdict, not picked, and its item is decided by picks — or covered
  by the item's active none-fits).
- **Waiting** = no verdict, not picked, not `notChosen`. One predicate (`entryWaits`) everywhere "waiting" is read today.
- **External attempts** (refs that only external stages report) join the item's counts: `attempts`, `accepted` (final stage
  accepted/done, or picked), `missing` (`fixed`: usable unless a row says `failed`; `until_accepted`: accepted + pending), and
  `pending`.
- **Fates:** picked → accepted; `notChosen` → neither accepted, pending nor rejected; otherwise as today.
- **Item progress gains** `pickTarget`, `picks: [{ attemptRef, device, at, note }]`, `noneFits: { note, device, at } | null`,
  `notChosen`. **Waves gain** `counts.picked` and `counts.noneFits`.
- **The owner-review stage's `accepted` count** adds picked attempts that have no accepted row (so `stage_complete` can fire).
- **`group_reviewed`:** recorded as today when an owner action takes a wave's waiting count to zero (verdicts, picks,
  none-fits, from either computer); details gain `picked` and `noneFits`.
- **Report cut:** picked and `notChosen` entries rank with the reviewed ones (cut first above 500 entries).

### 2.4 Marker region (pins)

- `region?: { x, y, r }`, each 0..1 (`x` of the width, `y` of the height, `r` of the shorter side) on every marker: verdicts,
  `factory_plan_report` rows, re-check markers and answers, the report's rows, verdicts and re-checks.
- A marker without a region is stored and sent exactly as today (the field is omitted, never `null`).
- Image: `{ start: 0, end: null, note, region }`. Video: a range with an optional region (a pin on the frame at `start`).

### 2.5 Reason chips

- `reviewReasons?: string[]` (≤ 20, each ≤ 60) on the plan and on a group (create, update / `upsertGroups`, import); the wave's
  list wins over the plan's. Its chips record the text as given.
- Defaults by media kind (image, video), English values shown translated (DEV-RESP-0021 §2.4 table); audio keeps the ten music
  chips. The verdict records the English value, as for music.

### 2.6 Two computers (plans report version 5)

- **Report v5 adds:** marker `region` (rows, verdicts, re-checks); `reviewReasons` (plan, groups); `pickTarget` per item;
  `picks` / `noneFits` per plan (active ones); `notChosen` per entry; top-level `picks` (pick actions this computer sent to other
  computers' plans, 30 days, ≤ 1000). Reads 1–5. A version 4 build refuses version 5: both computers update together.
- **Peer actions:** `POST /api/generation-plans/peers/<device>/<plan>/pick` stores the action here (`generation_plan_peer_picks`,
  schema v84) for a plan and attempt in that device's latest report; refused `peer_update_required` while that report is below
  version 5.
- **Apply on the owning computer** (`applyPeerPicks`, on the tick after `applyPeerVerdicts`, under the plan's lock), in time
  order: an action older than the state it would change (the row's `at`) is recorded superseded; a pick on an attempt rejected by
  a newer verdict is superseded; an applied or superseded action's id goes into a `peer_pick` event, so it is weighed once. A pick on
  an attempt whose current verdict is rejected is superseded; an applied peer verdict `rejected` withdraws an active pick
  (`reason: rejected`).
- **Pending overlays:** on the owning computer, actions not applied yet count as done in the queue, progress and badge (as
  pending peer verdicts do); on the sending computer, its own actions newer than the plan's state overlay the report
  ("sent, waiting for <device>").

### 2.7 Routes and files

- `POST /api/generation-plans/<plan>/pick` and the peer variant (session, active-channel check, `planErrorResponse`).
- `GET /api/generation-plans/<plan>/preview?itemKey=&attemptRef=` and the peer variant: a JPEG preview (longest side 480 px) of
  an image attempt, resolved exactly like its audition (plans core, workspace proof, loopback only); 415 for anything that is not
  an image. Made with `sharp` (now a direct dependency; Next.js already installs it), cached in memory (≤ 300 previews, keyed by
  path, size and mtime). Any `sharp` failure streams the original image instead.

### 2.8 Factory API 1.13.0

- `factory_plan_create` / `factory_plan_update` / `factory_plan_import`: `reviewReasons` (plan, groups), `pickTarget` (items).
- `factory_plan_report` and `factory_plan_request_recheck`: marker `region`.
- `factory_plan_get`: item `pickTarget`, `picks`, `noneFits`, `notChosen`; group `counts.picked` / `counts.noneFits`; the
  pick events; `group_reviewed` details. `factory_plan_todo`: `waitingReview` without picked / not-chosen attempts.

### 2.9 Screen (Media → Review)

- **Single view** (the three columns), when the entry is an image or a video:
  - **Image viewer:** fit, 100 % on `Z`, drag to pan, wheel zoom, readout, pixel size and bytes; pins as numbered circles.
  - **Video player:** looped and muted by default, `Space`, speed 0.25 / 0.5 / 1 / 2, `,` / `.` one frame (fps from
    `metrics.fps`, else measured while playing, else 1/30 s), `←` / `→` ±1 s, a timeline with hover-scrub, time and frame
    number, drag a range to loop it, markers on the timeline, a check's `atSeconds` jumps there.
  - **No** loudness line, spectrogram or A/B for pictures.
  - **The item's attempts** as a strip of previews under the viewer (picked ★, verdict, not chosen dimmed); a click opens one.
- **Grid** (`G`, full window): the item's attempts or the whole wave grouped by item; video previews play muted on hover;
  select two (click + `Shift`/`Ctrl`) for compare; `Enter` or double-click opens the loupe; «Выбрать» on each card.
- **Loupe** (`Enter`, full window): one attempt, image or video, at full size, with pins; `Esc` back.
- **Compare** (`C`, full window): two attempts side by side, linked zoom and pan (images) or linked play and seek (videos).
- **Decisions:** «Выбрать» (`S`) and «Снять выбор»; «Ни один не подходит» on the item (in-app dialog with a required note and
  an optional "↻ Ask to generate again"); Accept / Reject as today; Reject on a picked attempt asks first.
- **Pins:** `Shift`+click on the picture (or the paused frame) adds a pin; the radius is set by dragging before release (or the
  wheel while the note box is open); every new marker on an image or a video opens a small note box (≤ 200).
- **Chips:** the wave's / plan's list, else the media kind's defaults.
- **The keyboard** belongs to an open layer (grid, loupe, compare, note box): the screen's A/R/digits never fire under it.

## 3. Acceptance criteria (fixed before the code; numbers worked out by hand)

- **AC-VR-01 Media kind.** `.png` → image, `.mp4` → video, `.mp3` → audio, `.txt` → null; an accepted revision's file wins over
  the reported one, the reported one over the job output.
- **AC-VR-02 Pick target.** `fixed` targetCount 8 → 1; `until_accepted` targetCount 2 → 2; `pickTarget: 3` → 3; `pickTarget`
  above `targetCount` or below 1 is refused (`plan_invalid`).
- **AC-VR-03 Fixed item, external attempts.** Plan [external `render`, owner_review]; item I (`fixed`, targetCount 1), 8
  external attempts reported done with png files. Before: `attempts 8, accepted 0, waitingReview 8, missing 0`. One pick on
  `a3`: `accepted 1, notChosen 7, rejected 0, waitingReview 0, missing 0, picks [a3]`; todo `waitingReview` empty; the wave's
  `group_reviewed { accepted 0, rejected 0, overridesValidator 0, picked 1, noneFits 0 }` once; `owner_pick` recorded.
- **AC-VR-04 Not decided yet.** `until_accepted` targetCount 2, 8 attempts, one pick: `accepted 1`, 7 still waiting,
  `notChosen 0`, `missing 0` (1 accepted + 7 pending).
- **AC-VR-05 Pick moves, reject and pick.** Target 1: pick a3 then a5 → a5 picked, `owner_unpick { a3, reason: moved }`. Reject
  a5 → its pick withdrawn (`reason: rejected`), the other 7 wait again. Pick on a5 now → `plan_mismatch` `rejected`.
- **AC-VR-06 None fits.** On I: `owner_none_fits { attempts: 8 }`, `waitingReview 0`, `notChosen 8`, `accepted 0`; a 9th attempt
  reported after it waits; a pick clears the none-fits.
- **AC-VR-07 Music unchanged.** A fixture shaped like `R-0001-S1-music` (only `job:` attempts, no picks): every progress number,
  todo list and queue order equals the values computed by the rules before this change (fixed expected values); the only
  additions are the new fields at their empty values (`pickTarget`, `picks: []`, `noneFits: null`, `notChosen 0`, wave
  `picked 0` / `noneFits 0`, `group_reviewed` details `picked 0` / `noneFits 0`, entry `media`).
- **AC-VR-08 Region round trip.** A verdict with `region { x 0.25, y 0.5, r 0.1 }` and a note: stored, in the history, in
  `owner_verdict`, in the review route, in a re-check's `previousVerdict`; through the other computer (peer verdict → report →
  apply → history) unchanged. A marker without a region has no `region` key anywhere. Out of range (`x 1.2`) is refused.
- **AC-VR-09 Reason lists.** `reviewReasons` on the plan and on a wave are stored and returned; the wave's wins; 21 entries or a
  61-character one is refused.
- **AC-VR-10 Report v5.** A v5 report with every new field parses; v4 still parses; v6 is refused. The shared entry carries
  `notChosen`; the plan carries its active `picks` / `noneFits`.
- **AC-VR-11 Peer picks.** On the other computer: a pick action is stored and carried; refused for a plan whose report is v4
  (`peer_update_required`), for an attempt not in that report, and for a closed plan. On the owner: applied once (second tick
  changes nothing), an older action than the state is superseded (`peer_pick { superseded: true }`), a pick on an attempt a newer
  verdict rejected is superseded; before it is applied, the queue and progress count it.
- **AC-VR-12 Preview route.** Loopback only (403 otherwise); an image attempt gets `image/jpeg` no wider or taller than 480 px;
  a video or audio attempt gets 415; a path never comes from the request; a broken `sharp` streams the original.
- **AC-VR-13 MCP 1.13.0.** Version, the new input fields accepted by the plan tools (strict), descriptions name the pick events.
- **AC-VR-14 Screen helpers** (pure, tested): media kind, chip list per entry, `entryWaits`, the grid's grouping by item, the
  pin geometry (normalized ↔ pixels for fit and 100 %), fps from metrics, frame number, the keyboard map with the new keys, the
  peer overlay of sent pick actions.
- **AC-VR-15 Live** (Mac, scratch HOME, synthesized files): an image wave (one item, 6 PNG attempts) and a video wave (16 fps
  MP4 clips, `metrics.fps` 16): grid, loupe at 100 %, compare two with linked zoom, pick one, reject another with «лишний
  предмет» and a pin with a note, `factory_plan_get` shows both; a video plays looped and muted, frame step and 0.5× work, a range
  marker with a note and a pin, a check jumps to its time; music waves show the music chips; the music screen is unchanged.

## 4. Build order (one branch)

1. One waiting predicate, behavior unchanged (all tests green, no expected value changed).
2. Contracts, schemas, schema v84, store; picks, counting and events (own computer) with AC-VR-01..09.
3. Report v5, peer picks, tick, pending overlays (AC-VR-10/11).
4. Routes (pick, preview), Factory API 1.13.0 texts (AC-VR-12/13).
5. Screen (AC-VR-14), locales en/ru.
6. Validation, docs, live check (AC-VR-15), then two review rounds before the merge request.

## 5. Not in this phase

Wipe slider, difference, image/video references in A/B, visual re-check compare, seam view (phase 2); Gemini outputs without
copying, owner time per verdict, phone mode (phase 3); relaying a pick through `factory_plan_report`; N-up survey.
