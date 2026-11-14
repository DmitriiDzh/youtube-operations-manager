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
