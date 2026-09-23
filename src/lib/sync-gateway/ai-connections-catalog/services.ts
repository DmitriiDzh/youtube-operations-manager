import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, ConflictLike } from "../automerge-core";
import type { DocumentByteStore } from "../automerge-core/store";
import {
  AI_CONNECTION_MUTABLE_FIELDS,
  DomainError,
  GLOBAL_DOCUMENT_KEY,
  type AiConnectionEntry,
  type AiConnectionsDocument,
  type FieldConflict,
  type MergeResult,
} from "./contracts";
import type { SqlProjectionAdapter } from "./adapters/sql-projection";
import type { SqlSourceAdapter } from "./adapters/sql-source";

export type AiConnectionsCatalogLogger = {
  error(payload: { event: string; context?: Record<string, unknown> }): void;
};

function createDefaultLogger(): AiConnectionsCatalogLogger {
  return { error: () => {} };
}

export type ServiceDependencies = {
  core: AutomergeCore<AiConnectionsDocument>;
  /** Kept separately from `core` only to answer "has ANY document ever been saved for this key"
   * -- the one-time SQL-bootstrap trigger below, which `AutomergeCore` deliberately doesn't
   * expose (an empty `connections` map is otherwise ambiguous: never-bootstrapped vs.
   * genuinely-zero-connections-after-deletions). */
  store: DocumentByteStore;
  sqlSource: SqlSourceAdapter;
  projection: SqlProjectionAdapter;
  logger?: AiConnectionsCatalogLogger;
};

export function emptyDocument(): AiConnectionsDocument {
  return { connections: {} };
}

function scanForConflicts(doc: Automerge.Doc<AiConnectionsDocument>): FieldConflict[] {
  const conflicts: FieldConflict[] = [];
  for (const [connectionId, connection] of Object.entries(doc.connections)) {
    for (const field of AI_CONNECTION_MUTABLE_FIELDS) {
      const valuesByActor = Automerge.getConflicts(connection, field);
      if (valuesByActor && Object.keys(valuesByActor).length > 1) {
        conflicts.push({ connectionId, field, valuesByActor });
      }
    }
  }
  return conflicts;
}

function scanConflictsGeneric(doc: Automerge.Doc<AiConnectionsDocument>): ConflictLike[] {
  return scanForConflicts(doc).map((c) => ({ key: `${c.connectionId}.${c.field}`, valuesByActor: c.valuesByActor }));
}

