# Languages: translation review by video, checks and agent reports (BL-227)

Status: **Stage 1 assigned** (owner, Telegram msg 3581, 2026-10-26: «Да» to the mockup and stage 1, after msgs 3567/3575/3578).
Stage 2 (translation request queue) and stage 3 (section layout) follow on the same branch, merged once. Stage 4 (auto-approve) is
**not assigned** — asked twice (msgs 3575, 3578), no answer. ADR 0052. Operator input: DEV-MSG-0006 → FO-MSG-0025 (with §2a).

## 1. Why

- The owner reviews translations change set by change set. A set shows «Создано ИИ · 14 изменений» and, inside, a video id and
  14 separate cards (title and description of each language apart). Which video a set is for, and whether a translation is any
  good, is not visible (msg 3567).
- The owner wants a check report on every translation before reviewing, like the music validator (FO-MSG-0025 §2a). The worker
  produces it (a script and an independent AI review on its side). The app shows it next to the app's own checks and keeps the
  owner's decision next to the verdict.
- Today's BL-226 failure showed a limit the app counted wrong. The description limit is 5000 **bytes** (YouTube Data API
  `videos` resource: "maximum length of 5000 bytes"), but both creation paths count UTF-16 code units
  (`ai-localization/services.ts` `classifyAndValidateField`, `changesets/import.ts`). A ja/ko/zh description passes locally and
  YouTube refuses it.

## 2. Stage 1 scope

1. **Review by video** (the mockup approved in msg 3581):
   - a queue of videos with sets waiting for review (thumbnail, Vn when known, title, release date, verdict counts);
   - one video at a time: the original on top (description folded), one row per language with title and description together,
     the checks under the row, the agent's note, the back-translation folded;
   - filter «Только ! и ✗»; «Одобрить все зелёные»; per row «Одобрить» / «Отклонить»;
   - «Отправить одобренное этого видео».
   Sets from several change sets for one video merge into one view (V59 had two today).
2. **The app's own checks**: one shared module (§4) for both creation paths, the review screen and the send.
3. **Agent check reports**: `factory_localization_report_checks` and the worker's `agent_localization_report_checks`.
4. **The agent's note per change** and **who made the set**: an optional `note` on each proposal of
   `ai_localization_create_change_set`; the author is server-stamped.
5. **"The original changed after this set was made"**: a hash of each video's original title + description is stored when the
   set is created, and compared with the synced copy on read.
6. **The owner's decision next to the verdict**: every approve/reject records which report and verdict were current.

Not in stage 1:
- «Запросить переделку» (stage 2, it needs the request queue). A row with an error offers «Отклонить» only.
- The section's new layout and the «что ждёт вас» strip (stage 3). Stage 1 replaces the review panel and the set list in place.
- Auto-approve (stage 4, not assigned).
- Channel-template checks (block order, title pattern, brand phrase, the `| N Hours` suffix, emoji). These are channel rules and
  live on the worker's side (AGENTS.md §B). The app shows them only as part of the worker's report.

## 3. Data (ADR 0052)

Change sets are kept in the `change-drafts` Automerge document per channel, synced between computers
(`src/lib/sync-gateway/change-drafts/`). Everything new that the second computer must also see goes into the same document. All
new keys are optional: documents saved before them lack the keys, and every reader defaults them.

- `provenance[*]` (write-once per set) gains three fields:
  - `notesJson`: changeId → the agent's note;
  - `originalsJson`: videoId → sha256 of the original title + "\n" + description at creation;
  - `createdBy`: `owner` | `factory` | `worker` | `agent`, server-stamped from the caller.
- `checkReports?: Record<reportId, DraftCheckReport>`, append-only:
  `{ id, changeSetId, reportedAt, reportedBy, entriesJson }`. `entriesJson` holds
  `[{ language, field, verdict, checks: [{ id, result, detail }], note, backTranslation }]`.
  The latest report of a set (by `reportedAt`, then `id`) is the current one. Older ones stay as history. No report means "not
  checked yet": that is the absence of a report, not a stored status.
- `decisions?: Record<id, DraftDecision>`, append-only: `{ id, changeId, changeSetId, action: approve|reject, reportId|null,
  verdict|null, decidedAt }`. `approveChange`/`rejectChange` (and their bulk forms) write it in the same Automerge change as the
  approval status. Nothing reads it for any decision; it is the record for "how often does the owner agree with the validator".

No SQLite table or column. The SQL projection mirrors `change_sets`/`changes` only. The new maps are read from the document
through the change-drafts service. The schema version stays.

## 4. Checks (one owner: `src/lib/shared-localization-checks/`)

A pure module. Input: language, field, proposed text, the original's text for the same field, the video's own language, the
channel's tracked languages. Output: `[{ id, result: pass|warn|fail, detail }]`. Limits come from `src/lib/youtube-video-fields/`.

