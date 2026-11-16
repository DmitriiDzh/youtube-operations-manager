import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import { slotKey, type MergeResult, type PublishingPlanApprovalStage, type PublishingPlanChange, type PublishingPlanDecision, type PublishingPlanMove, type PublishingPlansDocument, type PublishingPlansSnapshot, type PublishingPlanTemplateDecision, type PublishingPlanTemplateVersion } from "./contracts";

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

/**
 * BL-267 (ADR 0073 §1, plan §3.1): the template maps are not in the genesis, so two computers that each wrote the first entry
 * conflict on the root key; every conflicting map is read (each entry is assigned whole under a fresh id), so nothing is lost --
 * the `storyboards` pattern.
 */
function mergedMap<K extends "templateVersions" | "templateDecisions">(doc: Automerge.Doc<PublishingPlansDocument>, field: K): NonNullable<PublishingPlansDocument[K]> | undefined {
  const maps = Object.values(Automerge.getConflicts(doc, field) ?? {}).filter((m) => m && typeof m === "object") as Array<NonNullable<PublishingPlansDocument[K]>>;
  if (maps.length === 0 && !doc[field]) return undefined;
  return clone(Object.assign({}, ...maps, doc[field] ?? {})) as NonNullable<PublishingPlansDocument[K]>;
}

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
        return {
          plans: clone(doc.plans ?? {}),
          slots: clone(doc.slots ?? {}),
          decisions: clone(doc.decisions ?? {}),
          // BL-242: only the two known values; anything else (absent, or a future value) reads as absent (`packaged`).
          ...(doc.approvalStage === "slot" || doc.approvalStage === "packaged" ? { approvalStage: doc.approvalStage } : {}),
          ...(() => {
            const versions = mergedMap(doc, "templateVersions");
            const decisions = mergedMap(doc, "templateDecisions");
            return { ...(versions ? { templateVersions: versions } : {}), ...(decisions ? { templateDecisions: decisions } : {}) };
          })(),
        };
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

    /**
     * BL-267 (ADR 0073 §1): template versions and decisions appended under their ids in ONE change (the owner's edit is a version
     * and its approval together). The caller checks who may.
     */
    addTemplateRecords(channelId: string, records: { versions?: PublishingPlanTemplateVersion[]; decisions?: PublishingPlanTemplateDecision[] }): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `template ${[...(records.versions ?? []).map((v) => `version ${v.id}`), ...(records.decisions ?? []).map((d) => `${d.kind} ${d.versionId}`)].join(", ")}`, (draft) => {
          if ((records.versions ?? []).length > 0) {
            if (!draft.templateVersions) draft.templateVersions = {};
            for (const version of records.versions ?? []) draft.templateVersions[version.id] = clone(version);
          }
          if ((records.decisions ?? []).length > 0) {
            if (!draft.templateDecisions) draft.templateDecisions = {};
            for (const decision of records.decisions ?? []) draft.templateDecisions[decision.id] = clone(decision);
          }
        });
        await deps.core.save(channelId, next);
      });
    },

    /**
     * BL-267 (ADR 0073 §5): a slot moved, also to another week, as ONE change -- the old key deleted and the same slot (same id)
     * put under its new week; the target plan created when it has none. Decisions are not touched (they are read by slot id).
     */
    moveSlot(channelId: string, move: PublishingPlanMove): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `move ${move.slot.slotId} ${move.fromWeekStart} -> ${move.slot.weekStart}`, (draft) => {
          const target = draft.plans[move.slot.weekStart];
          if (!target) draft.plans[move.slot.weekStart] = clone(move.createTarget ?? { weekStart: move.slot.weekStart, timeZone: "UTC", createdAt: move.slot.updatedAt, createdBy: move.slot.updatedBy, updatedAt: move.slot.updatedAt, updatedBy: move.slot.updatedBy });
          else {
            target.updatedAt = move.slot.updatedAt;
            target.updatedBy = move.slot.updatedBy;
          }
          const source = draft.plans[move.fromWeekStart];
          if (source && move.fromWeekStart !== move.slot.weekStart) {
            source.updatedAt = move.slot.updatedAt;
            source.updatedBy = move.slot.updatedBy;
          }
          delete draft.slots[slotKey(move.fromWeekStart, move.slot.slotId)];
          draft.slots[slotKey(move.slot.weekStart, move.slot.slotId)] = clone(move.slot);
        });
        await deps.core.save(channelId, next);
      });
    },

    /** BL-242 (ADR 0062 §1): the owner's approval stage of the channel, set in one change (the caller checks who may). */
    setApprovalStage(channelId: string, stage: PublishingPlanApprovalStage): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `approval stage ${stage}`, (draft) => {
          draft.approvalStage = stage;
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
