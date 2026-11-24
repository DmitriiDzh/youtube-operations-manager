# ADR 0068 — Cross-posting to other networks: one social gateway, accounts per channel, the owner approves every post

Status: Accepted for stage 1 (2026-11-14, BL-252). Owner, Telegram 2026-11-14: msg 4243 (path 1: our own YTM module), 4245 (every
network with an API; each channel connects its own, chosen in the UI), 4279 (back to integrating other networks), 4291/4293/4297
(Meta first; business portfolio «YouWave Studio»). Plan: `docs/roadmap/plans/CROSS_POSTING_PLAN.md`.

## Decision
1. **One gateway** `src/lib/social-gateway/` (AGENTS.md §G, one gateway per API category) is the only code that reaches a social
   network's API; one child per network (`meta.ts` today). `social-gateway/inventory.test.ts` fails on any other caller.
2. **One feature module** `src/lib/cross-posting/` (AGENTS.md §M) owns the accounts and, from stage 2, the posts. Turning it off
   or removing it breaks nothing else; YouTube paths never depend on it.
3. **The owner's own Meta app** (Facebook Login for Business + Instagram API with Facebook Login), in development mode with the
   owner's own Pages — no app review is needed while it only touches accounts the app's admins own. App ID + App Secret are this
   computer's device secret `meta_app` (ADR 0042), entered on the Mac only (proxy `REMOTE_BLOCKED_PREFIXES`), never returned.
4. **Accounts per channel**: `social_accounts` (schema v121, device-local) — one row per (channel, network) with the Page token
   sealed by the device key; the user token is never stored. Connect = Meta consent with a single-use random `state` (15 min,
   bound to the redirect URI) → the owner picks the Page → its Instagram professional account comes with it.
5. **No post without the owner's approval** (stage 2): a post is a draft until the owner approves it in the Web UI; no MCP or
   agent path publishes. TikTok and Pinterest stay paused (audit / review needed), owner decision later.

## Consequences
- Each computer connects its own accounts (tokens do not travel in snapshots).
- Page tokens from a long-lived user token do not expire on a schedule, but revoking the app or changing the password does;
  a rejected token surfaces as `social_token_invalid` and the owner connects again.
- Graph API version is pinned in `meta.ts` (`v23.0`), UNVERIFIED until the first real connect.

## Amendment 1 — stage 2: posting rides on the weekly-plan slot (2026-11-14; owner msgs 4337/4339/4344)

1. **One entry, one approval (AC-XP-10/15).** Social posts are part of the slot's `yt-release-package/2` manifest, in an
   optional top-level `crossPost` block: `{ "instagram": { "caption", "shareToFeed"?, "at"? }, "facebook": { "title"?,
   "description", "at"? } }` (`at` = "HH:MM" in the plan's time zone on the slot's date; absent = the slot's `publishAt`).
   The publishing parser ignores unknown keys (checked: `packages.ts` picks fields), so older builds (Windows) are unaffected,
   and the slot approval's manifest SHA-256 (ADR 0062) already covers the captions, networks and times — any change voids it.
   A slot approved without a package fingerprint (the `slot` stage) never posts to a social network (fail closed). The video
   is the package's own `files.video`. No separate post request, Producer tools or sync family (replaces the plan's earlier
   "Post request" shape).
2. **YTM fires every network itself** at the planned time; Facebook's own scheduling is not used (a veto or a change after
   approval must still stop a post). Immediately before each mutating call: the switch «Публикация в соцсети» (this computer,
   off by default), the slot decision (approved, same manifest SHA, not vetoed) and the identity read (AC-XP-8).
3. **AI label:** `is_ai_generated` on the Instagram container and the Page Reel finish call — from the package's
   `containsSyntheticMedia`, else the channel's publishing setting (the same value the YouTube upload sends).
4. **Jobs:** one row per (channel, slot, network) on the computer that posts (device-local table); the remote container /
   video id is stored before the publish / finish call, so a restart checks status instead of posting twice (AC-XP-6). An
   in-flight social upload holds restart-when-idle (§N), like a YouTube upload.
5. **Composition, not coupling (§M):** `src/composition/` joins the slot decisions and the package scan to the cross-posting
   runner; `publishing` and `publishing-plans` never import `cross-posting`.
6. **App mode:** while the Meta app is in development mode, posts are visible only to the app's roles (Meta App Modes doc);
   public posts need the app Live, which needs a public Privacy Policy URL — an owner decision.
7. **Social posts do not wait for YouTube** (owner msg 4360, «Оставь как есть»): an approved slot posts to its networks at its
   time even if the YouTube upload did not happen -- the approval covers the whole package.

