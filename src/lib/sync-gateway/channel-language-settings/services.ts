import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, ConflictLike, DocumentByteStore } from "../automerge-core";
import {
  BASELINE_FIELDS,
  DomainError,
  LANGUAGE_SETTING_FIELDS,
  type ChannelLanguageSettingsDocument,
  type LanguageSettingConflict,
  type LanguageSettingField,
  type LanguageSettingValue,
  type LanguageSettingValues,
  type MergeResult,
} from "./contracts";

/** This computer's own copy of the settings (the `channels` columns every reader already uses). */
export type LocalLanguageSettingsStore = {
  read(channelId: string): Promise<LanguageSettingValues>;
  write(channelId: string, patch: Partial<LanguageSettingValues>): Promise<void>;
};

export type ChannelLanguageSettingsLogger = {
  info(payload: { event: string; context?: Record<string, unknown> }): void;
};

export type ServiceDependencies = {
  core: AutomergeCore<ChannelLanguageSettingsDocument>;
  store: DocumentByteStore;
  local: LocalLanguageSettingsStore;
  logger?: ChannelLanguageSettingsLogger;
};

/**
 * The document every computer starts a channel from: the same actor, the same time and the same content, so its genesis change
 * -- and its hash -- is identical everywhere (the `media-settings` pattern). Two computers that each started the channel's
 * document on their own share history and merge field by field, never refused as `divergent_document_lineage`.
 */
const GENESIS_ACTOR = "6368616e6e656c2d6c616e6775616765"; // hex of "channel-language"
export function genesisDocument(channelId: string): Automerge.Doc<ChannelLanguageSettingsDocument> {
  return Automerge.change(Automerge.init<ChannelLanguageSettingsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-channel-language-settings";
    draft.version = 1;
    draft.channelId = channelId;
    draft.settings = {};
  });
}
export function emptyDocument(channelId: string): ChannelLanguageSettingsDocument {
  return { format: "ytm-channel-language-settings", version: 1, channelId, settings: {} };
}

function plain(field: LanguageSettingField, value: unknown): LanguageSettingValue {
  if (field === "trackedLanguages") return Array.isArray(value) ? value.map(String) : [];
  return typeof value === "string" ? value : null;
}

/** Tracked languages are a set: the same languages in another order are the same setting. */
function canonical(field: LanguageSettingField, value: unknown): string {
  const v = plain(field, value);
  return JSON.stringify(Array.isArray(v) ? [...new Set(v)].sort() : v);
}

/** A value worth carrying to the other computer at the first sync: an empty one would only conflict with a real one there. */
function isSet(value: LanguageSettingValue): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null && value.trim() !== "";
}

function assign(draft: ChannelLanguageSettingsDocument, field: LanguageSettingField, value: LanguageSettingValue) {
  // A list is assigned whole, never edited in place: two computers' lists then conflict cleanly instead of interleaving.
  if (field === "trackedLanguages") draft.settings.trackedLanguages = [...(value as string[])];
  else draft.settings[field] = value as string | null;
}

function scan(doc: Automerge.Doc<ChannelLanguageSettingsDocument>): Array<Omit<LanguageSettingConflict, "thisComputer">> {
  const conflicts: Array<Omit<LanguageSettingConflict, "thisComputer">> = [];
  const settings = doc.settings ?? {};
  for (const field of LANGUAGE_SETTING_FIELDS) {
    const raw = Automerge.getConflicts(settings, field);
    if (!raw || Object.keys(raw).length < 2) continue;
    const byValue = new Map<string, { actor: string; value: LanguageSettingValue }>();
    for (const actor of Object.keys(raw).sort()) {
      const value = plain(field, raw[actor]);
      const key = canonical(field, value);
      if (!byValue.has(key)) byValue.set(key, { actor, value });
    }
    if (byValue.size < 2) continue;
    const entries = [...byValue.values()];
    conflicts.push({ field, values: entries.map((e) => e.value), valuesByActor: Object.fromEntries(entries.map((e) => [e.actor, e.value])) });
  }
  return conflicts;
}

