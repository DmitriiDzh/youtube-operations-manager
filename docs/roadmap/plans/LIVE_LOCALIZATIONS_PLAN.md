# Live stream translations at publish (BL-207)

Owner: request 2026-10-21 (Telegram msg 3254), decisions msg 3257:
1. The Factory Operator sets the translations over MCP. They are also editable by hand in the Live section, like the base
   text.
2. There is one set per stream (the description is per stream), so every broadcast and every BL-205 segment gets the same
   set.
3. A language without a translation gets nothing written, so viewers see the base (English) text.
4. This is a second authorized writer of per-language title/description, besides Batches. It is limited to live broadcasts
   and to the stored set.

This **reverses** `LIVE_STREAMS_FIELDS_PLAN.md` §2.3 ("no second `localizations` writer"). AGENTS.md §F, PROJECT_SPEC §21,
ADR 0045 and the code comments that state the old rule (`video-details/contracts.ts`, `live-streams/fields.ts`) are amended
in the same branch.

## 1. Facts (code read 2026-10-21)

- **Where the base text comes from.** Each broadcast and BL-205 segment copies `stream.title` / `stream.description` from
  `live_streams`: `broadcasts.ts` ~218 and `segments.ts` ~256.
- **What runs after go-live.** `applyVideoSettings` (`video-apply.ts`) runs three steps:
  1. fields, through video-details (identity check, backup, merge onto a fresh read, read-back, audit);
  2. the thumbnail;
  3. playlists.

  The fields step sets `defaultLanguage` to the channel baseline. Every step emits `video_settings_step`, and the panel shows
  the result.
- **No live path writes `localizations`.** video-details cannot write them either: they are outside its contract and outside
  its read parts.
- **The merge rule exists only in Batches.** `buildSafeLocalizationsPayload` and `checkDefaultLanguage`
  (`batches/merge.ts`) keep every other locale, send the whole writable snippet, and block when the video has no
  `defaultLanguage`. They write through `applyVideoMetadataUpdate` (write gateway, `part: snippet,localizations`).
- **`live_streams` is device-local** (snapshot contracts: a stream runs from this computer only). There is one row per
  channel.
- **Limits:**
  - the title limit is `TITLE_MAX_CHARACTERS` 100 and the description limit is `DESCRIPTION_MAX_BYTES` 5000 (bytes), both in
    `youtube-video-fields`;
  - the `<`/`>` rule exists only in publishing (`packages.ts` 143–150);
  - language codes are checked with `isSupportedYoutubeLanguageCode`, an exact match.

## 2. Design

### Stage 1 — shared merge logic (no behaviour change)
- **The move.** `buildSafeLocalizationsPayload`, `checkDefaultLanguage` and the locale-key helpers move from `batches/merge.ts`
  into a shared module, `src/lib/shared-localization-merge/` (AGENTS.md §M: two feature modules need it). Batches import it
  from there, and their tests stay green unchanged.
- **The angle-bracket check.** It moves into `youtube-video-fields` as `hasAngleBrackets`, and publishing uses it.

### Stage 2 — storage and validation
- **Schema v101.** It adds `live_streams.localizations_json` (nullable): `{ "<lang>": { title, description } }`. The column is
  device-local, like the row.
- **Validation** (shared by the MCP tool, the route and the store). The language must be an exact supported YouTube code
  (`pt-br` is refused with a "did you mean pt-BR" hint). The title must be 1–100 characters after trimming and the description
  1–5000 bytes (required: empty after trimming is refused, owner msg 3287). Neither may contain `<` or `>`. The channel's baseline language is refused, because its text is the base
  text. At most 50 languages.
- **Semantics.** Saving a set replaces the stored set. An empty set clears it.

### Stage 3 — the write step (`step: "localizations"`)
- **When it runs.** It runs in `applyVideoSettings` **after fields**, and only when the fields step was `ok`; otherwise it is
  skipped. It covers all three triggers: start, segment, and «Применить снова».
