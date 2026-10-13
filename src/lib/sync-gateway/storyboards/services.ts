import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, DocumentByteStore } from "../automerge-core";
import {
  DomainError,
  type MergeResult,
  type StoryboardComment,
  type StoryboardDecision,
  type StoryboardGateSetting,
  type StoryboardPick,
  type StoryboardRecord,
  type StoryboardReply,
  type StoryboardsDocument,
  type StoryboardVersion,
} from "./contracts";

export type ServiceDependencies = { core: AutomergeCore<StoryboardsDocument>; store: DocumentByteStore };

/**
 * The document every computer starts a channel from: the same actor, time and content, so its genesis change -- and its hash -- is
 * identical everywhere (the `media-settings` pattern), and two computers that each started it merge instead of being refused.
 */
const GENESIS_ACTOR = "73746f7279626f617264732d646f6331"; // hex of "storyboards-doc1"
export function genesisDocument(channelId: string): Automerge.Doc<StoryboardsDocument> {
  return Automerge.change(Automerge.init<StoryboardsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-storyboards";
    draft.version = 1;
    draft.channelId = channelId;
    draft.storyboards = {};
  });
}
export function emptyDocument(channelId: string): StoryboardsDocument {
  return { format: "ytm-storyboards", version: 1, channelId, storyboards: {} };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const notFound = (what: string, details: Record<string, unknown>) => new DomainError({ code: "not_found", message: `${what} not found`, details });

export function createStoryboardsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time (the `media-settings` review finding): a merge that loaded the document
  // before a save would otherwise write over that save.
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<StoryboardsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<StoryboardsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  /** One change to one storyboard, saved; `fn` throws (nothing saved) when the storyboard or its parts are not there. */
  function changeStoryboard(channelId: string, storyboardId: string, message: string, fn: (record: StoryboardRecord) => void): Promise<void> {
    return serialized(async () => {
      const doc = await loadOrGenesis(channelId);
      if (!doc.storyboards?.[storyboardId]) throw notFound("Storyboard", { channelId, storyboardId });
      const next = Automerge.change(doc, message, (draft) => fn(draft.storyboards[storyboardId]));
      await deps.core.save(channelId, next);
    });
  }

  return {
    /** The channel's storyboards as plain data (an empty list for a channel without a document yet). */
    read(channelId: string): Promise<StoryboardRecord[]> {
      return serialized(async () => Object.values(clone((await loadOrGenesis(channelId)).storyboards ?? {})));
    },

    /** A new storyboard with its first version (number 1). Refused when the id is taken. */
    create(channelId: string, record: Omit<StoryboardRecord, "versions" | "submissions" | "decisions" | "comments">, first: StoryboardVersion): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        if (doc.storyboards?.[record.id]) throw new DomainError({ code: "validation_failed", message: "A storyboard with this id exists", details: { storyboardId: record.id } });
        const next = Automerge.change(doc, `create storyboard ${record.id}`, (draft) => {
          // `picks` and its version entry exist from the start, so two computers' first picks merge instead of one replacing the other.
          draft.storyboards[record.id] = { ...clone(record), versions: { [String(first.number)]: clone(first) }, submissions: {}, decisions: {}, comments: {}, picks: { [String(first.number)]: {} } };
        });
        await deps.core.save(channelId, next);
      });
    },

    /** A new version, numbered after the latest (assigned whole; never edited later). Returns its number. */
    async addVersion(channelId: string, storyboardId: string, version: Omit<StoryboardVersion, "number">): Promise<number> {
      let number = 0;
      await changeStoryboard(channelId, storyboardId, `version ${storyboardId}`, (record) => {
        number = Math.max(0, ...Object.keys(record.versions).map(Number)) + 1;
        record.versions[String(number)] = clone({ ...version, number });
        if (!record.picks) record.picks = {};
        record.picks[String(number)] = {};
      });
      return number;
    },

    submit(channelId: string, storyboardId: string, versionNumber: number, at: string): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `submit ${storyboardId} v${versionNumber}`, (record) => {
        const version = record.versions[String(versionNumber)];
        if (!version) throw notFound("Version", { storyboardId, versionNumber });
        record.submissions[String(versionNumber)] = { at, contentHash: version.contentHash };
      });
    },

    addDecision(channelId: string, storyboardId: string, decision: StoryboardDecision): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `${decision.kind} ${storyboardId} v${decision.versionNumber}`, (record) => {
        if (!record.versions[String(decision.versionNumber)]) throw notFound("Version", { storyboardId, versionNumber: decision.versionNumber });
        record.decisions[decision.id] = clone(decision);
      });
    },

    addComment(channelId: string, storyboardId: string, comment: StoryboardComment): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `comment ${storyboardId}`, (record) => {
        record.comments[comment.id] = clone(comment);
      });
    },

    addReply(channelId: string, storyboardId: string, commentId: string, reply: StoryboardReply): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `reply ${storyboardId}`, (record) => {
        const comment = record.comments[commentId];
        if (!comment) throw notFound("Comment", { storyboardId, commentId });
        comment.replies[reply.id] = clone(reply);
      });
    },

    setCommentState(channelId: string, storyboardId: string, commentId: string, state: StoryboardComment["state"], by: StoryboardComment["author"], at: string): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `comment ${commentId} ${state}`, (record) => {
        const comment = record.comments[commentId];
        if (!comment) throw notFound("Comment", { storyboardId, commentId });
        comment.state = state;
        comment.stateChangedAt = at;
        comment.stateChangedBy = by;
      });
    },

    /** BL-184 stage 3: the owner's take for a segment of a version, or null to clear it. */
    setPick(channelId: string, storyboardId: string, versionNumber: number, segmentId: string, pick: StoryboardPick | null): Promise<void> {
      return changeStoryboard(channelId, storyboardId, `pick ${storyboardId} v${versionNumber} ${segmentId}`, (record) => {
        if (!record.versions[String(versionNumber)]) throw notFound("Version", { storyboardId, versionNumber });
        if (!record.picks) record.picks = {};
        const key = String(versionNumber);
        if (!record.picks[key]) record.picks[key] = {};
        if (pick) record.picks[key][segmentId] = clone(pick);
        else delete record.picks[key][segmentId];
      });
    },

    /** The channel's gate setting as stored, or null when it was never changed (the caller's default applies). */
    readGate(channelId: string): Promise<StoryboardGateSetting | null> {
      return serialized(async () => {
        const gate = (await loadOrGenesis(channelId)).gate;
        return gate ? clone(gate) : null;
      });
    },

    setGate(channelId: string, setting: StoryboardGateSetting): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const next = Automerge.change(doc, `gate ${setting.requireApproved ? "on" : "off"}`, (draft) => {
          draft.gate = clone(setting);
        });
        await deps.core.save(channelId, next);
      });
    },

    exportBytes: (channelId: string): Promise<Uint8Array> => serialized(() => deps.core.exportBytes(channelId)),

    /** Everything is appended under fresh ids, so a merge has no conflicts to report (a comment's state: the last writer wins). */
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

export type StoryboardsCore = ReturnType<typeof createStoryboardsCore>;
