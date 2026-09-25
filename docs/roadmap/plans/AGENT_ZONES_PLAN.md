# AGENT_ZONES_PLAN.md — Multi-Agent Responsibility Zones

**Status, 2026-09-25: all three slices (data model, enforcement, Settings UI) implemented on
`feature/agent-connections`.** Both open scope questions in §9 were answered by the owner the same
day. An `advisor()` consultation (not the independent-review cycle, which had not started yet)
found the initial enforcement policy violated the owner's own exclusivity rule (an unassigned
capability stayed open to any enabled connection even with 2+ active) -- fixed before slice 2 was
presented as complete; see §5/§7's "as actually implemented" notes. Remaining before merge: a full
independent-review cycle, then the owner's explicit "yes, merge" (`AGENTS.md` §K.2).

## 1. Origin and problem statement

Project owner, Telegram, 2026-09-25 (verbatim, translated): "About agent connection... can we
make it so Claude can connect too? Either/or, or scenarios where they work together?" — followed,
after establishing that any MCP client can already connect today with zero code changes, by:

> "Это по домену. Например Клод делает переводы и анализ аналитики. А кодекс делает ассеты, тк
> Клод не может сгенерировать изображения. Или одни задачи может эффективнее делать одним
> агентом, а другой скоуп другим. Но при этом все должны работать в одном информационном поле.
> Например создание новых ассетов каким-то образом должно опираться на анализ прошлых креативов,
> даже если этот анализ делал другой агент."

Two requirements, in tension unless deliberately reconciled:

1. **Exclusivity**: when N agents are connected at once, a given zone of responsibility must
   belong to exactly one of them, never shared.
2. **Shared context**: all agents must still see the same underlying data and each other's
   conclusions — an asset-creating agent must be able to draw on analysis another agent produced.

## 2. What already satisfies requirement 2, unmodified

No new work needed here. Confirmed by direct inspection (`src/mcp/server.ts`, `src/lib/agent-operations/services.ts`):

- Every READ-tier capability (`analytics.*`, `asset_catalog.*`, `comparable_content.*`,
  `asset_performance.*`, `channel_context`/`video_context`) is already unconditionally callable by
  any connected client — the underlying data is the same local SQLite database for everyone.
- `content_proposal.get_content_proposal` / `list_content_proposals` / `list_proposal_artifacts`
  (owner spec §18/§19) already let one agent read another agent's filed proposal, including its
  `evidence`/`rationale`, and any artifact registered against it. This is the existing mechanism
  for "asset creation should draw on another agent's analysis" — Claude can file a Content
  Proposal citing analytics evidence, Codex can read it and register the artifact it produces
  against that same proposal. No new object type is needed for this.

Requirement 2 is a non-issue as long as zone enforcement (below) never touches READ.

## 3. Full mutating/DRAFT tool inventory (why this is bigger than the agent-operations module alone)

`grep registerTool src/mcp/server.ts` gives 46 registered tools. They fall into three, not two, families — this matters because a plan scoped only to the new Phase 7 `agent_*` namespace would miss most of the actual local-mutation surface an agent can already reach:

| Family | Tools | Current gate |
|---|---|---|
| **Real YouTube writes** (barrier-disabled today, Gate B/RISK-09) | `apply`, `playlist_create/update/delete/add_videos/remove_videos` | `assertLiveWritesAuthorized` (single gateway choke point, `AGENTS.md` §G) — already agent-agnostic and already fails closed. Zoning these is moot while Gate B stays closed, but the classification should still cover them for when it opens. |
| **Local-mutation, pre-Phase-7 general MCP surface** (designed for one operator-grade client, no permission tiering beyond the single `connectionEnabled` toggle) | `write_channel_select`, `auth_user_select`, `changeset_create_from_import`, `channel_sync`, `ai_localization_generate`, `ai_localization_create_change_set` | Only `assertMcpDeviceAvailable` (operation-lock/device-availability gate) + `connectionEnabled`. No per-capability permission concept at all. |
| **Phase 7 agent-operations DRAFT tier** (the only family with an actual permission model) | `content_proposal.create_content_proposal`, `content_proposal.register_external_artifact` (the only two `AGENT_CAPABILITIES` entries with `permission: "DRAFT"`) | `GRANTED_PERMISSIONS = ["READ","DRAFT"]`, uniform, no per-agent identity. |

