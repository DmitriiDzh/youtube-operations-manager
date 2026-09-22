import * as Automerge from "@automerge/automerge";
import { DomainError } from "@/lib/video-metadata/contracts";
import type { DiscardedDocumentBackupStore, DocumentByteStore } from "./store";

/**
 * Generic, document-shape-agnostic core of what `change-drafts/services.ts` (CD1-CD7) proved
 * empirically for the draft layer -- extracted here (2026-09-22,
 * `docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md` §4, owner instruction: "Объединяем
 * весь этот функционал в отдельный модуль") so a second and third document family
 * (editorial-profile, ai-connections config) reuse the same hard-won merge-safety logic instead
 * of a copy-pasted reimplementation. `change-drafts/` itself is left untouched (`AGENTS.md` §D --
 * already-shipped, safety-adjacent code is not refactored just to share this).
 *
 * Deliberately knows NOTHING about a document's field shape -- conflict scanning is a
 * caller concern (different documents conflict on different fields). This module only owns:
 * load-or-create, merge two documents safely, and the discard/adopt-peer resolution.
 */
export type AutomergeCoreDeps<T extends Record<string, unknown>> = {
  store: DocumentByteStore;
  discardedBackupStore: DiscardedDocumentBackupStore;
  emptyDocument: (key: string) => T;
};

export type MergeOutcome<T extends Record<string, unknown>> = {
  before: Automerge.Doc<T>;
  merged: Automerge.Doc<T>;
};

export type DiscardAndAdoptOutcome<T extends Record<string, unknown>> = {
  backupPath: string | null;
  discarded: Automerge.Doc<T> | null;
  adopted: Automerge.Doc<T>;
};

function genesisChangeHash<T extends Record<string, unknown>>(doc: Automerge.Doc<T>): string {
  const changes = Automerge.getAllChanges(doc);
  return Automerge.decodeChange(changes[0]).hash;
}

export function createAutomergeCore<T extends Record<string, unknown>>(deps: AutomergeCoreDeps<T>) {
  async function loadOrCreate(key: string): Promise<Automerge.Doc<T>> {
    const bytes = await deps.store.loadDocumentBytes(key);
    if (!bytes) return Automerge.from<T>(deps.emptyDocument(key));
    return Automerge.load<T>(bytes);
  }

  async function loadOrThrow(key: string): Promise<Automerge.Doc<T>> {
    const bytes = await deps.store.loadDocumentBytes(key);
    if (!bytes) {
      throw new DomainError({ code: "not_found", message: "No document exists for this key", details: { key } });
    }
    return Automerge.load<T>(bytes);
  }

  async function save(key: string, doc: Automerge.Doc<T>): Promise<void> {
    await deps.store.saveDocumentBytes(key, Automerge.save(doc));
  }

  async function exportBytes(key: string): Promise<Uint8Array> {
    const doc = await loadOrThrow(key);
    return Automerge.save(doc);
  }

  /**
   * The two empirically-found merge-safety fixes from `change-drafts/services.ts`'s own
   * `mergeIncoming`, generalized:
   * (1) a brand-new local document (`Automerge.from()`, fresh unrelated history) merged against a
   *     real incoming one silently drops the whole incoming side in ~55% of runs -- ADOPT it
   *     directly instead of merging when there is truly nothing local yet;
   * (2) a local document that already exists but shares no genesis change with the incoming one
   *     (two devices that independently bootstrapped the same key without ever syncing first)
   *     deterministically loses one whole side -- refuse with `divergent_document_lineage` rather
   *     than silently corrupt local state, mirroring `src/lib/snapshot/`'s own divergent-lineage
   *     handling.
   * Does NOT save the result -- the caller re-projects to SQL and saves via its own `save` call,
   * since only the caller knows how to project its own document shape.
   */
  async function mergeIncoming(key: string, incomingBytes: Uint8Array): Promise<MergeOutcome<T>> {
    const existingBytes = await deps.store.loadDocumentBytes(key);
    const before = existingBytes ? Automerge.load<T>(existingBytes) : Automerge.from<T>(deps.emptyDocument(key));
    const incoming = Automerge.load<T>(incomingBytes);

    if (existingBytes && genesisChangeHash(before) !== genesisChangeHash(incoming)) {
      throw new DomainError({
        code: "divergent_document_lineage",
        message:
          "The incoming document shares no common history with the local document for this key -- refusing to merge rather than silently discard one side's data",
        details: { key },
      });
    }

    const merged = existingBytes ? Automerge.merge(before, incoming) : incoming;
    return { before, merged };
  }

  /**
   * Explicit, human-triggered "discard my local copy, adopt this peer's version instead" --
   * never automatic. Backs up the discarded document first (never overwritten), mirroring
   * `change-drafts/services.ts`'s own `discardLocalAndAdoptPeer` (RISK-46). Does NOT save the
   * adopted document or clean up any projection -- same division of responsibility as
   * `mergeIncoming` above.
   */
  async function discardLocalAndAdoptPeer(key: string, incomingBytes: Uint8Array): Promise<DiscardAndAdoptOutcome<T>> {
    const existingBytes = await deps.store.loadDocumentBytes(key);
    let backupPath: string | null = null;
    let discarded: Automerge.Doc<T> | null = null;
    if (existingBytes) {
      const backup = await deps.discardedBackupStore.backup(key, existingBytes);
      backupPath = backup.path;
      discarded = Automerge.load<T>(existingBytes);
    }
    const adopted = Automerge.load<T>(incomingBytes);
    return { backupPath, discarded, adopted };
  }

  return { loadOrCreate, loadOrThrow, save, exportBytes, mergeIncoming, discardLocalAndAdoptPeer };
}

export type AutomergeCore<T extends Record<string, unknown>> = ReturnType<typeof createAutomergeCore<T>>;
