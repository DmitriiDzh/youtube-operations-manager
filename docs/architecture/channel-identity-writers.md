> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## BL-210 — a channel's own translations (ADR 0047)

Owner msgs 3343/3345/3347/3350; plan `docs/roadmap/plans/CHANNEL_LOCALIZATIONS_PLAN.md` (its "API facts" section quotes the
`channels` / `channels.update` / `channels.list` reference). The third, narrowly scoped writer of per-language title/description
(`docs/WRITE_AUTHORIZATIONS.md`, PROJECT_SPEC §21), for the channel resource itself. It writes only `localizations`, never `brandingSettings`.

- **Shared validator** (`src/lib/shared-localization-set/`, pure): `validateLocalizationSet(input, { baselineLanguage, limits,
  ownText })` -- moved from `live-streams/localizations.ts`, whose `validateLiveLocalizations` is now a wrapper with the video
  limits (100 characters / 5000 bytes, behaviour unchanged). The description limit is counted in bytes or characters.
- **The set** (`channel-localizations/set.ts`, pure, imported by the card): channel limits 30 / 1000 characters (the documented
  `brandingSettings.channel.title` and description limits; none is documented for `localizations`), `readStoredChannelLocalizations`
  (a stored value that no longer passes is reported, never guessed), `channelDefaultLanguage` (`brandingSettings.channel.defaultLanguage`
  only; both it and `snippet.defaultLanguage` set and different = mismatch), `ownLanguageEntry` and `previewChannelLocalizations`
  (per language new / changed / unchanged, the untouched languages -- an own-language entry included --, `defaultLanguage { current }`,
  problems `default_language_not_set | default_language_mismatch | own_language_in_live | own_language_in_set | empty_set`,
  `quota { writes: 0 | 1, writeUnits, readUnits }`).
- **Storage** (schema v104, device-local, in the snapshot's device-local list): `channel_localizations` (`localizations_json`,
  `updated_at`, `updated_by`, `last_apply_json`, `last_apply_at`; saving the set keeps the last apply and vice versa) and
  `channel_localization_events` (saved / backup / write / verification / failed).
- **The service** (`channel-localizations/services.ts`): `save` (connected channel, validator, replace, event `saved`, no YouTube
  call), `view`, `live` (a `channels.list` with the channel's connected account, read scope), `preview` (adds `setVersion` =
  SHA-256 of the stored column) and `apply(channelId, credentialRef, setVersion)` -- the version must match the stored set (else
  `localizations_changed`) → identity → fresh read → refusals (`channel_default_language_not_set`, `default_language_mismatch`,
  `own_language_in_live`, `validation_failed`) → nothing different: `{ ok: true, writes: 0 }` → backup (`kind:
  "channel_localizations"`, stored under the channel id) → re-read equal to the first (else `update_failed`) → the shared merge
  (`buildSafeLocalizationsPayload` with the channel as a `FreshVideoContext`, only `localizations` used; an own-language entry equal
  to the base text put back unchanged) → `assertLiveWritesAuthorized` → `channels.update part=localizations` → read-back (4 reads,
  5 s apart: "language missing" / "text differs" / "language lost" / "other language changed" / "branding settings changed" / base
  text) → the last result (`ok`, `languages`, `writes`, `backupPath`; or `failure: read_back_mismatch | failed`). A failure before the
  write throws and is also stored as the last result.
- **Surfaces.** `createChannelLocalizationsOwnerCore` (the Web routes only) and `createChannelLocalizationsOperatorCore` =
  `operatorSurface` (view, live, save as `factory`; no apply) for the Factory MCP route; `operatorChannelLocalizations` shapes
  `factory_channel_get_localizations` (codes only). `no-agent-apply.test.ts` scans every MCP and agent path for the apply and the
  gateway write.
- **Gateways.** Read: `getChannelLocalizationsContext` (`part=snippet,brandingSettings,localizations`, by id). Write:
  `updateChannelLocalizations` (one part); the `brandingSettings` primitives are BL-223's own. The quota ledger logs both through the wrapped
  client (`channels.update` 50, `channels.list` 1).
- **Web UI.** «Переводы канала» (`src/components/channel-localizations-panel.tsx`) in the Languages tab under the channel's language
  defaults: rows (language, name, description with character counters), Save, «Проверить на YouTube» (the preview; a missing
  default language says to set it in YouTube Studio → Settings → Channel → Basic info → Language), «Применить» behind
  `ConfirmDialog` sending the preview's `setVersion`, the last result. The row logic reuses `live-stream-localizations-model.ts`
  (`checkRows` takes the validator). Routes: `GET/PUT /api/channels/[channelId]/channel-localizations`, `GET .../preview`,
  `POST .../apply`.
