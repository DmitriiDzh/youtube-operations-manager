import * as Automerge from "@automerge/automerge";
import {
  DomainError,
  type ChannelDraftDocument,
  type DraftChange,
  type DraftChangeSet,
  type FieldConflict,
  type MergeResult,
} from "./contracts";
import {
  addChangeInputSchema,
  channelIdInputSchema,
  createChangeSetInputSchema,
  mergeIncomingInputSchema,
  parseWithSchema,
  setApprovalStatusInputSchema,
  updateProposedValueInputSchema,
} from "./schemas";
import type { ChangeDraftsStoreAdapter } from "./adapters/automerge-store";
import { createDefaultLogger, type ChangeDraftsLogger } from "./adapters/logger";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

export type ServiceDependencies = {
  store: ChangeDraftsStoreAdapter;
  sqlSource: SqlSourceAdapter;
  projection: SqlProjectionAdapter;
  logger?: ChangeDraftsLogger;
};

/**
 * Every `DraftChange` field this module's conflict scan actually checks -- deliberately not
 * every key. `id`/`changeSetId`/`videoId`/`language`/`field`/`createdAt` never change after
 * creation in this module's own API, so they can never legitimately conflict. `updatedAt` is
 * deliberately excluded too, for a reason found empirically while writing this module's own
 * tests: two devices independently touching the SAME meaningful field (e.g. both editing
 * `approvalStatus` while offline) each also stamp their own `updatedAt`, at genuinely different
 * millisecond timestamps -- Automerge then reports `updatedAt` itself as "conflicted," which is
 * pure bookkeeping noise, not a business conflict a human needs to resolve. Scanning it would
 * make every ordinary concurrent edit look like two conflicts instead of one.
 */
const MUTABLE_CHANGE_FIELDS = [
  "baselineValue",
  "proposedValue",
  "changeType",
  "validationStatus",
  "validationError",
  "conflictStatus",
  "approvalStatus",
  "approvedValue",
] as const satisfies readonly (keyof DraftChange)[];

function emptyDocument(channelId: string): Automerge.Doc<ChannelDraftDocument> {
  return Automerge.from<ChannelDraftDocument>({
    channelId,
    changeSets: {},
    changes: {},
  });
}

/**
 * Scans every `DraftChange` in `doc` for a field Automerge recorded more than one concurrent
 * write for (AC-CRDT-02) -- a deterministic "current" value is always readable via normal
 * property access, but `Automerge.getConflicts` is the only way to discover that a concurrent
 * write happened at all and recover every value, not just the one that currently wins.
 */
function scanForConflicts(doc: Automerge.Doc<ChannelDraftDocument>): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  for (const [changeId, change] of Object.entries(doc.changes)) {
    for (const field of MUTABLE_CHANGE_FIELDS) {
      const valuesByActor = Automerge.getConflicts(change, field);
      if (valuesByActor && Object.keys(valuesByActor).length > 1) {
        conflicts.push({ changeId, field, valuesByActor });
      }
    }
  }

  return conflicts;
}

