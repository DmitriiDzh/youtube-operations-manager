import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import type { ImageReviewDecision, ImageReviewImage, ImageReviewsDocument, ImageReviewsSnapshot, MergeResult } from "./contracts";

export type ServiceDependencies = { core: AutomergeCore<ImageReviewsDocument>; store: DocumentByteStore };

/**
 * BL-272 (ADR 0076): the document every computer starts a channel from -- the same actor, time and content, so its genesis change
 * (and its hash) is identical everywhere (the clip-reviews pattern), and two computers that each started it merge.
 */
const GENESIS_ACTOR = "696d6167652d72657669657773"; // hex of "image-reviews"
export function genesisDocument(channelId: string): Automerge.Doc<ImageReviewsDocument> {
  return Automerge.change(Automerge.init<ImageReviewsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-image-reviews";
    draft.version = 1;
    draft.channelId = channelId;
    draft.images = {};
    draft.decisions = {};
  });
}
export function emptyDocument(channelId: string): ImageReviewsDocument {
  return { format: "ytm-image-reviews", version: 1, channelId, images: {}, decisions: {} };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createImageReviewsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before a save would otherwise write
  // over that save.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<ImageReviewsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<ImageReviewsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  return {
    /** The channel's images and decisions as plain data. */
    read(channelId: string): Promise<ImageReviewsSnapshot> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        return { images: clone(doc.images ?? {}), decisions: clone(doc.decisions ?? {}) };
      });
    },

    /** One submitted image, assigned whole under its id (checked by the caller; never edited afterwards). */
    addImage(channelId: string, image: ImageReviewImage): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `image ${image.imageId}`, (draft) => {
          draft.images[image.imageId] = clone(image);
        });
        await deps.core.save(channelId, next);
      });
    },

    /** One decision, appended under its own id. */
    addDecision(channelId: string, decision: ImageReviewDecision): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `${decision.kind} ${decision.imageId}`, (draft) => {
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

export type ImageReviewsCore = ReturnType<typeof createImageReviewsCore>;