function scanGeneric(doc: Automerge.Doc<ChannelLanguageSettingsDocument>): ConflictLike[] {
  return scan(doc).map((c) => ({ key: c.field, valuesByActor: c.valuesByActor }));
}

function sharedValues(doc: Automerge.Doc<ChannelLanguageSettingsDocument>): Partial<LanguageSettingValues> {
  const out: Partial<LanguageSettingValues> = {};
  const settings = doc.settings ?? {};
  for (const field of LANGUAGE_SETTING_FIELDS) {
    if (field in settings) (out as Record<string, LanguageSettingValue>)[field] = plain(field, settings[field]);
  }
  return out;
}

export function createChannelLanguageSettingsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before an owner's save would
  // otherwise write its result over that save (the `media-settings` independent-review finding).
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<ChannelLanguageSettingsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<ChannelLanguageSettingsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  /**
   * This computer's copy follows the shared document, field by field -- except a field set differently on the two computers:
   * each keeps its own value until the owner chooses, so a Batch never starts writing with a baseline nobody picked.
   */
  async function applyToLocal(channelId: string, doc: Automerge.Doc<ChannelLanguageSettingsDocument>): Promise<LanguageSettingField[]> {
    const local = await deps.local.read(channelId);
    const conflicted = new Set(scan(doc).map((c) => c.field));
    const shared = sharedValues(doc);
    const patch: Partial<LanguageSettingValues> = {};
    for (const field of LANGUAGE_SETTING_FIELDS) {
      if (!(field in shared) || conflicted.has(field)) continue;
      const value = shared[field] as LanguageSettingValue;
      if (canonical(field, local[field]) !== canonical(field, value)) (patch as Record<string, LanguageSettingValue>)[field] = value;
    }
    const fields = Object.keys(patch) as LanguageSettingField[];
    if (fields.length > 0) await deps.local.write(channelId, patch);
    return fields;
  }

  async function withLocal(channelId: string, doc: Automerge.Doc<ChannelLanguageSettingsDocument>): Promise<LanguageSettingConflict[]> {
    const conflicts = scan(doc);
    if (conflicts.length === 0) return [];
    const local = await deps.local.read(channelId);
    return conflicts.map((c) => ({ ...c, thisComputer: plain(c.field, local[c.field]) }));
  }

  /** This computer's earlier values for the fields the document does not have yet -- never over a value already shared. */
  async function seedUnlocked(channelId: string): Promise<LanguageSettingField[]> {
    const local = await deps.local.read(channelId);
    const doc = await loadOrGenesis(channelId);
    const settings = doc.settings ?? {};
    const missing = LANGUAGE_SETTING_FIELDS.filter((field) => !(field in settings) && isSet(plain(field, local[field])));
    if (missing.length === 0) return [];
    const next = Automerge.change(doc, `seed ${missing.join(", ")}`, (draft) => {
      for (const field of missing) assign(draft, field, plain(field, local[field]));
    });
    await deps.core.save(channelId, next);
    return missing;
  }

  return {
    /**
     * The owner saved these fields on this computer (after the caller's own validation). Written to the document: a field it
     * holds differently or in conflict (an edit of a conflicted field settles it -- the owner's decision), and a field it lacks
     * when the new value is set (an empty value the other computer never had is nothing to share, and would only conflict with
     * a real value there). This computer's copy takes every saved field, then follows the document for the others.
     */
    save(input: { channelId: string } & Partial<LanguageSettingValues>): Promise<LanguageSettingValues> {
      return serialized(async () => {
        const doc = await loadOrGenesis(input.channelId);
        const conflicted = new Set(scan(doc).map((c) => c.field));
        const shared = sharedValues(doc);
        const provided = LANGUAGE_SETTING_FIELDS.filter((field) => input[field] !== undefined);
        const changed = provided.filter((field) =>
          field in shared
            ? conflicted.has(field) || canonical(field, shared[field]) !== canonical(field, input[field])
            : isSet(plain(field, input[field]))
        );
        let current = doc;
        if (changed.length > 0) {
          current = Automerge.change(doc, `save ${changed.join(", ")}`, (draft) => {
            for (const field of changed) assign(draft, field, plain(field, input[field]));
          });
          await deps.core.save(input.channelId, current);
        }
        if (provided.length > 0) {
          await deps.local.write(input.channelId, Object.fromEntries(provided.map((field) => [field, plain(field, input[field])])));
        }
        await applyToLocal(input.channelId, current);
        return deps.local.read(input.channelId);
      });
    },

    /** The shared values (a conflicted field's Automerge winner included; see `conflicts`) and the conflicts. */
    read(channelId: string): Promise<{ values: Partial<LanguageSettingValues>; conflicts: LanguageSettingConflict[] }> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        return { values: sharedValues(doc), conflicts: await withLocal(channelId, doc) };
      });
    },

    listConflicts(channelId: string): Promise<LanguageSettingConflict[]> {
      return serialized(async () => withLocal(channelId, await loadOrGenesis(channelId)));
    },

    /** The baseline fields set differently on the computers -- while any is, Batches refuse (PROJECT_SPEC §14). */
    conflictedBaselineFields(channelId: string): Promise<LanguageSettingField[]> {
      return serialized(async () => scan(await loadOrGenesis(channelId)).map((c) => c.field).filter((f) => BASELINE_FIELDS.includes(f)));
    },

    /** The owner kept one computer's value: it becomes the one value on every computer. Re-derived from the document, never
     * taken from the request, so only a value a computer actually saved can win. */
    resolveConflict(input: { channelId: string; field: LanguageSettingField; winningActorId: string }): Promise<LanguageSettingValues> {
      return serialized(async () => {
        const doc = await loadOrGenesis(input.channelId);
        const conflict = scan(doc).find((c) => c.field === input.field);
        if (!conflict) {
          throw new DomainError({ code: "not_found", message: `The language setting "${input.field}" has no conflict to resolve -- it may already be resolved.`, details: { channelId: input.channelId, field: input.field } });
        }
        if (!(input.winningActorId in conflict.valuesByActor)) {
          throw new DomainError({ code: "validation_failed", message: "The chosen version is not one of the conflicting values.", details: { channelId: input.channelId, field: input.field } });
        }
        const value = conflict.valuesByActor[input.winningActorId];
        const next = Automerge.change(doc, `resolve ${input.field}`, (draft) => assign(draft, input.field, value));
        await deps.core.save(input.channelId, next);
        await applyToLocal(input.channelId, next);
        return deps.local.read(input.channelId);
      });
    },

    /** Seeds this computer's earlier values first, so they reach the other computer before its values are merged here. */
    exportBytes(channelId: string): Promise<Uint8Array> {
      return serialized(async () => {
        await seedUnlocked(channelId);
        return deps.core.exportBytes(channelId);
      });
    },

    mergeIncoming(channelId: string, incomingBytes: Uint8Array): Promise<MergeResult> {
      return serialized(async () => {
        const { merged, newConflicts } = await deps.core.mergeIncoming(channelId, incomingBytes, scanGeneric);
        await deps.core.save(channelId, merged);
        const applied = await applyToLocal(channelId, merged);
        if (applied.length > 0) deps.logger?.info({ event: "channel_language_settings.applied_from_peer", context: { channelId, fields: applied } });
        const fields = new Set(newConflicts.map((c) => c.key));
        return { newConflicts: (await withLocal(channelId, merged)).filter((c) => fields.has(c.field)) };
      });
    },

    discardLocalAndAdoptPeer(channelId: string, incomingBytes: Uint8Array): Promise<{ backupPath: string | null }> {
      return serialized(async () => {
        const { backupPath, adopted } = await deps.core.discardLocalAndAdoptPeer(channelId, incomingBytes);
        await deps.core.save(channelId, adopted);
        await applyToLocal(channelId, adopted);
        return { backupPath };
      });
    },
  };
}

export type ChannelLanguageSettingsCore = ReturnType<typeof createChannelLanguageSettingsCore>;
