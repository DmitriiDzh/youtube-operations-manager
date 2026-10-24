# 0048. Channel workers' YouTube writes: declared as EXECUTE, never public, never a playlist delete, always logged

Status: Accepted

**Date:** 2026-10-24. **Decided by** the owner, Telegram msg 3384 (answers 1–4 to DEV-RESP-0040's questions). Request: FO-REQ-0037
(Factory Operator) and PRD-REQ-0019 (Producer). Plan: `docs/roadmap/plans/WORKER_CAPABILITIES_PLAN.md` (BL-215).

## Context

- Since Phase 12 (ADR 0011, owner decision D4 «один агент отвечает за все на одном канале») a channel-bound agent (a "worker") can
  call every `bound` tool, among them five that write to YouTube: `apply` (a video's main title/description) and
  `playlist_create`/`_update`/`_add_videos`/`_remove_videos`, plus `playlist_delete`. The binding confines them to the worker's
  channel; Live writes still gate each one.
- The capability inventory (`agent_get_capabilities`) never listed those tools, and `GRANTED_PERMISSIONS` still said
  `READ + DRAFT` (`docs/AGENT_OPERATIONS_INTERFACE.md` §3). Workers trusted the inventory and refused a privacy change the token
  could make (PRD-REQ-0019). That is a discrepancy between the documentation and the implementation since Phase 12, recorded here.
- `docs/PROJECT_SPEC.md` §26 ("AI may propose. Human approves. System applies.") allows "specific trusted rules" later. The owner's
  D4 and msg 3384 are those rules for a worker's own channel.
- Two gaps: a worker could make a playlist public, which FO-REQ-0037 keeps owner-only, and these writes left no per-call record.

## Decision

1. **The inventory tells the truth.** A new domain `youtube_writes` lists the writing tools with permission `EXECUTE`;
   `GRANTED_PERMISSIONS` becomes `READ`, `DRAFT`, `EXECUTE`. `APPROVE` is still never granted: a worker never approves its own
   drafts (Change Sets, media sessions, collection requests stay owner-approved). A test ties the inventory to the channel tool
   registry in both directions.
2. **Never public.** In an agent session `playlist_create` and `playlist_update` refuse `privacyStatus: "public"` with
   `AGENT_PUBLIC_NOT_ALLOWED` (`src/lib/channel-access`'s agent scope, checked by the playlist core right after input validation, before any credential or YouTube call). The owner's
   Web UI is unchanged.
3. **No playlist delete.** `playlist_delete` becomes `operator-only` (not registered for a worker). It cannot be undone; a worker
   makes a playlist private instead (owner, answer 3).
4. **`apply` stays** a real write for workers (owner, answer 2), logged.
5. **A worker log.** Schema v107 `worker_action_log`, device-local, 90 days: one row per worker call that would really write
   (`apply` with `dryRun: false`, every call of the four playlist tools), refused calls included (a revoked token too; a call the MCP SDK rejects on its input schema never reaches the tool and cannot write). It is written by the channel
   session's MCP wrapper, outside the tool's own result (a log failure never changes the answer). The owner reads it in Settings →
   Channels; a worker reads its own channel's rows with `agent_list_worker_actions`.

## Consequences

- `AGENT_API_VERSION` 4.0.0 (MAJOR): a worker loses `playlist_delete` and `public`.
- Stage 2 (BL-216, Agent API 4.1.0) adds `agent_set_privacy` under the same rules: private/unlisted only, logged with the previous
  status, refused for a scheduled video and the app's current broadcast. It is allowed by the owner's Live writes switch, like
  every other write (owner msgs 3386/3389: no separate approval per change).
- Stage 3 (BL-217, Agent API 4.2.0) gives a worker 28 of the Factory Operator's channel tools as `agent_*` (domain
  `channel_production`): the factory server's own tools over channel-pinned deps (`src/mcp/worker-factory-tools.ts`; the wiring
  moved to `src/lib/factory-tool-deps`, shared with the factory route). Local writes are DRAFT and logged; the modules keep the actor
  `factory`, because their synced shapes accept only `factory`/`owner` (the worker log says which worker wrote).
- `docs/AGENT_OPERATIONS_INTERFACE.md` §3 and §8 are updated: §8's "no new YouTube write path" still holds (every write goes through
  the write gateway, the write-channel guardrail and Live writes), but a worker's writes are no longer only drafts.
