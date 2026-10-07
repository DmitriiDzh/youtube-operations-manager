import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, ConflictLike, DocumentByteStore } from "../automerge-core";
import { DomainError, GLOBAL_DOCUMENT_KEY, type MediaSettingsDocument, type MergeResult, type SettingConflict, type SettingValue } from "./contracts";

export type ServiceDependencies = {
  core: AutomergeCore<MediaSettingsDocument>;
  store: DocumentByteStore;
};

/**
 * The document every device starts from: the same actor, the same time and the same content, so its genesis change -- and so
 * its hash -- is identical on every device. Two devices that each start the document on their own therefore share history and
 * merge field by field, instead of being refused as `divergent_document_lineage` (which would need a manual "adopt" in Merge
 * for something as small as a settings map).
 */
const GENESIS_ACTOR = "6d656469612d73657474696e67733031"; // hex of "media-settings01"
export function genesisDocument(): Automerge.Doc<MediaSettingsDocument> {
  return Automerge.change(Automerge.init<MediaSettingsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-media-settings";
    draft.version = 1;
    draft.settings = {};
  });
}
export function emptyDocument(): MediaSettingsDocument {
  return { format: "ytm-media-settings", version: 1, settings: {} };
}

/** Order-preserving canonical JSON of one value (arrays keep their order: the fallback GPU list is ordered). */
const canonical = (value: unknown) => JSON.stringify(value ?? null);

function plain(value: unknown): SettingValue {
  return Array.isArray(value) ? value.map(String) : (value as SettingValue);
}

export function scanForConflicts(doc: Automerge.Doc<MediaSettingsDocument>): SettingConflict[] {
  const conflicts: SettingConflict[] = [];
  const settings = doc.settings ?? {};
  for (const field of Object.keys(settings)) {
    const valuesByActor = Automerge.getConflicts(settings, field);
    if (!valuesByActor || Object.keys(valuesByActor).length < 2) continue;
    const distinct = new Map<string, SettingValue>();
    for (const value of Object.values(valuesByActor)) distinct.set(canonical(plain(value)), plain(value));
    if (distinct.size > 1) conflicts.push({ field, values: [...distinct.values()], valuesByActor });
  }
  return conflicts;
}

function scanConflictsGeneric(doc: Automerge.Doc<MediaSettingsDocument>): ConflictLike[] {
  return scanForConflicts(doc).map((c) => ({ key: c.field, valuesByActor: c.valuesByActor }));
}

export function createMediaSettingsCore(deps: ServiceDependencies) {
  async function loadOrGenesis(): Promise<Automerge.Doc<MediaSettingsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(GLOBAL_DOCUMENT_KEY);
    // Loaded from bytes, so this device writes with its own fresh actor -- never with the genesis actor, which every device
    // shares (its next change would collide with another device's: "duplicate seq").
    return Automerge.load<MediaSettingsDocument>(bytes ?? Automerge.save(genesisDocument()));
  }

  async function write(values: Record<string, SettingValue>, shouldWrite: (current: unknown, value: SettingValue) => boolean): Promise<{ changed: string[] }> {
    const doc = await loadOrGenesis();
    const settings = doc.settings ?? {};
    const changed = Object.keys(values).filter((field) => shouldWrite(settings[field], values[field]));
    if (changed.length === 0) return { changed };
    const next = Automerge.change(doc, `settings: ${changed.join(", ")}`, (draft) => {
      // A list is assigned whole, never edited in place: two devices' lists then conflict cleanly instead of interleaving.
      for (const field of changed) draft.settings[field] = Array.isArray(values[field]) ? [...(values[field] as string[])] : values[field];
    });
    await deps.core.save(GLOBAL_DOCUMENT_KEY, next);
    return { changed };
  }

  return {
    /** The shared values (the Automerge winner of a conflicted field is included; see `conflicts` to know which). */
    async read(): Promise<{ values: Record<string, SettingValue>; conflicts: SettingConflict[] }> {
      const doc = await loadOrGenesis();
      const values: Record<string, SettingValue> = {};
      for (const [field, value] of Object.entries(doc.settings ?? {})) values[field] = plain(value);
      return { values, conflicts: scanForConflicts(doc) };
    },

    /**
     * The owner saved these fields on this device (after its own validation): each one whose value differs from the
     * document's is written. An edit of a conflicted field settles it -- that is the owner's own decision. Values equal to
     * the document's write nothing, so applying a peer's value never echoes back as a new change.
     */
    async publishChanged(values: Record<string, SettingValue>): Promise<{ changed: string[] }> {
      return write(values, (current, value) => current === undefined || canonical(plain(current)) !== canonical(value));
    },

    /**
     * This device's settings for the fields the document does not have yet (the first sync, or a field added by a newer
     * build). Never overwrites a value already shared -- so a device's old local value never silently replaces a newer one.
     */
    async seedMissing(values: Record<string, SettingValue>): Promise<{ changed: string[] }> {
      return write(values, (current) => current === undefined);
    },

    /** The owner picked one of a conflicted field's values in Merge: it becomes the one value on every device. */
    async resolveConflict(input: { field: string; value: SettingValue }): Promise<void> {
      const doc = await loadOrGenesis();
      const conflict = scanForConflicts(doc).find((c) => c.field === input.field);
      if (!conflict) throw new DomainError({ code: "not_found", message: `Setting "${input.field}" has no conflict to resolve.`, details: { field: input.field } });
      if (!conflict.values.some((v) => canonical(v) === canonical(input.value))) {
        throw new DomainError({ code: "validation_failed", message: "The chosen value is not one of the conflicting values.", details: { field: input.field } });
      }
      const next = Automerge.change(doc, `resolve ${input.field}`, (draft) => {
        draft.settings[input.field] = Array.isArray(input.value) ? [...input.value] : input.value;
      });
      await deps.core.save(GLOBAL_DOCUMENT_KEY, next);
    },

    exportBytes: (): Promise<Uint8Array> => deps.core.exportBytes(GLOBAL_DOCUMENT_KEY),

    async mergeIncoming(incomingBytes: Uint8Array): Promise<MergeResult> {
      const { merged, newConflicts } = await deps.core.mergeIncoming(GLOBAL_DOCUMENT_KEY, incomingBytes, scanConflictsGeneric);
      await deps.core.save(GLOBAL_DOCUMENT_KEY, merged);
      const fields = new Set(newConflicts.map((c) => c.key));
      return { newConflicts: scanForConflicts(merged).filter((c) => fields.has(c.field)) };
    },

    async discardLocalAndAdoptPeer(incomingBytes: Uint8Array): Promise<{ backupPath: string | null }> {
      const { backupPath, adopted } = await deps.core.discardLocalAndAdoptPeer(GLOBAL_DOCUMENT_KEY, incomingBytes);
      await deps.core.save(GLOBAL_DOCUMENT_KEY, adopted);
      return { backupPath };
    },
  };
}

export type MediaSettingsCore = ReturnType<typeof createMediaSettingsCore>;
