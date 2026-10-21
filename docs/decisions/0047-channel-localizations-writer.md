# 0047. A third localization writer: the channel's own name and description translations

Status: Accepted

**Date:** 2026-10-22. **Decided by** the owner, Telegram msgs 3343 (translations of the channel description), 3345 (the name too),
3347 (option 3: the Factory Operator prepares over MCP, the owner applies, and there is also a manual card) and 3350 (no
`brandingSettings` write at all; the 30-character title limit kept). Plan:
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

1. **A third authorized writer**, `src/lib/channel-localizations/`, of a channel's own per-language `title`/`description`
   (`channels.update part=localizations`) -- and nothing else of the channel. It never writes `brandingSettings` (owner msg 3350).
2. **Storage.** Schema v104, device-local: `channel_localizations` (one set per channel, `{ "<lang>": { title, description } }`,
   who saved it, the last apply's result) and `channel_localization_events` (the append-only audit trail). Saving replaces the
   set, `{}` clears it, and nothing is sent to YouTube on save. The validator is the shared `src/lib/shared-localization-set/`
   (extracted from `live-streams/localizations.ts`, which keeps its own limits through a thin wrapper, AGENTS.md §M), with the
   channel's limits: title 1–30 characters (kept by the owner, msg 3350), description 1–1000 characters, no `<`/`>` (kept from the
   video fields: conservative), an exact supported code, never the channel's baseline, at most 50 languages; one bad language
   refuses the whole set.
3. **Who may write.** The Factory Operator saves a set (`factory_channel_save_localizations`, Factory API 1.29.0) and reads it
   with the live translations (`factory_channel_get_localizations`). Only the owner's «Применить» in the Web UI
   (`POST /api/channels/[channelId]/channel-localizations/apply`, Web session + active channel) sends it to YouTube. The MCP
   route receives the module's Operator surface (`operatorSurface`: view, live, save) -- it has no apply, and a source-scan test
   (AC-CL-10) keeps the apply and the gateway write out of every MCP and agent path.
4. **The pipeline** (AGENTS.md §G):
   1. the stored set must still be the one the owner previewed: the preview answers `setVersion` (SHA-256 of the stored set),
      «Применить» sends it, a set saved since (e.g. by the Operator) is refused with `localizations_changed` (review #2);
   2. `write-context.assertWriteChannel`;
   3. a fresh `channels.list part=snippet,brandingSettings,localizations` (read gateway);
   4. refusals before any write: `channel_default_language_not_set` when `brandingSettings.channel.defaultLanguage` is not set
      (even if `snippet.defaultLanguage` is -- the owner sets it once in YouTube Studio: Settings → Channel → Basic info →
      Language), `default_language_mismatch` when both are set and differ, `own_language_in_live` when YouTube lists a translation
      in the channel's own language whose text differs from the base name/description (review #1), the channel's own language in
      the set, an empty set; nothing different: nothing written;
   5. a backup of the channel as read (`kind: "channel_localizations"`, under the channel id);
   6. a re-read that must equal the first (else `update_failed`, nothing sent);
   7. the shared merge (`shared-localization-merge`'s `buildSafeLocalizationsPayload`, only its `localizations` used): the set's
      languages added or replaced, every other language kept, nothing deleted; an own-language entry equal to the base text is
      sent back unchanged (the merge leaves it out; this writer puts it back);
   8. `assertLiveWritesAuthorized` immediately before the one `channels.update part=localizations` with the full merged map;
   9. read-back (every written language exactly, every other language -- the own-language entry included -- kept, the base text
      and the branding settings unchanged; bounded re-reads);
   10. audit events (saved, backup, write, verification, failed) and the last result.
5. **The write gateway** gains `updateChannelLocalizations` (in the inventory's `WRITE_PRIMITIVE_NAMES`) and nothing for
   `brandingSettings`; the read gateway gains `getChannelLocalizationsContext`.

## Consequences

- AGENTS.md §F and PROJECT_SPEC §21 name this third writer; SYSTEM_MAP and ARCHITECTURE describe it.
- **Deviations from the plan:** the plan's "set the baseline as the default language" (AC-CL-08) and `no_baseline` (AC-CL-09)
  are replaced by the owner's msg 3350 -- a channel without a default language is refused; the default language is the branding
  field; the limits are the documented ones of the fields translated (30 / 1000 characters).
- Each apply costs one `channels.update` (50 units) plus at least 3 one-unit reads; «Проверить на YouTube» and
  `factory_channel_get_localizations` cost 1 unit each.
- Not verified against the real API yet: the first real apply is the live acceptance (whether YouTube lists an own-language entry
  for a channel, and whether a channel translation longer than 30 characters would have been accepted by YouTube).

## Alternatives rejected

- **Sending `brandingSettings` and `localizations` in one call:** refused by the API (one part per request).
- **Setting a missing default language by a separate `brandingSettings` write** (this ADR's first draft): it has to echo every
  settable branding field (keywords, country, description, ...), which YouTube may change on the way (keywords truncation); the
  owner chose to set the language once in YouTube Studio instead (msg 3350).
- **Letting the Operator apply over MCP:** the owner chose option 3 (msg 3347): the Operator prepares, the owner applies.
- **Reusing the video limits (100 characters / 5000 bytes):** they are a video's; the channel's documented limits are lower.
