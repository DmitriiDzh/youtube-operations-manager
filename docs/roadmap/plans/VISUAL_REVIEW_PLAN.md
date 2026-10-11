# Review of generated images and video (BL-175, FO-REQ-0018 §A–§G)

Status: phase 1 BUILT and reviewed (four rounds); phases 2 and 3 in progress on the same branch (`feature/visual-review`), one
merge at the end. Owner's go: phase 1 — Telegram 2026-10-11 msg 2538; phases 2 and 3 — msg 2549 («Давай сделаем все 3 и уже
только потом мерджить будем»). Reply to the Operator: DEV-RESP-0021. Sections 1–6: phase 1; §7: phase 2; §8: phase 3.

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
- **Pins:** `Shift`+click on the picture (or the paused frame) adds a pin; the radius is set by dragging before release; every
  new marker on an image or a video opens a small note box (≤ 200).
- **Chips:** the wave's / plan's list, else the media kind's defaults.
- **The keyboard** belongs to an open layer (grid, loupe, compare, note box): the screen's A/R/digits never fire under it.

## 3. Acceptance criteria (fixed before the code; numbers worked out by hand)

- **AC-VR-01 Media kind.** `.png` → image, `.mp4` → video, `.mp3` → audio, `.txt` → null; an accepted revision's file wins over
  the reported one, the reported one over the job output.
- **AC-VR-02 Pick target.** `fixed` targetCount 8 → 1; `until_accepted` targetCount 2 → 2; `pickTarget: 3` → 3; `pickTarget`
  above `targetCount` is refused (`plan_invalid`), below 1 by the input schema (`validation_failed`).
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

## 5. Changed while building (2026-10-11)

- **Reject vs pick** (§2.2): a rejection always withdraws the pick, also one that arrives later from the other computer or
  answers a re-check; the withdrawal is dated no earlier than the pick. A pick on an attempt whose current verdict is rejected
  (stored, or on its way from the other computer) is refused here and superseded when it comes from there.
- **A pick's note** is the screen's comment field at the moment of the pick (FO-REQ-0018 asks for no separate field). A pick
  stays on the attempt (no auto-advance): the owner may still rate it.
- **The wheel** zooms a picture on the screen itself only with Ctrl / ⌘ (a trackpad pinch), so the column still scrolls; in the
  whole-window layer it always zooms (found in the live check).
- **A picture wave's summary** reads "looked at: picked, accepted, rejected"; music keeps its text.
- **The grid** shows the attempts in a stable order (item, then attempt), not the queue's (which moves settled ones down). A
  click selects an attempt; a double click or Enter opens it at full size; Esc goes back to the grid when the loupe or compare
  was opened from it (from the screen, Esc closes).
- **Media kind** is not a report field (DEV-RESP-0021 §3 Q4 listed it): the reading computer derives it from the file the entry
  names (`sharedEntryMedia`), so the report carries nothing it could disagree with.
- **Own reason lists** (a wave's, else the plan's) apply to any media kind the Operator sets them for; without one, music waves
  keep the ten music chips.
- **Review round 1** (two reviewers, server and screen; all findings fixed):
  - a rejection the factory relays also withdraws the pick;
  - the owner's own pick action is weighed against what the owner sees (picks on their way from the other computer included);
  - only rows of `external` stages make an external attempt (a relayed verdict for an unknown ref does not);
  - a "none fits" sent from the other computer carries the attempts its owner saw (`covered`) and covers only those;
  - the other computer's plan card counts its sent picks like the badge;
  - a question re-check on a picture shows the picture;
  - in video compare the first clip leads and the other follows (no double steps);
  - a mark waiting for its note is sent with it, or the decision waits;
  - a picture's draft is kept per attempt while the owner browses the grid;
  - the "Reject the picked attempt?" → "Replace?" questions no longer loop;
  - the layer and the "none fits" dialog hold the focus; held keys do not repeat a pick;
  - a hover-scrub gives the paused frame back; the frame rate is measured only at 1×.
