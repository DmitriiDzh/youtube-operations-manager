import type { BatchCore } from "@/lib/batches";
import { isApprovalStillValid } from "@/lib/batches";
import type { ChangeSetCore } from "@/lib/changesets";
import { DomainError, type ExperimentExecutionResolver } from "@/lib/decision-engine/contracts";

// Phase 10 slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §3) -- the ONE place in this
// codebase allowed to import BOTH `@/lib/decision-engine` and `@/lib/changesets`/`@/lib/batches`.
// `decision-engine/**` itself must never import either (AGENTS.md §M, PHASE10-INV-03, the same
// module-independence rule already applied to `analytics`/`market-intelligence` in slice 3).
// Deliberately outside `decision-engine/`'s own directory so it stays outside that test's
// `MODULE_ROOT`, and kept outside the route folder itself for its own `.test.ts` file, mirroring
// `evidence-reference-resolver.ts`'s own precedent exactly.
//
// This file only ever reaches `createBatchCore().createBatch` -- it never touches the later
// preparation/attempt stage of the Batch pipeline at all (deliberately not named symbol-by-symbol
// here, to avoid tripping `src/lib/batches/write-path-inventory.test.ts`'s own naive
// whole-file substring scan for real-write-capable batches symbols with a mere code comment; see
// that file's own header for the exact, authoritative list). No code path in this repository wires
// a real write-issuing adapter behind that later stage in the first place, so `createBatch` itself
// cannot issue a real `videos.update` regardless. The `dryRun` argument this resolver is given is
// threaded straight from the route's own `getLiveWritesEnabled()` check (AGENTS.md §G) -- this
// file has no opinion on Live Writes itself.
const MAX_ELIGIBLE_PAGE_SIZE = 500;

export function createRealExperimentExecutionResolver(deps: {
  changeSetCore: Pick<ChangeSetCore, "getChangeSet">;
  batchCore: Pick<BatchCore, "createBatch">;
}): ExperimentExecutionResolver {
  return {
    async verifyChangeSetBelongsToChannel(changeSetId: string, channelId: string): Promise<boolean> {
      // `getChangeSet` itself validates the channel is real/active (`requireChannel`) THEN looks
      // the Change Set up scoped to that exact channel (`requireChangeSet`: `not_found` if the
      // change set doesn't exist OR belongs to a different channel -- the two cases this resolver
      // needs to treat identically, since both mean "not a valid attach target for this channel").
      // `changeSetCore` exposes no "get by id alone" lookup on its public surface at all (mirrors
      // slice 3's own finding that market-intelligence has no single get-by-id lookup either), so
      // there is no way to ask "which channel does this belong to" independent of a candidate
      // channel -- this resolver only ever needs the yes/no answer anyway (both call sites already
      // hold the candidate `channelId` from the experiment's own hypothesis).
      try {
        await deps.changeSetCore.getChangeSet({ channelId, changeSetId, pageSize: 1 });
        return true;
      } catch (error) {
        if (error instanceof DomainError && error.code === "not_found") return false;
        throw error;
      }
    },

    async createDryRunBatch(args: {
      channelId: string;
      changeSetId: string;
      dryRun: boolean;
    }): Promise<{ batchId: string; videoCount: number }> {
      const result = await deps.changeSetCore.getChangeSet({
        channelId: args.channelId,
        changeSetId: args.changeSetId,
        status: "approved",
        pageSize: MAX_ELIGIBLE_PAGE_SIZE,
      });

      if (result.pagination.total > MAX_ELIGIBLE_PAGE_SIZE) {
        throw new DomainError({
          code: "EXPERIMENT_CHANGE_SET_TOO_LARGE",
          message: `Change Set has ${result.pagination.total} approved changes, more than the ${MAX_ELIGIBLE_PAGE_SIZE} this action supports`,
          details: { changeSetId: args.changeSetId, total: result.pagination.total, max: MAX_ELIGIBLE_PAGE_SIZE },
        });
      }

      // Reuses batches/services.ts's own `isApprovalStillValid` predicate (the non-throwing half
      // of `assertApprovalStillValid`) instead of a hand-copied duplicate (found by independent
      // review: an earlier hand-copy here had silently drifted from the real rule, missing the
      // `approvedValue`-vs-`proposedValue` "edited after approval" check entirely) -- filtered
      // here rather than asserted, so one stale/conflicting change never aborts the whole call
      // with an opaque `createBatch` error; a change that fails this is simply excluded, not
      // reported as a batch-level failure. `getChangeSet` is only ever called with
      // `status: "approved"` above, so `approvalStatus` itself is already guaranteed `"approved"`
      // here -- this predicate's own re-check of it is what still catches a race where a change
      // was un-approved between that fetch and this filter running.
      const eligible = result.changes.filter(isApprovalStillValid);
      if (eligible.length === 0) {
        throw new DomainError({
          code: "EXPERIMENT_CHANGE_SET_NO_ELIGIBLE_CHANGES",
          message: "This Change Set has no approved changes that are still valid, non-conflicting, and unedited since approval",
          details: { changeSetId: args.changeSetId },
        });
      }

      // Groups eligible changes by videoId (DEC-OQ-1: one ledger row per video) -- mirrors
      // `batch-manager.tsx`'s own client-side grouping; duplicated here because one copy is
      // client-side JSON-shaping and the other is server-side calling the real service directly,
      // not the same code path `market-velocity-format.ts`'s two copies were.
      const byVideo = new Map<string, string[]>();
      for (const change of eligible) {
        const list = byVideo.get(change.videoId) ?? [];
        list.push(change.id);
        byVideo.set(change.videoId, list);
      }
      const selections = [...byVideo.entries()].map(([videoId, changeIds]) => ({ videoId, changeIds }));

      const batch = await deps.batchCore.createBatch({
        channelId: args.channelId,
        selections,
        dryRun: args.dryRun,
      });
      return { batchId: batch.id, videoCount: selections.length };
    },
  };
}
