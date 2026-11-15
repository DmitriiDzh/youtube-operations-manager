import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import type { MergeResult, PackageReviewDecision, PackageReviewRequired, PackageReviewsDocument, PackageReviewsSnapshot } from "./contracts";

export type ServiceDependencies = { core: AutomergeCore<PackageReviewsDocument>; store: DocumentByteStore };

/**
 * The document every computer starts a channel from: the same actor, time and content, so its genesis change -- and its hash -- is
 * identical everywhere (the `clip-reviews` pattern), and two computers that each started it merge instead of being refused.
 */
const GENESIS_ACTOR = "7061636b6167652d72657669657773"; // hex of "package-reviews"
export function genesisDocument(channelId: string): Automerge.Doc<PackageReviewsDocument> {
  return Automerge.change(Automerge.init<PackageReviewsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-package-reviews";
    draft.version = 1;
    draft.channelId = channelId;
    draft.decisions = {};
  });
}
export function emptyDocument(channelId: string): PackageReviewsDocument {
  return { format: "ytm-package-reviews", version: 1, channelId, decisions: {} };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createPackageReviewsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before a save would otherwise write
  // over that save.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<PackageReviewsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<PackageReviewsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  return {
    /** The channel's switch and decisions; `exists` false when this computer has no document. Throws on a document it cannot load. */
    read(channelId: string): Promise<PackageReviewsSnapshot> {
      return serialized(async () => {
        const bytes = await deps.store.loadDocumentBytes(channelId);
        if (!bytes) return { exists: false, required: null, decisions: {} };
        const doc = Automerge.load<PackageReviewsDocument>(bytes);
        if (doc.format !== "ytm-package-reviews") throw new Error("not a package reviews document");
        return { exists: true, required: doc.required ? clone(doc.required) : null, decisions: clone(doc.decisions ?? {}) };
      });
    },

    /** The owner's switch, assigned whole. */
    setRequired(channelId: string, required: PackageReviewRequired): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `required ${required.value}`, (draft) => {
          draft.required = clone(required);
        });
        await deps.core.save(channelId, next);
      });
    },

    /** One decision, appended under its own id. */
    addDecision(channelId: string, decision: PackageReviewDecision): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `${decision.kind} ${decision.video}`, (draft) => {
          draft.decisions[decision.id] = clone(decision);
        });
        await deps.core.save(channelId, next);
      });
    },

    exportBytes: (channelId: string): Promise<Uint8Array> => serialized(() => deps.core.exportBytes(channelId)),

    /** Decisions are assigned under fresh ids and the switch whole, so a merge has no conflicts to report. */
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

export type PackageReviewsCore = ReturnType<typeof createPackageReviewsCore>;