export function createAiConnectionsCatalogCore(deps: ServiceDependencies) {
  /** One-time SQL bootstrap (mirrors CD4's `migrateFromSql`, triggered lazily on first real
   * write instead of a separate explicit rollout call -- see `ServiceDependencies.store`'s own
   * doc comment for why "never saved yet" is the unambiguous trigger here). */
  async function loadOrCreateWithSqlBootstrap(): Promise<Automerge.Doc<AiConnectionsDocument>> {
    const existingBytes = await deps.store.loadDocumentBytes(GLOBAL_DOCUMENT_KEY);
    if (existingBytes) return Automerge.load<AiConnectionsDocument>(existingBytes);

    const existingRows = await deps.sqlSource.listExistingConnections();
    return Automerge.change(Automerge.from<AiConnectionsDocument>(emptyDocument()), "bootstrap from pre-existing SQL rows", (draft) => {
      for (const row of existingRows) draft.connections[row.id] = row;
    });
  }

  async function projectAndSave(doc: Automerge.Doc<AiConnectionsDocument>, touchedIds: string[]): Promise<void> {
    await deps.core.save(GLOBAL_DOCUMENT_KEY, doc);
    try {
      for (const id of touchedIds) {
        const connection = doc.connections[id];
        if (connection) {
          await deps.projection.upsertConnection({ ...connection });
        } else {
          await deps.projection.deleteConnection(id);
        }
      }
    } catch (error) {
      (deps.logger ?? createDefaultLogger()).error({
        event: "ai_connections_catalog.projection.failed",
        context: { touchedIds, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return {
    async createConnection(input: Omit<AiConnectionEntry, "status" | "statusMessage" | "statusCheckedAt" | "createdAt" | "updatedAt">): Promise<AiConnectionEntry> {
      const doc = await loadOrCreateWithSqlBootstrap();
      if (doc.connections[input.id]) {
        throw new DomainError({ code: "validation_failed", message: "A connection with this id already exists", details: { connectionId: input.id } });
      }

      const now = new Date().toISOString();
      const entry: AiConnectionEntry = { ...input, status: "unknown", statusMessage: null, statusCheckedAt: null, createdAt: now, updatedAt: now };

      const next = Automerge.change(doc, `create connection ${input.id}`, (draft) => {
        draft.connections[input.id] = entry;
      });
      await projectAndSave(next, [input.id]);
      return entry;
    },

    async updateConnection(
      connectionId: string,
      patch: Partial<Omit<AiConnectionEntry, "id" | "createdAt" | "updatedAt">>
    ): Promise<AiConnectionEntry | null> {
      const doc = await loadOrCreateWithSqlBootstrap();
      if (!doc.connections[connectionId]) return null;

      const now = new Date().toISOString();
      const next = Automerge.change(doc, `update connection ${connectionId}`, (draft) => {
        const target = draft.connections[connectionId];
        for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
          const value = patch[key];
          if (value !== undefined) (target as Record<string, unknown>)[key] = value;
        }
        target.updatedAt = now;
      });
      await projectAndSave(next, [connectionId]);
      return next.connections[connectionId];
    },

    async deleteConnection(connectionId: string): Promise<void> {
      const doc = await loadOrCreateWithSqlBootstrap();
      if (!doc.connections[connectionId]) return;

      const next = Automerge.change(doc, `delete connection ${connectionId}`, (draft) => {
        delete draft.connections[connectionId];
      });
      await projectAndSave(next, [connectionId]);
    },

    async exportBytes(): Promise<Uint8Array> {
      return deps.core.exportBytes(GLOBAL_DOCUMENT_KEY);
    },

    async mergeIncoming(incomingBytes: Uint8Array): Promise<MergeResult> {
      // Regression (found by advisor review, same bug class as change-drafts' own RISK-46 orphan-
      // row fix): a connection deleted by a PEER (present locally before this merge, absent from
      // `merged`) must still be included in the projection pass so `deleteConnection` actually
      // runs for it -- `Object.keys(merged.connections)` alone only ever grows the projection,
      // never shrinks it. The pre-merge key set is read BEFORE calling the generic engine's
      // `mergeIncoming` (which may mutate the underlying document in place, per
      // `automerge-core/engine.ts`'s own mutation-order warning) -- never derived from it after.
      const beforeBytes = await deps.store.loadDocumentBytes(GLOBAL_DOCUMENT_KEY);
      const beforeIds = beforeBytes ? Object.keys(Automerge.load<AiConnectionsDocument>(beforeBytes).connections) : [];

      const { merged, newConflicts: genericConflicts } = await deps.core.mergeIncoming(GLOBAL_DOCUMENT_KEY, incomingBytes, scanConflictsGeneric);
      const touchedIds = new Set([...beforeIds, ...Object.keys(merged.connections)]);
      await projectAndSave(merged, [...touchedIds]);

      const newConflicts: FieldConflict[] = genericConflicts.map((c) => {
        const [connectionId, field] = c.key.split(/\.(.+)/);
        return { connectionId, field: field as FieldConflict["field"], valuesByActor: c.valuesByActor };
      });
      return { newConflicts };
    },

    async discardLocalAndAdoptPeer(incomingBytes: Uint8Array): Promise<{ backupPath: string | null }> {
      const { backupPath, discarded, adopted } = await deps.core.discardLocalAndAdoptPeer(GLOBAL_DOCUMENT_KEY, incomingBytes);

      const touchedIds = new Set([...Object.keys(discarded?.connections ?? {}), ...Object.keys(adopted.connections)]);
      await projectAndSave(adopted, [...touchedIds]);
      return { backupPath };
    },

    async listConflicts(): Promise<FieldConflict[]> {
      const doc = await deps.core.loadOrThrow(GLOBAL_DOCUMENT_KEY);
      return scanForConflicts(doc);
    },

    /**
     * Mirrors `change-drafts/services.ts`'s own `resolveConflict`: takes `winningActorId`, never
     * a raw value -- the value actually written is re-derived here from Automerge's own recorded
     * conflict. `AI_CONNECTION_MUTABLE_FIELDS` is heterogeneously typed (unlike editorial-profile's
     * uniform `string | null`), so a per-field switch keeps the write type-safe, same reasoning as
     * change-drafts' own `DraftChange` fields.
     */
    async resolveConflict(input: { connectionId: string; field: FieldConflict["field"]; winningActorId: string }): Promise<AiConnectionEntry> {
      const doc = await deps.core.loadOrThrow(GLOBAL_DOCUMENT_KEY);
      const connection = doc.connections[input.connectionId];
      if (!connection) {
        throw new DomainError({ code: "not_found", message: "Connection not found", details: { connectionId: input.connectionId } });
      }

      const conflicts = Automerge.getConflicts(connection, input.field);
      if (!conflicts || !(input.winningActorId in conflicts)) {
        throw new DomainError({
          code: "validation_failed",
          message: "No such conflicting value to resolve -- it may have already been resolved",
          details: { connectionId: input.connectionId, field: input.field, winningActorId: input.winningActorId },
        });
      }
      const winningValue = conflicts[input.winningActorId];

      const next = Automerge.change(doc, `resolve conflict on ${input.connectionId}.${input.field}`, (draft) => {
        const target = draft.connections[input.connectionId];
        switch (input.field) {
          case "displayName":
            target.displayName = winningValue as string;
            break;
          case "baseUrl":
            target.baseUrl = winningValue as string | null;
            break;
          case "modelId":
            target.modelId = winningValue as string;
            break;
          case "localInferenceMode":
            target.localInferenceMode = winningValue as boolean;
            break;
          case "enabled":
            target.enabled = winningValue as boolean;
            break;
          case "status":
            target.status = winningValue as string;
            break;
          case "statusMessage":
            target.statusMessage = winningValue as string | null;
            break;
          case "statusCheckedAt":
            target.statusCheckedAt = winningValue as string | null;
            break;
          case "capabilitiesJson":
            target.capabilitiesJson = winningValue as string;
            break;
          case "assignedTasksJson":
            target.assignedTasksJson = winningValue as string;
            break;
          case "pricingJson":
            target.pricingJson = winningValue as string | null;
            break;
        }
        target.updatedAt = new Date().toISOString();
      });

      await projectAndSave(next, [input.connectionId]);
      return next.connections[input.connectionId];
    },
  };
}

export type AiConnectionsCatalogCore = ReturnType<typeof createAiConnectionsCatalogCore>;
