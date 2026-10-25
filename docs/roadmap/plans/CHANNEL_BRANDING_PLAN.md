# Channel branding: description, keywords and banner (BL-223, FO-REQ-0039)

## Sources

- FO-REQ-0039 (Factory Operator, 2026-10-25; owner, Operator Telegram 2801): MCP tools to edit the channel's image, name,
  description and translations, and the same toolset for the owner.
- The owner, Telegram 2026-10-25: msg 3482 («Я хочу иметь возможность через YT manager менять информацию о канале и делать
  переводы главной страницы»), msg 3488 answering DEV msg 3487: **a)** yes, the app may write the channel's branding
  (description, keywords, banner) -- this lifts msg 3350's "never write `brandingSettings`" for these fields only; **b)** the
  screen lives on «Главная» (the first section); **c)** keywords are in scope.
- ADR 0050 records the decision (AGENTS.md §F/§G: a new YouTube write surface).

## Limits stated up front (Operator's reading of the docs, to be re-checked by the implementer before code)

- The channel **name** is not writable through the API (`channelTitleUpdateForbidden`), the **avatar** has no API method: both
  are shown read-only with a link to YouTube Studio.
- The channel's **translations** (title/description per language) already exist (BL-210, ADR 0047) and are unchanged; their
  card is also shown on «Главная» (msg 3489), the «Языки» page keeps it or links to it.

## What it does

1. **A stored draft per channel** (device-local, like BL-210's `channel_localizations`): `description` (base language),
   `keywords`, `banner` (an image), each optional; who saved it (owner / operator / worker) and when; the last apply result.
   - Saving replaces the draft; `{}` clears it; nothing is sent to YouTube on save.
   - The banner is copied into the app's data folder on save (`channel-branding/<channelId>/banner.<jpg|png>`), so the file the
     owner previewed cannot change before Apply. Source: an upload in the Web UI, or for agents a path relative to the channel
     workspace's `99 Data Exchange/Sent to YTM/` (no `..`, no absolute path; resolved inside the workspace only).
   - Validation on save, whole draft refused on any error (`validation_failed`, `details.refused`): description within the
     documented limit, keywords within the documented limit and format, banner jpeg/png by content (magic bytes), ≥ 2048×1152,
     16:9 (the documented aspect rule), ≤ 6 MB. The implementer takes the exact figures from the official docs and records them
     in "API facts" below before writing code.
   - `draftVersion` = SHA-256 over the stored draft including the banner's bytes hash.
2. **Read (`get`)**: the draft, the live values from one `channels.list part=snippet,brandingSettings` (1 unit, read gateway):
   name, description, keywords, country, default language, banner URL, avatar URL; the last apply result as codes.
3. **Preview («Проверить на YouTube»)**: per field new / changed / unchanged / cleared, the banner old vs new, the quota cost,
   `draftVersion`.
4. **Apply («Применить», owner only, Web UI only)**, AGENTS.md §G:
   1. `draftVersion` must equal the previewed one, else `branding_changed` (409), nothing written;
   2. `write-context.assertWriteChannel`;
   3. fresh `channels.list part=snippet,brandingSettings` (read gateway); backup of the resource as read
      (`kind: "channel_branding"`); a re-read must equal it, else `update_failed`, nothing sent;
   4. nothing different → nothing written;
   5. banner in the draft: `assertLiveWritesAuthorized`, then `channelBanners.insert` (write gateway) → its URL;
   6. build the FULL `brandingSettings` to send: every settable field exactly as read (country, defaultLanguage,
      unsubscribedTrailer, trackingAnalyticsAccountId, ...; the title repeated as read or omitted per the docs) with only the
      draft's fields replaced (description, keywords, banner URL in the documented property);
   7. `assertLiveWritesAuthorized` immediately before one `channels.update part=brandingSettings` (write gateway);
   8. read-back (bounded re-reads): the draft's fields as sent (keywords compared after the documented normalisation, a
      difference reported, not hidden), every other branding field unchanged, the title unchanged, the localizations unchanged;
   9. audit events (saved, backup, banner upload, write, verification, failed) and the last result.
   - **Partial states are said exactly**: banner uploaded but the update refused/failed → `banner_uploaded_not_set` (the old
     banner stays on the channel); update ok but read-back differs → `read_back_mismatch` with the fields; the backup is kept.