**Correction (post-implementation): this is adjacent to, but not the same gap as, `docs/TECHNICAL_DEBT.md` RISK-32.** RISK-32 is specifically about `proxy.ts`/CLI/MCP each independently classifying which operations need the *device-availability/recovery-mode* gate (`assertDeviceAvailableForMutation`) — a different concern (data-integrity-during-migration/recovery) from agent-identity zoning. The actual implementation below does not build an exhaustive, mechanically-enforced classification of all ~46 MCP tools (an earlier draft of this plan mistakenly claimed it would, and that it would close RISK-32) — it adds an *opt-in* `zoneCapabilityId` parameter used only at the 6 call sites the owner approved zoning for (§9's scope answer), verified by name-specific behavioral tests, not a repo-wide static inventory. RISK-32 remains OPEN and untouched by this work; do not cite this plan as having resolved it.

### Open scope question 1 (needs owner answer before slice 2)

Does "zone of responsibility" apply to:

- **(a) Only the Phase 7 agent-operations DRAFT tier** (`create_content_proposal`,
  `register_external_artifact`) — the smallest, already-permission-modeled surface; or
- **(b) The full local-mutation surface**, including `channel_sync`, `changeset_create_from_import`,
  `ai_localization_generate`/`create_change_set` — i.e. "Claude owns localization" would also mean
  only Claude's connection can create AI-localization Change Sets, not just file evidence-bearing
  proposals about them.

**Recommendation: (b), with the real-YouTube-write family (`apply`/`playlist_*`) always excluded
from per-agent zoning and left operator-only** (`write_channel_select`/`auth_user_select` also
operator-only — see §4). Reasoning: the owner's own example ("Клод делает переводы") describes the
localization *generation* workflow itself, not just proposal-filing about it — scoping to (a) alone
would not actually enforce the split the owner described. `apply`/`playlist_*` stay out because
Gate B already fails them closed for everyone, so zoning them adds complexity with no present
effect.

## 4. Concurrency hazard found during design — active-channel state

`getActiveChannelId(userId)` (`src/lib/channel-sync/services.ts`) is keyed by the **OAuth user**,
not by agent connection. In this app's actual deployment model (single local operator, one real
Google identity — `AGENTS.md` §F's own accepted "no per-user ownership boundary" tradeoff), two
agent connections sharing that one identity would also share one global "active channel." If
Codex is mid-task on channel A and Claude's connection calls `write_channel_select` to switch to
channel B, Codex's next call would silently resolve against the wrong channel.

**Resolution proposed for this plan: `write_channel_select` and `auth_user_select` become
operator-only** — excluded from every agent connection's callable surface regardless of zone
assignment, alongside `apply`/`playlist_*`. An agent's calls already carry `channelId`/
`credentialRef` explicitly on every agent-operations capability (K/L's own established pattern) and
are checked against it (`assertActiveChannel`); switching the *global* active channel from inside
an agent session was never required by any owner spec section and removing it from the agent
surface removes a real race condition for free.

## 5. Proposed module: `src/lib/agent-connections/`

Standard domain-module pattern (`AGENTS.md` §D, `DEVELOPMENT_PLAYBOOK.md` §6.2):
`contracts.ts`/`schemas.ts`/`services.ts`/`adapters/`/`index.ts`.

**Two new tables** (additive, `SCHEMA_MIGRATIONS` next version, per ADR 0001/0002):

- `agent_connections`: `id` (text PK, operator-chosen slug e.g. `"claude"`/`"codex"`), `label`,
  `enabled` (bool), `createdAt`. **No secret/token field** — this is a coordination guardrail
  between an owner-controlled Claude client and an owner-controlled Codex client, not a security
  boundary (the owner configures both ends), so it doesn't need the credential-handling machinery
  `AGENTS.md` §F governs. Per-agent authentication, if ever needed, is a separate, later decision.
- `agent_capability_zones`: `capabilityId` (text PK, e.g. `"content_proposal.create_content_proposal"`
  — an opaque string this module does not validate against any registry, matching an
  `AGENT_CAPABILITIES` entry id where one exists, or a bare MCP tool/CLI command name otherwise),
  `assignedConnectionId` (nullable FK to `agent_connections.id`). **Zoned per capability, not per
  domain** — this is what actually lets `content_proposal.create_content_proposal` (drafting the
  brief) and `content_proposal.register_external_artifact` (registering the produced artifact) go
  to two different agents if the owner ever wants that split, without a later schema change. **As
  actually implemented (slice 3, correcting this paragraph's original design intent)**: the Web UI
  groups capabilities visually under a domain heading, but assigns each one individually via its
  own dropdown — there is no domain-level bulk-assign/"split individually" control. Putting an
  entire domain on one connection ("Codex owns the whole assets domain") still works, just via one
  click per capability in that domain rather than a single domain-wide action — the owner's "по
  домену" framing is satisfied in the resulting state, not via a dedicated bulk-assign affordance.
  A one-click domain-level assign, if ever wanted, would be a separate, later UI enhancement.

**Services**: `registerConnection`, `listConnections`, `setConnectionEnabled`,
`assignCapabilityZone(capabilityId, connectionId | null)`, `listZoneAssignments`, and the
enforcement primitive:

```ts
assertAgentAllowedForCapability(args: {
  capabilityId: string;
  callerConnectionId: string | null;
}): void // throws AgentZoneViolationError, a new DomainErrorCode entry
```

**Default policy, as actually implemented (keyed on ENABLED connections, not merely registered
ones — a disabled connection does not count, so disabling every connection is an explicit escape
hatch back to today's single-agent, zero-behavior-change state):**

- If zero connections are **enabled**: identical to today, no gate.
- Once **one or more** connections are enabled: every mutating capability in scope (§3's answer to
  open question 1) requires a resolvable, enabled, registered `callerConnectionId` — an unknown or
  missing one is rejected, not silently treated as "anyone." This closes the exact gap advisor
  review flagged: a forgotten `AGENT_CONNECTION_ID` env var must never quietly bypass zoning.
  (Read-tier capabilities are never gated by this at all, per §2.)
- A capability with **no zone assigned** (`assignedConnectionId IS NULL`) is open to the caller
  **only while exactly one connection is enabled** — trivially unambiguous, since there is only
  one possible caller. **Once two or more connections are enabled, an unassigned capability is
  rejected for every connection, not shared.** A first implementation missed this and left an
  unassigned capability open to any enabled connection regardless of count, caught by an
  `advisor()` consultation before the independent-review cycle even started — this directly
  contradicted the owner's own exclusivity requirement ("нельзя одну и ту же зону ответственности
  дать обоим") and was fixed before this feature was presented as complete, together with
  regression tests for both the 1-enabled and 2-plus-enabled cases.
- A capability **assigned** to a specific connection rejects every other connection's calls,
  regardless of how many connections are enabled, including an unregistered/unknown caller.

## 6. Identity mechanism

MCP is stdio-per-client: each of Codex/Claude spawns its own `npm run mcp:video-metadata` process,
so there is no shared in-process session to key off. The SDK's own `clientInfo` handshake field is
self-reported by the client and not authenticated — advisor review confirmed this should not be
relied on alone. **Proposed mechanism: an `AGENT_CONNECTION_ID` environment variable**, read once
at `startMcpServer()` startup and threaded through exactly like `credentialRef` already is for K/L
— the owner sets a distinct value in each client's own MCP launch config (Claude Desktop's /
Codex's respective `mcpServers` config file), matching an `agent_connections.id` the owner
registered via the Web UI. **This is explicitly a coordination guardrail, not a security
boundary** — the owner controls both configs, so it prevents accidental cross-zone calls, not a
malicious client. CLI gets the equivalent via a `--agentConnectionId` flag (or the same env var),
required in slice 2 alongside MCP, not deferred — a CLI caller must not be able to bypass zoning
the MCP path enforces.

## 7. Enforcement — as actually implemented (slice 2, 2026-09-25)

One function, `assertAgentAllowedForCapability` (`src/lib/agent-connections/services.ts`), is the
single implementation every zoned call site invokes — never a second copy of the fail-closed
logic itself. Unlike the write/read gateways (ADR 0005/0007), this is **not** a mandatory
classification enforced by a repo-wide static inventory test — an earlier draft of this plan
described that approach and was not followed, to keep the diff scoped to the 6 capabilities the
owner actually approved zoning for (§9's answer), rather than touching all ~46
`registerTool`/CLI-dispatch call sites:

- **MCP** (`src/mcp/server.ts`): `registerTool`'s wrapper takes an *optional* `zoneCapabilityId`
  parameter, passed only at the 6 approved call sites (`channel_sync`,
  `changeset_create_from_import`, `ai_localization_generate`, `ai_localization_create_change_set`,
  `agent_create_content_proposal` → `content_proposal.create_content_proposal`,
  `agent_register_external_artifact` → `content_proposal.register_external_artifact`). A caught
  `AGENT_ZONE_VIOLATION` is converted to the same `isError` tool-response shape every other
  `DomainError` in this file already uses (`toolErrorResult`), never a raw thrown exception.
- **CLI** (`src/cli/video-metadata.ts`): each of the same 6 actions calls
  `assertAgentAllowedForCapability` as its own first line, immediately after resolving
  `channelId`/`credentialRef` where applicable. This is deliberately *not* a single blanket
  `command`-string gate the way the device-availability check above it is — `parsedArgs.command`
  alone is ambiguous across namespaces here (e.g. `"create"` is both `changeset create` and
  `playlist create`), so each zoned call site names its own capability id explicitly instead.
  Identity resolves from `--agentConnectionId` (flag takes priority) or the same
  `AGENT_CONNECTION_ID` env var MCP uses.
- **Verification**: proven by name-specific behavioral tests (`src/mcp/server.test.ts`,
  `src/cli/video-metadata.test.ts`) — a fake `AgentConnectionsCoreSubset` that unconditionally
  denies is injected, and each of the 6 tool/command names is asserted to actually reject, while a
  representative unzoned tool/command is asserted to be unaffected. This proves the wiring exists
  for exactly these 6 call sites; it does not prove exhaustiveness across the full tool surface the
  way a static-source-scanning inventory test would.
- **Not implemented**: `write_channel_select`/`auth_user_select` were *not* moved operator-only —
  the concurrency hazard in §4 remains a documented, tracked risk (`docs/TECHNICAL_DEBT.md`
  RISK-60), not a behavior change, since the owner did not explicitly confirm that specific
  proposal (only the two numbered questions in §9 were confirmed).

## 8. Slice breakdown (one branch, `feature/agent-connections`, final merge needs owner approval per `AGENTS.md` §K.2 — this is a substantive feature)

1. **Data model + module skeleton** — `src/lib/agent-connections/` (contracts/schemas/services/
   adapters/index), the two new tables, CRUD services, full unit tests. **No enforcement wired
   anywhere yet** — pure addition, zero behavior change. **Done.**
2. **Enforcement + CLI parity** — `assertAgentAllowedForCapability` wired at the 6 owner-approved
   call sites in both MCP and CLI, `AGENT_CONNECTION_ID`/`--agentConnectionId` identity resolution.
   See §7's "as actually implemented" note for what this did and did not end up covering. **Done**
   (owner confirmed scope question 1 as "(b)", Telegram 2026-09-25: "1. Согласен").
3. **Web UI** — new component `src/components/agent-connections-manager.tsx` (Settings → AI
   Agent), a connections list (register/enable/disable, reusing `ToggleSwitch`) and a per-domain
   grouped zone-assignment view (`ZONED_CAPABILITIES`, exported from `agent-connections/contracts.ts`
   so this list has exactly one owner, not a copy per consumer). **Done.**
4. **Independent review** — at least one round per this repo's established convention for anything
   touching approval integrity (`AGENTS.md` §L). **In progress as of this update** — several rounds
   have run. No bug has ever been found in the exclusivity/fail-closed policy logic itself
   (`assertAgentAllowedForCapability`); separately, three real bugs elsewhere in this feature were
   found and fixed: a gateway-traffic undercount (a zone rejection wasn't recorded as `blocked`),
   an API route returning 500 instead of 400 for a malformed body, and a Settings UI warning that
   stated the opposite of reality when zero connections were enabled — plus several rounds of stale
   comments/docs describing an earlier, already-superseded design. The cycle is not yet closed (a
   round must find zero issues).
   The final round tally will be recorded here once it closes, per this repo's own convention.

Each slice gets `npm test`/`lint`/`build`; the branch merges to `dev` as one complete, working
feature (`AGENTS.md` §K.1 — "не льем в дев каждую правку"), not per-slice.

## 9. Open questions — resolved, plus what remains

Both original open questions were answered by the owner the same day (Telegram, 2026-09-25):

1. **Scope**: "1. Согласен" — zoning covers the full local-mutation surface (b), not only the
   Phase 7 `agent_*` DRAFT tier.
2. **Snapshot/sync inclusion**: "2. Оставим локально" — `agent_connections`/`agent_capability_zones`
   stay per-device, excluded from `SNAPSHOT_TRANSFERRED_TABLES`, as this plan recommended.

**Resolved same day:** the `asset register` CLI gap (§4/`interfaces.md`) — the project owner
confirmed (Telegram, 2026-09-25) it is not a gap: "Если она не доступна агентам, то не вижу
проблемы... пользователь может дополнять работу агентов по своему усмотрению" (a human operator
using this application directly was never meant to be constrained by agent zoning).

**Remaining before this feature is ready to present as finished:**

- A full independent-review cycle (§8 item 4) — in progress, not yet closed.
- The owner's explicit "yes, merge" for `feature/agent-connections` → `dev` (`AGENTS.md` §K.2).
