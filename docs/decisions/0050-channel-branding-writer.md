# 0050. The channel branding writer: description, keywords and banner

Status: Accepted

**Date:** 2026-10-25. **Decided by** the owner, Telegram msgs 3482 («Я хочу иметь возможность через YT manager менять
информацию о канале и делать переводы главной страницы») and 3488, answering DEV msg 3487: **a)** yes, the app may write the
channel's branding -- description, keywords, banner -- which lifts msg 3350's "never write `brandingSettings`" (ADR 0047) for
these fields only; **b)** the screen lives on «Главная» (`/home`, the app's first section); **c)** keywords are in scope.
Request: FO-REQ-0039 (Factory Operator). Plan: `docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md` (BL-223).

## Context

- ADR 0047 (BL-210) let the app write a channel's translations (`part=localizations`) and nothing else of the channel: the owner
  refused any `brandingSettings` write (msg 3350), because that part is replaced whole and would have to echo fields the app does
  not own. The owner now wants the channel's own description, keywords and banner editable from the app and by the agents' drafts.
- The official Data API v3 reference (checked 2026-10-25, before the code; the plan's "API facts" section quotes it):
  - [`channels.update`](https://developers.google.com/youtube/v3/docs/channels/update): "You can only update any one of those parts
    with a single request"; it "overrides the existing values for all of the mutable properties" of the part; an omitted property
    that has a value: "the property's existing value will be deleted". Settable: `brandingSettings.channel.country`,
    `description`, `defaultLanguage`, `keywords`, `trackingAnalyticsAccountId`, `unsubscribedTrailer`. `channelTitleUpdateForbidden`:
    the title must be "the channel's current title or omit the property". 50 units.
  - [`channels`](https://developers.google.com/youtube/v3/docs/channels): the description has "a maximum length of 1000
    characters"; keywords are "a space-separated list of strings", "truncated if they exceed the maximum allowed length of 500
    characters or if they contained unescaped quotation marks"; `brandingSettings.image.bannerExternalUrl` is "the location of the
    banner image that YouTube uses to generate the various banner image sizes" (its parent object is marked deprecated);
    `snippet.thumbnails` (the avatar) is read-only.
  - [`channelBanners.insert`](https://developers.google.com/youtube/v3/docs/channelBanners/insert): "The image must have a 16:9
    aspect ratio and be at least 2048x1152 pixels", "Maximum file size: 6MB", jpeg/png, 50 units; the returned `url` is then set as
    `brandingSettings.image.bannerExternalUrl` through `channels.update`.
  - The channel name and the avatar have no API write: they stay YouTube Studio's.

## Decision

1. **A new authorized writer**, `src/lib/channel-branding/`, of a channel's `brandingSettings.channel.description`,
   `brandingSettings.channel.keywords` and banner (`channelBanners.insert`, then `brandingSettings.image.bannerExternalUrl`) --
   nothing else. It never changes the title, country, default language, trailer or tracking id: they are sent back exactly as
   read because the part is replaced whole. It is not a localization writer (AGENTS.md §F's four writers of per-language text are
   unchanged), and BL-210 still never writes `brandingSettings`.
2. **Storage.** Schema v109, device-local: `channel_branding` (one draft per channel: description, keywords, banner metadata with
   its SHA-256; who saved it; the last apply's result) and `channel_branding_events` (append-only audit). The banner's bytes are
   copied on save to `<app data>/channel-branding/<channelId>/banner.<jpg|png>` and checked against the stored SHA-256 at apply,
   so the image the owner previewed cannot change before «Применить». `{}` clears the draft; saving sends nothing to YouTube.
3. **Validation on save** (one error refuses the whole draft, `validation_failed`, `details.refused`): description ≤ 1000
   characters without `<`/`>` (the card counts the ones to remove); keywords: each non-empty, no `"`, a keyword with a space written in double quotes, the whole
   space-separated string ≤ 500 characters; banner: jpeg/png by its first bytes, ≤ 6 MB, ≥ 2048×1152, exactly 16:9, a JPEG
   without an EXIF orientation other than 1 (undocumented: conservative). An agent's banner is read from one handle whose dev/ino
   is the resolver's, at most 6 MB + 1 byte; a Web multipart upload needs `Content-Length`.
4. **Who may write.** The owner (the card «Канал» on «Главная») and, as drafts only, the Factory Operator
   (`factory_channel_get_branding` / `factory_channel_save_branding`, Factory API 1.32.0) and a channel's own worker
   (`agent_channel_get_branding` / `agent_channel_save_branding`, bound to its channel, Agent API 4.6.0). Agents name the banner by
   a path relative to the channel workspace's `99 Data Exchange/Sent to YTM/` (the shared `workspace-exchange` rules: no `..`, no
   absolute path, the real file inside the folder). Only the owner's «Применить» in the Web UI
   (`POST /api/channels/[channelId]/channel-branding/apply`, Web session + active channel) writes to YouTube; a source-scan test
   (AC-CB-09) keeps the apply, the adapter and both gateway writes out of every MCP and agent path.
5. **The pipeline** (AGENTS.md §G): the `draftVersion` (SHA-256 over the stored draft and the banner's hash) must equal the
   previewed one, else `branding_changed`; `write-context.assertWriteChannel`; a fresh `channels.list
   part=snippet,brandingSettings,localizations`; nothing different → nothing written; a backup (`kind: "channel_branding"`); a
   re-read that must equal the first (else `update_failed`, nothing sent); with a banner, `assertLiveWritesAuthorized` then
   `channelBanners.insert`; the full `brandingSettings` built from the read (the documented settable fields, the title as read,
   the banner URL as read unless replaced) with only the draft's fields replaced; `assertLiveWritesAuthorized` immediately before
   the one `channels.update part=brandingSettings`; read-back (bounded re-reads: the draft's fields as sent -- keywords compared
   as lists --, every other branding field, the title and the translations unchanged); audit and the last result.
   Partial states are named: banner uploaded but the update failed → `banner_uploaded_not_set` (the old banner stays); the update
   done but the read-back differs → `read_back_mismatch` with the fields (the backup is kept); the update done but the audit or a
   read-back read then fails → `written_unverified` (independent review: never a plain failure once the channel was written).
   A failed apply keeps the banner a previous apply recorded, so it is not uploaded again.
6. **Gateways.** The write gateway gains `insertChannelBanner` and `updateChannelBrandingSettings` (both in the inventory's
   `WRITE_PRIMITIVE_NAMES`); the read gateway gains `getChannelBrandingContext`. `channelBanners.insert` costs 50 units in the
   quota ledger.

## Consequences

- AGENTS.md §F and PROJECT_SPEC §21 name this writer; SYSTEM_MAP and ARCHITECTURE describe it; the BL-210 test that the gateway
  exports no branding write is replaced by one that only this module's adapter calls the new primitives.
- An apply costs one `channels.update` (50 units), with a banner one `channelBanners.insert` (50 units), plus at least 3 one-unit
  reads; «Проверить на YouTube» and the agents' `get` cost 1 unit each.
- **Not verified against the real API yet:** whether YouTube keeps `bannerExternalUrl` exactly as sent (the read-back reports a
  difference), whether it re-orders or re-quotes keywords (compared as lists; a difference is reported, not hidden), and whether
  a `brandingSettings.channel` field outside the documented settable list exists on our channels (not sent; reported if lost).
  The first real apply is the live acceptance.

## Alternatives rejected

- **Echoing every field read, documented or not:** a field outside U1's settable list may be refused (`invalidBrandingOption`).
- **Omitting the banner URL when the draft has none:** U1's deletion rule could remove the channel's banner.
- **Letting the Operator or a worker apply:** the owner's decision since ADR 0047 -- agents prepare, the owner applies.
- **Writing the name or the avatar:** no API method (`channelTitleUpdateForbidden`; thumbnails are read-only).
