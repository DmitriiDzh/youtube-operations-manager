# Phase 10 slice 5 — execution of an approved experiment (localization-type only)

Continues on `feature/phase-10-decision-experiment-engine`, the one branch for the whole phase
(`AGENTS.md` §K.1). Owner said "продолжай" (Telegram, 2026-09-29) after slice 4 (AI-generated
hypothesis drafts) was reported done, then answered three safety-design questions directly before
this slice started:

1. Only localization-type experiments get real execution now (the only type with an existing
   execution interface — the Change Set/Batch pipeline). No other type gets any execution
   interface in this slice.
2. Approval alone never triggers execution. A separate, explicit "Execute" action is required
   after approval. Owner's own words: "реальное исполнение нужно" (yes, real execution is
   needed) — confirming Execute should do something real, never that approval itself should.
3. Execution never bypasses an existing safety gate — it is one more caller of the existing,
   unchanged Change Set/Batch pipeline (identity check, dry-run, Live Writes toggle), not a new
   write path.

**Mandatory reading for this slice's own scope** (`AGENTS.md` §A): `src/lib/changesets/contracts.ts`
(full — `Change`/`ChangeSet` shapes) and `src/lib/changesets/services.ts`'s `getChangeSet` action
(the exact call the existing Batch-creation UI already makes: `{channelId, changeSetId, status:
"approved", pageSize}` → `{changeSet, changes, pagination}`); `src/lib/batches/contracts.ts` (full)
and `src/lib/batches/services.ts`'s `createBatch` (confirmed by reading its body: it only inserts a
`Batch` row + `LedgerRow`s, defaults `dryRun` to `true` when unspecified, and — checked explicitly —
never calls `writeContext.assertWriteChannel`; that check only happens later, inside
`prepareBatchExecution`/`executeBatch`, neither of which this slice calls); `src/lib/batches/index.ts`
(`createBatchCore()` — no `WriteExecutor` is ever wired in, so no code path reachable through it can
issue a real `videos.update`) and `src/lib/changesets/index.ts` (`createChangeSetCore()`);
`src/components/batch-manager.tsx`'s own `createBatch()` (the existing, client-side "group approved
changes by video into `selections`" logic this slice's server-side equivalent mirrors);
`docs/TECHNICAL_DEBT.md`'s Gate B / single-write-gateway section and `docs/decisions/
0005-youtube-write-gateway.md` (confirms: this slice must never construct a `WriteExecutor` or call
a mutating YouTube method — it only ever reaches `createBatch`, which itself cannot write); slice
1/3/4's own plan docs for continuity (`status.ts`'s transition table, the resolver-port pattern
`evidence-reference-resolver.ts` already established).

## 1. What "execute" actually does — and does not do

**Revised after `advisor()` review of this plan's first draft**, which caught a real error: a
`Batch.dryRun` value is fixed forever at creation (`prepareBatchExecution` sends a dry-run batch
straight to the terminal `DRY_RUN_COMPLETE` state; nothing in this codebase ever flips it back to
live). An always-dry-run Execute action could therefore never produce the real write the owner
explicitly asked for ("реальное исполнение нужно") — the Batch it created would be permanently
inert. The first draft's claim that the operator could "later run the resulting Batch for real" was
false and has been corrected.

Execute now follows **exactly** the existing, already-approved Batch-creation gate
(`src/app/api/channels/[channelId]/batches/route.ts`, `batch-manager.tsx`'s own `dryRun:
liveWritesEnabled ? !createAsLive : true`): the request may include `{live?: boolean}`; the route
reads `getLiveWritesEnabled()` (the same Gate B toggle every other write surface reads) and computes
`dryRun = liveWritesEnabled ? !(live ?? false) : true` — fail-closed, identical logic, not a new
policy. With Live Writes off (this project's default), Execute is unconditionally dry-run, same as
today. With Live Writes on AND the operator explicitly requests `live: true` (its own separate
`ConfirmDialog`, never silently inferred from "approved"), Execute creates a real, non-dry-run Batch
— which still has to go through that Batch's own full safety pipeline (identity check, fresh
conflict re-check, backup, per-video attempts) before anything actually reaches YouTube; Execute
itself still only ever calls `createBatch`, never `prepareBatchExecution`/`executeBatch` — the
operator finishes the write for real from the existing Batches tab, exactly as they would for any
other batch. Execute's own job stays **"approved experiment → a Batch exists (dry-run by default,
live only on explicit request while Live Writes is on), linked back to the experiment"** — zero new
write path, zero new bypass of Gate B, one more caller of the same existing gate.

## 2. Schema (migration v32, additive)

```sql
ALTER TABLE experiments ADD COLUMN change_set_id TEXT;
ALTER TABLE experiments ADD COLUMN execution_batch_id TEXT;
ALTER TABLE experiments ADD COLUMN execution_claimed_at INTEGER;
```

**No `REFERENCES` on `change_set_id`/`execution_batch_id`, deliberately** — `advisor()` caught that
`change_sets` rows ARE really deleted (`change-drafts/services.ts`'s `discardLocalAndAdoptPeer`,
the RISK-46 divergent-lineage-resolution flow, via `sql-projection.ts`'s `deleteChangeSet`, which
runs with `foreign_keys=ON`). An FK here would make that unrelated delete throw the moment any
experiment ever referenced the change set — a real, novel breakage this slice must not introduce.
Follows `RISK-66`'s own already-accepted "no FK for an informal reference" pattern; both fields are
validated at the application level instead (§4's resolver, re-checked at execute time, not just at
attach time). `execution_claimed_at` is the atomic execution claim (§4) — a dedicated field kept
orthogonal to `status`, mirroring `research_channels.collection_claimed_at`'s own precedent
(Phase 9 slice 9B), never repurposing the user-visible `status` column itself as a lock.

## 3. Module independence (`AGENTS.md` §M) — extending the established pattern

`decision-engine` must never import `@/lib/changesets` or `@/lib/batches` directly, the same rule
`PHASE10-INV-03` already enforces for `analytics`/`market-intelligence` (slice 3). A new port,
`ExperimentExecutionResolver` (in `decision-engine/contracts.ts`, alongside `EvidenceReferenceResolver`):

```ts
export type ExperimentExecutionResolver = {
  /** null if changeSetId doesn't exist at all. */
  getChangeSetChannelId(changeSetId: string): Promise<string | null>;
  /** Always dry-run. Returns the real Batch id + how many videos it covers. */
  createDryRunBatch(args: { channelId: string; changeSetId: string }): Promise<{ batchId: string; videoCount: number }>;
};
```

The real implementation lives in `src/app/api/decision-engine/experiment-execution-resolver.ts`
(sibling to `evidence-reference-resolver.ts`, same reasoning: the one place allowed to import both
`@/lib/decision-engine` and `@/lib/changesets`/`@/lib/batches`, outside `decision-engine/`'s own
directory so `PHASE10-INV-03`'s scan never sees it, with its own `.test.ts`). `createDryRunBatch`
(name kept from the original draft for the port's own identity, but its `dryRun` argument is now
threaded through explicitly, never hardcoded — see §1's revision) calls
`createChangeSetCore().getChangeSet({channelId, changeSetId, status: "approved", pageSize: 500})`,
**filters the returned changes to those actually eligible** (`validationStatus === "valid" &&
conflictStatus === "none" && (approvedValue === null || approvedValue === proposedValue)` — the
exact same predicate `assertApprovalStillValid` in `batches/services.ts` enforces per-change, so a
single stale/conflicting change never aborts the whole call with an opaque error), throws a new,
specific `EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES` if zero remain, throws
`EXPERIMENT_CHANGE_SET_TOO_LARGE` if `pagination.total > 500` (this module does not paginate beyond
what the existing UI itself already caps at — a real, explicit limit, not a silent truncation),
groups the eligible changes by `videoId` into `selections` (mirroring `batch-manager.tsx`'s own
grouping — duplicated here because one copy is client-side JSON-shaping and the other is
server-side calling the real service directly, not the same code path the way
`market-velocity-format.ts`'s two copies were), then calls `createBatchCore().createBatch({
channelId, selections, dryRun })` with the caller-supplied `dryRun` value from §1.

`PHASE10-INV-03` is widened to also forbid `@/lib/changesets` and `@/lib/batches` inside
`decision-engine/**` (same forbidden-specifier list, two more entries).

## 4. New/changed service actions (`decision-engine/services.ts`)

- **`setExperimentChangeSet(experimentId, input, ctx, resolver)`** — `input: { changeSetId: string |
  null }`. Requires the experiment accessible (existing `assertExperimentAccessible`). **Revised
  after `advisor()`:** attaching (`changeSetId !== null`) requires status in `["proposed",
  "approved"]` AND `hypothesis.channelId !== null`, exactly as the first draft said — but
  *detaching* (`changeSetId: null`) is now also restricted to `["proposed", "approved"]`, not
  "always legal" as the first draft claimed: detaching a `running` experiment would leave
  `execution_batch_id` pointing at a Change Set the experiment no longer references, a real,
  self-inconsistent state the first draft would have permitted. Calls
  `resolver.getChangeSetChannelId(changeSetId)` on attach; throws `EXPERIMENT_CHANGE_SET_NOT_FOUND`
  if `null`, `EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH` if it doesn't equal `hypothesis.channelId`.
- **`executeExperiment(experimentId, input, ctx, resolver)`** — `input: { live?: boolean }` (§1).
  **Redesigned after `advisor()` caught a real race in the first draft** (calling the resolver
  before the atomic guard let two concurrent Execute calls both create a real Batch, contradicting
  this very plan's own §7 "only one Batch is ever created" criterion — the RISK-68 anti-pattern,
  not the intended 9B claim-first pattern). Now **claim-first**, mirroring
  `claimStaleResearchChannelsForCollection` exactly:
  1. Read-only early check: status `"approved"` and `changeSetId !== null` (else
     `EXPERIMENT_NOT_EXECUTABLE`, distinct from the generic transition-invalid error, naming the
     real reason) — a fast, friendly rejection only; not the actual guard.
  2. **Atomic claim** (new store method `claimExperimentForExecution`): `UPDATE experiments SET
     execution_claimed_at = ? WHERE id = ? AND status = 'approved' AND change_set_id = ? AND
     execution_claimed_at IS NULL`. Zero rows affected → `EXPERIMENT_INVALID_TRANSITION` (already
     claimed by a concurrent call, or state changed since the read-only check).
  3. Re-resolve the Change Set's channel (`resolver.getChangeSetChannelId`) and re-verify it still
     equals `hypothesis.channelId` — the attach-time check (§ above) is not trusted as still valid;
     this mirrors `AC-BATCH-03`'s own "re-run the full safety pipeline immediately before send"
     principle, not a redundant check.
  4. `resolver.createDryRunBatch({channelId, changeSetId, dryRun})` (the `live`-derived value from
     §1). **On any throw here** (no eligible changes, too large, channel mismatch, etc.): release
     the claim (new store method `releaseExperimentExecutionClaim`, sets `execution_claimed_at`
     back to `NULL`) and rethrow — the experiment returns to a normal, re-attemptable `"approved"`
     state, never stuck.
  5. On success: `UPDATE experiments SET status = 'running', execution_batch_id = ? WHERE id = ?`
     (new store method `finalizeExperimentExecution`) — unconditional, no further `WHERE` guard
     needed, since step 2's claim is already exclusive (no other call could have reached this point
     for the same experiment).

  With this design, §7's "only one Batch is ever created" is a real, passing property (the claim in
  step 2 is exclusive before either call's resolver ever runs), and §9's original "orphaned Batch"
  residual risk shrinks to only "claim succeeded, then the process crashed before step 5" — an
  existing, already-accepted class of risk this codebase already lives with everywhere else a
  claim/finalize pattern is used (e.g. Phase 9's own collection claims), not a new one.
- **`transitionExperiment`** (existing, slice 1): when `parsed.targetStatus === "running"` AND the
  experiment's own `changeSetId !== null`, reject with a new `EXPERIMENT_MUST_USE_EXECUTE` error
  ("this experiment has a Change Set attached — use the Execute action, not a manual status
  transition, so `running` always corresponds to a real Batch") **before** the existing
  `assertValidStatusTransition` call. An experiment with `changeSetId === null` (any non-localization
  type, or a localization-type experiment that never got one attached) is completely unaffected —
  manual `approved → running` stays legal for it, exactly as slice 1 shipped it, since that
  represents genuine manual/offline tracking with no real execution interface to speak of.

## 5. API routes

- `PUT /api/decision-engine/experiments/[experimentId]/change-set` — body `{changeSetId: string |
  null}`, wraps `setExperimentChangeSet`.
- `POST /api/decision-engine/experiments/[experimentId]/execute` — body `{live?: boolean}` (§1),
  wraps `executeExperiment`. Both routes are gated by `proxy.ts`'s existing mutation-lock pattern
  (real, persisted writes), matching every other mutating decision-engine route from slices 1-3 —
  `proxy.test.ts` gets one new case per route, not just `/execute` (the first draft only planned
  the second).

## 6. UI (`decisions-manager.tsx`)

On an experiment card: a "Change Set" field (id input + a fetched preview of channel/status/change
count, reusing the existing `GET .../channels/[channelId]/change-sets/[changeSetId]` route already
used elsewhere — no new read route needed) shown once the experiment has a `channelId` (via its
hypothesis); an "Execute" button, enabled only when `status === "approved" && changeSetId !== null`,
behind the existing `ConfirmDialog` pattern (never `window.confirm`) since it creates a real,
persisted row; on success, shows the resulting Batch id with a link/pointer to the Batches tab
(no navigation is built here — the Batches tab already exists and already shows every batch for the
channel, `AGENTS.md` §D).

## 7. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- `setExperimentChangeSet` (attach) on an experiment whose hypothesis has `channelId: null` throws
  before calling the resolver at all.
- `setExperimentChangeSet` (attach) with a `changeSetId` whose resolved channel differs from the
  hypothesis's own `channelId` throws `EXPERIMENT_CHANGE_SET_CHANNEL_MISMATCH`, and nothing is
  persisted.
- `setExperimentChangeSet` (detach, `changeSetId: null`) on a `"running"` experiment throws — detach
  is restricted to `["proposed", "approved"]` exactly like attach.
- `executeExperiment` on a `"proposed"` (never-approved) experiment throws
  `EXPERIMENT_NOT_EXECUTABLE` before the atomic claim, and the claim column stays untouched.
- `executeExperiment` on an `"approved"` experiment with `changeSetId: null` throws
  `EXPERIMENT_NOT_EXECUTABLE` before the atomic claim.
- **Real-DB concurrency test** (not a fake store, per the same rigor `batches`/`market-intelligence`
  already hold their own claim-based race tests to): two concurrent `executeExperiment` calls for
  the same experiment — exactly one wins the atomic claim in step 2 and proceeds to create a Batch;
  the other observes the claim already taken and throws `EXPERIMENT_INVALID_TRANSITION` **without
  ever calling the resolver** (assert the resolver's `createDryRunBatch` was called exactly once
  across both concurrent calls) — so **exactly one Batch is created**, a real passing property now,
  not an accepted residual risk.
- If the resolver throws after a successful claim (e.g. zero eligible changes), the claim is
  released (`execution_claimed_at` back to `NULL`, status still `"approved"`) and a second
  `executeExperiment` call afterward can succeed normally — proves a failed attempt never strands
  the experiment.
- `executeExperiment` calls `resolver.createDryRunBatch` with `channelId` equal to the hypothesis's
  own `channelId`, never a caller-suppliable value.
- With Live Writes disabled, `executeExperiment({live: true})` still produces `dryRun: true` on the
  resulting Batch (fail-closed, mirrors the existing Batch-creation route's own test coverage) —
  the request body cannot force a live write while the global toggle is off.
- With Live Writes enabled, `executeExperiment({live: true})` produces `dryRun: false`, and
  `executeExperiment({})`/`executeExperiment({live: false})` still defaults to `dryRun: true` even
  with the toggle on — live is opt-in per call, never inferred from the toggle alone.
- The resolver rejects a Change Set whose real `pagination.total` exceeds 500 with
  `EXPERIMENT_CHANGE_SET_TOO_LARGE`, and rejects one whose approved changes are all
  invalid/conflicting/edited-after-approval with `EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES` — both
  before calling `createBatch`, both with a specific, non-opaque error.
- `transitionExperiment("approved", "running")` on an experiment with a non-null `changeSetId`
  throws `EXPERIMENT_MUST_USE_EXECUTE`, never silently succeeds.
- `transitionExperiment("approved", "running")` on an experiment with `changeSetId: null` still
  succeeds exactly as slice 1 shipped it (regression test, not just a new-behavior test).
- A negative test on `PHASE10-INV-03`: a probe file inside `decision-engine/` importing
  `@/lib/changesets` or `@/lib/batches` is caught by the widened scan.
- `proxy.test.ts` gains a case for `PUT .../change-set` in addition to `POST .../execute`, both
  gated exactly like every other mutating decision-engine route.

## 8. Explicitly out of scope

- Any non-localization experiment type ever getting an execution interface.
- Automatically updating experiment status when the linked Batch itself completes/fails, or
  auto-recording an outcome from Batch results — `experiment_outcomes` stays a separate, manual,
  human-recorded action (slice 1), unchanged. A future slice could wire this, not this one.
- Any change to `prepareBatchExecution`/`executeBatch`/`WriteExecutor` — untouched, per the mandatory
  reading above confirming no real write is reachable through this slice at all.
- MCP/CLI exposure of `setExperimentChangeSet`/`executeExperiment` (slice 2's agent surface stays
  read + `create_experiment_proposal` only; a real-Batch-creating agent action is a materially
  different risk category than anything slice 2 shipped, and needs its own separate assignment).

## 9. Known, accepted residual risk (record in `docs/TECHNICAL_DEBT.md`)

With the claim-first redesign (§4), the concurrent-double-execute risk the first draft accepted is
closed by a real, tested guarantee (§7). The only remaining residual risk is narrower: if the
process crashes between step 4 (resolver succeeds, real Batch created) and step 5 (finalize write)
of `executeExperiment`, the experiment is left holding `execution_claimed_at` set but `status` still
`"approved"` and no `execution_batch_id` recorded — an orphaned-but-harmless (Batch itself still
respects its own `dryRun`/Gate B rules, visible and manageable from the Batches tab like any other)
Batch, and the experiment itself stuck unable to re-claim (`execution_claimed_at IS NOT NULL`) until
manually cleared. This is the same class of crash-recovery gap `docs/TECHNICAL_DEBT.md` already
accepts elsewhere for claim-based patterns without a dedicated recovery sweep (e.g. Phase 9's own
collection claims have no automatic staleness-based release either) — recorded as a new, explicit
RISK entry rather than silently carried forward, not fixed in this pass (a real fix needs either a
claimed-at staleness timeout + manual "release" admin action, or a two-phase commit across modules,
both disproportionate for this slice).

## 10. Where this is recorded

`docs/roadmap/BACKLOG.md` BL-107 (existing Phase 10 tracking row) gets this slice's summary appended,
short, per `AGENTS.md` §H.
