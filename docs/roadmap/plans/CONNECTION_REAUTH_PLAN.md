# Google Connection Health & Re-login Prompt Plan (BL-115)

**Status 2026-10-03: implemented on `feature/bl-115-connection-reauth`** (owner assigned: "начинай реализацию"). Clarification made during implementation: AC-1's "exactly 7 d => `reauth_required`" holds when no real check could run; a *passing* real check proves the grant works, so age >= 7 d then reads `ok` (and 6-7 d `expiring_soon`). An `invalid_grant` is final at any age. Pure verdict + tests: `src/lib/channel-connections/connection-health{,.test}.ts`.

Produced 2026-10-03 at the project owner's request (Telegram, after the Mac showed "Active channel: Loading..."
forever). **This is a plan, not an implementation** (`AGENTS.md` §C): nothing here starts until the owner assigns it.

## 1. The gap (found, not assumed)

- On a device whose stored Google grant has gone stale (a refresh token revoked or expired, e.g. the 7-day limit that
  Google applies to refresh tokens while an OAuth consent screen is in *Testing* status), `GET /api/youtube/channel-info`
  answers `502 channel_info_unavailable` (`src/app/api/youtube/channel-info/route.ts`).
- The dashboard swallows that (`fetchChannel` in `src/app/dashboard/page.tsx` returns silently), so the header stays on
  **"Loading..."** forever.
- Settings → Channels (`channel-connections-settings.tsx`) shows only "Active now" / Activate / Disconnect. A stale
  connection looks identical to a healthy one.
