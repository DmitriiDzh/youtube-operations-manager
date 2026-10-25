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

## API facts (to be filled by the implementer from the official Data API v3 reference before code)

`channels.update` (parts, replace semantics, settable `brandingSettings` fields, title rule, errors, 50 units), `channels`
resource (description and keywords limits and format, banner property names returned by `channels.list`),
`channelBanners.insert` (media types, size, dimensions/aspect, quota, response, how the URL is then set), `channels.list`
(1 unit). Each fact with its source URL and a short quote, like CHANNEL_LOCALIZATIONS_PLAN.md. Where the docs contradict this
plan, the docs win and the deviation is listed here.

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
