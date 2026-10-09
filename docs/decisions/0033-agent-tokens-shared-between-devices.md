# 0033. Agent tokens shared between devices: hashes and revocations travel through the device sync

Status: Accepted (supersedes [ADR 0024](0024-agent-token-import.md) §3 "Storage stays device-local; nothing is synced")

**Date:** 2026-10-09.

**Decided** by the owner (Telegram, 2026-10-09). Msg 2198: the tokens live in the channel folders that Syncthing shares, "так что я
ожидаю что эти токены везде будут одинаковы". Msg 2200: "можно сделать чтобы токены всех агентов работали одинаково". Msgs 2205/2207:
the folder-trust consequence, the "newest wins" rule and "disconnect no longer revokes" were put to the owner and accepted ("3 и 4
ок"). This reverses the 2026-10-05 choice of variant A (paste on each device, msg 1577). Plan: `docs/roadmap/plans/PRODUCER_ROLE_PLAN.md`
§2 (BL-160).

## Context

Since BL-130 a token worked on a second device only after the operator pasted it there ("Use an existing token"), and a revocation
applied only where it was made (RISK-108). The owner keeps each token in a file in the folder of the agent that uses it, which
Syncthing shares between the computers, and expects that file to work on every computer as it is.

## Decision

1. **A per-device report family `agent-tokens`** in `src/lib/sync-gateway` (the `media-sessions` shape, ADR 0028): each device
   publishes every agent token it knows -- channel, Factory Operator and Producer -- as `{hash, role, channelId, userId, label,
   createdAt, revokedAt}`. Only the SHA-256 travels, never the token. The family merges nothing and imports nothing from the token
   modules.
2. **The rules live in `src/lib/agent-token-sync`** (shared by the three token modules, owned by none, AGENTS.md §M), as one pure
   function every device evaluates on the same records:
   - joined by hash; a hash revoked on any device is revoked (earliest time); a revocation is never undone;
   - a peer record for a known hash under another role, channel or Google account is ignored; peers disagreeing about an unknown
     hash: skipped;
   - one active token per slot (each channel, the factory, the producer): the newest `createdAt` wins (equal: the larger hash),
     the others are revoked as of the winner's `createdAt`.
3. **Applying** is one transaction on this device's own token tables (revocations first, then learned tokens, so the one-active
   indexes never see two active rows). Verification is unchanged: each token module reads only its local table, so a known token
   keeps working when the shared folder is unavailable. A learned channel token still needs the channel connected on that device
   under the Google account recorded at issue (`users.id` is Google's `sub`, the same on every device).
4. **When**: after every device-sync cycle (60 s) and 5 s after start; an issue, import or revoke on this device publishes at once
   without applying peers (so a revoke made in recovery mode still leaves the device).
5. **Disconnecting a channel no longer revokes its token** (the revocation would reach every device). The token stops working on that
   device while the channel is not connected there.
6. **Import stays** for a device on an older build or without the shared folder. The token tables stay out of the snapshot: only
   this family fills them, so a snapshot import can never roll a revocation back.

## Consequences

- RISK-108 is resolved: a revocation reaches every running device within about two minutes plus Syncthing's delivery; a device
  that is off accepts the token until it syncs.
- New RISK-117: the shared folder is trusted. Its reports are not signed, so whoever can write "YT Manager Data" can register a token
  hash or publish a report. Exposure set unchanged in practice: on the owner's Mac the T9 drive has ownership disabled, so every local
  account can already read the plaintext token files kept in the channel folders, and the service answers loopback calls from every
  account (RISK-105 extended).
- Rule 3 trusts device clocks; a report dated more than 5 min ahead is refused (per-device report rule).
- A device on a build without BL-160 neither sends nor receives tokens; both computers update.
- Amends `AGENT_TOKEN_IMPORT_PLAN.md` AC-TI-08 and AC-TI-10 (the requirement changed: owner msg 2200).