- Tokens are per device by design (never synced), so each computer finds out separately, and today only by accident.
- The app stores no refresh-token **issue date** (`users` has `access_token`, `refresh_token`, `token_expiry` = the
  *access* token's expiry, `oauth_scope`, `selected_channel_id`), so the age of a grant cannot be computed.

## 2. Goal (owner's words, paraphrased)

On dashboard load, check how old each stored connection's grant is. If it is too old / no longer valid, ask for a new
Google login **immediately**, using the recently built shared modal modules (popup + dimmed, blurred background).

## 3. Design

**3.1 Two signals, one verdict per connection** (new service in `src/lib/channel-connections/`, no new module):

| Signal | Source | Role |
|---|---|---|
| Age | new nullable `users.refresh_token_issued_at` (set whenever a sign-in/token exchange returns a refresh token: `auth.ts` sign-in callback and the token-exchange paths; never from a refresh) | early warning, no network |
| Real check | one token-endpoint refresh attempt per connection (`invalid_grant` => dead; network/other error => `unknown`, never blocks) | authoritative |

Verdict per connection: `ok` · `expiring_soon` · `reauth_required` · `unknown`.
- `reauth_required`: real check said `invalid_grant`, **or** age >= 7 days (the Testing-status limit).
- `expiring_soon`: age >= 6 days (a day of margin), real check still passing.
- `unknown`: no issue date yet (every existing row) and the real check could not run. Rows with no issue date are
  checked for real once; a successful check does not invent an issue date.
- The age threshold is a named constant, because it only applies while the app is in Testing status (open question 1).

**3.2 Check timing.** Once per dashboard load, for **all** stored connections of this device (owner: both channels
must be visible), not only the active one. Result cached ~10 min server-side so reloads do not hammer Google. The
token-endpoint call is not a YouTube Data/Analytics call: no quota, not subject to the read-gateway toggles, but it
lives next to the existing `auth.ts` client factory (the only place besides the gateways that may import `googleapis`).

**3.3 API.** `GET /api/channel-connections/health` -> `[{ channelId, title, state, ageDays | null, checkedAt }]`.
Local + one Google token call, never returns token material (`AGENTS.md` §F). A failed check is logged without the
token. A failed `channel-info` call also marks that connection `reauth_required` when the cause is `invalid_grant`.

**3.4 UI** (reuse, do not rebuild):
- Extract the dim + `backdrop-blur-sm` fixed overlay from `operation-progress/operation-overlay.tsx` into one small
  shared `BlockingDialog` shell (the overlay and `ConfirmDialog` keep their behaviour; only the shell is shared).
- Dashboard load: if any connection is `reauth_required`, show the blocking popup, not dismissable by Esc/backdrop,
  listing which channel(s) and one **"Sign in with Google"** button per channel. `expiring_soon` shows the same popup
  with a **"Later"** button and does not block.
- Re-login uses the existing flow (`signIn("google")`, which already requests `access_type: offline` and
  `prompt: "select_account consent"` so a new refresh token is issued) with `login_hint` set to that connection's
  email, so the right account is offered.
- Settings → Channels: a status badge per row (Connected · Expires in N days · Reconnect needed) and a "Reconnect"
  button on the same flow.
- Header: replace the eternal "Loading..." with "Reconnect needed" when `channel-info` fails with
  `channel_info_unavailable`; keep "Loading..." only while the request is genuinely pending.

**3.5 Not in scope:** auto-refreshing tokens in the background, changing OAuth scopes, moving the OAuth app out of
Testing status (an owner action in Google Cloud), syncing tokens between devices (rejected by design), any YouTube
write. No change to Live writes / write-safety gates.

## 4. Slices (one branch, per `AGENTS.md` §K.1)

1. Schema v41 `users.refresh_token_issued_at` + set it at every refresh-token issuance + tests.
2. Health service (pure verdict function with injected clock, real-check adapter, cache) + `GET .../health` + tests.
3. `BlockingDialog` extraction + dashboard-load popup + header message + Settings badges/Reconnect.
4. Docs (`SYSTEM_MAP`, `ARCHITECTURE`, ADR 0010 note), then verification on both Mac and Windows.

## 5. Acceptance criteria (written from the requirement, before code; `AGENTS.md` §L)

- AC-1: age 6d 23h 59m -> `expiring_soon`; exactly 7d -> `reauth_required`; 5d 23h 59m -> `ok` (injected clock).
- AC-2: a real check returning `invalid_grant` -> `reauth_required` regardless of age; a network error -> `unknown`
  and never shows the blocking popup.
- AC-3: no issue date + passing real check -> `ok`, issue date stays NULL; no issue date + failed check -> `unknown`.
- AC-4: an existing database (all NULL dates) migrates without data loss and without any popup on first load when the
  real check passes.
- AC-5: with two stored connections where only the non-active one is dead, the popup names that one; the active
  channel's data still loads.
- AC-6: the popup cannot be closed with Esc or a backdrop click while `reauth_required` is present; "Later" exists only
  for `expiring_soon`.
- AC-7: no response, log line or UI text contains an access/refresh token (`AGENTS.md` §F); the endpoint is
  session-scoped and returns only this user's connections.
- AC-8: after a successful re-login the new `refresh_token_issued_at` is set, the badge turns to Connected, and the
  header shows the channel title.
- AC-9: negative: Disconnect behaviour is unchanged (it stays out of the reconnect flow).

## 6. Open questions for the owner

1. ~~Is the consent screen in Testing status?~~ **Answered by the owner (2026-10-03): yes, Testing.** So Google's 7-day refresh-token limit applies and the 7-day / 6-day thresholds are real, not advisory. (If the app is ever moved to production, only the age signal becomes advisory; the real check still decides.)
2. ~~Which account becomes active after a re-login?~~ **Answered by the owner (2026-10-03):** the popup lists **every account that needs a new login** and the user picks which one to sign in first (it becomes the active session; the others stay listed until done). Replaces the earlier default; §3.4 is amended accordingly: one popup, a row per affected account with its own "Sign in with Google" button, "Later" only when no row is `reauth_required`.
3. ~~Should `expiring_soon` interrupt with a dismissable popup, or only show the Settings badge?~~ **Answered by the owner (Telegram, 2026-10-03): a popup** (as §3.4 already specifies, with a "Later" button). Questions 1 and 2 were put to the owner in plainer words; the plan keeps its defaults until answered: the age threshold stays a constant, and re-login as another account makes that account the active session (the sign-in flow signs in one account at a time).

## 7. Risks

- `prompt: "select_account consent"` shows Google's account picker every time; the hint narrows it but cannot skip it.
- A real check on every dashboard load is a Google call per connection (cached 10 min); on a flaky network the verdict
  stays `unknown` and never blocks.
- Adds one nullable column to a persisted table: needs the full schema-change reading pass and a pre-migration backup
  (the app already takes one).

## Addendum 2026-10-04 (BL-126): the Google Cloud grant gets the same check

Raised by the owner (Telegram, msg 1374): the Cloud/Monitoring connection also dies 7 days after it is issued (found live: connected 2026-09-22, last refresh 2026-09-29, no Monitoring call since, quota bars empty without a word).
- **Same rules, one implementation.** `cloud-connection` `getHealth()` reuses `classifyConnectionHealth` and the 10-minute probe cache from `channel-connections`; the age counts from `cloud_connection.connected_at`.
- **Date fix.** `connected_at` is now reset by a (re)connection (`completeConnect` passes it) and NOT by an access-token refresh; before, an in-place reconnect kept the old date and would have shown "expired" forever.
- **Same list.** `GET /api/channel-connections/health` appends the Cloud row (`kind: "cloud"`); the dashboard dialog lists it with "Reconnect Google Cloud" (the existing consent flow). Unlike a dead channel login, a dead Cloud grant never blocks the app (it only feeds quota statistics): a dismissable dialog.
- **No more silence.** `getQuotaStatus` sets `tokenRefreshFailed: true` when the grant cannot be turned into an access token; the Settings quota bars then show "Google Cloud connection expired - reconnect" instead of an empty space, and the Cloud card shows an expired/expiring notice with a Reconnect button.
- No schema change.
