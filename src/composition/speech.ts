import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { VoiceProvider, VoiceProviderPort, VoiceRegistryServices } from "@/lib/voice-registry";

// ---------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057, AGENTS.md §M): one provider-neutral speech surface over the two speech providers -- Gemini TTS
// (`gemini-media`, its `speech` kind) and ElevenLabs (`elevenlabs-speech`) -- and the channel voice registry wired with both as its
// providers. Composed here at the app layer: the registry imports neither provider, the providers know the registry only through
// its resolver, and neither provider imports the other. `createSpeechSurface` is pure (tested with fakes); `createSpeechForProduction`
// wires the real modules lazily, so an unused provider is never built.
// ---------------------------------------------------------------------------

export const SPEECH_PROVIDERS = ["gemini", "elevenlabs"] as const satisfies readonly VoiceProvider[];
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number];

/** What the speech surface needs of one provider module. */
export type SpeechProviderPort = {
  /** Key presence and hint (never the key), switch, limits, usage, models and prices. */
  status(): Promise<Record<string, unknown>>;
  /** One take (or, with dryRun, its estimate); the input is the surface's without `provider`. */
  createJob(input: Record<string, unknown>, actor: string): Promise<Record<string, unknown>>;
  /** One of this provider's speech jobs (a job of another kind is "not found"). */
  getJob(jobId: string): Promise<Record<string, unknown>>;
  listJobs(filter: { channelId?: string; status?: string; limit: number }): Promise<Array<Record<string, unknown>>>;
  /** Whether a job id is this provider's (`gm_…` Gemini, `el_…` ElevenLabs). */
  ownsJobId(jobId: string): boolean;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function invalid(message: string, field: string): DomainError {
  return new DomainError({ code: "validation_failed", message, details: { field } });
}

export function createSpeechSurface(providers: Partial<Record<SpeechProvider, () => SpeechProviderPort>>) {
  const port = (provider: unknown): SpeechProviderPort => {
    if (typeof provider !== "string" || !(SPEECH_PROVIDERS as readonly string[]).includes(provider)) throw invalid(`provider must be one of ${SPEECH_PROVIDERS.join(", ")}`, "provider");
    const make = providers[provider as SpeechProvider];
    if (!make) throw new DomainError({ code: "voice_registry_unavailable", message: `Speech through ${provider} is not available on this server.`, details: { provider } });
    return make();
  };

  return {
    /** Every provider's status side by side; one that cannot be read reports its error code instead (the others still show). */
    async getStatus(): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      for (const provider of SPEECH_PROVIDERS) {
        if (!providers[provider]) continue;
        try {
          out[provider] = await port(provider).status();
        } catch (error) {
          out[provider] = { available: false, errorCode: isDomainError(error) ? error.code : "internal_error" };
        }
      }
      return { providers: out };
    },

    async createJob(raw: unknown, actor: string): Promise<Record<string, unknown>> {
      const { provider, ...rest } = record(raw);
      const answer = await port(provider).createJob(rest, actor);
      return { provider, ...answer };
    },

    /** One job by id (its prefix names the provider), or the newest speech jobs of one or every provider, newest first. */
    async getJobs(raw: unknown): Promise<Record<string, unknown>> {
      const input = record(raw);
      if (typeof input.jobId === "string") {
        const owner = SPEECH_PROVIDERS.find((p) => providers[p] && port(p).ownsJobId(input.jobId as string));
        if (!owner) throw new DomainError({ code: "gemini_job_not_found", message: `No speech job ${input.jobId} on this computer.`, details: { jobId: input.jobId } });
        return { provider: owner, ...(await port(owner).getJob(input.jobId)) };
      }
      const limit = typeof input.limit === "number" ? input.limit : 20;
      if (input.provider !== undefined) port(input.provider); // an unknown or unavailable provider is refused, not ignored
      const chosen: SpeechProvider[] = input.provider === undefined ? SPEECH_PROVIDERS.filter((p) => providers[p]) : [input.provider as SpeechProvider];
      const filter = { ...(typeof input.channelId === "string" ? { channelId: input.channelId } : {}), ...(typeof input.status === "string" ? { status: input.status } : {}), limit };
      const jobs: Array<Record<string, unknown>> = [];
      for (const provider of chosen) for (const job of await port(provider).listJobs(filter)) jobs.push({ provider, ...job });
      jobs.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
      return { jobs: jobs.slice(0, limit) };
    },
  };
}

export type SpeechSurface = ReturnType<typeof createSpeechSurface>;

// -- production ---------------------------------------------------------------------------------------------------------------

const DEFAULT_GEMINI_SPEECH_MODEL = "gemini-3.8-flash-tts";

async function geminiCore() {
  return (await import("@/lib/gemini-media")).createGeminiMediaCore();
}

