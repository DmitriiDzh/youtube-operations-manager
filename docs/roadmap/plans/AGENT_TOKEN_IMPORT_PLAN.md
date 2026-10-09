# Agent token import: one token usable on every device — plan

**Backlog:** BL-130. **Requested:** owner, Telegram 2026-10-05 (msgs 1572–1577). The owner expects a channel agent's
token, and the Factory Operator's token, to be the same on every device. Variant A was chosen (msg 1577): the operator
pastes an already-issued token into Settings on each additional device. There is no automatic sync. Variant B
(syncing token hashes through Syncthing) was considered and not chosen.

**Status:** approved by the owner (Telegram msg 1580, 2026-10-05); implemented on `feature/bl-130-agent-token-import`.

## 1. What exists today (`dev` at `6d13303`)

- Channel tokens: `src/lib/agent-tokens/` (prefix `ytom_ch_`, table `agent_channel_tokens`). Factory Operator token:
  `src/lib/factory-agent-tokens/` (prefix `ytom_fo_`, table `factory_agent_tokens`).
- Both tokens are `prefix + base64url(32 random bytes)`. Only the SHA-256 hash is stored, the plaintext is shown once,
  and issuing a token revokes the previous one (one active per channel / one active factory token).
- Both tables are device-local: not in `SNAPSHOT_TRANSFERRED_TABLES` and not in sync-gateway
  (`src/lib/snapshot/contracts.ts:39-44`). The only way a token becomes valid on a device is being issued there, so a
  token issued on device A gets `AGENT_TOKEN_INVALID` on device B.
- On every call, a channel token is also checked against `channels.connected_user_id` on the device answering the call.
  `users` and `channels` are device-local too, so device B must have the channel connected under the same Google
  identity. This plan does not change that; the operator still connects each channel on each device.
- The MCP master switch (`app_settings`) is per device; it is also unchanged.

## 2. Design

### 2.1 A second way to register a token: import

Each token module gets an operator-only `importToken` next to `issueToken`. The operator pastes a plaintext token. The
service validates it, applies the same checks as issuing, and stores its SHA-256 hash in the same table through the
same `replace` transaction. Nothing new is stored: the same columns are used, with a new row id per device and no
schema migration.

### 2.2 Channel tokens carry their channel id (new format)

A channel token's plaintext does not currently say which channel it belongs to. An import would therefore need the
operator to pick the channel, and pasting channel A's token into channel B's row would give the agent configured for
A access to B on that device. That is a wrong-channel binding, which `AGENTS.md` §G requires to fail closed.

- **New issue format:** `ytom_ch_<channelId>.<secret>`, where `<secret>` is base64url of 32 random bytes (43 chars).
  YouTube channel ids and base64url never contain `.`, so the separator is unambiguous. The total length is about 76,
  under the existing 200 cap. The hash still covers the full string.
- **Import binds to the channel embedded in the token.** The import is started from a specific channel's row in the
  UI, so the request also carries that row's `channelId`. A mismatch is `AGENT_TOKEN_CHANNEL_MISMATCH`, and nothing is
  stored.
- **Verify, defense in depth:** for a new-format token, the embedded channel id must equal the stored row's
  `channelId`, otherwise the result is `AGENT_TOKEN_INVALID`.
- **Legacy tokens** (`ytom_ch_<secret>`, issued before this change) keep verifying exactly as today. They cannot be
  imported (`AGENT_TOKEN_IMPORT_LEGACY_FORMAT`), and the UI says to reissue on the source device. The live database on
  the owner's Mac currently has no channel tokens at all.
- The Factory Operator token has no binding, so its format is unchanged.

### 2.3 Import rules (both token kinds)

1. **Strict format check:**
   - right prefix for the endpoint, so a `ytom_fo_` token is rejected in a channel row and the reverse;
   - exact secret length and alphabet;
   - surrounding whitespace is trimmed, nothing else is altered.

   A failure stores nothing and leaves the current active token untouched.
2. **Same live identity check as issuing** (channel tokens, AC-P12-11): the channel must be connected on this device,
   and its recorded identity must own the channel live (`AGENT_TOKEN_CHANNEL_NOT_CONNECTED` /
   `AGENT_TOKEN_IDENTITY_MISMATCH`).
3. **One active per channel / one active factory token** still holds per device: an import revokes the previous
   active token, exactly like issuing.
4. **Already known on this device:**
   - if the hash is already active for the same binding, the import is an idempotent success: no new row, nothing
     revoked;
   - if the hash belongs to a revoked row, the import is refused (`AGENT_TOKEN_IMPORT_REVOKED`). A token revoked on a
     device stays revoked on that device.
5. **The plaintext never leaves the request handler:**
   - the response carries only the metadata summary;
   - error messages and details never include the submitted value;
   - nothing logs it.
6. **Revocation stays per device.** Revoking on device A does not revoke on device B. The UI says so next to the
   revoke action, and a new risk entry records it (§5).

### 2.4 Surfaces

