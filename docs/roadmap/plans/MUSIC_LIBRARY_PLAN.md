# Music: library per genre and the owner's batch review (BL-229)

Status: **assigned** (owner, Telegram msg 3598, 2026-10-27: «Делай обе задачи, System и по музыке. Каждую в своей ветке»).
Request: FO-REQ-0043 (Operator; source PRD-REQ-0037 + Addendum 1). Reply: DEV-RESP-0043 Part 2 (questions Q7–Q13). ADR 0054.
Part D (playlists per genre in a package) belongs to FO-REQ-0041, not here.

## 1. Why

The factory now sorts the music library into genre profiles, each with its own playlist and generation brief. The owner wants
to see the library per genre and to review a new batch with a fixed form whose answers the factory turns into better briefs.
The factory owns every rule, profile, scope and file move; the Manager shows the library, shows the form, and saves the owner's
answers.

## 2. Part A — library per genre (read-only)

- **Source:** one factory-written snapshot per channel, `<workspace>/99 Data Exchange/Sent to YTM/music/library.json` (the
  output of the factory's music summary; format answered in Q7). The Manager reads only this file: never the factory's
  profiles, CSVs, ledger or durations, and never runs a factory script.
- **Module** `src/lib/music-library/` (feature module, AGENTS.md §M): a strict reader of the snapshot (zod; unknown top-level
  fields ignored, a malformed file is shown as "unreadable: <reason>", never half-shown), resolved through
  `workspace-exchange.resolveWorkspaceFile` inside the channel's own workspace.
- **Route** `GET /api/channels/[channelId]/music-library` (session required; the channel is the route's own; the workspace is
  that channel's on this computer).
- **UI:** Media → «Музыка», a «Библиотека по жанрам» card above the plans: one row per genre (label/colour, title, playlist,
  status `active`/`stub`, batches, tracks, hours, never-used hours, days of videos left when given), a highlighted «без жанра»
  row when the snapshot has tracks without a genre, and per genre its batches (number, playlist, `brief_version`, tracks,
  date, source, accepted/reviewed). The snapshot's age is shown; older than 24 h is marked stale. No workspace / no file /
  unreadable file each have their own empty state.

## 3. Part B — batch review inside the plan review (changed 2026-10-27)

DEV-MSG-0009 / FO-RESP-0044 and the owner (msgs 3610–3614) replaced `review.json` / `answers.json`: a batch is a normal
generation plan (`music-014`, one wave per batch) and is reviewed on the existing plan review screen. No new screen, no new
files. `listen` is dropped. The rating stays 1–10.

- **Plan definition (all optional, existing plans unchanged).**
  - plan `reviewForm: { fields[] }` = the general questions; plan `reviewReasons` = the general problem chips (exists);
  - wave `genre: { id, title, color #rrggbb, icon }` (icon: one emoji, at most 2 graphemes and 16 characters);
  - wave `reviewForm: { fields[] }` = the genre's questions; wave `reviewReasons` = the genre's chips (exists).
  - A field is `{ id, type: yes_no | scale_1_10 | choice, question, options? (choice only, 2–10 distinct), required? }`, at
    most 20 per form. Inside `genre`, `reviewForm` and a field, unknown keys (the Operator's `rule`, `fails_when`,
    `fails_below`) are stripped, not refused; a wave's own top-level keys stay strict.
  - Field ids are unique across the plan's form plus each wave's form (two waves may reuse an id).
  - Accepted by `factory_plan_create`, `factory_plan_import`, `factory_plan_update` (`reviewForm`, null clears; `upsertGroups`
    with `genre` / `reviewForm`, absent keeps, null clears). Chips (`reviewReasons`) can be changed at any time, mid-review
    included. `factory_plan_clone_group` copies the wave's `genre`, `reviewForm` and `reviewReasons` to the new wave (a re-run of
  a batch keeps its genre review).
- **Verdict.** An optional `answers: { <fieldId>: true | false | 1..10 | "<option>" }` next to `rating`, `reasons`, `note`,
  checked against the attempt's effective forms (the plan's plus its wave's). Refused with its own code: unknown field id,
  wrong type, out of range, unknown option, a missing required field (for accept AND reject). No scope or rule field exists.
  Stored with the verdict and in the verdict history (schema migration), shown to the factory in the `owner_verdict` event
  (`factory_plan_get`), and carried with verdicts given on the other computer (plans report version 6, written only while the report
  carries a form, a genre or answers -- otherwise version 5 as before, so an old build keeps reading it until the first such
  plan). Re-check answers take no `answers`; the attempt's current verdict keeps the answers it had (its history row of the answer
  has none). An already-rated attempt opens with its saved answers in the form (FO-REQ-0043 §B
  item 4); changing the verdict sends them as edited.
