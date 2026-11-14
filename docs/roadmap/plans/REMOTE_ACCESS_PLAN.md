# BL-251 — YT Manager from the owner's phone over Tailscale, with a password (plan and acceptance criteria)

Owner, Telegram 2026-11-14: msg 4210 (reach YTM from any device, a simple password), 4212/4215/4216 (Tailscale chosen, its
safety), 4214 (Tailscale on the phone; "do the Mac side"), 4219 («Делай 251»), 4221/4224 (Tailscale over ZeroTier).
Changes the deployment model (`docs/PROJECT_SPEC.md` §37, `docs/TECHNICAL_DEBT.md` "network exposure" gate): reachable from the
owner's own tailnet only, never from the LAN or the internet. New ADR.

## Shape
- The server keeps binding 127.0.0.1. `tailscale serve --bg --https=443 http://127.0.0.1:3000` (Tailscale for macOS, the
  owner's account) publishes it to the tailnet as `https://<mac>.<tailnet>.ts.net` with a real certificate. No Funnel.
- A request is **remote** when its Host is not loopback OR it carries a proxy header (`X-Forwarded-For`, `X-Forwarded-Host`,
  `Forwarded`, `Tailscale-User-Login`) -- whatever `tailscale serve` does with Host.
- New feature module `src/lib/remote-access/` (AGENTS.md §M): the switch «Доступ с других устройств» (ON by default once a password is set, owner msg 4228; off only when switched off), a password
  stored as a scrypt hash (app setting; never the password), a failed-attempt counter.
- `src/lib/loopback-guard`: a request with a proxy header is never loopback -> every MCP endpoint and every loopback-only route
  stays Mac-only through tailscale serve too.
- `src/proxy.ts`, for remote requests only: switch off -> 403 for everything; `/api/mcp*` -> 403 always; a mutating method
  needs `Origin` equal to the request's own origin (CSRF, the network-exposure gate); `/api/auth/*` passes (login).
- NextAuth CredentialsProvider `remote-password`: switch on + right password (rate-limited) -> a normal session for a
  connected channel's stored identity (like `channel-connections`: no Google round-trip, tokens untouched). Every route keeps
  its own session check unchanged.
- Login page: on a remote host a password form instead of Google; `signIn("remote-password", { redirect: false })`.
- Settings → Общие: «Доступ с других устройств» card -- switch and password, changeable only from the Mac (loopback); shows
  the Tailscale steps. en + ru texts.
- `scripts/macos/remote-access.sh enable|disable|status`: runs `tailscale serve` for the owner (no sudo).

## Acceptance criteria
- AC-RA-1 Remote detection: Host `mac.tail1234.ts.net` -> remote; Host `127.0.0.1:3000` with `X-Forwarded-For` or
  `Tailscale-User-Login` -> remote; plain `127.0.0.1:3000` / `localhost:3000` -> local.
- AC-RA-2 `isLoopbackRequest` is false whenever a proxy header is present (MCP endpoints refuse with AGENT_ENDPOINT_NOT_LOOPBACK).
- AC-RA-3 Proxy, remote request: switch off -> 403 on a page and an API; switch on -> `/api/mcp`, `/api/mcp/factory` 403;
  POST without Origin or with another origin -> 403; POST with its own origin passes; `/api/auth/callback/...` passes.
  Local requests behave exactly as before (existing proxy tests unchanged).
- AC-RA-4 Password: set from the Mac only (a remote request -> 403); minimum 8 characters; stored as scrypt hash + salt; a
  wrong password is refused; after 5 failures in 15 minutes every attempt is refused for 15 minutes (even the right one).
- AC-RA-5 `remote-password` sign-in: switch off -> refused; right password -> the identity of a connected channel with a
  usable token; no channel -> refused; the sign-in never touches stored OAuth tokens.
- AC-RA-6 Turning the switch off ends remote access at once (next request 403), sessions stay valid on the Mac.
- AC-RA-7 No secret in logs or API answers (status shows `passwordSet: true/false` only).

## Not in scope
LAN exposure; Funnel; per-device accounts; changing the Google login; phone layout polish (later, if the owner asks).
