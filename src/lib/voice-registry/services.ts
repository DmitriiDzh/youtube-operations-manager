import type { StoredChannelVoice } from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import {
  VOICE_PREVIEWS_SUBDIR,
  voiceNotFound,
  type VoicePreview,
  type VoiceProvider,
  type VoiceProviderPort,
  type VoiceView,
} from "./contracts";
import { approveVoiceSchema, designVoiceSchema, listVoicesSchema, parseWithSchema, updateVoiceSchema } from "./schemas";

// BL-236 (ADR 0057): pure logic over injected ports; `./index.ts` wires the database and the files, `src/composition/speech.ts`
// the providers.

export type VoiceStore = {
  insert(row: StoredChannelVoice): Promise<boolean>;
  get(voiceId: string): Promise<StoredChannelVoice | null>;
  list(filter: { channelId: string; provider?: VoiceProvider }): Promise<StoredChannelVoice[]>;
  update(voiceId: string, fromStatus: StoredChannelVoice["status"], set: Partial<StoredChannelVoice>): Promise<boolean>;
};

export type VoiceFilesPort = {
  /** The channel's `99 Data Exchange/From YTM` folder (proven inside its workspace; `voice_registry_unavailable` otherwise). */
  outputRoot(channelId: string): Promise<string>;
  /** Writes through a temporary file and a rename; returns the size and SHA-256 of what was written. */
  write(filePath: string, data: Buffer): Promise<{ bytes: number; sha256: string }>;
  join(...parts: string[]): string;
};

export type VoiceRegistryDeps = {
  store: VoiceStore;
  files: VoiceFilesPort;
  /** The speech providers (absent: that provider's voices can be listed and resolved, not designed or approved). */
  providers: Partial<Record<VoiceProvider, VoiceProviderPort>>;
  clock: { now(): Date };
  generateId(): string;
};

function parsePreviews(json: string): VoicePreview[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as VoicePreview[]) : [];
  } catch {
    return [];
  }
}