- **Review round 2** (two reviewers again; all findings fixed):
  - the owner's own pick action first applies the picks still on their way from the other computer (as the tick would), then is
    weighed against the stored picks -- what those moved is stored, never only shown (round 1 had lost it);
  - a "none fits" from the other computer also covers the item's attempts already settled here (its report may have cut them);
  - a report row of the stage right before the review that takes a picked attempt out of the queue withdraws the pick (`left_queue`); only picks on
    attempts in the queue that are counted show and decide an item; a ref only a relayed verdict names cannot be picked;
  - the same "none fits" weighed twice changes nothing;
  - focus holders stack (the "none fits" dialog and a pin's note box over the layer keep Tab); the focus goes back where it was;
  - a picture's draft is kept and brought back on every move (arrows, auto-advance, filters, waves) and dropped when the
    attempt's verdict changed meanwhile; the missing-note check comes before any question;
  - an open re-check never opens the grid, loupe or compare (they would be empty);
  - video compare: play and pause in either clip drive the other, and both clips start together once loaded; the loop range
    stays each clip's own;
  - Esc goes back to the grid also after loupe ↔ compare; the C key and the button follow one rule; N/P in compare skip the
    compared attempt; held Z and held N/P in the layer do not repeat; the wheel does not set a pin's radius (dropped from §2.9).
- **Review round 3** (the round-2 changes only, two reviewers; all findings fixed):
  - the owner's own pick action counts the other computer's rejections still on their way, as the tick does (round 2 had
    weighed its pending picks without them: a pick and a rejection of the same attempt could both be stored);
  - one `left_queue` sweep after every report and every plan change (`reviewRejected` off, a stage removed), so it never
    depends on an unrelated report; a pick that may no longer stand takes no place when another is picked;
  - a "none fits" from the other computer covers settled attempts only if they existed when it was given;
  - a picked attempt that only external stages report stays accepted when a stage after the review fails it, as the app's own;
  - compare: a fresh pair starts together, a clip that joins (N/P) takes the other clip's moment and state, a picture or a clip
    that fails never holds a clip back; Space and the frame keys lead with the clip that exists;
  - focus goes back on close only when it was left in the closing layer or dialog (never away from the pin's note box); a
    verdict or answer that arrives after the owner moved on keeps the owner where they are, with their draft;
  - the layer opens only on a playable picture; its Compare button follows the screen's rule; N/P in compare stay put when the
    only other attempt is the compared one.
- **Review round 4** (the round-3 server changes only, one reviewer; all findings fixed):
  - a "none fits" from the other computer covers settled attempts only if they were in the owner's queue when it was given (a
    job that finished after it, or a row of the stage right before the review reported after it, waits);
  - a `failed` review-stage row the factory relays withdraws the pick like a `rejected` one;
  - a pick never revives an in-app attempt whose job failed (the round-3 reorder was reverted; a picked external attempt stays
    usable through `externalState`);
  - `updatePlan` runs whole under the plan's lock; a pending verdict overlaid on an entry clears its `notChosen`.
- **Live check (AC-VR-15)** ran on an isolated instance of the branch (`next dev` on 127.0.0.1:3100 with a scratch HOME and
  database, a test user and channel, generated PNG stills, 16 fps MP4 loops and an MP3; a session minted with the worktree's
  throwaway secret). Pictures in the owner's Chrome; clips in a separate headless Chrome (the Mac's display was off, and Chrome
  does not load media in a hidden tab). Not checked live: two computers -- that needs the Windows update.

## 6. Not in phase 1

Wipe slider, difference, image/video references in A/B, visual re-check compare, seam view (phase 2); Gemini outputs without
copying, owner time per verdict, phone mode (phase 3); relaying a pick through `factory_plan_report`; N-up survey.

## 7. Phase 2 (FO-REQ-0018 §E–§F)

### 7.1 Facts (code read 2026-10-11, branch at 959b594)

- `references[]` and row `referenceIds` already accept any file path; the reference routes (own and peer) already serve
  png/jpg/webp/mp4/webm (`AUDITION_CONTENT_TYPES`). The screen offers every reference to the music A/B; visual entries get none.
- A revision re-check plays its file from `…/recheck-audition`; the attempt's current file (an earlier accepted revision, else the
  original) plays from `…/audition` — the music A/B already uses it as «Было».
- The layer compares two attempts of the walk (`compareKey`); it is closed for re-checks (review round 2).
- `metrics` takes any key: the Operator can send `metrics.loop: true` and `metrics.fps` today (DEV-RESP-0021 §3 Q5).
- No server, schema, report or Factory API change is needed for phase 2: it is all on the screen.

### 7.2 Design

- **Compare views** (§E): in compare, «Рядом · Шторка · Разница» when both sides are the same kind (two pictures or two clips).
  - *Шторка:* one viewer, the second side drawn in the same frame and the same view (zoom, pan; for clips the same moment), cut
    at a vertical line the owner drags; the left part shows the first side, the right part the second, each labelled.
  - *Разница:* the second side over the first with the `difference` blend: what is the same turns black.
  - The second side is drawn in the first side's rectangle; when their proportions differ by more than 1 % the view says so.
  - Clips: one set of controls (play, timeline, frames, speed, loop range); the second clip follows the first (moment, play,
    pause, speed) and is corrected when it drifts by more than half a frame.
