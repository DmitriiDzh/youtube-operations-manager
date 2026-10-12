# Localization: the channel's language is the truth (FO-REQ-0022, BL-178)

- **Status:** APPROVED 2026-10-12 (owner, Telegram msg 2665: В1 yes, В2 yes, В3 yes, В4 ok). Part A is built first, then B,
  then C; each is merged on its own. **Part A DONE**: built on `feature/bl-178-localization-safety`, reviewed, merged into `dev`
  2026-10-12 (owner, Telegram msg 2674). Parts B and C are not started. Deviation from §3.1 A5: `channel_video_list` gets no `languageDeviates` flag; the list is in
  `agent_get_channel_context` (`languageDeviations`), which serves the same need.
- **Request:** FO-REQ-0022, created by the Operator on 2026-10-12 and relayed by the owner on 2026-10-12.
- **Owner's rule:** decision 1078, quoted in the request:
  - "All our videos are in English by default."
  - "If another original language is declared, it is a YouTube recognition error that we fix."
  - "When new translations are uploaded, the algorithm itself must set the defaults as specified."
- **Sources:**
  - `dev` 1c102a2;
  - the Mac database, read only (`sqlite3 -readonly`);
  - the audit trail synced from the Windows computer.

## 1. Findings

### 1.1 The two videos are already fixed

The video-details audit (`video_edit_audit_events`) shows the whole sequence for `kB8OuwCcgnM` and `OA0c4JGa1PY`. All of it ran on the Windows computer on 2026-10-12.

| Time (UTC) | Action | Result |
|---|---|---|
| 14:11 | "Исправить все" wrote `defaultLanguage es → en` | Verified |
| 14:13 | Dry run showed `defaultAudioLanguage` was now `en-US` | See §1.4 |
| 14:19 | A second "Исправить все" wrote audio `en` | Verified |
| 14:21–14:22 | Batches for `pt-BR` and `es` | Succeeded |

On the Mac now (synced 17:59 UTC):
- both videos are `en`/`en`;
- the snippet is the English original;
- `localizations` holds `en` (a mirror of the snippet, §1.2), `es` and `pt-BR` translations.

The `es` Change Set `66cbf969` that FO-REQ-0022 warns about was rejected.

### 1.2 Why "English under `es`": YouTube's mirror entry

YouTube returns a `localizations` entry for the video's own default language that equals the snippet title and description. All 59 English Tropico videos on the Mac have `localizations.en` equal to the snippet. The sync keeps it (`youtube-read-gateway/data-api.ts:762-776`).

With the wrong `defaultLanguage: es`, that mirror was `localizations.es`. So:
- the diff (`changesets/diff.ts:35-44`) compared an `es` row with the snippet;
- the row was typed `modify`, with the English baseline.

The comment at `diff.ts:26-29` says such an entry never exists. The data contradicts it.

### 1.3 A real overwrite path in Batches

`batches/services.ts:644-682` covers four cases.

| Case | What happens |
|---|---|
| Baseline language `en`, video `es` | Fails closed: "Fix the mismatch first" (2026-10-04 amendment) |
| No baseline at all (the Mac today) | Every row fails closed on "no audio language set" |
| **Audio baseline set, language baseline not set** | The deviation check is skipped and `mergeBase` keeps `es`. The `es` row is written into `snippet.title`/`description` (`merge.ts:182-184`), and `detectPreWriteConflict` does not see it, because the snippet equals the row's baseline. **The English original is replaced.** No test covers this. |
| Video has no `defaultLanguage` | The baseline is applied (2026-10-02 exception) |

### 1.4 "Исправить все" resets the audio language (RISK-102)

`video-details/adapters/youtube-api.ts:107-118` sends `defaultAudioLanguage` only when the patch changes it. `videos.update` resets a snippet field that is left out.

A fix of `defaultLanguage` alone therefore turned the audio language `en` into `en-US`, and the verification checks only the patched fields. The 14:13 dry run shows exactly this. `video-metadata` single-item apply has the same exposure.

### 1.5 The baseline and the tracked languages do not sync

- `channels.expected_default_language` / `expected_default_audio_language` and `channels.target_languages_json` are written locally only (`db.ts:5669-5689`).
- `snapshot/contracts.ts:187` classifies `channels` as a YouTube cache re-synced per device. That stopped being true with v6/v39.
- Result:
  - Windows has `en`/`en`;
  - the Mac has nothing, so every batch from the Mac fails;
  - the Mac's tracked languages are `["es"]`.
