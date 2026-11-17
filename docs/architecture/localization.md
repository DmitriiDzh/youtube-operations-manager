> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 5. Phase 3: Localization Manager (read-only) + XLSX export (`src/lib/localization/`)

### 5.1 Purpose and scope

Adds a read-only view over the localization data already captured by Phase 2 sync (`videos.existingLocalizations`), plus an XLSX export. **No new YouTube API calls, no new database tables, and no write path exist in this module** — it is a pure read model over data `channel-sync` already persisted, plus a local file-generation adapter (`exceljs`). Matches `docs/PROJECT_SPEC.md` §62 (Third Agent Assignment): "Implement the Localization Manager read-only UI and XLSX export. Do not implement live localization writes yet."

### 5.2 Data flow

```text
Web UI / API → core.getLocalizationOverview({ credentialRef, channelId })
  1. channelStore.getChannel(channelId)              — from src/lib/db.ts, fails not_found if never synced
  2. channelStore.listVideosByChannel(channelId)      — from src/lib/db.ts (same table channel-sync writes)
  3. collectChannelLanguages(videos)                  — union of every existingLocalizations key across all
                                                          videos in this channel (never a hard-coded language list,
                                                          per docs/PROJECT_SPEC.md §13)
  4. per video: present/missing languages vs. that union → status "complete" | "missing"
  5. return { channelId, channelTitle, languages, totalVideos, videos[] }

Web UI / API → core.getVideoLocalizationDetail({ credentialRef, channelId, videoId })
  → original title/description (from synced snippet) + every existing remote locale's title/description

Web UI / API → core.exportLocalizations({ credentialRef, channelId, videoIds? })
  1. same read as above, optionally scoped to a videoIds subset (validated to belong to the channel)
  2. xlsxBuilder.buildWorkbook({ channel, videos })    — exceljs, two sheets, see §5.3
  3. return { filename, buffer, videoCount, rowCount }
```

No `authResolver`/OAuth scope check occurs inside this module (there is no YouTube call to authorize) — the API routes still require a valid NextAuth session before reaching the service, consistent with every other route handler.

### 5.3 XLSX workbook shape (`src/lib/localization/adapters/xlsx.ts`)

Two sheets, per `docs/PROJECT_SPEC.md` §15, built with `exceljs` (bold frozen header row, `autoFilter`, sensible column widths, wrapped description cells):

```text
Videos          — channel_id, channel_name, video_id, youtube_url, published_at,
                  default_language, original_title, original_description
                  (one row per exported video; video_id is canonical, never title)

Localizations   — video_id, language, language_name, title, description,
                  remote_title, remote_description, status ("Existing" | "Missing")
                  (one row per exported video × every language that exists anywhere
                  in the channel's synced data; title/description are left blank —
                  they are the future XLSX-import input columns, not populated here)
```

Export scope (`videoIds?`) covers all three cases from `docs/PROJECT_SPEC.md` §15 ("selected videos / all filtered videos / entire channel"): the Web UI computes the relevant id list client-side (selection checkboxes, or the currently-filtered table rows) and passes it as a query param; omitting it exports the entire synced channel.

### 5.4 Known limitation: no target-language configuration yet