- **Not yet verified against the real API:** the first real apply is the live acceptance.

## BL-223 — the channel branding writer (ADR 0050)

Owner msgs 3482/3488 (FO-REQ-0039); plan `docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md` (its "API facts" section quotes the
`channels`, `channels.update`, `channelBanners.insert` and `channels.list` reference, with the deviations the docs forced). The
only writer of a channel's `brandingSettings` (`docs/WRITE_AUTHORIZATIONS.md`, PROJECT_SPEC §21): description, keywords and banner; nothing else.

- **The draft** (`channel-branding/draft.ts`, pure, imported by the card): `{ description?, keywords?: string[], banner?: { sha256,
  bytes, width, height, mimeType } }`; absent = leave as on YouTube, `""` / `[]` = clear. Checks: description ≤ 1000 characters and
  no `<`/`>`; keywords trimmed, no `"`, serialized space-separated with a spaced keyword in quotes, ≤ 500 characters in that form;
  banner jpeg/png by magic bytes, ≤ 6 MB, ≥ 2048×1152, `width × 9 = height × 16`, its size read from the PNG IHDR or the JPEG SOFn
  header (no dependency). `parseKeywords` reads YouTube's string back as a list (a quoted run = one keyword).
- **Storage** (schema v109, device-local, in the snapshot's device-local list): `channel_branding` (`draft_json`, `updated_at`,
  `updated_by` owner | factory | worker, `last_apply_json`, `last_apply_at`) and `channel_branding_events` (saved / backup /
  banner_upload / write / verification / failed). The banner's bytes: `adapters/banner-store.ts` under
  `<appDataDir>/channel-branding/<channelId>/banner.<ext>` (temp file + rename; one per channel).
- **The service** (`services.ts`): `save` (all fields checked, any refusal → `validation_failed` with every `details.refused`,
  nothing stored; an agent's banner through `workspace-exchange.resolveSentToYtmFile`, its size checked before reading), `view`,
  `live` / `get` (one `channels.list part=snippet,brandingSettings,localizations` with the channel's account), `bannerBytes`,
  `preview` (`planBranding`: per field new / changed / unchanged / cleared; the banner `unchanged` only when the last apply set the
  same SHA-256 and the channel still shows that URL; quota; `draftVersion` = SHA-256 of the stored column, which holds the banner's
  hash) and `apply(channelId, credentialRef, draftVersion)`: version → the stored banner's bytes match its SHA-256 (else
  `branding_changed`) → identity → fresh read → nothing different: `{ ok: true, writes: 0 }` → backup (`kind: "channel_branding"`)
  → re-read equal (else `update_failed`) → `assertLiveWritesAuthorized` + `insertBanner` → `buildBrandingBody` (title as read, the
  six documented settable `brandingSettings.channel` fields as read, the changed draft fields replaced, a cleared one left out, the
  banner URL as read unless uploaded; undocumented fields are not sent) → `assertLiveWritesAuthorized` + `updateBranding` (a failure
  after the upload → `banner_uploaded_not_set`; any failure after the update succeeded → `written_unverified`; a failure keeps the
  previous apply's banner in the last result) → read-back (4 reads, 5 s apart: the draft fields, the banner URL, every other
  branding field, the name, the translations) → the last result.
- **Surfaces.** `createChannelBrandingOwnerCore` (the Web routes only); `agentSurface` / `createChannelBrandingAgentCore` (get,
  save as `factory` or `worker`; no apply) for `src/mcp/factory-channel-deps.ts`, which the Factory route and the channel workers'
  pinned tools (`worker-factory-tools.ts`, saved as `worker`) share; `agentChannelBranding` shapes the get in codes.
  `no-agent-apply.test.ts` scans every MCP and agent path for the apply, the adapter and both primitives.
- **Gateways.** Read: `getChannelBrandingContext`. Write: `insertChannelBanner` (`channelBanners.insert`, media only, ≤ 6 MB) and
  `updateChannelBrandingSettings` (one part). Quota ledger: `channelBanners.insert` 50.
- **Web UI.** «Канал» (`src/components/channel-branding-panel.tsx`) on «Главная» above «Переводы канала»: the name, handle and avatar
  read-only with a YouTube Studio link; description, keywords (comma-separated) and banner (file input, checked in the browser by
  the same `draft.ts`) next to their values on YouTube; Save, «Проверить на YouTube», «Применить» behind `ConfirmDialog`, the last
  result with its code. Routes: `GET/PUT /api/channels/[channelId]/channel-branding`, `GET .../banner`, `GET .../preview`,
  `POST .../apply`.
- **Not yet verified against the real API:** whether YouTube keeps `bannerExternalUrl` exactly as sent, and how it formats keywords;
  the read-back reports either. The first real apply is the live acceptance.