- **Screen.** A wave with a `genre` shows a header (icon + title); its colour tints the frame, the primary verdict buttons and
  the progress bar. Chips: for a genre wave two labelled rows, general (the plan's chips, else the media kind's defaults) then
  the genre's; any other wave keeps today's rule (its own list replaces the plan's). Questions sit under the verdict buttons,
  general first: yes/no = two buttons, scale = 10 buttons, choice = one button per option; a required one is marked and the
  verdict buttons stay disabled, with a hint, until it is answered. The plans list shows the genre badge of plans whose waves
  have one. Complete = the wave's `group_reviewed`, as today.

## 4. Acceptance, worked out by hand

### 4.1 Part A

- AC-ML-01 A snapshot with genre `rural-japan-control` (13 batches × 30 tracks, 390 tracks, 70 200 s, never used 36 000 s,
  daysLeft 41) shows one row «Sounds of Rural Japan»: 13 batches, 390 tracks, 19.5 h, 10.0 h never used, 41 days left.
- AC-ML-02 A stub genre with one batch shows its own label and the status «заготовка».
- AC-ML-03 A snapshot with 2 tracks without a genre shows a highlighted «Без жанра: 2 трека» row; with 0 the row is absent.
- AC-ML-04 A batch with 30 reviewed and 24 accepted shows 24/30 (80 %); a batch with 0 reviewed shows «—», never 0 %.
- AC-ML-05 `generatedAt` 25 h ago shows the stale mark; 23 h ago does not.
- AC-ML-06 No workspace set → «Папка канала не задана на этом компьютере»; no file → «Фабрика ещё не прислала сводку»; a file
  that is not JSON or misses `genres` → «Сводку не прочитать: …», and no rows.
- AC-ML-07 The route for channel A never reads channel B's workspace (a channel id in the path picks the workspace; nothing
  else).
- AC-ML-08 A `library.json` that is a symlink to a file outside the workspace is refused.


### 4.2 Part B

Forms used below: plan `reviewReasons` [голос / вокал, щелчок / провал], plan `reviewForm` = g.no_vocals (yes_no, required),
g.background (scale_1_10); wave `014` with `genre` {rural-japan-control, Sounds of Rural Japan, #4f9d69, 🌾}, `reviewReasons`
[барабаны / бит], `reviewForm` = rj.instruments (yes_no, required), rj.tempo (choice: slower, right, faster); wave `015` without
genre or form.

- AC-MR-01 A field sent with `rule`, `fails_when` and `fails_below` is stored as exactly `{id, type, question, required}`; a genre
  with an extra `profileVersion` is stored without it; a wave with an unknown top-level key is refused (`validation_failed`).
- AC-MR-02 Refused at create: choice without options, with 1, with 11, or with a repeated option; options on a yes_no; colour
  `green`; icon `ab`, `🌾🌾🌾` (3 graphemes) or 17 characters. Accepted: icon `🌧️`.
- AC-MR-03 g.no_vocals in both the plan's and wave 014's form → `plan_invalid`; the same id twice in one form → refused; rj.tempo
  in the forms of two different waves → accepted.
- AC-MR-04 `factory_plan_update` with `reviewForm: null` clears the plan form; `upsertGroups` [{groupId 014, title}] keeps the
  genre and form; with `genre: null` clears the genre. Changing plan and wave `reviewReasons` mid-review shows the new chips on
  the next review read.
- AC-MR-05 On an attempt of wave 014: accepted with {g.no_vocals: true, rj.instruments: false, g.background: 7, rj.tempo:
  "right"} is stored as given. Refused: {…, x: 1} `plan_answer_unknown_field`; g.background "7" or rj.instruments 1
  `plan_answer_wrong_type`; g.background 0, 11 or 7.5 `plan_answer_out_of_range`; rj.tempo "fast" `plan_answer_unknown_option`;
  rejected without rj.instruments `plan_answer_required`. On wave 015: rj.tempo is an unknown field; g.no_vocals is still
  required. A plan without forms takes a verdict without answers exactly as before.
- AC-MR-06 The stored verdict, its history row and its `owner_verdict` event carry `answers`; a verdict without answers carries
  none (no empty object).
- AC-MR-07 A verdict with answers on the other computer's plan is checked against that computer's report (same codes), sent in
  report version 6, and applied there with its answers in the verdict, the history and the event. A field the factory removed
  before it was applied is dropped; the verdict is kept.
- AC-MR-08 This build reads report versions 1–6; it writes 6 only when the report carries a form, a genre or an answer, and 5
  otherwise (no version 6 key anywhere, parsed by the version 5 schema). One stored answer makes it 6.
- AC-MR-11 A rated attempt with answers {g.no_vocals: true, rj.instruments: false, rj.tempo: "right"} opens with exactly those
  answers chosen (a copy); the rating and chips start empty as before; changing rj.tempo to "faster" and replacing the verdict
  sends {g.no_vocals: true, rj.instruments: false, rj.tempo: "faster"}.
- AC-MR-09 Chips on wave 014: general row [голос / вокал, щелчок / провал], genre row [барабаны / бит]; on wave 015 one row
  [голос / вокал, щелчок / провал], the same result as before BL-229.
- AC-MR-10 On wave 014 the header reads «🌾 Sounds of Rural Japan»; Accept and Reject are disabled with the hint until
  g.no_vocals and rj.instruments are answered; the scale shows 10 buttons 1–10. The plans list shows the badge «🌾 Sounds of
  Rural Japan» on the plan.

## 5. Stages (one branch, one merge)

1. Part A.
2. Part B (forms in the plan, answers with the verdict, report v6, the genre on the review screen).

## 6. Risks

- The snapshot format is the factory's contract (Q7); until it lands the card shows «нет сводки».
- Report version 6: written only once a plan has a form or genre (or a verdict has answers); until then the report stays version
  5 and an old build keeps reading it. From the first such plan a computer still on version 5 refuses it, so both computers must
  run this build before the Operator creates one (FO-RESP-0044).