The Localizations sheet only emits rows for languages that **already exist** somewhere in the channel's synced localizations — there is no concept yet of a channel's "configured target languages" (spec §11's language-chip picker). A channel with zero existing localizations exports an empty Localizations sheet. Introducing a target-language configuration step (so operators can generate blank rows inviting *new* translations, not just review existing ones) is deferred to the XLSX-import phase (`docs/PROJECT_SPEC.md` §63), where "language to add" becomes a meaningful input rather than a display-only computation.

---

## 46. The channel's language is the truth for localization (BL-178, FO-REQ-0022)

Owner exception 2026-10-12 (msg 2665), recorded in `docs/PROJECT_SPEC.md` §14 and `docs/WRITE_AUTHORIZATIONS.md` (AGENTS.md §F). Plan:
`docs/roadmap/plans/LOCALIZATION_BASELINE_PLAN.md`.

- **The rule** lives in `src/lib/shared-language-baseline/` (pure, shared by `batches`, `changesets`, `localization`,
  `agent-operations` and `channel-language-defaults`, AGENTS.md §M).
  - YouTube lists a video's own default language in `localizations` too, equal to the snippet. This entry is called the mirror.
  - With a channel baseline set, a video whose language differs from it is read **aligned**:
    - its snippet is the original, in the baseline language;
    - mirrors under the old or new code are dropped.
  - An entry under either code that differs from the snippet is **ambiguous**, and a write refuses it.
  - Language codes compare case-insensitively.
  - `baselineValueStillHolds` accepts both row shapes for the old language: rows made against the mirror (the snippet text) and
    rows made against nothing (`""`).
- **Batches** (`runSafetyPipeline`):
  - A wired baseline source with no language set → FAILED. This closes the path where an audio-only baseline let an `es` row
    overwrite the English snippet.
  - Deviating video → `mergeBase` gets the baseline `defaultLanguage` and the mirror-free localizations.
    - A row in the baseline language → FAILED.
    - Conflict detection and reconciliation read with the baseline.
    - The backup adds `snippetTitle`/`snippetDescription`.
    - DRY_RUN/ATTEMPT audit gets `defaultLanguageAligned {from, to}`.
    - The read-back must show the snippet exactly as sent. Otherwise the row FAILS with `systemic`, and the batch stops.
    - A read that still shows the old language is re-read (lag), not failed. A read that never shows the channel's language
      also stops the batch.
    - Reconciliation and crash recovery accept a success only when the read shows the sent snippet: `defaultLanguage`, title
      and description (`readBackMatchesSentSnippet`, against the attempt's stored payload). Otherwise the row FAILS with
      `systemic`.
    - Language codes match localization keys case-insensitively in `merge.ts` too: a row `pt-br` updates `pt-BR`.
- **Change Sets, XLSX import, AI localization, the Languages overview:**
  - They read videos with the baseline (`changesets/diff.ts` `readWithChannelBaseline`). For a mislabelled video an `es` row is
    an `add`.
  - AI `sourceLanguage` = the configured baseline, else the video's own language.
  - The overview row gains `originalLanguage` (a video without a language takes the channel's); `defaultLanguage` stays
    YouTube's value.
  - The approval screen marks old-language rows "translation, not an edit of the original".
  - **Known limits, both fail closed:**
    - a row in the channel's language on a mislabelled video looks approvable, but the Batch refuses it (fix the language
      first);
    - a video whose old-language entry differs from its snippet ("ambiguous") is read as it is, and the Batch refuses it.
  - `getChangeSet` returns `languageAlignments` for the approval screen.
  - BL-227 (ADR 0052): creation validates fields with `shared-localization-checks` (description in bytes, < >, ja/ko/zh script);
    each new set gets `setDetails` in the change-drafts document (author, agent notes, original fingerprints); approve/reject append
    `decisions`; agents add `checkReports` (`factory_`/`agent_localization_report_checks`). The review by video
    (`src/lib/localization-review/`) merges every set's changes of a video into one row per language.
  - BL-226: `getChangeSet` also returns `untitledTranslations`; the send refuses them (`send_untitled_translations`) and the merge
    throws before the write (`untitledTranslations`, `shared-localization-merge`). Basis: YouTube refused a whole video whose `it`
    translation had only a description (2026-10-26, audit events 2456/2459); the official `videos` reference does not state it.
- **Single-item writes** (`video-details`, including "Fix all", and `video-metadata`):
  - They send the `defaultAudioLanguage` read just before the write (`pickWritableSnippetFields(..., { includeDefaultAudioLanguage:
    "keep" })`), except `zxx`.
  - This closes RISK-102.
- **Agents:** `agent_get_channel_context` gains `languageBaseline` and `languageDeviations`. These are additive, with no version
  bump.
- **Part B — the same settings on every computer** (`src/lib/sync-gateway/channel-language-settings/` + `-sync/`):
  - One Automerge document per channel: `defaultLanguage`, `defaultAudioLanguage`, `trackedLanguages`. It is the only writer of
    `channels.expected_default_*` and `channels.target_languages_json`. `channel-language-defaults` and `localization` save
    through it, and every reader keeps reading those columns.
  - The genesis is shared, as in `media-settings`: same actor, time 0, content keyed by channel. Documents two computers started
    on their own merge field by field and are never refused as `divergent_document_lineage`.
  - The first sync seeds each computer's earlier values: only set values, only fields the document lacks, and before the
    peer's document is merged (the runner exports before it merges). An unset value never conflicts with a set one, so the Mac
    with nothing received Windows' `en`/`en`.
  - A field set to different values is a conflict. Tracked languages compare as a set. While a field conflicts, each computer
    keeps its own value.
  - The owner picks a computer's version on the startup screen or in Merge (`/api/channels/[id]/language-settings/conflicts`,
    by actor, re-derived server-side). Saving the field with a value other than this computer's own also settles it. Re-sending
    this computer's value does not: a form that saves every field never decides by itself.
  - The Language defaults form sends only the fields the owner changed. A field left out keeps a value that arrived from the
    other computer after the form loaded. The form also reloads when the refresh fingerprint moves, unless the owner is
    editing.
  - Adding or removing a tracked language is refused while the tracked lists conflict, because it would drop the other
    computer's languages.
  - Batches refuse a row before any YouTube call while `defaultLanguage` or `defaultAudioLanguage` conflicts. So does "Fix
    all", which also refuses when the shared document cannot be read. Per-video alignment (a `video-details` preview/apply of the
    panel's value) is disabled in the panel only: `video-details` is the owner's single-video edit and has no channel-baseline
    check of its own (low risk, accepted). If the conflict state cannot be read, a Batch row fails closed with the cause. A tracked-languages conflict does not stop Batches, since no write reads the tracked list. The Languages page says
    when the defaults differ.
  - **Known limit:** a value an owner clears before the first sync is not shared, because an empty value is never seeded.
    The other computer's set value then arrives and takes its place. A value cleared after it was shared reaches the other
    computer as cleared.
  - Load, change, merge and save run one at a time per process, the `media-settings` review finding.
- **Part C — refresh and alerts:**
  - Reconciliation that confirms a write also updates the local copy, as the ordinary success path does.
  - `GET /api/channels/[id]/localizations/version` is a fingerprint of the channel's local video copy, tracked languages,
    baseline language and audio language, and which language settings conflict. A fingerprint, not a counter, sees a change made by any process (a Batch run by an agent or the CLI, a sync, a
    setting from the other computer) without a schema change. The Languages page and the Change Set view poll it every 15 s
    while visible (`use-localization-version.ts`) and reload quietly when it moves. Only the newest request's answer is applied.
  - `localization.getTranslationAlerts` covers public or scheduled (`publishAt` set) videos that lack a tracked language: no
    entry, an empty title, or an empty description where the original has one. It is read against the baseline: a mirror is not
    a translation, and an ambiguous video's original is in the baseline language too. The original's language never counts.
  - `GET /api/localization-alerts` returns every connected channel's counts plus its deviation count (the "Fix all" list). It
    feeds:
    - the «Языки» badge for the active channel (distinct videos missing a translation or deviating, with the split on hover);
    - bell entries for the other channels (the BL-157 rule: the active channel has its badge).

    The entries are derived on every poll, so they clear once the translations are applied.
  - `agent_get_channel_context` gains `missingTranslations` `{videoCount, byLanguage, videos[{videoId, missingLanguages}]}`,
    additive.

