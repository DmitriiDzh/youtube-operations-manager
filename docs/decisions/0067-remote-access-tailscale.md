# ADR 0067 — Access from the owner's other devices over Tailscale, with a password

Status: Accepted (2026-11-14, BL-251). Owner, Telegram 2026-11-14: msg 4210 (reach YTM from the phone, a simple password),
4212/4215/4216 (Tailscale chosen, its safety), 4214 (Tailscale installed on the phone), 4219 («Делай 251»), 4221/4224
(Tailscale over ZeroTier). Plan and acceptance criteria: `docs/roadmap/plans/REMOTE_ACCESS_PLAN.md`.

## Context
YT Manager is local-first (`docs/PROJECT_SPEC.md` §37): the server listens on 127.0.0.1 and the Web UI signs in through Google
with YouTube scopes and a localhost callback. The owner wants the same app on his phone. `docs/TECHNICAL_DEBT.md` lists a
network-exposure gate (CSRF, a reachability inventory, deployment assumptions) that any exposure must address.

## Decision
- **Transport:** the owner's own Tailscale network only. `tailscale serve --bg --https=443 http://127.0.0.1:3000`
  (`scripts/macos/remote-access.sh`) publishes the app as `https://<mac>.<tailnet>.ts.net` with a real certificate. The server
  keeps binding 127.0.0.1; no LAN listener, never Funnel (the public internet).
- **Remote = forwarded from another device** (`loopback-guard.isRemoteRequest`), measured on a real `tailscale serve` 1.104.7:
  it keeps the tailnet Host, sets `X-Forwarded-For` to the client's tailnet address and `X-Forwarded-Host`, and writes
  `Tailscale-User-Login/-Name` (overwriting forged ones); it sends no `X-Forwarded-Proto`. Next.js fills in
  `x-forwarded-*` from the socket on EVERY request (loopback values for the Mac's own), so presence alone means nothing
  (security review C1). Remote = a non-loopback Host or forwarded host, a non-loopback forwarded-for address, or any
  `Tailscale-User-*` / `Forwarded` header. Such a request is never loopback: MCP and loopback-only routes stay Mac-only.
- **The gate (`src/proxy.ts`, pages and APIs, before every exemption):** the switch «Доступ с других устройств» (on by default once a password is set, owner msg 4228) off
  → 403; MCP, device handoff / sync, moving or replacing cloud keys (Gemini, ElevenLabs, RunPod, HF, GitHub), agent tokens,
  Google sign-in / cloud connection (localhost callbacks), this computer's paths, the hub relay secret, disconnecting a
  channel, the operation lock and the remote-access settings → 403 Mac-only; a mutating method needs an `Origin` whose host is the request's
  own host (CSRF; the scheme is not compared since no X-Forwarded-Proto arrives); a remote session must carry `remote: true` and the current epoch and come from the pinned Tailscale login.
- **Sign-in:** NextAuth Credentials provider `remote-password` (remote requests only): the switch, the password (scrypt,
  constant-time compare, 5 wrong in 15 min → 15 min lock, persisted), then a session for the most recently connected channel's
  stored identity (no Google round-trip; the `signIn` callback never touches its tokens, like `channel-connections`). The JWT
  carries `remote` and `remoteEpoch`; switching channel from the phone keeps both.
- **State on this Mac only:** `<app data>/remote-access.json` (0600, atomic): switch, hash + salt, epoch, pinned login, failures.
  Not in the database, so a device handoff never carries it. A password change or switch-off bumps the epoch: phone sessions end
  at once. The first successful remote sign-in pins its `Tailscale-User-Login`; later remote requests must carry the same.
- **UI:** the login page shows a password form on a remote host; Google connect / reconnect buttons are hidden there; sign-out
  never follows NextAuth's localhost redirect. Settings → Общие card (changes only on the Mac).

## Consequences
- The network-exposure gate is addressed for this deployment only (the owner's tailnet): CSRF origin check on remote mutations,
  the reachability inventory above, the assumptions written here. Still open: plaintext local token storage (RISK-07), dependency
  advisories (RISK-06), best-effort upload size (RISK-01) -- acceptable inside one person's private network, not beyond it.
- New risk RISK-153 (a proxy that strips the headers; the owner's Tailscale account as the outer trust boundary).
- No MCP / API version change: agents keep their Mac-only endpoints.

## Verification (2026-11-14)
On this Mac with Tailscale 1.104.7, the branch's production build on port 3100 (isolated app data) behind a temporary
`tailscale serve --http=8081`: switch off → every remote page and API 403 while local requests and the MCP loopback check pass;
switch on → MCP, keys, agent tokens, handoff 403 Mac-only, no / foreign Origin 403, the login page 200, a wrong password refused,
the right one pinned the Tailscale login, 5 wrong passwords locked even the right one. HTTPS needs "HTTPS Certificates" enabled
in the tailnet's DNS settings (the owner's admin console) before `remote-access.sh enable`.