5. **MCP**, saves and reads only, never Apply (a source-scan test like BL-210's AC-CL-10):
   - Factory API (Operator): `factory_channel_get_branding { channelId }`, `factory_channel_save_branding { channelId,
     description?, keywords?, bannerFile? }` (WRITE to local storage only). Minor version bump.
   - Agent API (a channel's own worker, bound to its channel): `agent_channel_get_branding`, `agent_channel_save_branding`, the
     same shape, following how BL-217 exposed the channel translations to workers. Minor version bump; listed in
     `agent_get_capabilities`.
6. **UI on «Главная»**: a card «Канал» -- name and avatar read-only with a Studio link and a one-line note why; description,
   keywords and banner: live next to the draft, edit by hand, upload a banner, «Сохранить», «Проверить на YouTube» →
   «Применить»; the result with its code. Below it the existing «Переводы канала» card. Texts in en and ru.

## Out of scope

- The channel name and avatar (no API). Country, default language, trailer: shown, never changed by this feature.
- Syncing drafts between computers (device-local like BL-210).
- Any Apply path for agents.

## API facts (checked 2026-10-25 in the official Data API v3 reference, before the code)

Sources: [channels.update](https://developers.google.com/youtube/v3/docs/channels/update) (U1, last updated 2026-10-15),
[channels resource](https://developers.google.com/youtube/v3/docs/channels) (U2),
[channelBanners.insert](https://developers.google.com/youtube/v3/docs/channelBanners/insert) (U3),
[channelBanners resource](https://developers.google.com/youtube/v3/docs/channelBanners) (U4),
[channels.list](https://developers.google.com/youtube/v3/docs/channels/list) (U5),
[quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) (U6).

- **One part per request, replaced whole.** U1: "You can only update any one of those parts with a single request"; the method
  "overrides the existing values for all of the mutable properties that are contained in the part"; "If ... your request does not
  specify a value for a property that already has a value, the property's existing value will be deleted." So the
  `brandingSettings` write echoes every settable property it read; only the draft's fields are replaced.
- **Settable `brandingSettings` properties (U1, "You can set values for these properties").** `brandingSettings.channel.country`,
  `.description`, `.defaultLanguage`, `.keywords`, `.trackingAnalyticsAccountId`, `.unsubscribedTrailer`. Required: `id`.
- **Title.** U1 (`channelTitleUpdateForbidden`): "When updating a channel's brandingSettings part, you must set the
  brandingSettings.channel.title property's value to the channel's current title or omit the property. The API returns an error
  if you change the property's value." The write repeats the title exactly as read (and the read-back checks it unchanged).
- **Description.** U2 `brandingSettings.channel.description`: "The property's value has a maximum length of 1000 characters."
  (characters, not bytes; no forbidden characters are documented -- `<`/`>` are refused anyway, conservatively, as in BL-210).
- **Keywords.** U2 `brandingSettings.channel.keywords`: "The value is a space-separated list of strings. Channel keywords might be
  truncated if they exceed the maximum allowed length of 500 characters or if they contained unescaped quotation marks (")."; "the
  500 character limit is not a per-keyword limit but rather a limit on the total length of all keywords." How a keyword with a
  space is written is not documented: the app writes it in double quotes (as YouTube Studio shows it), counts the quotes and the
  separating spaces in the 500, and refuses a keyword containing `"` (never truncated by YouTube, conservative).
- **Banner upload.** U3: "1. Call the channelBanners.insert method to upload the binary image data to YouTube. The image must have
  a 16:9 aspect ratio and be at least 2048x1152 pixels. We recommend uploading a 2560px by 1440px image. 2. Extract the url
  property's value from the response ... 3. Call the channels.update method ... Set the brandingSettings.image.bannerExternalUrl
  property's value to the URL obtained in step 2." "Maximum file size: 6MB"; "Accepted Media MIME types: image/jpeg, image/png,
  application/octet-stream"; "A call to this method has a quota cost of 50 units." Errors `bannerAlbumFull`, `mediaBodyRequired`.
  U4: the response is a `youtube#channelBannerResource` with `url`.
- **Banner on the channel.** U2: `brandingSettings.image.bannerExternalUrl`: "This property specifies the location of the banner
  image that YouTube uses to generate the various banner image sizes for a channel." `channels.list part=brandingSettings` returns
  it. U2 also marks the `brandingSettings.image` object "deprecated" (every other image child individually), and U1's settable
  list does not name `bannerExternalUrl`.
- **Deprecated, never sent.** U2: `brandingSettings.watch` "This object and all of its child properties have been deprecated"
  (`featuredPlaylistId`: "The API returns an error if you attempt to set its value"), `brandingSettings.hints` deprecated.
- **Avatar.** U2 `snippet.thumbnails` (default 88×88, medium 240×240, high 800×800) is read-only; no method sets it. The name has no
  update path either (the title rule above). Both are shown read-only with a YouTube Studio link.
- **Quota.** U1/U6 `channels.update` 50 units; U3/U6 `channelBanners.insert` 50 units; U5/U6 `channels.list` 1 unit.

**Deviations from the plan above (the docs win):**

1. **Exact 16:9.** U3 says "must have a 16:9 aspect ratio" with no tolerance: the app refuses any banner whose width × 9 ≠
   height × 16 (2048×1152, 2560×1440 pass; 2560×1441 is refused). No maximum dimension is documented; none is enforced.
2. **The banner property is documented on U3/U4 but missing from U1's settable list** (and its parent object is marked deprecated).
   The app follows U3's documented three steps (`brandingSettings.image.bannerExternalUrl`), and echoes the banner URL as read
   when the draft has no banner (U1's deletion rule: leaving it out could remove the channel's banner). Whether YouTube keeps
   exactly the URL sent is unknown until the first real apply: the read-back compares it and reports `read_back_mismatch`
   (`banner not set`) rather than hiding a difference. A banner can only be replaced, never removed.
3. **Only the documented settable fields are echoed** (the six above plus the title as read, and the banner URL). A
   `brandingSettings.channel` field YouTube returns outside that list is not sent (sending it risks `invalidBrandingOption`); the
   read-back reports it if YouTube dropped it.
4. **The read** is `channels.list part=snippet,brandingSettings,localizations` (still 1 unit), so the read-back can prove the
   translations (BL-210) unchanged.

## Implementation notes (2026-10-25, branch `feature/bl-223-channel-branding`)

- Module `src/lib/channel-branding/`, schema v109, Factory API 1.32.0, Agent API 4.6.0; ADR 0050; acceptance tests
  `services.test.ts` (AC-CB-01..08, 10), `no-agent-apply.test.ts` (AC-CB-09), `gateway-inventory.test.ts` (AC-CB-11), the route
  and MCP tests.
- §5 said workers follow "how BL-217 exposed the channel translations to workers" -- BL-217 never did (ADR 0047 keeps them the
  Operator's). The branding tools are added to `WORKER_FACTORY_TOOLS` like the other channel tools, pinned to the bound channel,
  the draft recorded as saved by `worker`; channel translations stay out of channel sessions.
- Draft semantics chosen: a field left out = unchanged on YouTube; `""` / `[]` clear it; `keepBanner` keeps the stored banner on a
  save that does not send a new one. A banner cannot be removed (no documented way), only replaced.
- The preview is `POST .../preview` (the task asked for POST; BL-210 used GET).

## Acceptance (written before the code)

- **AC-CB-01** Saving a valid draft (description, keywords, a 2560×1440 PNG) stores it and copies the banner; no YouTube call.
- **AC-CB-02** Save refuses the whole draft: a 2047×1152 banner, a 7 MB banner, a 4:3 banner, a GIF, a description over the
  limit, a banner path with `..` or absolute; nothing is stored.
- **AC-CB-03** Apply with description + keywords: one `channels.update part=brandingSettings` whose body repeats every other
  settable field exactly as read (country, defaultLanguage, trailer, tracking id) and the title per the docs; read-back ok.
- **AC-CB-04** Apply with a banner: `channelBanners.insert` then the update carrying the returned URL; order checked.
- **AC-CB-05** Banner uploaded, update fails → `banner_uploaded_not_set`, the result says the old banner stays; audit shows both.
- **AC-CB-06** Wrong channel → refused before any write. Live writes off → refused, no gateway write.
- **AC-CB-07** The draft saved after the preview (other `draftVersion`) → `branding_changed`, no write.
- **AC-CB-08** Read-back shows another field changed or a draft field differing → `ok: false`, `read_back_mismatch`, backup kept.
- **AC-CB-09** No MCP tool or agent endpoint reaches the banner upload or the branding update (source scan).
- **AC-CB-10** `get` returns the draft, the live values (name and avatar included) and the last result.
- **AC-CB-11** The write-gateway inventory lists `channelBanners.insert` and the `brandingSettings` update only inside
  `youtube-write-gateway`; the localization writer (BL-210) still never writes `brandingSettings`.
