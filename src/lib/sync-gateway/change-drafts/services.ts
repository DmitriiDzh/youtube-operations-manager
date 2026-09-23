import * as Automerge from "@automerge/automerge";
import {
  DomainError,
  type ChannelDraftDocument,
  type DraftChange,
  type DraftChangeSet,
  type DraftProvenance,
  type FieldConflict,
  type MergeResult,
} from "./contracts";
import {
  addChangeInputSchema,
  bulkPatchChangesInputSchema,
  channelIdInputSchema,
  createChangeSetInputSchema,
  createChangeSetWithChangesInputSchema,
  createProvenanceInputSchema,
  discardLocalAndAdoptPeerInputSchema,
  mergeIncomingInputSchema,
  parseWithSchema,
  patchChangeInputSchema,
  resolveConflictInputSchema,
  setApprovalStatusInputSchema,
  setChangeSetStatusInputSchema,
  updateProposedValueInputSchema,
} from "./schemas";
import type { ChangeDraftsStoreAdapter } from "./adapters/automerge-store";
import type { DiscardedDocumentBackupStore } from "./adapters/discarded-backup-store";
import { createDefaultLogger, type ChangeDraftsLogger } from "./adapters/logger";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

export type ServiceDependencies = {
  store: ChangeDraftsStoreAdapter;
  sqlSource: SqlSourceAdapter;
  projection: SqlProjectionAdapter;
  /** RISK-46 (docs/TECHNICAL_DEBT.md): captures the local document being discarded before
   * `discardLocalAndAdoptPeer` overwrites it, so the discard is never silently unrecoverable. */
  discardedBackupStore: DiscardedDocumentBackupStore;
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
    provenance: {},
  });
}

/**
 * The hash of a document's very first ("genesis") change -- deterministic for every document
 * that shares real history with another (a real `Automerge.load` of previously-`Automerge.save`d
 * bytes, or a document produced by `Automerge.merge`/`Automerge.change` starting from one of
 * those), and different for every independently-created document (`Automerge.from()` draws a
 * fresh random actor id and starts an unrelated history each time it runs). Used by
 * `mergeIncoming` to refuse a merge between two documents with no common ancestor, rather than
 * silently corrupt one side -- see that function's own doc comment for the empirical failure this
 * guards against. Verified empirically (this module's own probe scripts, not from Automerge's
 * docs): two real forks of the same document always share this hash even after both diverge;
 * two independently-created documents never do.
 */