export function voiceView(row: StoredChannelVoice): VoiceView {
  return {
    voiceId: row.voiceId,
    channelId: row.channelId,
    name: row.name,
    provider: row.provider,
    providerVoiceId: row.providerVoiceId ?? null,
    description: row.description,
    model: row.model ?? null,
    status: row.status,
    previews: parsePreviews(row.previewsJson),
    approvedPreviewId: row.approvedPreviewId ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvedBy: row.approvedBy ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

/** The voice resolution every speech job goes through (pure over the store; exported for the providers' resolver). */
export function createVoiceResolver(store: Pick<VoiceStore, "list">) {
  return {
    /**
     * An APPROVED voice of this channel and provider, by its id or its name; otherwise `voice_not_approved` (details.reason:
     * not_found | draft | archived | other_provider) -- a voice of another channel is simply not found.
     */
    async resolve(input: { channelId: string; provider: VoiceProvider; voice: string }): Promise<{ voiceId: string; name: string; providerVoiceId: string }> {
      const rows = await store.list({ channelId: input.channelId });
      const matches = rows.filter((row) => row.voiceId === input.voice || sameName(row.name, input.voice));
      const approved = matches.find((row) => row.provider === input.provider && row.status === "approved" && row.providerVoiceId);
      if (approved) return { voiceId: approved.voiceId, name: approved.name, providerVoiceId: approved.providerVoiceId! };
      const sameProvider = matches.filter((row) => row.provider === input.provider);
      const reason = sameProvider.some((row) => row.status === "draft")
        ? "draft"
        : sameProvider.some((row) => row.status === "archived")
          ? "archived"
          : matches.length > 0
            ? "other_provider"
            : "not_found";
      const said: Record<string, string> = {
        draft: "is still a draft -- the owner approves one of its previews first",
        archived: "is archived",
        other_provider: `belongs to another provider, not ${input.provider}`,
        not_found: "is not in this channel's voices",
      };
      throw new DomainError({
        code: "voice_not_approved",
        message: `The voice "${input.voice}" ${said[reason]} (factory_voice_list).`,
        details: { voice: input.voice, provider: input.provider, reason },
      });
    },
  };
}

export function createVoiceRegistryServices(deps: VoiceRegistryDeps) {
  const now = () => deps.clock.now();

  async function ownVoice(channelId: string, voiceId: string): Promise<StoredChannelVoice> {
    const row = await deps.store.get(voiceId);
    // Channel scope is checked here (Playbook §6.6): another channel's voice is "not found", never shown or changed.
    if (!row || row.channelId !== channelId) throw voiceNotFound(voiceId);
    return row;
  }

  async function assertNameFree(channelId: string, provider: VoiceProvider, name: string, exceptVoiceId: string | null): Promise<void> {
    const taken = (await deps.store.list({ channelId, provider })).find((row) => row.status !== "archived" && row.voiceId !== exceptVoiceId && sameName(row.name, name));
    if (taken) throw new DomainError({ code: "voice_name_taken", message: `This channel already has a ${provider} voice named "${taken.name}" (${taken.voiceId}).`, details: { name, voiceId: taken.voiceId } });
  }

  // Review item 2: the name check and the draft's insert run one at a time per channel and provider in this process.
  const nameLocks = new Map<string, Promise<unknown>>();
  async function withNameLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = nameLocks.get(key) ?? Promise.resolve();
    const result = previous.then(run, run);
    nameLocks.set(key, result.catch(() => undefined));
    return result;
  }

  function providerOf(provider: VoiceProvider): VoiceProviderPort {
    const port = deps.providers[provider];
    if (!port) throw new DomainError({ code: "voice_registry_unavailable", message: `Voices of ${provider} cannot be designed or approved on this server.`, details: { provider } });
    return port;
  }

  return {
    resolve: createVoiceResolver(deps.store).resolve,

    async list(raw: unknown): Promise<{ voices: VoiceView[] }> {
      const input = parseWithSchema(listVoicesSchema, raw, "voice list");
      const rows = await deps.store.list({ channelId: input.channelId, ...(input.provider ? { provider: input.provider } : {}) });
      return { voices: rows.filter((row) => input.includeArchived || row.status !== "archived").map(voiceView) };
    },

    async get(channelId: string, voiceId: string): Promise<VoiceView> {
      return voiceView(await ownVoice(channelId, voiceId));
    },

    /**
     * Designs a voice from its description (PAID, through the provider's own gate) and keeps every preview as a file; the voice is
     * a draft until the owner approves one preview. Review item 2: the draft row is inserted FIRST (under a per-channel lock, and the
     * database's unique name index), so a taken name -- even by a design running at the same moment -- is refused before anything is
     * paid. A design that fails archives its row (the name is free again) with the error; previews that cannot be written leave the
     * row a draft with the error and the previews that were written, so a paid design is never lost silently.
     */
    async design(raw: unknown, actor: string): Promise<{ voice: VoiceView }> {
      const input = parseWithSchema(designVoiceSchema, raw, "voice design");
      const provider = providerOf(input.provider);
      const root = await deps.files.outputRoot(input.channelId);
      const voiceId = `vc_${deps.generateId()}`;
      const at = now();
      const row: StoredChannelVoice = {
        voiceId,
        channelId: input.channelId,
        name: input.name,
        provider: input.provider,
        providerVoiceId: null,
        description: input.description,
        model: input.model ?? null,
        status: "draft",
        previewsJson: "[]",
        approvedPreviewId: null,
        error: null,
        createdAt: at,
        createdBy: actor,
        approvedAt: null,
        approvedBy: null,
        updatedAt: at,
      };
      await withNameLock(`${input.channelId}\u0000${input.provider}`, async () => {
        await assertNameFree(input.channelId, input.provider, input.name, null);
        if (!(await deps.store.insert(row))) throw new DomainError({ code: "voice_name_taken", message: `The name "${input.name}" was just taken.`, details: { name: input.name } });
      });
      const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      let designed: Awaited<ReturnType<VoiceProviderPort["design"]>>;
      try {
        designed = await provider.design(
          { channelId: input.channelId, name: input.name, description: input.description, previewText: input.previewText ?? null, count: input.previews ?? (input.provider === "elevenlabs" ? 3 : 1), model: input.model ?? null },
          actor
        );
        if (designed.previews.length === 0) throw new DomainError({ code: "voice_registry_unavailable", message: "The provider designed no preview.", details: { provider: input.provider } });
      } catch (error) {
        await deps.store.update(voiceId, "draft", { status: "archived", error: `The design failed: ${message(error)}`, updatedAt: now() });
        throw error;
      }
      const previews: VoicePreview[] = [];
      try {
        for (const [index, preview] of designed.previews.entries()) {
          const fileName = `preview-${index + 1}.${preview.audio.extension}`;
          const relative = `${input.provider}/${VOICE_PREVIEWS_SUBDIR}/${voiceId}/${fileName}`;
          const written = await deps.files.write(deps.files.join(root, input.provider, VOICE_PREVIEWS_SUBDIR, voiceId, fileName), preview.audio.data);
          previews.push({
            previewId: `p${index + 1}`,
            file: relative,
            mimeType: preview.audio.mimeType,
            bytes: written.bytes,
            sha256: written.sha256,
            sampleRateHz: preview.audio.sampleRateHz,
            durationSeconds: preview.audio.durationSeconds,
            providerRef: preview.providerRef,
            jobId: preview.jobId,
          });
        }
      } catch (error) {
        const failed = `${designed.previews.length - previews.length} of ${designed.previews.length} previews could not be written: ${message(error)}`;
        await deps.store.update(voiceId, "draft", { previewsJson: JSON.stringify(previews), model: designed.model ?? row.model, error: failed, updatedAt: now() });
        throw new DomainError({ code: "voice_registry_unavailable", message: `The voice was designed (and paid) but ${failed}. It stays a draft (${voiceId}).`, details: { voiceId, written: previews.length } });
      }
      const set = { previewsJson: JSON.stringify(previews), model: designed.model ?? row.model, updatedAt: now() };
      await deps.store.update(voiceId, "draft", set);
      return { voice: voiceView({ ...row, ...set }) };
    },

    /** The owner's pick (in the app, or relayed by the Operator): one preview of a draft becomes the voice the provider speaks with. */
    async approve(raw: unknown, actor: string): Promise<{ voice: VoiceView }> {
      const input = parseWithSchema(approveVoiceSchema, raw, "voice approval");
      const row = await ownVoice(input.channelId, input.voiceId);
      if (row.status !== "draft") throw new DomainError({ code: "voice_invalid_state", message: `Voice ${row.voiceId} is ${row.status}; only a draft is approved.`, details: { voiceId: row.voiceId, status: row.status } });
      const preview = parsePreviews(row.previewsJson).find((p) => p.previewId === input.previewId);
      if (!preview) throw new DomainError({ code: "voice_not_found", message: `Voice ${row.voiceId} has no preview ${input.previewId}.`, details: { voiceId: row.voiceId, previewId: input.previewId } });
      const saved = await providerOf(row.provider).save({ channelId: row.channelId, name: row.name, description: row.description, providerRef: preview.providerRef });
      const at = now();
      const set = { status: "approved" as const, providerVoiceId: saved.providerVoiceId, approvedPreviewId: preview.previewId, approvedAt: at, approvedBy: actor, updatedAt: at };
      if (!(await deps.store.update(row.voiceId, "draft", set))) {
        throw new DomainError({ code: "voice_invalid_state", message: `Voice ${row.voiceId} changed meanwhile.`, details: { voiceId: row.voiceId } });
      }
      return { voice: voiceView({ ...row, ...set }) };
    },

    /** Rename (unique among the channel's voices of that provider that are not archived) or archive. An archived voice stays archived. */
    async update(raw: unknown): Promise<{ voice: VoiceView }> {
      const input = parseWithSchema(updateVoiceSchema, raw, "voice update");
      const row = await ownVoice(input.channelId, input.voiceId);
      if (row.status === "archived") throw new DomainError({ code: "voice_invalid_state", message: `Voice ${row.voiceId} is archived.`, details: { voiceId: row.voiceId, status: row.status } });
      if (input.name !== undefined && input.archived === undefined) await assertNameFree(row.channelId, row.provider, input.name, row.voiceId);
      const set: Partial<StoredChannelVoice> = { updatedAt: now(), ...(input.name !== undefined ? { name: input.name } : {}), ...(input.archived ? { status: "archived" as const } : {}) };
      if (!(await deps.store.update(row.voiceId, row.status, set))) {
        throw new DomainError({ code: "voice_name_taken", message: `Voice ${row.voiceId} could not be changed (the name was just taken, or it changed meanwhile).`, details: { voiceId: row.voiceId } });
      }
      return { voice: voiceView({ ...row, ...set } as StoredChannelVoice) };
    },

    /** A preview's file for the owner's player: only a preview of this channel's voice (`voice_not_found` otherwise). */
    async previewFile(channelId: string, voiceId: string, previewId: string): Promise<{ localPath: string; mimeType: string }> {
      const row = await ownVoice(channelId, voiceId);
      const preview = parsePreviews(row.previewsJson).find((p) => p.previewId === previewId);
      // Only a path the registry itself wrote (never `..` or an absolute path from an odd row).
      if (!preview || !/^(gemini|elevenlabs)\/voices\/vc_[A-Za-z0-9_-]{1,80}\/preview-[0-9]{1,2}\.[a-z0-9]{1,5}$/.test(preview.file)) throw voiceNotFound(voiceId);
      const root = await deps.files.outputRoot(channelId);
      return { localPath: deps.files.join(root, ...preview.file.split("/")), mimeType: preview.mimeType };
    },
  };
}

export type VoiceRegistryServices = ReturnType<typeof createVoiceRegistryServices>;