export function createChangeDraftsCore(deps: ServiceDependencies) {
  /** Used by every write path (including `mergeIncoming`'s local side): a channel with no
   * document yet legitimately starts from an empty one -- this is not an error case. */
  async function loadOrCreateDocument(channelId: string): Promise<Automerge.Doc<ChannelDraftDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    if (!bytes) return emptyDocument(channelId);
    return Automerge.load<ChannelDraftDocument>(bytes);
  }

  /** Used by read-only entry points (`getDocument`/`exportBytes`/`listConflicts`): a channel
   * that was never actually saved is a real error (e.g. a typo'd channelId), not "empty" --
   * silently returning a valid-looking empty document here would let `exportBytes` hand a peer
   * a document for a channel that was never real, which that peer would then happily merge. */
  async function loadDocumentOrThrow(channelId: string): Promise<Automerge.Doc<ChannelDraftDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    if (!bytes) {
      throw new DomainError({ code: "not_found", message: "No draft document exists for this channel", details: { channelId } });
    }
    return Automerge.load<ChannelDraftDocument>(bytes);
  }

  /**
   * AC-CRDT-04: the SQL read-projection always reflects the current merged Automerge state
   * after any local edit or remote merge -- so every existing (and future) UI/API/MCP/CLI reader
   * of `change_sets`/`changes` keeps working without ever needing to know Automerge exists.
   * Deliberately projects the WHOLE document on every save, not just the row(s) a given
   * operation touched -- a channel's draft document is small (CD1's spike measured ~500 bytes
   * for a single-field edit), and `upsertStoredChangeSet`/`upsertStoredChange` are idempotent, so
   * this trades a little redundant I/O for never having to enumerate "which rows did this
   * specific operation affect" at each call site (a `mergeIncoming` can introduce or change any
   * number of rows at once, unlike a single `updateProposedValue` call).
   */
  async function projectToSql(doc: Automerge.Doc<ChannelDraftDocument>): Promise<void> {
    for (const changeSet of Object.values(doc.changeSets)) {
      await deps.projection.upsertChangeSet(changeSet);
    }
    for (const change of Object.values(doc.changes)) {
      await deps.projection.upsertChange(change);
    }
  }

  async function saveDocument(channelId: string, doc: Automerge.Doc<ChannelDraftDocument>): Promise<void> {
    // The Automerge document -- not the SQL projection -- is this module's source of truth, so
    // it's saved first and unconditionally. The projection is then deliberately isolated in its
    // own try/catch: if it throws (a transient DB error, a missing `channels` FK row, SQLite
    // busy), the caller must NOT see this as a failure of the operation it actually asked for --
    // the document write already succeeded. Letting the exception propagate here would make a
    // caller retry an operation that already happened; for `mergeIncoming` specifically, a retry
    // would re-merge the identical bytes and correctly find zero *new* conflicts the second time
    // (by design, see that function's own comment) -- silently losing the AC-CRDT-07 notification
    // for a conflict the merge genuinely just introduced, caused by nothing more than a transient
    // projection failure. A stale projection is an acceptable, recoverable degradation (the next
    // successful save re-projects the whole document anyway); losing a conflict notification is
    // not.
    await deps.store.saveDocumentBytes(channelId, Automerge.save(doc));
    try {
      await projectToSql(doc);
    } catch (error) {
      (deps.logger ?? createDefaultLogger()).error({
        event: "change_drafts.projection.failed",
        context: { channelId, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return {
    async getDocument(input: unknown): Promise<ChannelDraftDocument> {
      const { channelId } = parseWithSchema(channelIdInputSchema, input, "getDocument input");
      return loadDocumentOrThrow(channelId);
    },

    async createChangeSet(input: unknown): Promise<DraftChangeSet> {
      const parsed = parseWithSchema(createChangeSetInputSchema, input, "createChangeSet input");
      const doc = await loadOrCreateDocument(parsed.channelId);

      if (doc.changeSets[parsed.changeSetId]) {
        throw new DomainError({
          code: "validation_failed",
          message: "A change set with this id already exists",
          details: { changeSetId: parsed.changeSetId },
        });
      }

      const now = new Date().toISOString();
      const changeSet: DraftChangeSet = {
        id: parsed.changeSetId,
        channelId: parsed.channelId,
        source: parsed.source,
        status: "in_review",
        importedFilename: parsed.importedFilename ?? null,
        schemaVersion: parsed.schemaVersion ?? null,
        exportedAt: parsed.exportedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };

      const next = Automerge.change(doc, `create change set ${parsed.changeSetId}`, (draft) => {
        draft.changeSets[parsed.changeSetId] = changeSet;
      });
      await saveDocument(parsed.channelId, next);
      return changeSet;
    },

    async addChange(input: unknown): Promise<DraftChange> {
      const parsed = parseWithSchema(addChangeInputSchema, input, "addChange input");
      const doc = await loadOrCreateDocument(parsed.channelId);

      if (!doc.changeSets[parsed.changeSetId]) {
        throw new DomainError({
          code: "not_found",
          message: "Change set not found",
          details: { changeSetId: parsed.changeSetId },
        });
      }
      if (doc.changes[parsed.changeId]) {
        throw new DomainError({
          code: "validation_failed",
          message: "A change with this id already exists",
          details: { changeId: parsed.changeId },
        });
      }

      const now = new Date().toISOString();
      const change: DraftChange = {
        id: parsed.changeId,
        changeSetId: parsed.changeSetId,
        videoId: parsed.videoId,
        language: parsed.language,
        field: parsed.field,
        baselineValue: parsed.baselineValue,
        proposedValue: parsed.proposedValue,
        changeType: parsed.changeType,
        validationStatus: "valid",
        validationError: null,
        conflictStatus: "none",
        approvalStatus: "pending",
        approvedValue: null,
        createdAt: now,
        updatedAt: now,
      };

      const next = Automerge.change(doc, `add change ${parsed.changeId}`, (draft) => {
        draft.changes[parsed.changeId] = change;
      });
      await saveDocument(parsed.channelId, next);
      return change;
    },

    async updateProposedValue(input: unknown): Promise<DraftChange> {
      const parsed = parseWithSchema(updateProposedValueInputSchema, input, "updateProposedValue input");
      const doc = await loadOrCreateDocument(parsed.channelId);
      const existing = doc.changes[parsed.changeId];
      if (!existing) {
        throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId: parsed.changeId } });
      }

      const next = Automerge.change(doc, `update proposed value for ${parsed.changeId}`, (draft) => {
        draft.changes[parsed.changeId].proposedValue = parsed.proposedValue;
        draft.changes[parsed.changeId].updatedAt = new Date().toISOString();
      });
      await saveDocument(parsed.channelId, next);
      return next.changes[parsed.changeId];
    },

    async setApprovalStatus(input: unknown): Promise<DraftChange> {
      const parsed = parseWithSchema(setApprovalStatusInputSchema, input, "setApprovalStatus input");
      const doc = await loadOrCreateDocument(parsed.channelId);
      const existing = doc.changes[parsed.changeId];
      if (!existing) {
        throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId: parsed.changeId } });
      }

      const next = Automerge.change(doc, `set approval status for ${parsed.changeId}`, (draft) => {
        draft.changes[parsed.changeId].approvalStatus = parsed.approvalStatus;
        if (parsed.approvedValue !== undefined) {
          draft.changes[parsed.changeId].approvedValue = parsed.approvedValue;
        }
        draft.changes[parsed.changeId].updatedAt = new Date().toISOString();
      });
      await saveDocument(parsed.channelId, next);
      return next.changes[parsed.changeId];
    },

    /**
     * Merges another device's exported document bytes into the local document for this channel
     * (AUTOMERGE_MIGRATION_PLAN.md §6 CD5's eventual transport; this function is transport-agnostic
     * -- it doesn't care whether `incomingBytes` arrived via a Syncthing-synced file or any other
     * means). Returns exactly the *newly*-introduced conflicts this merge caused, not every
     * conflict that may already have existed in the local document before it (AC-CRDT-07).
     *
     * "New" is judged by which *competing values* (actor keys) exist for a given change/field,
     * not merely by whether that change/field was already flagged as conflicted at all --
     * otherwise a third device's distinct value arriving on an *already*-conflicted field would
     * be silently absorbed into the existing conflict without ever being reported, even though
     * the operator has never seen that particular value and AC-CRDT-02 requires every
     * concurrently-written value stay visible, not just the first two.
     *
     * IMPORTANT operational constraint, found empirically while testing this function: two
     * documents must share a real Automerge history to merge correctly -- two independently
     * created documents (e.g. two devices that each ran `migrateFromSql`/started fresh for the
     * same channel without ever syncing once first) are NOT safely mergeable, and Automerge does
     * not throw or warn when you try; it can silently produce an incomplete result. CD5's
     * continuous sync loop (and CD4's own rollout) must ensure every device's very first
     * participation in a channel comes from importing another device's actual exported bytes
     * (or being the one device that ran `migrateFromSql`), never from two devices independently
     * bootstrapping the same channel's document from scratch.
     */
    async mergeIncoming(input: unknown): Promise<MergeResult> {
      const parsed = parseWithSchema(mergeIncomingInputSchema, input, "mergeIncoming input");
      const localDoc = await loadOrCreateDocument(parsed.channelId);
      const actorsBefore = new Map<string, Set<string>>();
      for (const c of scanForConflicts(localDoc)) {
        actorsBefore.set(`${c.changeId}.${c.field}`, new Set(Object.keys(c.valuesByActor)));
      }

      // Deliberately NOT `Automerge.merge(Automerge.clone(localDoc), incomingDoc)`: an extra
      // clone here (found empirically while testing a 3-way conflict -- see this module's own
      // tests) reassigns a fresh actor id on every call and, across repeated save/reload/merge
      // cycles, silently dropped a third concurrent writer's value from the conflict entirely
      // instead of recording it. `localDoc`, freshly obtained from `Automerge.load`, is already
      // a valid, directly mergeable document -- no clone is needed or safe here.
      const incomingDoc = Automerge.load<ChannelDraftDocument>(parsed.incomingBytes);
      const merged = Automerge.merge(localDoc, incomingDoc);

      const conflictsAfter = scanForConflicts(merged);
      const newConflicts = conflictsAfter.filter((c) => {
        const knownActors = actorsBefore.get(`${c.changeId}.${c.field}`);
        if (!knownActors) return true; // a brand new conflict on this change/field
        return Object.keys(c.valuesByActor).some((actor) => !knownActors.has(actor));
      });

      await saveDocument(parsed.channelId, merged);
      return { newConflicts };
    },

    async listConflicts(input: unknown): Promise<FieldConflict[]> {
      const { channelId } = parseWithSchema(channelIdInputSchema, input, "listConflicts input");
      const doc = await loadDocumentOrThrow(channelId);
      return scanForConflicts(doc);
    },

    /** The exact bytes another device's `mergeIncoming` expects -- see that function's own doc comment. */
    async exportBytes(input: unknown): Promise<Uint8Array> {
      const { channelId } = parseWithSchema(channelIdInputSchema, input, "exportBytes input");
      const doc = await loadDocumentOrThrow(channelId);
      return Automerge.save(doc);
    },

    /**
     * CD4 (AUTOMERGE_MIGRATION_PLAN.md §6): one-time bootstrap of a channel's existing SQL
     * `change_sets`/`changes` rows into its initial Automerge document. Never runs twice against
     * the same channel -- refuses outright if a document already exists, since a second run would
     * either silently duplicate already-migrated drafts or (if the document has since been edited
     * for real) destroy real data by overwriting it wholesale. This is a one-shot bootstrap, not a
     * sync mechanism; ongoing sync is CD5's job, entirely separate from this function.
     *
     * Deliberately all-or-nothing: every change set/change is folded into one in-memory document
     * before `saveDocument` is called once at the very end -- never incrementally per change set.
     * If the process dies partway through, nothing is written at all (safe: the refuse-if-exists
     * guard above will simply let a retry start clean). Do not "optimize" this into an incremental
     * save per change set -- a save after only some change sets migrated would leave a permanent,
     * partially-migrated document that the same guard would then refuse to ever retry against.
     */
    async migrateFromSql(input: unknown): Promise<{ changeSetCount: number; changeCount: number }> {
      const { channelId } = parseWithSchema(channelIdInputSchema, input, "migrateFromSql input");

      const existingBytes = await deps.store.loadDocumentBytes(channelId);
      if (existingBytes) {
        throw new DomainError({
          code: "validation_failed",
          message: "A draft document already exists for this channel -- migration only ever runs once",
          details: { channelId },
        });
      }

      const changeSetsFromSql = await deps.sqlSource.listChangeSetsForChannel(channelId);
      let doc = Automerge.change(emptyDocument(channelId), "migrate change sets from SQL", (draft) => {
        for (const changeSet of changeSetsFromSql) {
          draft.changeSets[changeSet.id] = changeSet;
        }
      });

      let changeCount = 0;
      for (const changeSet of changeSetsFromSql) {
        const changesFromSql = await deps.sqlSource.listChangesForChangeSet(changeSet.id);
        doc = Automerge.change(doc, `migrate changes for change set ${changeSet.id}`, (draft) => {
          for (const change of changesFromSql) {
            draft.changes[change.id] = change;
            changeCount += 1;
          }
        });
      }

      await saveDocument(channelId, doc);
      return { changeSetCount: changeSetsFromSql.length, changeCount };
    },
  };
}

export type ChangeDraftsCore = ReturnType<typeof createChangeDraftsCore>;