function genesisChangeHash(doc: Automerge.Doc<ChannelDraftDocument>): string {
  const changes = Automerge.getAllChanges(doc);
  return Automerge.decodeChange(changes[0]).hash;
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
    // `provenance` may be entirely absent on a document saved before M4 added this field
    // (`contracts.ts`'s own doc comment) -- never assume it exists.
    for (const provenance of Object.values(doc.provenance ?? {})) {
      await deps.projection.upsertProvenance(provenance);
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
        validationStatus: parsed.validationStatus ?? "valid",
        validationError: parsed.validationError ?? null,
        conflictStatus: parsed.conflictStatus ?? "none",
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
     * A change set plus all of its changes, created as a SINGLE `Automerge.change` + a single
     * `saveDocument` call -- never as separate `createChangeSet`/`addChange`/`setChangeSetStatus`
     * calls. This preserves the all-or-nothing guarantee the OLD direct-SQL adapter had via one
     * `db.transaction(...)` (AGENTS.md §K.3): if this were split into N+2 sequential saves and
     * save #17 of 200 threw, the Automerge document (source of truth) would durably keep a
     * partially-populated change set with no rollback. One in-memory Automerge mutation followed
     * by one save avoids that -- either the whole batch lands, or (on a validation error thrown
     * before the `Automerge.change` call) nothing does.
     */
    async createChangeSetWithChanges(input: unknown): Promise<DraftChangeSet> {
      const parsed = parseWithSchema(createChangeSetWithChangesInputSchema, input, "createChangeSetWithChanges input");
      const doc = await loadOrCreateDocument(parsed.channelId);

      if (doc.changeSets[parsed.changeSetId]) {
        throw new DomainError({
          code: "validation_failed",
          message: "A change set with this id already exists",
          details: { changeSetId: parsed.changeSetId },
        });
      }
      for (const change of parsed.changes) {
        if (doc.changes[change.changeId]) {
          throw new DomainError({
            code: "validation_failed",
            message: "A change with this id already exists",
            details: { changeId: change.changeId },
          });
        }
      }

      const now = new Date().toISOString();
      const changeSet: DraftChangeSet = {
        id: parsed.changeSetId,
        channelId: parsed.channelId,
        source: parsed.source,
        status: parsed.initialStatus ?? "in_review",
        importedFilename: parsed.importedFilename ?? null,
        schemaVersion: parsed.schemaVersion ?? null,
        exportedAt: parsed.exportedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };

      const next = Automerge.change(
        doc,
        `create change set ${parsed.changeSetId} with ${parsed.changes.length} changes`,
        (draft) => {
          draft.changeSets[parsed.changeSetId] = changeSet;
          for (const change of parsed.changes) {
            draft.changes[change.changeId] = {
              id: change.changeId,
              changeSetId: parsed.changeSetId,
              videoId: change.videoId,
              language: change.language,
              field: change.field,
              baselineValue: change.baselineValue,
              proposedValue: change.proposedValue,
              changeType: change.changeType,
              validationStatus: change.validationStatus ?? "valid",
              validationError: change.validationError ?? null,
              conflictStatus: change.conflictStatus ?? "none",
              approvalStatus: "pending",
              approvedValue: null,
              createdAt: now,
              updatedAt: now,
            };
          }
        }
      );
      await saveDocument(parsed.channelId, next);
      return next.changeSets[parsed.changeSetId];
    },

    /**
     * M4 (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4, Category C): write-once
     * AI-generation provenance for a change set, folded into this same per-channel document.
     * Never updated or deleted through this API -- a duplicate `id` is rejected the same way
     * `createChangeSet`/`addChange` reject a duplicate id above. Pre-existing provenance rows
     * created in SQL before this cutover are NOT retroactively backfilled into any channel's
     * document (accepted limitation, same reasoning as `video_metrics_daily` staying device-local
     * -- this is audit/debug data, not a user-facing setting a cutover must not appear to lose).
     */
    async createProvenance(input: unknown): Promise<DraftProvenance> {
      const parsed = parseWithSchema(createProvenanceInputSchema, input, "createProvenance input");
      const doc = await loadOrCreateDocument(parsed.channelId);

      if (doc.provenance?.[parsed.id]) {
        throw new DomainError({
          code: "validation_failed",
          message: "Provenance with this id already exists",
          details: { id: parsed.id },
        });
      }

      const provenance: DraftProvenance = {
        id: parsed.id,
        changeSetId: parsed.changeSetId,
        channelId: parsed.channelId,
        profileVersion: parsed.profileVersion,
        effectiveContextJson: parsed.effectiveContextJson,
        createdAt: new Date().toISOString(),
      };

      const next = Automerge.change(doc, `create provenance ${parsed.id}`, (draft) => {
        // Defensive init -- a document saved before M4 has no `provenance` key at all
        // (`contracts.ts`'s own doc comment), and Automerge has no schema migration.
        if (!draft.provenance) draft.provenance = {};
        draft.provenance[parsed.id] = provenance;
      });
      await saveDocument(parsed.channelId, next);
      return provenance;
    },

    /**
     * Patches multiple changes (approve-all/reject-all/revalidation's dirty-write) in ONE
     * `Automerge.change` + one `saveDocument` call, for the same all-or-nothing reason as
     * `createChangeSetWithChanges` above -- the old direct-SQL adapter's `bulkUpdateStoredChanges`
     * wrapped every update in one `db.transaction`. Every caller in
     * `src/lib/changesets/services.ts` only ever passes changes belonging to a single change
     * set/channel in one call.
     */
    async bulkPatchChanges(input: unknown): Promise<DraftChange[]> {
      const parsed = parseWithSchema(bulkPatchChangesInputSchema, input, "bulkPatchChanges input");
      const doc = await loadOrCreateDocument(parsed.channelId);

      for (const update of parsed.updates) {
        if (!doc.changes[update.changeId]) {
          throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId: update.changeId } });
        }
      }

      const now = new Date().toISOString();
      const next = Automerge.change(doc, `bulk patch ${parsed.updates.length} changes`, (draft) => {
        for (const update of parsed.updates) {
          const change = draft.changes[update.changeId];
          if (update.patch.conflictStatus !== undefined) change.conflictStatus = update.patch.conflictStatus;
          if (update.patch.approvalStatus !== undefined) change.approvalStatus = update.patch.approvalStatus;
          if (update.patch.approvedValue !== undefined) change.approvedValue = update.patch.approvedValue;
          change.updatedAt = now;
        }
      });
      await saveDocument(parsed.channelId, next);
      return parsed.updates.map((u) => next.changes[u.changeId]);
    },

    async setChangeSetStatus(input: unknown): Promise<DraftChangeSet> {
      const parsed = parseWithSchema(setChangeSetStatusInputSchema, input, "setChangeSetStatus input");
      const doc = await loadOrCreateDocument(parsed.channelId);
      if (!doc.changeSets[parsed.changeSetId]) {
        throw new DomainError({ code: "not_found", message: "Change set not found", details: { changeSetId: parsed.changeSetId } });
      }

      const next = Automerge.change(doc, `set status for change set ${parsed.changeSetId}`, (draft) => {
        draft.changeSets[parsed.changeSetId].status = parsed.status;
        draft.changeSets[parsed.changeSetId].updatedAt = new Date().toISOString();
      });
      await saveDocument(parsed.channelId, next);
      return next.changeSets[parsed.changeSetId];
    },

    /**
     * A more general sibling of `setApprovalStatus`, covering every field
     * `src/lib/changesets/`'s own `updateChange`/`bulkUpdateChanges` contract needs to patch
     * (`conflictStatus` included -- e.g. after a fresh remote check finds a video changed since
     * approval) -- `setApprovalStatus` stays as the narrower, already-tested convenience for the
     * common approve/reject case.
     */
    async patchChange(input: unknown): Promise<DraftChange> {
      const parsed = parseWithSchema(patchChangeInputSchema, input, "patchChange input");
      const doc = await loadOrCreateDocument(parsed.channelId);
      if (!doc.changes[parsed.changeId]) {
        throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId: parsed.changeId } });
      }

      const next = Automerge.change(doc, `patch change ${parsed.changeId}`, (draft) => {
        const change = draft.changes[parsed.changeId];
        if (parsed.patch.conflictStatus !== undefined) change.conflictStatus = parsed.patch.conflictStatus;
        if (parsed.patch.approvalStatus !== undefined) change.approvalStatus = parsed.patch.approvalStatus;
        if (parsed.patch.approvedValue !== undefined) change.approvedValue = parsed.patch.approvedValue;
        change.updatedAt = new Date().toISOString();
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
      const existingBytes = await deps.store.loadDocumentBytes(parsed.channelId);
      const localDoc = existingBytes
        ? Automerge.load<ChannelDraftDocument>(existingBytes)
        : emptyDocument(parsed.channelId);
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

      // CRITICAL, found empirically while designing CD5 (device onboarding to a channel it has
      // never touched before): when `existingBytes` is null, `localDoc` above is a freshly,
      // independently-created empty document (`emptyDocument()` calls `Automerge.from()`, which
      // draws a random actor id and starts a brand-new, unrelated history every time it runs) --
      // it shares NO real history with `incomingDoc`. `Automerge.merge()` between two
      // independently-rooted documents is NOT a safe recursive combine: measured empirically
      // (100 trials, fresh random actor ids each time), it silently discarded the ENTIRE incoming
      // document's content in 55/100 runs -- a coin flip tied to random actor-id tie-breaking at
      // the root map keys, not a rare edge case. The correct move when there is truly nothing
      // local to combine is to ADOPT the incoming bytes directly as the new local document --
      // never attempt a merge at all in this case. `actorsBefore` is still computed from the
      // (empty) local state above, so every conflict already present in the adopted document is
      // correctly reported as "new" to this device, exactly as it should be for a first import.
      //
      // A second, related failure mode found while designing CD5's multi-peer sync loop: even
      // when `existingBytes` IS present, `localDoc` and `incomingDoc` can still share no real
      // history -- e.g. this device already adopted peer B's document (no local doc existed
      // before that), and is now processing peer C's file, where B and C independently
      // bootstrapped the same channel without ever syncing with each other first
      // (AUTOMERGE_MIGRATION_PLAN.md §6 CD5's own documented operational constraint). Measured
      // empirically: this is not a probabilistic coin flip like the empty-local case above -- it
      // is a DETERMINISTIC 100/100 silent loss of one whole side's content. A shared genesis
      // change hash (`genesisChangeHash`) reliably distinguishes "these two documents have real
      // common history" from "these two are unrelated" (verified: a real fork always keeps its
      // origin's genesis hash even after diverging; an independently-created document never
      // matches). Fail closed here rather than silently corrupt local state -- mirrors this
      // codebase's own established handling of the identical class of problem in
      // `src/lib/snapshot/` ("divergent lineage... блокируется явно, никогда не разрешается по
      // createdAt").
      if (existingBytes && genesisChangeHash(localDoc) !== genesisChangeHash(incomingDoc)) {
        throw new DomainError({
          code: "divergent_document_lineage",
          message:
            "The incoming document shares no common history with the local document for this channel -- refusing to merge rather than silently discard one side's data",
          details: { channelId: parsed.channelId },
        });
      }

      const merged = existingBytes ? Automerge.merge(localDoc, incomingDoc) : incomingDoc;

      const conflictsAfter = scanForConflicts(merged);
      const newConflicts = conflictsAfter.filter((c) => {
        const knownActors = actorsBefore.get(`${c.changeId}.${c.field}`);
        if (!knownActors) return true; // a brand new conflict on this change/field
        return Object.keys(c.valuesByActor).some((actor) => !knownActors.has(actor));
      });

      await saveDocument(parsed.channelId, merged);
      return { newConflicts };
    },

    /**
     * RISK-46 (docs/TECHNICAL_DEBT.md): the explicit, human-triggered "discard my local copy,
     * adopt this peer's version instead" resolution for a channel whose document diverged from a
     * peer's (no shared history, `divergent_document_lineage` above) -- never automatic, exactly
     * as that risk's remediation requires. Unlike `mergeIncoming`, this is NOT a merge: the local
     * document is unconditionally replaced by the incoming one. The local document being
     * discarded is backed up first (`deps.discardedBackupStore`, immutable, never overwritten) so
     * this destructive action is never silently unrecoverable, per `docs/PROJECT_SPEC.md` §16's
     * "no deletion is permanent and immediate" principle applied here. If there is no local
     * document at all yet, there is nothing to back up or discard -- this degenerates to a plain
     * adopt, though in practice a divergent-lineage error can only ever have been raised when a
     * local document already existed.
     */
    async discardLocalAndAdoptPeer(input: unknown): Promise<{ backupPath: string | null }> {
      const parsed = parseWithSchema(discardLocalAndAdoptPeerInputSchema, input, "discardLocalAndAdoptPeer input");

      const existingBytes = await deps.store.loadDocumentBytes(parsed.channelId);
      let backupPath: string | null = null;
      let discardedDoc: Automerge.Doc<ChannelDraftDocument> | null = null;
      if (existingBytes) {
        const backup = await deps.discardedBackupStore.backup(parsed.channelId, existingBytes);
        backupPath = backup.path;
        discardedDoc = Automerge.load<ChannelDraftDocument>(existingBytes);
      }

      // Deliberately `saveDocument` BEFORE deleting the orphaned rows below, not after (considered
      // and rejected the reverse ordering during review): the Automerge document -- not SQL -- is
      // this module's source of truth (`saveDocument`'s own doc comment). Deleting the stale rows
      // FIRST would create a window where a crash leaves SQL already missing rows for the
      // discarded document while the actual on-disk `.automerge` file (not yet overwritten) still
      // IS that discarded document -- SQL would then disagree with the real source of truth, not
      // just lag behind it. Saving first means the worst a crash between these two steps can do is
      // leave the exact same class of stale-but-harmless phantom row this fix addresses (logged,
      // never thrown, self-evident the next time anyone looks) -- SQL never disagrees with what
      // the document actually is, only with what it used to be.
      const adopted = Automerge.load<ChannelDraftDocument>(parsed.incomingBytes);
      await saveDocument(parsed.channelId, adopted);

      // `saveDocument`'s own projection only ever upserts the ADOPTED document's current rows --
      // it never removes a row for a change set/change that existed ONLY in the just-discarded
      // document. Found live (not assumed): without this, a change set from the discarded
      // document remained forever visible via `listChangeSets`/`getChangeSet` yet threw
      // `not_found` the instant anything (approve/reject) tried to act on it, since the Automerge
      // document -- the actual source of truth -- no longer has it. Deletes are scoped to exactly
      // the ids that disappeared, isolated in their own try/catch so a transient DB error here
      // never fails the discard itself (the document write, the part that matters most, already
      // succeeded) -- same reasoning as `saveDocument`'s own projection isolation above.
      if (discardedDoc) {
        try {
          for (const changeSetId of Object.keys(discardedDoc.changeSets)) {
            if (!(changeSetId in adopted.changeSets)) {
              await deps.projection.deleteChangeSet(changeSetId);
            }
          }
          for (const changeId of Object.keys(discardedDoc.changes)) {
            if (!(changeId in adopted.changes)) {
              await deps.projection.deleteChange(changeId);
            }
          }
        } catch (error) {
          (deps.logger ?? createDefaultLogger()).error({
            event: "change_drafts.discard_projection_cleanup_failed",
            context: { channelId: parsed.channelId, cause: error instanceof Error ? error.message : String(error) },
          });
        }
      }

      return { backupPath };
    },

    async listConflicts(input: unknown): Promise<FieldConflict[]> {
      const { channelId } = parseWithSchema(channelIdInputSchema, input, "listConflicts input");
      const doc = await loadDocumentOrThrow(channelId);
      return scanForConflicts(doc);
    },

    /**
     * Resolves a genuine, currently-recorded conflict on one field of one change (CD6, human
     * decision) by writing a fresh value on top of the merged history -- proven empirically (this
     * module's own probe scripts, not assumed from Automerge's docs) that a single subsequent
     * `Automerge.change` write causally succeeding both conflicting predecessors clears
     * `Automerge.getConflicts` for that property entirely, both in-memory and across the
     * save/load boundary.
     *
     * Deliberately takes `winningActorId`, never a raw value from the caller: the actual value to
     * write is re-derived here from Automerge's own recorded conflict, so this can never write a
     * value that wasn't already one of the values a device produced through this module's own
     * validated write paths (`updateProposedValue`/`setApprovalStatus`/`patchChange`). Restricted
     * to `proposedValue`/`approvalStatus`/`approvedValue`/`conflictStatus` -- the only fields
     * realistic for two devices to actually conflict on in practice (`schemas.ts`'s own comment).
     */
    async resolveConflict(input: unknown): Promise<DraftChange> {
      const parsed = parseWithSchema(resolveConflictInputSchema, input, "resolveConflict input");
      const doc = await loadOrCreateDocument(parsed.channelId);
      const change = doc.changes[parsed.changeId];
      if (!change) {
        throw new DomainError({ code: "not_found", message: "Change not found", details: { changeId: parsed.changeId } });
      }

      const conflicts = Automerge.getConflicts(change, parsed.field);
      if (!conflicts || !(parsed.winningActorId in conflicts)) {
        throw new DomainError({
          code: "validation_failed",
          message: "No such conflicting value to resolve -- it may have already been resolved",
          details: { changeId: parsed.changeId, field: parsed.field, winningActorId: parsed.winningActorId },
        });
      }
      const winningValue = conflicts[parsed.winningActorId];

      const next = Automerge.change(doc, `resolve conflict on ${parsed.changeId}.${parsed.field}`, (draft) => {
        const target = draft.changes[parsed.changeId];
        switch (parsed.field) {
          case "proposedValue":
            target.proposedValue = winningValue as string;
            break;
          case "approvalStatus":
            target.approvalStatus = winningValue as DraftChange["approvalStatus"];
            break;
          case "approvedValue":
            target.approvedValue = winningValue as string | null;
            break;
          case "conflictStatus":
            target.conflictStatus = winningValue as DraftChange["conflictStatus"];
            break;
        }
        target.updatedAt = new Date().toISOString();
      });
      await saveDocument(parsed.channelId, next);
      return next.changes[parsed.changeId];
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