- **API (operator Web session only, like issuing):**
  - `POST /api/agent-tokens/import` `{ channelId, token, label? }`;
  - `POST /api/factory-agent-token/import` `{ token, label? }`.

  Both are mutating routes behind the normal `src/proxy.ts` device-availability gate. They are not exempt, unlike
  revoke.
- **UI:** in each channel's agent-token field (`channel-agent-token-field.tsx`) and in the factory token settings
  (`factory-agent-token-settings.tsx`), add an inline "I already have a token" input next to "Issue":
  - a password-type field and a submit button, with no native browser dialogs; replacing an active token on this device first asks for confirmation in the app's ConfirmDialog, like Rotate (owner, msg 1584);
  - success shows the same metadata as issuing, never the token;
  - a short note explains that a token works on every device where it is entered, and revoking applies to this
    device only.
- **MCP / CLI:** none. Agents can never register tokens. `AGENT_API_VERSION` and the factory API version are
  unchanged, because no tool contract changes.

## 3. Slices (one branch `feature/bl-130-agent-token-import`, separate commits, one merge)

| Slice | Content |
|---|---|
| T1 | Domain, for both modules: new channel-token format and its verify check, `importToken`, the new error codes, plus unit tests written from §4. |
| T2 | API routes, the proxy gate check, and route tests (401, validation, no token echo). |
| T3 | UI for both token fields. |
| T4 | Docs: ADR 0024; the amendment notes on AC-P12-11 and AC-FO-10; `AGENT_ISOLATION_SETUP.md`, `SYSTEM_MAP.md`, `ARCHITECTURE.md`, RISK-108. Then a live smoke on two isolated app-data directories simulating two devices (`HOME` redirected; the real database is never touched). |

## 4. Acceptance criteria (written before implementation, `AGENTS.md` §L)

| ID | Criterion |
|---|---|
| AC-TI-01 | A channel token issued on device A, imported on device B for the same channel (connected there, identity owns it live), verifies on B's `/api/mcp` with that channel binding. A's token row is unaffected. |
| AC-TI-02 | Importing a channel token into a different channel's row fails with `AGENT_TOKEN_CHANNEL_MISMATCH`. Nothing is stored, and the row's existing active token stays active. |
| AC-TI-03 | Import with the channel not connected, or with the identity not owning it live, fails with the same codes as issuing. Nothing is stored. |
| AC-TI-04 | Each of the following is rejected with nothing stored and the current active token unchanged: wrong prefix (`ytom_fo_` in a channel row, `ytom_ch_` in the factory field), a legacy channel format, a wrong secret length, a non-base64url character, an empty string, or more than 200 chars. |
| AC-TI-05 | An import revokes the previously active token on that device (per channel / the factory token). The old token's next call returns `AGENT_TOKEN_INVALID`. |
| AC-TI-06 | Re-importing the active token is idempotent: no new row, no revocation. Importing a token revoked on this device is refused with `AGENT_TOKEN_IMPORT_REVOKED` and stays revoked. |
| AC-TI-07 | The submitted plaintext appears in no response body, no error body, and no captured log line. Only its SHA-256 hash is stored. |
| AC-TI-08 | Revoking on one device leaves the same token valid on another device. This is the documented limitation. **Superseded 2026-10-09 (BL-160, ADR 0033): the requirement changed -- the owner chose synced tokens (msg 2200); a revocation now reaches every device (AC-ST-02).** |
| AC-TI-09 | A new-format channel token verifies only if its embedded channel id equals the stored row's channel. Tokens issued in the legacy format before this change still verify. |
| AC-TI-10 | Both token tables remain excluded from the snapshot and from sync. The existing classification tests are unchanged. **Amended 2026-10-09 (BL-160, ADR 0033, owner msg 2200): still excluded from the snapshot; the `agent-tokens` sync family now fills them (hashes only).** |
| AC-TI-11 | An imported factory token works on `/api/mcp/factory` and is rejected on `/api/mcp`. An imported channel token is the reverse. |
| AC-TI-12 | Without a Web session, import returns 401. Import goes through the mutation gate: it is blocked in recovery mode, while revoke stays exempt. |

## 5. Requirement and risk changes

- **AC-P12-11 / AC-FO-10 amendment** (justification per `AGENTS.md` §L: the owner's new requirement, msg 1577).
  - Storage stays device-local and hash-only, and nothing is synced or handed off; that part of both criteria
    stands.
  - What changes: a token may be registered on a device either by issuing it there or by an operator importing an
    already-issued plaintext. Both paths apply the same checks.
  - "Issuing again revokes the previous token" also holds for import.
- **New RISK-108:** one token may be valid on several devices, and revocation is per device. A leaked token must be
  revoked on every device where it was entered. The exposure is the same loopback-only, same-OS-user boundary as
  RISK-105. Re-evaluation trigger: if tokens ever become reachable off-loopback, or if variant B (synced revocation)
  is assigned.
- **ADR 0024** records the token-format change and the import path.

## 6. Out of scope

- Automatic propagation of tokens or revocations (variant B).
- Syncing Google OAuth connections, or the MCP master switch.
- Changing the factory token format.
- Any YouTube write or paid AI call.
