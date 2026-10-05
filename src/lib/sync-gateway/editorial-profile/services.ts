import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, ConflictLike } from "../automerge-core";
import {
  DomainError,
  EDITORIAL_PROFILE_CONFLICT_FIELDS,
  type EditorialProfileDocument,
  type FieldConflict,
  type MergeResult,
} from "./contracts";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

export type EditorialProfileLogger = {
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

function createDefaultLogger(): EditorialProfileLogger {
  return { error: () => {} };
}

export type ServiceDependencies = {
  core: AutomergeCore<EditorialProfileDocument>;
  sqlSource: SqlSourceAdapter;
  projection: SqlProjectionAdapter;
  logger?: EditorialProfileLogger;
};

function emptyProfile(channelId: string): EditorialProfileDocument {
  return {
    channelId,
    version: 0,
    targetAudience: null,
    toneNotes: null,
    terminologyNotes: null,
    titleConstraints: null,
    descriptionConstraints: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function scanForConflicts(doc: Automerge.Doc<EditorialProfileDocument>): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const field of EDITORIAL_PROFILE_CONFLICT_FIELDS) {
    const valuesByActor = Automerge.getConflicts(doc, field);
    if (valuesByActor && Object.keys(valuesByActor).length > 1) {
      conflicts.push({ field, valuesByActor });
    }
  }
  return conflicts;
}

/** Adapts `scanForConflicts`'s `FieldConflict` shape (`field`) to the generic engine's
 * `ConflictLike` shape (`key`) -- `mergeIncoming` below passes this straight to
 * `deps.core.mergeIncoming`, which calls it before AND after `Automerge.merge()` internally
 * (see that function's own doc comment for why the sequencing must live there, not here). */
function scanConflictsGeneric(doc: Automerge.Doc<EditorialProfileDocument>): ConflictLike[] {
  return scanForConflicts(doc).map((c) => ({ key: c.field, valuesByActor: c.valuesByActor }));
}

export function createEditorialProfileCore(deps: ServiceDependencies) {
  /** A fresh (`version === 0`) document bootstraps from whatever SQL already had for this
   * channel BEFORE this module owned writes -- so cutting over never silently loses an existing
   * profile a channel already had saved the old, direct-SQL way. */
  async function loadOrCreateWithSqlBootstrap(channelId: string): Promise<Automerge.Doc<EditorialProfileDocument>> {
    const doc = await deps.core.loadOrCreate(channelId);
    if (doc.version !== 0) return doc;

    const existing = await deps.sqlSource.getExistingProfile(channelId);
    if (!existing) return doc;

    return Automerge.change(doc, "bootstrap from pre-existing SQL profile", (draft) => {
      draft.version = existing.version;
      draft.targetAudience = existing.targetAudience;
      draft.toneNotes = existing.toneNotes;
      draft.terminologyNotes = existing.terminologyNotes;
      draft.titleConstraints = existing.titleConstraints;
      draft.descriptionConstraints = existing.descriptionConstraints;
      draft.updatedAt = existing.updatedAt;
    });
  }

  async function projectAndSave(channelId: string, doc: Automerge.Doc<EditorialProfileDocument>): Promise<void> {
    await deps.core.save(channelId, doc);
    try {
      await deps.projection.upsertProfile({
        channelId: doc.channelId,
        version: doc.version,
        targetAudience: doc.targetAudience,
        toneNotes: doc.toneNotes,
        terminologyNotes: doc.terminologyNotes,
        titleConstraints: doc.titleConstraints,
        descriptionConstraints: doc.descriptionConstraints,
        updatedAt: doc.updatedAt,
      });
    } catch (error) {
      (deps.logger ?? createDefaultLogger()).error({
        event: "editorial_profile.projection.failed",
        context: { channelId, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return {
    /** `undefined` leaves the stored value unchanged; `null` explicitly clears it -- identical
     * semantics to the old direct-SQL `upsertStoredEditorialProfile` this replaces. */
    async saveProfile(input: {
      channelId: string;
      targetAudience?: string | null;
      toneNotes?: string | null;
      terminologyNotes?: string | null;
      titleConstraints?: string | null;
      descriptionConstraints?: string | null;
    }): Promise<EditorialProfileDocument> {
      const doc = await loadOrCreateWithSqlBootstrap(input.channelId);
      const now = new Date().toISOString();

      const next = Automerge.change(doc, `update editorial profile ${input.channelId}`, (draft) => {
        if (input.targetAudience !== undefined) draft.targetAudience = input.targetAudience;
        if (input.toneNotes !== undefined) draft.toneNotes = input.toneNotes;
        if (input.terminologyNotes !== undefined) draft.terminologyNotes = input.terminologyNotes;
        if (input.titleConstraints !== undefined) draft.titleConstraints = input.titleConstraints;
        if (input.descriptionConstraints !== undefined) draft.descriptionConstraints = input.descriptionConstraints;
        draft.version = doc.version + 1;
        draft.updatedAt = now;
      });

      await projectAndSave(input.channelId, next);
      return {
        channelId: next.channelId,
        version: next.version,
        targetAudience: next.targetAudience,
        toneNotes: next.toneNotes,
        terminologyNotes: next.terminologyNotes,
        titleConstraints: next.titleConstraints,
        descriptionConstraints: next.descriptionConstraints,
        updatedAt: next.updatedAt,
      };
    },

    async exportBytes(channelId: string): Promise<Uint8Array> {
      return deps.core.exportBytes(channelId);
    },

    async mergeIncoming(input: { channelId: string; incomingBytes: Uint8Array }): Promise<MergeResult> {
      const { merged, newConflicts: genericConflicts } = await deps.core.mergeIncoming(
        input.channelId,
        input.incomingBytes,
        scanConflictsGeneric
      );

      await projectAndSave(input.channelId, merged);
      const newConflicts: FieldConflict[] = genericConflicts.map((c) => ({
        field: c.key as FieldConflict["field"],
        valuesByActor: c.valuesByActor,
      }));
      return { newConflicts };
    },

    async discardLocalAndAdoptPeer(input: { channelId: string; incomingBytes: Uint8Array }): Promise<{ backupPath: string | null }> {
      const { backupPath, adopted } = await deps.core.discardLocalAndAdoptPeer(input.channelId, input.incomingBytes);
      await projectAndSave(input.channelId, adopted);
      return { backupPath };
    },

    async listConflicts(channelId: string): Promise<FieldConflict[]> {
      const doc = await deps.core.loadOrThrow(channelId);
      return scanForConflicts(doc);
    },

    /**
     * Mirrors `change-drafts/services.ts`'s own `resolveConflict` exactly: takes `winningActorId`,
     * never a raw value, so the value actually written is re-derived here from Automerge's own
     * recorded conflict -- this can never write something that wasn't already one of the values a
     * device produced through this module's own validated `saveProfile` path. Every field in
     * `EDITORIAL_PROFILE_CONFLICT_FIELDS` shares the same `string | null` type, so (unlike
     * change-drafts' mixed-type `DraftChange`) no per-field switch is needed to stay type-safe.
     */
    async resolveConflict(input: { channelId: string; field: FieldConflict["field"]; winningActorId: string }): Promise<EditorialProfileDocument> {
      const doc = await deps.core.loadOrThrow(input.channelId);
      const conflicts = Automerge.getConflicts(doc, input.field);
      if (!conflicts || !(input.winningActorId in conflicts)) {
        throw new DomainError({
          code: "validation_failed",
          message: "No such conflicting value to resolve -- it may have already been resolved",
          details: { channelId: input.channelId, field: input.field, winningActorId: input.winningActorId },
        });
      }
      const winningValue = conflicts[input.winningActorId] as string | null;

      const next = Automerge.change(doc, `resolve conflict on ${input.field}`, (draft) => {
        draft[input.field] = winningValue;
        draft.updatedAt = new Date().toISOString();
      });

      await projectAndSave(input.channelId, next);
      return {
        channelId: next.channelId,
        version: next.version,
        targetAudience: next.targetAudience,
        toneNotes: next.toneNotes,
        terminologyNotes: next.terminologyNotes,
        titleConstraints: next.titleConstraints,
        descriptionConstraints: next.descriptionConstraints,
        updatedAt: next.updatedAt,
      };
    },
  };
}

export { emptyProfile };
export type EditorialProfileCore = ReturnType<typeof createEditorialProfileCore>;