/** Gemini TTS as a speech provider (the `speech` kind of gemini-media). */
function geminiSpeechPort(): SpeechProviderPort {
  const speechKinds = ["speech", "voice_design"] as const;
  return {
    async status() {
      const status = record(await (await geminiCore()).getStatus());
      const models = Array.isArray(status.models) ? status.models.filter((m) => record(m).kind === "speech") : [];
      const { enabled, keyConfigured, keyHint, keyStatus, gatewayEnabled, limits, spend } = status;
      return { units: "usd", enabled, keyConfigured, keyHint, keyStatus, gatewayEnabled, limits, spend, models, defaultModel: DEFAULT_GEMINI_SPEECH_MODEL, sampleRateHz: 24_000, outputFile: "take-1.wav" };
    },
    async createJob(input, actor) {
      if (input.outputFormat !== undefined) throw new DomainError({ code: "gemini_invalid_params", message: "Gemini speech is always a WAV at Google's own rate; outputFormat is ElevenLabs'.", details: { field: "outputFormat" } });
      return record(await (await geminiCore()).createSpeechJob({ ...input, model: input.model ?? DEFAULT_GEMINI_SPEECH_MODEL }, actor));
    },
    async getJob(jobId) {
      const answer = record(await (await geminiCore()).getJobs({ jobId }));
      if (!(speechKinds as readonly unknown[]).includes(record(answer.job).kind)) throw new DomainError({ code: "gemini_job_not_found", message: `No speech job ${jobId} on this computer.`, details: { jobId } });
      return answer;
    },
    async listJobs(filter) {
      const answer = record(await (await geminiCore()).getJobs({ ...filter, limit: Math.min(filter.limit, 50), kinds: [...speechKinds] }));
      return Array.isArray(answer.jobs) ? answer.jobs.map(record) : [];
    },
    ownsJobId: (jobId) => jobId.startsWith("gm_"),
  };
}

/** Gemini as a voice designer: each preview is its own designed voice (one paid design each, recorded by gemini-media). */
function geminiVoicePort(): VoiceProviderPort {
  return {
    async design(input, actor) {
      const core = await geminiCore();
      const previews: Awaited<ReturnType<VoiceProviderPort["design"]>>["previews"] = [];
      for (let i = 0; i < input.count; i += 1) {
        try {
          const designed = await core.designVoice({ channelId: input.channelId, description: input.description, displayName: input.name, ...(input.previewText ? { sampleText: input.previewText } : {}) }, actor);
          previews.push({ providerRef: designed.providerVoiceId, audio: designed.sample, jobId: designed.jobId });
        } catch (error) {
          // A later preview that fails keeps the ones already paid for; the first one failing is the answer.
          if (previews.length === 0) throw error;
          break;
        }
      }
      return { previews, model: null };
    },
    // A Gemini designed voice is already persistent: the approved preview's id is the voice.
    async save(input) {
      return { providerVoiceId: input.providerRef };
    },
  };
}

type ElevenlabsModule = typeof import("@/lib/elevenlabs-speech");

async function elevenlabsCore() {
  return ((await import("@/lib/elevenlabs-speech")) as ElevenlabsModule).createElevenlabsSpeechCore();
}

/** ElevenLabs as a speech provider (the `elevenlabs-speech` module). */
function elevenlabsSpeechPort(): SpeechProviderPort {
  return {
    async status() {
      return record(await (await elevenlabsCore()).getStatus());
    },
    async createJob(input, actor) {
      if (input.style !== undefined) throw new DomainError({ code: "elevenlabs_invalid_params", message: "ElevenLabs takes no style field: write audio tags such as [whispers] or [laughs] into the text.", details: { field: "style" } });
      return record(await (await elevenlabsCore()).createJob(input, actor));
    },
    async getJob(jobId) {
      return record(await (await elevenlabsCore()).getJobs({ jobId }));
    },
    async listJobs(filter) {
      const answer = record(await (await elevenlabsCore()).getJobs({ ...filter, limit: Math.min(filter.limit, 50) }));
      return Array.isArray(answer.jobs) ? answer.jobs.map(record) : [];
    },
    ownsJobId: (jobId) => jobId.startsWith("el_"),
  };
}

function elevenlabsVoicePort(): VoiceProviderPort {
  return {
    async design(input, actor) {
      const designed = await (await elevenlabsCore()).designVoice({ channelId: input.channelId, description: input.description, ...(input.previewText ? { previewText: input.previewText } : {}), count: input.count }, actor);
      return { previews: designed.previews.map((p) => ({ providerRef: p.generatedVoiceId, audio: p.audio, jobId: designed.jobId })), model: designed.model };
    },
    async save(input) {
      return (await elevenlabsCore()).saveDesignedVoice({ name: input.name, description: input.description, generatedVoiceId: input.providerRef });
    },
  };
}

const VOICES_KEY = Symbol.for("youtube-operations-manager.voice-registry");

/** The voice registry with both providers (one per process: route bundles share it). */
export async function voiceRegistryForProduction(): Promise<VoiceRegistryServices> {
  const holder = globalThis as unknown as Record<symbol, VoiceRegistryServices | undefined>;
  if (!holder[VOICES_KEY]) {
    const { createVoiceRegistryForProduction } = await import("@/lib/voice-registry");
    holder[VOICES_KEY] = createVoiceRegistryForProduction({ gemini: geminiVoicePort(), elevenlabs: elevenlabsVoicePort() });
  }
  return holder[VOICES_KEY]!;
}

/** The provider-neutral speech surface over the real modules. */
export function createSpeechForProduction(): SpeechSurface {
  return createSpeechSurface({ gemini: geminiSpeechPort, elevenlabs: elevenlabsSpeechPort });
}
