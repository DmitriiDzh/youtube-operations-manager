# 0004. Every channel-scoped read is filtered to the session's active channel

Status: Accepted

Decided directly with the project owner over Telegram, 2026-09-20, resolving `docs/TECHNICAL_DEBT.md`
RISK-02 ("No per-user channel ownership boundary") as an explicit product decision.

## Context

RISK-02 documented that `listChannels()` and every channel-scoped read endpoint (videos, change
sets, batches, editorial profile, AI-localization generation/provenance, localization
export/import) return data for **any** locally-known channel, regardless of which Google
account/session is asking — mitigated only by treating the whole application as a "single local
operator" tool (`docs/PROJECT_SPEC.md` §37). RISK-02 was `OPEN`, gated
`BLOCKS_NETWORK_DEPLOYMENT`, explicitly awaiting a project-owner product decision.

The trigger: the project owner had tested this application against multiple different YouTube
channels/accounts over time on the same device. The Sync tab's channel picker (a documented,
spec'd feature — `docs/PROJECT_SPEC.md` §61, `docs/ARCHITECTURE.md` §5.1) showed every one of
those channels, not just the one currently signed in — because `channels` is a single, unfiltered
table (`src/lib/db.ts`'s `listStoredChannels()`) with no ownership/session filter applied anywhere
downstream. The project owner's explicit instruction: **"filter any information the user can see
exclusively to whichever channel is currently active"** — literally every read surface, not only
the Sync picker.

## Problem

Two things needed deciding that RISK-02 itself left open:

1. **What does "active channel" mean?** The codebase already had a `selectedChannelId` concept
   (`users.selectedChannelId`, `src/lib/write-context/service.ts`), but it was used *only* by the
   write-safety guardrail (`assertWriteChannel`) and *only* ever set via MCP/CLI's
   `auth select-channel` — the Web UI never called it. A pure Web UI user's `selectedChannelId`
   would be permanently `NULL`. Meanwhile, the Web UI's own intuitive notion of "active channel"
   was a live, per-request `youtube.channels.list({mine:true})` call
   (`/api/youtube/channel-info`), never persisted anywhere.
2. **How is it enforced without violating the read paths' documented invariants?** `channel-sync`,
   `changesets`, `batches`, `localization` and `ai-localization` reads are all documented as
   making zero live YouTube API calls. Reusing `assertWriteChannel`'s live-OAuth cross-check for
   every read would add YouTube API quota cost and latency to every list/get, and would be a
   different, stricter guarantee than a read actually needs (a write's "never fire against the
   wrong channel even under stale local state" justification does not apply to a local-only read).

## Decision

- `users.selectedChannelId` remains the single, shared "active channel" concept — reused, not
  duplicated (`AGENTS.md` §D). A new `src/lib/channel-access` service wraps it for the read side:
  `assertActiveChannel` (throws `CHANNEL_NOT_ACTIVE`, fail-closed — no active channel resolved
  yet is never treated as "everything visible"), `getActiveChannelId`, `filterToActiveChannel`
  (for list endpoints), and `activateChannel`.
- `selectedChannelId` is kept fresh for the Web UI **for free**, from places that already resolve
  the live OAuth-active channel: `GET /api/youtube/channel-info` (fetched once per dashboard load)
  and `channel-sync`'s `syncChannel` when called **without** an explicit `channelId` (the "sync my
  own channel" / `channels.list({mine:true})` path). No new "select active channel" UI step was
  added — the existing dashboard load flow already resolves this data; persisting it is the only
  change.
- `syncChannel` called **with** an explicit `channelId` (the "re-sync a previously-known channel"
  picker action) never activates that channel. `getChannelForSync` does an unauthenticated-scope
  public `channels.list(id=...)` lookup in that case (not cross-checked against the OAuth session
  at all — see the follow-up risk noted below), so it must never be trusted as evidence of which
  channel is genuinely "mine."
- `assertActiveChannel`/`filterToActiveChannel` is applied at every channel-scoped read entry
  point across all three interfaces (Web API routes, MCP tools, CLI commands): channel listing,
  video listing, change-set list/get/approve/reject/approve-all/reject-all, batch
  list/get/audit/errors/prepare, editorial profile, AI-localization generate/provenance,
  localization overview/detail/export/import/import-preview. Where a domain's service functions
  already receive a `credentialRef` (channel-sync), the check lives once in the service layer;
  where they don't (changesets/batches/localization/ai-localization), it is checked once per entry
  point, mirroring the codebase's existing `assertWriteChannel`/`requireBatchForChannel` pattern
  of "one implementation, multiple call sites" rather than threading identity into every service
  signature.
- No live YouTube API call is added to any read path — `selectedChannelId` is a plain local
  lookup, preserving every affected domain's "zero live YouTube calls" invariant.

## Rationale

Reusing the already-existing, already-tested `selectedChannelId` field (rather than introducing a
second "active channel" concept, or reusing `assertWriteChannel`'s stricter live-match check)
keeps this a narrow, additive change: one new lightweight service, wired into two places that
already resolve the live channel, checked at existing entry points. It resolves RISK-02 more
precisely than RISK-02's own original framing (`connectedUserId`-based, i.e. "belongs to this
user") — the owner's actual instruction is *per-active-channel*, not merely *per-user*: a user
with several locally-synced channels only ever sees the one currently active, not all of their
own.

## Consequences

**Easier:** the Sync picker, and every other channel-scoped view, now only ever shows the
channel the caller is actually signed in as (or explicitly activated via CLI/MCP) — closing the
exact leak the project owner observed. RISK-02 is resolved.

**Harder / follow-up items intentionally left out of this change:**

- A brand-new session (before its first `channel-info` fetch or first "sync my channel") sees
  empty lists everywhere until `selectedChannelId` is resolved once — a deliberate fail-closed
  choice, not a bug.
- `getChannelForSync`'s explicit-`channelId` path remains an unauthenticated-scope public lookup
  with no ownership check on the **write** side (re-syncing a foreign, previously-known
  `channelId` still succeeds and still writes to local storage — it just can no longer be *seen*
  afterward, since it's never the active channel). This is a related but distinct, pre-existing
  gap, tracked separately in `docs/TECHNICAL_DEBT.md` (RISK-39) rather than folded into this
  read-scoping change.
- The Sync tab's channel `<select>` dropdown (`src/components/channel-sync.tsx`) will now only
  ever list zero or one channel in practice. Left as-is (still functionally correct) rather than
  redesigned as part of this change; a UI simplification pass is a separate, optional follow-up.

## Compatibility / migration impact

No schema change (`users.selectedChannelId` already existed). No data migration. Existing MCP/CLI
users who already ran `auth select-channel` are unaffected. Existing Web UI users see empty
channel-scoped views until their next dashboard load re-resolves `selectedChannelId` via
`GET /api/youtube/channel-info` — a one-time, self-healing transition, not a persistent
regression.
