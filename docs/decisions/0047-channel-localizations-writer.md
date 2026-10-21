# 0047. A third localization writer: the channel's own name and description translations

Status: Accepted

**Date:** 2026-10-22. **Decided by** the owner, Telegram msgs 3343 (translations of the channel description), 3345 (the name too)
and 3347 (option 3: the Factory Operator prepares over MCP, the owner applies, and there is also a manual card). Plan:
`docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md` (BL-210).

## Context

- Per-language `title`/`description` had two authorized writers (AGENTS.md §F, PROJECT_SPEC §21): the Change Set mechanism
  (videos) and `live-localizations` (a live broadcast's video, ADR 0045). Neither touches the **channel** resource, whose own
  translations (`channels.localizations`) are what viewers see on the channel page in their language.
- The official Data API v3 reference (checked 2026-10-22, before the code; the plan's "API facts" section quotes it):
  - [`channels.update`](https://developers.google.com/youtube/v3/docs/channels/update) takes `brandingSettings`,
    `invideoPromotion` or `localizations`, and "You can only update any one of those parts with a single request";
  - it "overrides the existing values for all of the mutable properties" of the part, and an omitted property that has a value:
    "the property's existing value will be deleted";
  - `defaultLanguageNotSetError`: "The defaultLanguage must be set to update localizations"; the settable default language is
    `brandingSettings.channel.defaultLanguage` (`snippet.defaultLanguage` is not in the settable list);
  - `channelTitleUpdateForbidden`: a `brandingSettings` update must repeat the current title "or omit the property";
  - [`channels`](https://developers.google.com/youtube/v3/docs/channels): `brandingSettings.channel.title` "maximum length of 30
    characters", the description "maximum length of 1000 characters"; no limit is stated for `localizations.(key).*`;
  - quota: `channels.update` "a quota cost of 50 units"; [`channels.list`](https://developers.google.com/youtube/v3/docs/channels/list)
    "a quota cost of 1 unit".

## Decision

1. **A third authorized writer**, `src/lib/channel-localizations/`, of a channel's own per-language `title`/`description` --
   and nothing else of the channel, with the one exception in 4.
2. **Storage.** Schema v104, device-local: `channel_localizations` (one set per channel, `{ "<lang>": { title, description } }`,
   who saved it, the last apply's result) and `channel_localization_events` (the append-only audit trail). Saving replaces the
   set, `{}` clears it, and nothing is sent to YouTube on save. The validator is the shared `src/lib/shared-localization-set/`
   (extracted from `live-streams/localizations.ts`, which keeps its own limits through a thin wrapper, AGENTS.md §M), with the
   channel's limits: title 1–30 characters, description 1–1000 characters, no `<`/`>` (kept from the video fields: conservative),
   an exact supported code, never the channel's baseline, at most 50 languages; one bad language refuses the whole set.
3. **Who may write.** The Factory Operator saves a set (`factory_channel_save_localizations`, Factory API 1.29.0) and reads it
   with the live translations (`factory_channel_get_localizations`). Only the owner's «Применить» in the Web UI
   (`POST /api/channels/[channelId]/channel-localizations/apply`, Web session + active channel) sends it to YouTube. The MCP
   route receives the module's Operator surface (`operatorSurface`: view, live, save) -- it has no apply, and a source-scan test
   (AC-CL-10) keeps the apply and the two gateway writes out of every MCP and agent path.
4. **The pipeline** (AGENTS.md §G): `write-context.assertWriteChannel` → a fresh `channels.list
   part=snippet,brandingSettings,localizations` (read gateway) → the preview's refusals (`no_baseline`, `default_language_mismatch`
   when the two default-language fields disagree, the channel's own language in the set, an empty set) before any write → nothing
   different: nothing written → a backup of the channel as read (`kind: "channel_localizations"`, under the channel id) → a re-read
   that must equal the first (else `update_failed`, nothing sent) → **only when the channel has no default language:** its own
   `channels.update part=brandingSettings` setting `brandingSettings.channel.defaultLanguage` to the channel's baseline, every other
   settable `brandingSettings.channel` field that had a value sent back exactly as read, the title omitted; then read back (the
   default language set, every other settable field and the base text unchanged; else `read_back_mismatch` and the translations
   are not written) → the shared merge (`shared-localization-merge`'s `buildSafeLocalizationsPayload`, only its `localizations`
   used): the set's languages added or replaced, every other language kept, nothing deleted, the own language never sent →
   `assertLiveWritesAuthorized` immediately before each write → `channels.update part=localizations` with the full merged map →
   read-back (every written language exactly, every other language kept, the base text, the default language and the branding
   fields unchanged; bounded re-reads) → audit events (saved, backup, write, verification, failed) and the last result.
5. **The write gateway** gains `updateChannelLocalizations` and `updateChannelBrandingChannel` (both in the inventory's
   `WRITE_PRIMITIVE_NAMES`) and the pure `pickSettableBrandingChannelFields`; the read gateway gains
   `getChannelLocalizationsContext`.

## Consequences

- AGENTS.md §F and PROJECT_SPEC §21 name this third writer; SYSTEM_MAP and ARCHITECTURE describe it.
- **Deviations from the plan forced by the reference:** the default language cannot be set "in the same update" as the
  translations (one part per request), so a channel without one costs two writes (100 units) instead of one (50); the default
  language is the branding field; the limits are the documented ones of the fields translated (30 / 1000 characters).
- The `brandingSettings` write echoes `keywords`, `country`, `description`, `unsubscribedTrailer` and
  `trackingAnalyticsAccountId` as read. YouTube may truncate keywords holding an unescaped quote; the read-back then reports
  `branding field changed: keywords` and stops before the translations (the backup holds the original).
- Each apply costs 50 units (100 with the default language) plus at least 3 (5) one-unit reads; «Проверить на YouTube» and
  `factory_channel_get_localizations` cost 1 unit each.
- Not verified against the real API yet: the first real apply is the live acceptance (whether YouTube lists an own-language entry
  for a channel, and whether a channel translation longer than 30 characters is refused by YouTube or only by us).

## Alternatives rejected

- **Sending `brandingSettings` and `localizations` in one call:** refused by the API (one part per request).
- **Letting the Operator apply over MCP:** the owner chose option 3 (msg 3347): the Operator prepares, the owner applies.
- **Reusing the video limits (100 characters / 5000 bytes):** they are a video's; the channel's documented limits are lower.