## Note — BL-267 (ADR 0073, owner TG 4630–4636 O10, 2026-11-16; with that merge)

Amendment 1's "the owner's approval of one manifest SHA-256 authorizes the posts" widens: one plan for YouTube and the social networks.
A slot authorizes its package's `crossPost` when the weekly plan dates it -- a match of the owner's approved week template with his
media approval (where the channel has the review gate), or his explicit one-slot date -- evaluated also for slots up to 36 h past and
bound to the slot's CURRENT manifest SHA-256, which the runner re-checks before each Meta call (`socialSlotStates`). A vetoed slot, a
slot whose video carries a date this computer did not set, or one the template no longer dates, posts nothing.

## Amendment 2 — every network posts or stops on its own (2026-11-23; owner TG 4779)

Cause: from 20.11 Meta blocked the channel's Instagram, the Page's answer lost `instagram_business_account`, and the channel-wide
identity read refused every post (`social_account_mismatch (instagram_unlinked)`), so Facebook Reels S6–S8 were never posted.
Owner: «даже если одна из соц сетей отваливалась — оставшиеся продолжали обновляться и получать свои публикации».

1. **AC-XP-8 per network.** One Meta read of the stored Page token, judged per connected network: Facebook needs a valid token,
   its scopes (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`) and Meta's live Page equal to the stored one;
   Instagram needs the same plus `instagram_basic`, `instagram_content_publish` and the live linked account equal to the stored
   one. Each network still fails closed. `token_invalid` and `page_mismatch` concern the one Page token, so they stop every Meta
   network; `instagram_unlinked`, `instagram_mismatch` and `instagram_unreadable` stop only Instagram. The Page (`id,name`) and its linked
   Instagram are two separate reads: the Page read failing fails every network; any failure of the Instagram read makes only
   Instagram unreadable (fail closed) -- a definite refusal (4xx) fails its job with `instagram_unreadable`, a failure that proves
   nothing (no answer, timeout, 5xx, rate limit) is refused as `social_unavailable` so Instagram waits and asks again (an
   Instagram job already processing is never failed for it). `debug_token`'s `profile_id`, when Meta gives one, must be the
   stored Page too (else `page_mismatch` for every network). The runner's port is `postingTarget(channelId, network)`; a refusal stays
   `social_account_mismatch` with `details.problems` (`not_connected` when no account of that network is stored), and the job
   records its own network's problem as its code.
2. **One lane per network in the runner.** Each network's pass runs concurrently and sequentially by slot, with its own identity
   read (before the quota gate, so a refusal is recorded on that network's job at once), quota, jobs and errors; a step that
   throws is skipped for that pass only; a network whose pass is still running (a long upload) is skipped by the next tick while
   the others run. Per-network behaviour (upload, status read, identity, quota) sits in tables keyed by network, so a new network
   is a new entry, never a branch of a shared check.
3. **Surfaces.** `checkAccounts` adds `networks` (additive; the top-level `ok`/`problems` are their union); the Settings card shows
   the result per network. No MCP tool exposes the check, so no MCP contract version changes.
4. **The owner's retry posts however late (owner TG 4780).** «Повторить» in the Web UI (`POST /api/social/jobs/retry`, no MCP or
   agent path) records `owner_retry_at` on the failed job (schema v123, additive, device-local) instead of deleting it. The runner
   then starts that job again with no 12 h window, and the plan's social read evaluates that slot past its 36 h look-back
   (`socialSlotStates(channelId, { alsoSlotIds })`); the slot approval (current manifest, not vetoed), the network's identity read,
   its quota and the video's sha256 apply unchanged, and a job that sent its publishing call or has a post id is never retried
   (the mark is one conditional update on `status = failed`, `publish_attempted = 0`, no post id). Late is allowed, early never:
   the retry waits for the slot's (possibly moved) planned time. The mark is cleared when the runner takes the job over, and
   otherwise with the job's own code whenever it can no longer be carried out without a new click: refused again by the
   identity read (the network's code), `retry_slot_not_approved` (the slot no longer approved or listed for that network --
   also when the plan read fails: fail closed; a mark set while a pass was reading the plan waits for the next pass), `retry_blocked` (the package's block or video refused for that network),
   `retry_expired` (the mark is older than 48 h; a slot moved more than 48 h past the retry therefore expires, not posts). A full
   24 h limit keeps the mark, shown as `retry_waiting_quota`. A slot read past the look-back only for a retry or an in-flight
   job never counts against a current slot of the same video in the "one video in two approved slots" rule (the old slot
   itself is still disapproved). A late automatic start stays `missed_window`.
