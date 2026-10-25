import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import { slotKey, type MergeResult, type PublishingPlanChange, type PublishingPlanDecision, type PublishingPlansDocument, type PublishingPlansSnapshot } from "./contracts";

export type ServiceDependencies = { core: AutomergeCore<PublishingPlansDocument>; store: DocumentByteStore };

/**
 * The document every computer starts a channel from: the same actor, time and content, so its genesis change -- and its hash -- is
 * identical everywhere (the `storyboards` pattern), and two computers that each started it merge instead of being refused.
 */
const GENESIS_ACTOR = "7075626c697368696e672d706c616e73"; // hex of "publishing-plans"
export function genesisDocument(channelId: string): Automerge.Doc<PublishingPlansDocument> {
  return Automerge.change(Automerge.init<PublishingPlansDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-publishing-plans";
    draft.version = 1;
    draft.channelId = channelId;
    draft.plans = {};
    draft.slots = {};
    draft.decisions = {};
  });
}
export function emptyDocument(channelId: string): PublishingPlansDocument {
  return { format: "ytm-publishing-plans", version: 1, channelId, plans: {}, slots: {}, decisions: {} };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createPublishingPlansCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before a save would otherwise write
  // over that save.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<PublishingPlansDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<PublishingPlansDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  return {
    /** The channel's plans, slots and decisions as plain data. */
    read(channelId: string): Promise<PublishingPlansSnapshot> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        return { plans: clone(doc.plans ?? {}), slots: clone(doc.slots ?? {}), decisions: clone(doc.decisions ?? {}) };
      });
    },

    /** One agent save as one change (checked by the caller): the plan's fields set one by one, slots assigned whole or deleted. */
    savePlan(channelId: string, change: PublishingPlanChange): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `plan ${change.weekStart}`, (draft) => {
          const existing = draft.plans[change.weekStart];
          if (!existing) {
            draft.plans[change.weekStart] = clone(change.create ?? { weekStart: change.weekStart, timeZone: change.timeZone ?? "UTC", createdAt: change.updatedAt, createdBy: change.updatedBy, updatedAt: change.updatedAt, updatedBy: change.updatedBy });
          } else {
            if (change.timeZone !== undefined && existing.timeZone !== change.timeZone) existing.timeZone = change.timeZone;
            existing.updatedAt = change.updatedAt;
            existing.updatedBy = change.updatedBy;
          }
          for (const slot of change.upserts) draft.slots[slotKey(change.weekStart, slot.slotId)] = clone(slot);
          for (const slotId of change.removes) delete draft.slots[slotKey(change.weekStart, slotId)];
        });
        await deps.core.save(channelId, next);
      });
    },

    /** The owner's decisions, appended under their ids in one change (the approval of a week is one change). */
    addDecisions(channelId: string, decisions: PublishingPlanDecision[]): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `decisions ${decisions.map((d) => `${d.kind} ${d.slotId}`).join(", ")}`, (draft) => {
          for (const decision of decisions) draft.decisions[decision.id] = clone(decision);
        });
        await deps.core.save(channelId, next);
      });
    },

    exportBytes: (channelId: string): Promise<Uint8Array> => serialized(() => deps.core.exportBytes(channelId)),

    /** Everything is assigned under keys or fresh ids, so a merge has no conflicts to report (a slot edited on both: last writer wins). */
    mergeIncoming(channelId: string, incomingBytes: Uint8Array): Promise<MergeResult> {
      return serialized(async () => {
        const { merged } = await deps.core.mergeIncoming(channelId, incomingBytes, () => []);
        await deps.core.save(channelId, merged);
        return { newConflicts: [] };
      });
    },

    discardLocalAndAdoptPeer(channelId: string, incomingBytes: Uint8Array): Promise<{ backupPath: string | null }> {
      return serialized(async () => {
        const { backupPath, adopted } = await deps.core.discardLocalAndAdoptPeer(channelId, incomingBytes);
        await deps.core.save(channelId, adopted);
        return { backupPath };
      });
    },
  };
}

export type PublishingPlansCore = ReturnType<typeof createPublishingPlansCore>;
