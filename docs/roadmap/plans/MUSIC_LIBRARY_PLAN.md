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

## 3. Part B — batch review (after the mockup and the Operator's answers Q9–Q13)

- The factory writes `Sent to YTM/music-review/<batch>/review.json` (tracks, check results, the form). The Manager shows each
  track with a player (listening hint), the check results and the form; the owner answers per track (`keep`/`reject`, free
  text).
- Answers are saved only as `{track, fieldId → value, verdict, text, reviewer, device, at}`. An unknown field id, a value of the
  wrong type or out of range, and any scope/rule field are refused (strict schema). There is no UI path to choose a scope or
  edit a rule, profile or batch genre.
- Answers sync between computers (sync-gateway family); the newer answer for a track wins. The Mac writes
  `From YTM/music-review/<batch>/answers.json` after each change.
- MCP: `factory_music_review_list`, `factory_music_review_get(batch)`; a batch is complete when every track has a verdict.

## 4. Acceptance (Part A), worked out by hand

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

## 5. Stages (one branch, one merge)

1. Part A.
2. Part B (form, answers, sync, MCP, answers.json) after the mockup is approved.

## 6. Risks

- The snapshot format is the factory's contract (Q7); until it lands the card shows «нет сводки».
- The Windows computer may not have the channel workspace (Q13): Part B's player would then not work there.