- No MCP tool reads or sets the baseline.

### 1.6 Other places keyed on the video's own `defaultLanguage`

- **AI localization:** `sourceLanguage: video.defaultLanguage` (`ai-localization/services.ts:350`), so a mislabelled video is sent to the provider as Spanish.
- **Languages overview "missing":** `localization/services.ts:45`.
- **The "original" cell:** `languages-manager.tsx:1583`.
- **XLSX:** the `default_language` column.

### 1.7 Refresh after a send

- **The local copy is updated** after a verified write (`confirmLocalMirror`, `batches/services.ts:559-579`). The reconciliation success path (`:1121-1130`) does not do it.
- **The Languages page reloads only:**
  - when it mounts;
  - after a sync;
  - after a send started from its own review screen (`onWritten`).

  A batch run from the Batches page or by MCP leaves an open page stale.
- **Coverage:** "Needs attention" does not exist as a state. Coverage is complete or missing per tracked language (`localization/services.ts:40-59`).

## 2. Decisions (answered by the owner, msg 2665)

Answers: В1 "да"; В2 "Да (но лучше не хард код английский, а выбирать на основе дефолтного языка…)" — the source language is
the channel's configured baseline, never a hard-coded `en`; В3 "да"; В4 "ок". PROJECT_SPEC §14 and AGENTS.md §F record В1 when
part A is built.

- **В1 — align on apply.** The question: may a localization Batch set a deviating `defaultLanguage` (e.g. `es`) to the channel baseline (`en`) in the same `videos.update` as the translations?
  - This replaces the 2026-10-04 "fail closed" rule in PROJECT_SPEC §14 for this case.
  - It widens the AGENTS.md §F exception from "a video with no defaultLanguage" to "any video whose defaultLanguage differs".
  - Proposed: yes.
- **В2 — AI source language.** Use the channel baseline whenever it is set, as an override, not as a fallback. Proposed: yes.
- **В3 — sync.** Sync the baseline and the tracked languages between computers, per channel, with a choice on conflict. Proposed: yes.
- **В4 — order.** Three features, each merged on its own (§3). Proposed: as listed.

## 3. Design

### 3.1 Part A — safety and alignment (one branch)

**A1. No baseline language → refuse.**
- A Batch row fails closed when the channel has no language baseline: "set Languages → Language defaults first".
- This is the same rule as the existing audio check, and it closes §1.3.
- With В1 = no, the 2026-10-04 rule stays as it is.

**A2. Align on apply (В1 = yes).**
- When the video's `defaultLanguage` differs from the baseline, `mergeBase.snippet.defaultLanguage` becomes the baseline. This reuses the `appliedDefaultLanguage` path at `:648-666`.
- Payload:
  - snippet title and description copied from the fresh read, unchanged;
  - `defaultLanguage` and `defaultAudioLanguage` set to the baseline;
  - the old language's mirror entry dropped (it equals the snippet);
  - each row in a non-baseline language written to `localizations[lang]`;
  - every other entry kept.
- Refused, as the existing collision rule already does:
  - a row in the baseline language itself;
  - an existing `localizations[baseline]` that differs from the snippet. A mirror equal to the snippet is not a collision.
- A title-only row for the old language takes its description from nothing, never from the mirror. If YouTube needs both fields, the row fails with a reason.
- Backup adds the snippet title and description.
- Read-back checks:
  - `defaultLanguage` equals the baseline;
  - the snippet title and description are byte-for-byte the pre-write text;
  - the written localizations.

  A mismatch marks the row FAILED and the batch reports it.
- Audit: DRY_RUN and ATTEMPT get `defaultLanguageAligned: {from, to}`.
- Approval screen (`change-set-review.tsx`) and batch dry run show "Default language es → en" for each affected video.
- **Rows created before alignment.** A row in the old default language, typed `modify` against the English mirror, is shown and sent as a translation (`localizations[lang]`), never as an edit of the original. The batch decides by the baseline, not by the stored `change_type`. The diff shows "translation (was shown as an edit of the original)".

**A3. Change Sets and AI.**
- `currentRemoteValueFor` and the overview use the channel baseline when it is set: a row is "the original" only in the baseline language.
- AI `sourceLanguage` is the baseline (В2).
- XLSX import types rows the same way.

