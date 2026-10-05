# 0024. Agent token import: one token usable on several devices, channel id embedded in channel tokens

Status: Accepted

**Date:** 2026-10-05.

**Decided** by the owner (Telegram, 2026-10-05, msgs 1572–1580): a channel agent's token and the Factory Operator's token should be the same on
every device. Of the two variants offered, the owner chose the operator pasting an already-issued token on each additional device (variant A) over
syncing token hashes through Syncthing (variant B). Plan and acceptance criteria: `docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md`.

## Context

Agent tokens (`agent_channel_tokens`, Phase 12; `factory_agent_tokens`, ADR 0022) are hash-only and device-local: not in the snapshot, not in
sync-gateway. A token issued on one device was unknown on every other, so an agent configuration could not be reused across the owner's machines.
The plaintext of a channel token did not say which channel it belonged to, so a manual import would have had to trust the operator's channel choice.

## Decision

1. **Import as a second way to register a token** (`importToken` in `src/lib/agent-tokens` and `src/lib/factory-agent-tokens`;
   `POST /api/agent-tokens/import`, `POST /api/factory-agent-token/import`; "Use an existing token" in Settings). It applies the same checks as issuing
   (for a channel: connected on this device and its identity owning it live), stores only the SHA-256 in the same table, and revokes the previous
   active token on this device. Re-importing the active token is a no-op; a token this device has revoked is refused and stays revoked.
2. **Channel tokens embed their channel id:** `ytom_ch_<channelId>.<secret>`. Import binds only to the embedded channel (`AGENT_TOKEN_CHANNEL_MISMATCH`
   otherwise), and verification additionally requires the embedded id to equal the stored row's channel. Legacy tokens (`ytom_ch_<secret>`) still
   verify but cannot be imported (`AGENT_TOKEN_IMPORT_LEGACY_FORMAT`); the factory token format is unchanged.
3. **Storage stays device-local; nothing is synced.** Revocation is per device (RISK-108).
4. Import is operator-only (Web session) and goes through the normal mutation gate; agents have no way to register a token. No MCP contract changes.

## Consequences

- Amends AC-P12-11 (`PHASE_12_PLAN.md`) and AC-FO-10 (`FACTORY_OPERATOR_ACCESS_PLAN.md`): a token may be registered by issuing or by import; the
  remaining wording (hash only, shown once at issue, device-local, one active, a new registration revokes the previous) stands.
- A leaked token must be revoked on every device where it was entered (RISK-108).
- Channel connections (Google OAuth) and the MCP master switch remain per device; the operator still sets them up on each device.
