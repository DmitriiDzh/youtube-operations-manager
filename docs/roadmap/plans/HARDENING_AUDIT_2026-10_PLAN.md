# Architecture-audit fixes (2026-10-01): plan and acceptance criteria

**Assigned** by the owner (Telegram, msg 1073): *"Составь план исправлений и приступай к его
реализации"* ("Make a plan of fixes and start implementing it"). This follows the independent
audit of `dev` @ 7679651: two read-only reviewers, one on modularity (`AGENTS.md` §M) and one on
implicit architectural divergences.

Everything is on one branch (`feature/hardening-audit-2026-10`). There is one independent-review
cycle at the end, then one merge-approval request.

**Principle.** Behavior changes only where a finding is a real bug. The modularity items are
mechanical moves with re-exports and no behavior change. The acceptance criteria below are
stated from the finding and its rule, not from the implementation (`AGENTS.md` §L).

## Package 1 — Hardening (bugs: safety and reliability)

| Slice | Finding | Fix | Acceptance |
|---|---|---|---|
| H1 | Every process start (CLI, MCP, web) resets the shared `live_writes_enabled` to false. So the CLI can never write live, an agent silently switches the operator's toggle off, and a running Batch that hits the reset is left `APPLYING`, which triggers recovery mode. | Reset only when the **web server** boots (`src/instrumentation.ts` `register()`), never on DB initialization in MCP/CLI. In Batch execution, a `live_writes_disabled` raised *before anything was sent* becomes a clean, retry-safe `FAILED` with the lock released, never a stuck `APPLYING`. | AC-H1-1: initializing the DB in a non-web process leaves an enabled flag enabled. AC-H1-2: the web boot hook resets it to false. AC-H1-3: a batch row whose attempt is refused by the live-writes gate ends `FAILED` (not `APPLYING`/`UNKNOWN`), with its video lock released and no recovery-mode trigger. |
| H2 | `GET/POST /api/settings` is all-or-nothing over 10 feature reads; one failure hides the safety toggles. Live writes and 4 unrelated cards share one error boundary. | `Promise.allSettled`: a failed field becomes `null`, with its name listed in `unavailable`. POST reports its write result independently of snapshot failures. One `FeatureErrorBoundary` per Settings card. | AC-H2-1: any single failing read gives 200 with the other fields intact. AC-H2-2: a POST that saved succeeds even if an unrelated read fails. |
| H3 | `upsertChannel` always overwrites `channels.connected_user_id`, including to NULL for a raw-access-token credential. An operator re-sync of another channel by id silently re-owns or disconnects it and kills its agent token. | Set `connected_user_id` only from the implicit "my channel" sync path, and never to NULL. An explicit-id sync updates the metadata only. Update RISK-39. | AC-H3-1: an explicit-id sync of channel B leaves B's `connected_user_id` unchanged. AC-H3-2: a sync with no user identity never clears it. AC-H3-3: the implicit sync still records the owner. |
| H4 | Recovery mode or the operation lock blocks the operator's stop switches: turning MCP / Live writes off, revoking an agent token, disconnecting a channel. | Exempt from the device mutation gate: `POST /api/settings` (device-local `app_settings` only), `DELETE /api/agent-tokens`, and `POST /api/channel-connections/disconnect`. None of their tables travel in a snapshot. | AC-H4-1: under recovery mode those three respond normally. AC-H4-2: every other mutating route is still 423/409. |
| H5 | Legacy `apply` sets `snippet.defaultLanguage` from a single-localization fallback. §F forbids the localization pipeline touching `defaultLanguage`, and no RISK entry exists. | Never set `defaultLanguage` as a side effect; preserve the video's existing value. Add a RISK entry for the legacy path's residual behavior if any remains. | AC-H5-1: `apply` on a video with no `defaultLanguage` does not add one. AC-H5-2: an existing `defaultLanguage` is sent back unchanged. |

## Package 2 — Modularity (§M), no behavior change

| Slice | Finding | Fix |
|---|---|---|
| M1 | The shared kernel (`DomainError`, codes, `parseWithSchema`, credential types) and Google credential resolution live inside the `video-metadata` feature. This causes an 8-module dependency knot that includes both YouTube gateways. | New `src/lib/shared-domain/` (kernel) and `src/lib/google-credentials/` (resolver), with the files moved as-is. `video-metadata` re-exports for compatibility. Callers are switched to the new modules. Playbook §6.2/§6.4 is updated. |
| M2 | `ai-connections` (shared AI transport) imports its consumers' mock providers and types. | Consumers register their own mock providers and own their request types; `ai-connections` knows no consumer. |
| M3 | Three loggers, two of which write `info` to stdout (the MCP stdio protocol channel and the CLI JSON channel). | One `shared-logger`, with all levels on stderr. Remove the copies and the re-export shim. |
| M4 | Four plain tmp+rename writes in `sync-gateway` bypass the RISK-22 Windows retry / fsync single implementation. | A byte-level `writeFileAtomic` in `atomic-json-file`, used by all four. |
| M5 | The app-wide mutation gate is owned by the `device-handoff` feature. | Extract `assertDeviceAvailableForMutation` / `RecoveryModeError` into a small `device-mutation-gate` module, used by proxy, MCP, CLI, device-handoff and the others. |
| M6 | Unclassified tables for handoff/device-locality. The Details audit trail (`video_edit_audit_events`) is silently dropped on handoff, while the Batch trail travels. The weekly-reports reasoning is wrong. | Classify every table explicitly in `snapshot/contracts.ts`. `video_edit_audit_events` travels, like `audit_events`. Correct the comment. Add a test that every table in the schema is either transferred or explicitly listed as device-local. |
| M7 | Coarse UI error boundaries (Research ×7, Home ×2, AI Agent ×4), and the Home fetch coupling. | One boundary per panel or card. Home fetches are independent. |
| M8 | Deep reach-ins into other modules' internals, and no general guard against them. | Export via barrels, switch callers, add a module-boundary inventory test. |

## Package 3 — Documentation and small consistency items

- Remove stale zone references (`AGENT_OPERATIONS_INTERFACE` error table, `interfaces.md`,
  `ARCHITECTURE`, `SYSTEM_MAP`, comments) and add the Phase 12 error codes.
- Make the `interfaces.md` MCP tool list agent-accurate.
- Fix the stale comments in `db.ts` (live-writes location, "restricted-mode").
- Playbook §6.8's CLI namespaces; ADR 0004's list of activation sources.
- A7 `expectedChannelId` optionality and A8 "analytics day" definitions: document the actual
  rules in ARCHITECTURE (no behavior change). A6 GET routes that write state: document them.

## Deliberately not in scope

- Splitting `db.ts` into per-feature files, and per-feature migration chains. This is recorded in
  TECHNICAL_DEBT with a trigger; it is a large refactor with no bug behind it.