**A4. "Исправить все" and Details keep the audio language.**
- A video-details snippet write echoes the `defaultAudioLanguage` read fresh just before the write (no change).
- "Исправить все" always sends both baseline fields when they are set.
- `video-metadata` single-item apply gets the same rule.
- This closes RISK-102.

**A5. Agents.** These are additive optional fields, so there is no version bump (`agent-operations/contracts.ts:44-60`):
- `agent_get_channel_context` returns `languageBaseline: {defaultLanguage, defaultAudioLanguage} | null` and `languageDeviations: [{videoId, defaultLanguage, defaultAudioLanguage}]`;
- `channel_video_list` gets `languageDeviates`.

The Producer gets both through the shared handlers.

### 3.2 Part B — sync of channel language settings (one branch)

- **The family:** a new per-channel sync family, `channel-language-settings`. It is one flat Automerge document per channel, the shape of `editorial-profile` (§2.9m):
  - `defaultLanguage`;
  - `defaultAudioLanguage`;
  - `trackedLanguages`.
- **Bootstrap and cutover:**
  - version `0` bootstraps from the SQL columns at the first save;
  - `channel-language-defaults` and `tracked-languages` write through it.
- **Registry:** `snapshot/contracts.ts` is corrected for these columns.
- **Conflicts:**
  - a field changed differently on two computers is a conflict;
  - it is shown on the startup screen and in the Merge tab, like the editorial profile;
  - Batches refuse while the channel's language settings are in conflict.

### 3.3 Part C — refresh and alerts (one branch)

- **C1. Refresh:**
  - the reconciliation success path also updates the local copy;
  - a verified batch bumps a per-channel "localizations changed" counter;
  - the Languages page and the Change Set view poll it every 15 s while visible, and reload when it moves.

  No YouTube call is involved: the read-back already happened.
- **C2. Alerts:**
  - **What counts:** a public or scheduled (`publish_at` set) video that lacks a title or description in a tracked language of its channel, measured against the baseline (not the video's own language).
  - **Badge:** on «Языки» in the sidebar for the active channel (the `generation-plans/summary` pattern).
  - **Bell:** an item per channel naming the channel, the count and the missing languages, with a link to the filtered list.
  - **Deviations:** the same kind of item for videos whose language differs from the baseline.
  - **Clearing:** items clear by themselves when the condition ends.
  - **Agents:** `agent_get_channel_context` gets `missingTranslations` (counts plus video ids).
- Every new UI string goes into `ui-text/locales/{en,ru}`.

## 4. Acceptance criteria (from the request and PROJECT_SPEC §14/§21/§24)

**A**
- A channel with an audio baseline and no language baseline, and a video `es` with an `es` row → FAILED, nothing sent.
- Baseline `en`, video `es` with mirror `localizations.es` equal to the snippet, an `es` row, В1 = yes → the payload has:
  - snippet title and description equal to the fresh read, byte for byte;
  - `defaultLanguage: en`, `defaultAudioLanguage: en`;
  - `localizations.es` equal to the row;
  - `localizations.pt-BR` kept;
  - no `localizations.en`.

  The read-back passes, the audit records `es → en`, and the approval screen shows the line.
- Same, with a read-back whose snippet title differs by one character → FAILED, reported.
- Same, with `localizations.en` holding text different from the snippet → FAILED (collision), nothing sent.
- A `modify` row created against the mirror (the `66cbf969` shape) → sent as `localizations.es`, never into the snippet.
- AI generation for a deviating video sends `sourceLanguage: en`.
- "Исправить все" changing only `defaultLanguage` sends `defaultAudioLanguage` too; the read-back shows audio unchanged.
- The agent context lists the baseline and the deviating videos.

**B**
- The baseline set on computer 1 appears on computer 2 after one sync cycle.
- Different values saved on both computers → a conflict on the startup screen; Batches refuse until it is resolved.

**C**
- After a verified batch started from the Batches page, an open Languages page shows the rows as done within 20 s, with no manual sync.
- A channel with N public or scheduled videos missing `es` shows a sidebar badge and a bell item. Both clear after the translations are applied.

## 5. What this does not change

- The Change Set field authority stays title and description (§21). Alignment writes only the two language fields, and only in a Batch, as §14's exceptions already allow.
- No write without the approval flow and Live writes.
- No blind round-trip of a cached value: echoed values come from the fresh read.