| id | rule | result when broken |
|---|---|---|
| `title_length` | title 1–100 characters (code points, after trim) | fail |
| `description_bytes` | description ≤ 5000 UTF-8 bytes | fail |
| `angle_brackets` | no `<` or `>` | fail |
| `own_language` | not the video's own language (an XLSX row there legitimately edits the original, PROJECT_SPEC §16) | warn |
| `script` | ja: has kana/kanji; ko: has hangul; zh-*: has CJK ideographs; and Latin letters are not the majority | fail |
| `tracked_language` | one of the channel's tracked languages | warn |
| `identical_to_original` | differs from the original (trimmed) | warn |
| `timestamps` | the original's `m:ss` / `h:mm:ss` timestamps, same count and order | warn |
| `hashtags` | the same number of `#tags` as the original | warn |
| `links` | no `http(s)://` or `www.` link | warn |
| `characters` | no U+FFFD, mojibake pairs (`Ã`, `â€`), zero-width or control characters (except newline/tab) | warn |

Across fields of one language, BL-226's `untitledTranslations` stays where it is (`shared-localization-merge`) and is shown as a
fail on the description row.

- **At creation** (`ai-localization` and XLSX import): every `fail` result sets `validationStatus: "invalid"`, with the fails'
  details as `validationError`. This replaces the two inline length rules, so there is one owner. An invalid change is already
  unapprovable and never sent.
- **On read**: all results (pass, warn and fail) are computed again for the review screen. A set made before this change shows
  its fails as warnings; it is not revalidated in storage.

## 5. MCP

- `factory_localization_report_checks` (Factory API 1.34.0, WRITE, local only). Input:
  `{ channelId, changeSetId, entries: [{ language, field, verdict: pass|warn|fail, checks: [{ id, result, detail }], note?,
  backTranslation? }] }`.
  - The set must belong to the channel, and each entry must name a (language, field) the set has.
  - Up to 200 entries, a detail ≤ 500 characters, a note ≤ 1000, a back-translation ≤ 6000.
  - It can be called again: each call adds a report and the newest is current.
  - It returns `{ reportId, reportedAt, replaced: <previous id | null> }`.
- `agent_localization_report_checks`: the same tool for the channel's worker, own channel only (`WORKER_FACTORY_TOOLS`,
  BL-217), Agent API 4.8.0.
- `ai_localization_create_change_set` gains an optional `note` (≤ 1000 characters) on each proposal. This is additive: the
  existing flow is unchanged.
- `changeset_get` (Web and MCP) gains `review`: the current report, the author, notes, original-changed flags and the
  read-time checks. This is additive.

## 6. Web

- `GET /api/channels/[channelId]/localization-review`: the queue. It lists the videos that have changes not yet written in
  sets that are `in_review` / `partially_approved` / `approved`, with per-video verdict counts.
- `GET /api/channels/[channelId]/localization-review/[videoId]`: one video. It returns the original, and per language the rows
  with the changes of every set (the ids the existing approve/reject routes take), checks, report, note, author, the
  original-changed flag and the weekly-plan slot.
- «Отправить одобренное этого видео»: the existing send-together route with an additive `videoIds` filter. It goes through the
  same service, the same checks (BL-226) and the same batch. There is no parallel send path.
- Approve and reject use the existing per-change routes. A language row's buttons call them for its changes.

## 7. Acceptance (stage 1), worked out by hand

- **AC-LR-01:** a 5001-byte description is invalid at creation in both paths. Example: 1667 × "あ" (3 bytes each) + "ab" =
  5003 bytes, only 1669 characters. A 5000-byte one is valid.
- **AC-LR-02:** a 101-code-point title is invalid; a title of 100 emoji (100 code points, 200 UTF-16 units) is valid.
- **AC-LR-03:** a ja title written only in Latin letters fails `script`. "一筆ずつ描く小屋 | 3時間" passes. A de title is not
  script-checked.
- **AC-LR-04:** warn checks never make a change invalid: identical-to-original, timestamps, hashtags, links, characters,
  tracked language.
- **AC-LR-05:** timestamps. The original has 00:00, 05:12 and 1:02:03; a translation with 00:00 and 05:12 warns with "2 of 3".
  The same three in a different order warns too.
- **AC-LR-06:** reporting twice keeps both reports; the second is current and `replaced` names the first. Reporting for another
  channel's set refuses with `change_set_not_found`. An entry for a language the set doesn't have refuses with
  `validation_failed`.
- **AC-LR-07:** the worker's tool is refused for another channel's set (`CHANNEL_NOT_ACTIVE`).
- **AC-LR-08:** approve and then reject one change: two decision records, each naming the then-current report id and its verdict
  for that (language, field), or null when there was no report.
- **AC-LR-09:** a set made when the original title was "A" reads `originalChanged: true` once the synced title is "B", and false
  while it is "A". A set without `originalsJson` (older) reads null, not true.
- **AC-LR-10:** the per-video view merges two sets of one video: a language whose title is in set B and description in set A
  shows as one row.
- **AC-LR-11:** `videoIds` on send-together sends only those videos' changes. An empty list refuses with `validation_failed`.
- **AC-LR-12:** a note on a proposal is stored and shown; a proposal without a note shows none.
- **AC-LR-13:** a document saved before this change (no `checkReports` / `decisions` / new provenance fields) loads, syncs and
  reads as "not checked yet".
- **AC-LR-14:** every new UI string has en and ru keys.

## 8. Risks

- Automerge document growth from reports: each report is a JSON string, at most ~200 entries × a few kB. Retention already purges
  a deleted set's records, and the purge is extended to `checkReports` and `decisions` of that set.
- A report made on one computer while the set was deleted on the other: the merge keeps an orphan report. Readers ignore a
  report whose set is gone, and the purge removes it.