- **No stored set:** the step is `skipped` and makes no YouTube call.
- **Write pipeline.** There is a new port, wired in composition next to `live-stream-video-fields`, with these steps:
  1. `write-context.assertWriteChannel` (identity, fail closed);
  2. a fresh `videos.list snippet,localizations`;
  3. `checkDefaultLanguage`; a missing `defaultLanguage` means no write;
  4. if the fresh `defaultLanguage` equals a language in the set, fail closed with no write (PROJECT_SPEC §14's "baseline
     language itself → FAILED" rule);
  5. a backup of the fresh title, description and localizations through the existing backup store;
  6. `buildSafeLocalizationsPayload`: the same languages are overwritten, other languages are kept, nothing is deleted;
  7. `assertLiveWritesAuthorized` immediately before `applyVideoMetadataUpdate`;
  8. read-back, which must show every written language exactly and the snippet title/description unchanged;
  9. an audit event like video-details' own.

  A mismatch gives `{step: "localizations", ok: false, error: "YouTube reads back something else"}`.
- **§G steps on this path:**
  - present: identity, validation, backup, approval, audit, verification;
  - not present: a diff (the set *is* the approved change);
  - dry-run: covered by Live writes off.
- **Quota.** One more `videos.update` (+50 units) plus one `videos.list` (1 unit) per broadcast and per segment, and only when
  a set exists.

### Stage 4 — MCP (Factory API 1.26.0 → 1.27.0)
- **`factory_live_save_localizations({ channelId, localizations })`** is a local write (no YouTube call). It is listed in
  `FACTORY_TOOL_NAMES` and `FACTORY_WRITE_TOOL_NAMES` and checked by `assertMutationAllowed`. The channel must have a stream
  here, like `factory_live_map_sources`. It returns the stored set and the languages it refused, with reasons. The whole call
  is refused if any language is invalid; nothing is half-saved.
- **`factory_live_get_status`** also returns the set (`localizations`) and the last localizations step result.

### Stage 5 — Web UI
- **The card.** A «Переводы» card in the Live section, next to the title and description, has one row per language: a language
  select (supported codes minus the baseline), the title and the description. It has Add, Remove and Save buttons, and the
  same validation messages as the server.
- **Text.** All text uses keys in `ui-text/locales/{en,ru}/liveStreams.ts`, plus a `stepLabel` key for the new step.
- **Before placing it.** The live panel is checked in the browser first (UX rule).

## 3. Acceptance criteria (fixed before the code; values by hand)

- **AC-LL-01:** Fresh `{defaultLanguage:"en", title:T, description:D, localizations:{fr:{Fo,Fd}, it:{Io,Id}}}` and the set
  `{de:{Dt,Dd}, fr:{Ft,Fd2}}` → the payload localizations are `{fr:{Ft,Fd2}, it:{Io,Id}, de:{Dt,Dd}}`, and the snippet title
  and description stay `T` / `D`.
- **AC-LL-02:** A set containing the baseline `en` is refused at save (MCP and route). If the baseline later becomes `de` and the
  set holds `de`, the step reports `ok:false` and no `videos.update` is sent.
- **AC-LL-03:** A fresh read without `defaultLanguage` → no write and `ok:false`.
- **AC-LL-04:** The fields step failed → the localizations step is `skipped` and no YouTube call is made.
- **AC-LL-05:** No stored set → `skipped` and zero YouTube calls.
- **AC-LL-06:** All three triggers (start, segment, apply again) run the step with the same set.
- **AC-LL-07:** Save refusals:
  - title "" or 101 characters;
  - description "" or "   " (required, owner msg 3287; "x" accepted);
  - a description of 5001 bytes, e.g. 2501 × "é" (5002 bytes) refused while 2500 × "é" (5000 bytes) is accepted;
  - `<` in the title;
  - `pt-br`, `xx`;
  - 51 languages.
  A refused call stores nothing.
- **AC-LL-08:** Read-back missing `de` → `ok:false`, "YouTube reads back something else".
- **AC-LL-09:** Live writes off → `live_writes_disabled` before any write call; the identity check fails → no write.
- **AC-LL-10:** The `factory_live_save_localizations` input is strict. A channel without a stream here gives
  `live_stream_not_found`. `factory_live_get_status` shows the saved set.
- **Live acceptance:** the first real go-live with a set. Whether `localizations` on a live broadcast's video read back is not
  verified yet; it is treated like the BL-205 spike.

## 4. Build order
Stages 1 to 5 go on the one branch `feature/live-localizations`. Then an independent review, a merge on the owner's «да», a
restart, and a DEV-REL to the Operator.
