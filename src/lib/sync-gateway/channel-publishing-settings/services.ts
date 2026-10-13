import * as Automerge from "@automerge/automerge";
import type { AutomergeCore, ConflictLike, DocumentByteStore } from "../automerge-core";
import { DomainError, type ChannelPublishingSettingsDocument, type MergeResult, type PublishingSettingConflict, type PublishingSettingValue } from "./contracts";

export type ServiceDependencies = {
  core: AutomergeCore<ChannelPublishingSettingsDocument>;
  store: DocumentByteStore;
};

/**
 * The document every computer starts a channel from: the same actor, the same time and the same content, so its genesis change
 * -- and its hash -- is identical everywhere (the `media-settings` pattern). Two computers that each started the channel's
 * document on their own share history and merge field by field, never refused as `divergent_document_lineage`.
 */
const GENESIS_ACTOR = "6368616e6e656c2d7075626c69736831"; // hex of "channel-publish1"
export function genesisDocument(channelId: string): Automerge.Doc<ChannelPublishingSettingsDocument> {
  return Automerge.change(Automerge.init<ChannelPublishingSettingsDocument>({ actor: GENESIS_ACTOR }), { message: "genesis", time: 0 }, (draft) => {
    draft.format = "ytm-channel-publishing-settings";
    draft.version = 1;
    draft.channelId = channelId;
    draft.settings = {};
  });
}
export function emptyDocument(channelId: string): ChannelPublishingSettingsDocument {
  return { format: "ytm-channel-publishing-settings", version: 1, channelId, settings: {} };
}

function plain(value: unknown): PublishingSettingValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  // A list (the channel tags) comes back from Automerge as its own list type: a plain copy of strings, or nothing.
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value] as string[];
  return null;
}
const canonical = (value: unknown) => JSON.stringify(plain(value));

function scan(doc: Automerge.Doc<ChannelPublishingSettingsDocument>): PublishingSettingConflict[] {
  const conflicts: PublishingSettingConflict[] = [];
  const settings = doc.settings ?? {};
  for (const field of Object.keys(settings).sort()) {
    const raw = Automerge.getConflicts(settings, field);
    if (!raw || Object.keys(raw).length < 2) continue;
    const byValue = new Map<string, { actor: string; value: PublishingSettingValue }>();
    for (const actor of Object.keys(raw).sort()) {
      const value = plain(raw[actor]);
      if (!byValue.has(canonical(value))) byValue.set(canonical(value), { actor, value });
    }
    if (byValue.size < 2) continue;
    const entries = [...byValue.values()];
    conflicts.push({ field, values: entries.map((e) => e.value), valuesByActor: Object.fromEntries(entries.map((e) => [e.actor, e.value])) });
  }
  return conflicts;
}

function scanGeneric(doc: Automerge.Doc<ChannelPublishingSettingsDocument>): ConflictLike[] {
  return scan(doc).map((c) => ({ key: c.field, valuesByActor: c.valuesByActor }));
}

function values(doc: Automerge.Doc<ChannelPublishingSettingsDocument>): Record<string, PublishingSettingValue> {
  return Object.fromEntries(Object.entries(doc.settings ?? {}).map(([field, value]) => [field, plain(value)]));
}

export function createChannelPublishingSettingsCore(deps: ServiceDependencies) {
  // Every load -> change/merge -> save runs one at a time: a merge that loaded the document before an owner's save would
  // otherwise write its result over that save (the `media-settings` independent-review finding).
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  async function loadOrGenesis(channelId: string): Promise<Automerge.Doc<ChannelPublishingSettingsDocument>> {
    const bytes = await deps.store.loadDocumentBytes(channelId);
    // Loaded from bytes, so this computer writes with its own fresh actor -- never with the genesis actor every computer shares.
    return Automerge.load<ChannelPublishingSettingsDocument>(bytes ?? Automerge.save(genesisDocument(channelId)));
  }

  return {
    /** The saved values (a conflicted field's Automerge winner included; see `conflicts`) and the conflicts. */
    read(channelId: string): Promise<{ values: Record<string, PublishingSettingValue>; conflicts: PublishingSettingConflict[] }> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        return { values: values(doc), conflicts: scan(doc) };
      });
    },

    /**
     * The owner saved these fields (after the publishing module's own validation). A field is written when the document lacks
     * it or holds another value; a conflicted field is always written, because the caller sends only the fields the owner
     * changed, and that edit is the owner's decision. A value equal to the document's writes nothing, so it never echoes.
     */
    save(channelId: string, patch: Record<string, PublishingSettingValue>): Promise<{ changed: string[] }> {
      return serialized(async () => {
        const doc = await loadOrGenesis(channelId);
        const current = doc.settings ?? {};
        const conflicted = new Set(scan(doc).map((c) => c.field));
        const changed = Object.keys(patch).filter((field) => conflicted.has(field) || !(field in current) || canonical(current[field]) !== canonical(patch[field]));
        if (changed.length === 0) return { changed };
        const next = Automerge.change(doc, `save ${changed.join(", ")}`, (draft) => {
          for (const field of changed) draft.settings[field] = plain(patch[field]);
        });
        await deps.core.save(channelId, next);
        return { changed };
      });
    },

    listConflicts(channelId: string): Promise<PublishingSettingConflict[]> {
      return serialized(async () => scan(await loadOrGenesis(channelId)));
    },

    /** The owner kept one computer's value: it becomes the one value on every computer. Re-derived from the document, never
     * taken from the request, so only a value a computer actually saved can win. */
    resolveConflict(input: { channelId: string; field: string; winningActorId: string }): Promise<void> {
      return serialized(async () => {
        const doc = await loadOrGenesis(input.channelId);
        const conflict = scan(doc).find((c) => c.field === input.field);
        if (!conflict) {
          throw new DomainError({ code: "not_found", message: `The publishing setting "${input.field}" has no conflict to resolve -- it may already be resolved.`, details: { channelId: input.channelId, field: input.field } });
        }
        if (!(input.winningActorId in conflict.valuesByActor)) {
          throw new DomainError({ code: "validation_failed", message: "The chosen version is not one of the conflicting values.", details: { channelId: input.channelId, field: input.field } });
        }
        const value = conflict.valuesByActor[input.winningActorId];
        const next = Automerge.change(doc, `resolve ${input.field}`, (draft) => {
          draft.settings[input.field] = value;
        });
        await deps.core.save(input.channelId, next);
      });
    },

    exportBytes: (channelId: string): Promise<Uint8Array> => serialized(() => deps.core.exportBytes(channelId)),

    mergeIncoming(channelId: string, incomingBytes: Uint8Array): Promise<MergeResult> {
      return serialized(async () => {
        const { merged, newConflicts } = await deps.core.mergeIncoming(channelId, incomingBytes, scanGeneric);
        await deps.core.save(channelId, merged);
        const fields = new Set(newConflicts.map((c) => c.key));
        return { newConflicts: scan(merged).filter((c) => fields.has(c.field)) };
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

export type ChannelPublishingSettingsCore = ReturnType<typeof createChannelPublishingSettingsCore>;
