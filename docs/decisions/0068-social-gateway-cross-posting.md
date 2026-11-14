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
