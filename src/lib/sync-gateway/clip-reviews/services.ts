import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import type { ClipReviewClip, ClipReviewDecision, ClipReviewsDocument, ClipReviewsSnapshot, MergeResult } from "./contracts";

export type ServiceDependencies = { core: AutomergeCore<ClipReviewsDocument>; store: DocumentByteStore };

/**
 * The document every computer starts a channel from: the same actor, time and content, so its genesis change -- and its hash -- is
 * identical everywhere (the `publishing-plans` pattern), and two computers that each started it merge instead of being refused.
 */
const GENESIS_ACTOR = "636c69702d72657669657773"; // hex of "clip-reviews"
export function genesisDocument(channelId: string): Automerge.Doc<ClipReviewsDocument> {
  return Automerge.change(Automerge.init<ClipReviewsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-clip-reviews";
    draft.version = 1;
    draft.channelId = channelId;
    draft.clips = {};
    draft.decisions = {};
  });
}
export function emptyDocument(channelId: string): ClipReviewsDocument {
  return { format: "ytm-clip-reviews", version: 1, channelId, clips: {}, decisions: {} };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createClipReviewsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before a save would otherwise write
  // over that save.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<ClipReviewsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<ClipReviewsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  return {
    /** The channel's clips and decisions as plain data. */
    read(channelId: string): Promise<ClipReviewsSnapshot> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        return { clips: clone(doc.clips ?? {}), decisions: clone(doc.decisions ?? {}) };
      });
    },

    /** One submitted clip, assigned whole under its id (checked by the caller; never edited afterwards). */
    addClip(channelId: string, clip: ClipReviewClip): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `clip ${clip.clipId}`, (draft) => {
          draft.clips[clip.clipId] = clone(clip);
        });
        await deps.core.save(channelId, next);
      });
    },

    /** One decision, appended under its own id. */
    addDecision(channelId: string, decision: ClipReviewDecision): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `${decision.kind} ${decision.clipId}`, (draft) => {
          draft.decisions[decision.id] = clone(decision);
        });
        await deps.core.save(channelId, next);
      });
    },

    exportBytes: (channelId: string): Promise<Uint8Array> => serialized(() => deps.core.exportBytes(channelId)),

    /** Everything is assigned under fresh ids, so a merge has no conflicts to report. */
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

export type ClipReviewsCore = ReturnType<typeof createClipReviewsCore>;