- **What the second side can be:** another attempt (as in phase 1), a plan reference, or — for a revision re-check — «Было».
  - *References* (§E): a picture or a clip of `references[]` (a cast sheet, a style plate, a base frame). For a picture or clip
    on screen the screen offers the plan's picture and clip references (this attempt's `referenceIds` first, marked «близкий»)
    and «Сравнить» opens compare against the chosen one. The music A/B offers only audio references (unchanged for music plans:
    their references are audio).
  - *«Было / Исправлено»* (§E): a revision re-check of a picture or clip gets «Было / Исправлено», which opens compare: the
    attempt's current file («Было», as the music A/B) and the revised file («Исправлено»); Шторка first. Only compare opens on a
    re-check (no grid, no loupe, no picks); moving to another re-check shows its own pair, or closes compare when it is no
    revision of a picture or clip.
  - A reference or «Было» is not an attempt: no pick button, no status; its caption names it.
- **Question re-check** (§E): a question about a clip opens paused at its first marker, so its pin shows (a picture already
  shows its pins).
- **«Как в ленте»** (§E): for a picture, a toggle under the viewer shows it at feed sizes, 16:9 with rounded corners and a
  duration badge, on YouTube's dark (#0f0f0f) and light (#ffffff) backgrounds: 360 px (home, search), 246 px (narrow grid),
  168 px («Далее» column), 120 px (notifications, playlists).
- **Loop clips** (§F): a clip whose rows say `metrics.loop` is true (on any stage row: `true` or `"true"`) gets a «Петля» row:
  - *Стык ±1 с:* the player plays the last second straight into the first, on repeat (the browser's own loop makes the join;
    the player jumps from the end of the first second back to one second before the end). At 1× and 0.5× (the speed buttons).
    The window is min(1 s, a quarter of the clip).
  - *Подряд ×5:* the whole clip five times without a gap, a counter «2 / 5», then it stops.
  - *Кадры стыка:* the last and the first frame side by side, with «Разница» (the same blend). The last frame is at
    duration − 1/fps (the row's fps, else the measured one, else 1/30 s).
  - The Operator's seam and drift numbers stay ordinary `checks` with `atSeconds` (shown as today).

### 7.3 Acceptance criteria (fixed before the code; numbers worked out by hand)

- **AC-V2-01 References by kind.** References `img.png`, `clip.mp4`, `ref.mp3`; an image entry is offered `img.png` and
  `clip.mp4` (its `referenceIds` first, marked nearest); an audio entry is offered only `ref.mp3`; a revision gets none.
- **AC-V2-02 Wipe geometry.** A split of 0.25 cuts the second side at a quarter of the frame (`inset(0 0 0 25%)`); a drag past
  either edge clamps to 0 and 1; a split of 0.5 at a frame 800 px wide puts the line at 400 px.
- **AC-V2-03 Same proportions.** 1600×900 and 1920×1080: same (both 16:9); 1600×900 and 1080×1920: differ; 1000×1000 and
  1005×1000: same (within 1 %).
- **AC-V2-04 «Было / Исправлено».** A revision re-check of a picture: «Было» is `…/audition?itemKey=&attemptRef=`, «Исправлено»
  is `…/recheck-audition?recheckId=`; a question re-check and a music revision get no pair.
- **AC-V2-05 Question opens at its marker.** A question with markers at 2.5 s and 1.0 s opens the clip at 1.0 s, paused; with no
  marker at 0 s, playing (as any clip).
- **AC-V2-06 Feed sizes.** 360×202.5→202, 246×138, 168×94.5→94, 120×67.5→67 (16:9, rounded down), in that order.
- **AC-V2-07 Loop flag.** `metrics.loop` `true` or `"true"` on any stage row → loop; `false`, `"yes"`, absent → not.
- **AC-V2-08 Seam window.** A 4 s clip: window 1 s; at 0.5 s and 3.5 s nothing; at 1.2 s jump to 3.0 s. A 2 s clip: window 0.5 s,
  at 0.7 s jump to 1.5 s. A 0 s clip: no window.
- **AC-V2-09 Five times.** Times 0.1, 3.9, 0.1 (a wrap), 3.8, 0.2 (a wrap) count 2 passes started after the first; the fifth
  wrap stops; a seek back by the owner (3.0 → 1.0) is no wrap (a wrap needs a fall of more than half the clip).
- **AC-V2-10 Last frame.** 4 s at 16 fps → 3.9375 s; at no fps → 4 − 1/30 = 3.9667 s; never below 0.
- **AC-V2-11 Music unchanged.** The music screen, its A/B and keys behave as before (existing tests stay green).
- **AC-V2-12 Live check** on the isolated instance: wipe and difference for two stills and two clips, a reference compare, a
  revision «Было / Исправлено», «Как в ленте», the three loop tools.
