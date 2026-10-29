import { createHash } from "node:crypto";
import type { StoredElevenlabsSpeechJob, ElevenlabsSpeechJobStatusValue } from "@/lib/db";
import type { DeviceSecretSlot } from "@/lib/device-secrets";
import type { ElevenlabsApiClient } from "@/lib/media-gateway";
import { audioFileOf } from "@/lib/shared-audio";
import { ceil4 } from "@/lib/shared-money";
import {
  DEFAULT_ELEVENLABS_SETTINGS,
  DomainError,
  ELEVENLABS_ACTIVE_STATUSES,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_DESIGN_MODEL,
  ELEVENLABS_LIMITS,
  ELEVENLABS_OUTPUT_FORMATS,
  ELEVENLABS_PRICES_AS_OF,
  ELEVENLABS_SPEECH_MODELS,
  charCount,
  elevenlabsJobNotFound,
  isDomainError,
  ownEntry,
  type ElevenlabsCostBasis,
  type ElevenlabsDesignParams,
  type ElevenlabsJobOutput,
  type ElevenlabsJobStatus,
  type ElevenlabsJobView,
  type ElevenlabsKeyView,
  type ElevenlabsLimitName,
  type ElevenlabsRefusal,
  type ElevenlabsSettings,
  type ElevenlabsSpeechParams,
  type ElevenlabsUsage,
  type ElevenlabsVoiceResolver,
} from "./contracts";
import { checkJobRules, createJobInputSchema, designVoiceInputSchema, getJobsInputSchema, parseWithSchema, setKeyInputSchema, updateSettingsInputSchema, type CreateJobInput } from "./schemas";

// BL-236 (ADR 0057): the key, the owner's switch and character limits, the usage, job creation and reads, voice design and saving.
// The worker that runs jobs is `./worker.ts`. Pure logic over injected ports; `./index.ts` wires the real ones.

export type ElevenlabsStore = {
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  insertJob(row: StoredElevenlabsSpeechJob): Promise<boolean>;
  getJob(jobId: string): Promise<StoredElevenlabsSpeechJob | null>;
  getJobByRequest(createdBy: string, requestId: string): Promise<StoredElevenlabsSpeechJob | null>;
  listJobs(filter: { channelId?: string; statuses?: readonly ElevenlabsSpeechJobStatusValue[]; createdSince?: Date; limit: number }): Promise<StoredElevenlabsSpeechJob[]>;
  updateJob(jobId: string, fromStatus: ElevenlabsSpeechJobStatusValue, set: Partial<StoredElevenlabsSpeechJob>): Promise<boolean>;
};

export type ElevenlabsApiPort = Pick<ElevenlabsApiClient, "getSubscription" | "textToSpeech" | "designVoice" | "createVoiceFromDesign">;

export type ElevenlabsSpeechDeps = {
  store: ElevenlabsStore;
  api: ElevenlabsApiPort;
  /** The ElevenLabs key's slot in this computer's shared secret store (hint: its last 4 characters). */
  secret: DeviceSecretSlot;
  workspace: { resolveOutputRoot(channelId: string): Promise<string> };
  files: { writeOutput(filePath: string, data: Buffer): Promise<{ bytes: number; sha256: string }>; writeManifest(filePath: string, manifest: unknown): Promise<void> };
  assets: {
    register(input: { channelId: string; assetType: "generated_audio"; referenceKind: "local_path"; referenceValue: string; title: string; provenance: Record<string, unknown> }): Promise<{ assetId: string }>;
    findByLocalPath(channelId: string, localPath: string): Promise<{ assetId: string } | null>;
  };
  device(): Promise<{ deviceId: string | null; hostname: string | null }>;
  isChannelConnected(channelId: string): Promise<boolean>;
  isGatewayEnabled(): Promise<boolean>;
  voices: ElevenlabsVoiceResolver;
  /** BL-194: which video a job is made for (absent: a `videoNumber` is refused). */
  videoLink?: { resolve(input: { channelId: string; videoNumber?: string | null; storyboardId?: string | null }): Promise<string | null> };
  clock: { now(): Date };
  generateId(): string;
  withCreateLock<T>(run: () => Promise<T>): Promise<T>;
};

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfLocalMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** The list price of a number of characters with a model (USD, 4 decimals, rounded up). */
export function listPriceUsd(model: string, chars: number): number {
  const spec = ownEntry(ELEVENLABS_SPEECH_MODELS, model);
  // Voice design: priced like the dearest speech model (no separate price is published in R-0005; never under-counted).
  const perK = spec ? spec.usdPer1kChars : Math.max(...Object.values(ELEVENLABS_SPEECH_MODELS).map((m) => m.usdPer1kChars));
  return ceil4((chars * perK) / 1000);
}

/** Forgiving per field: a bad stored value falls back to its own default only. */
export function settingsFromJson(json: string | null): ElevenlabsSettings {
  const stored = parseJson<Record<string, unknown>>(json, {});
  const settings: ElevenlabsSettings = { ...DEFAULT_ELEVENLABS_SETTINGS };
  for (const key of Object.keys(DEFAULT_ELEVENLABS_SETTINGS) as Array<keyof ElevenlabsSettings>) {
    const parsed = updateSettingsInputSchema.safeParse({ [key]: stored[key] });
    if (parsed.success && parsed.data[key] !== undefined) (settings as Record<string, unknown>)[key] = parsed.data[key];
  }
  return settings;
}

export function jobView(row: StoredElevenlabsSpeechJob): ElevenlabsJobView {
  return {
    jobId: row.jobId,
    channelId: row.channelId,
    requestId: row.requestId ?? null,
    kind: row.kind,
    model: row.model,
    text: row.text,
    params: parseJson<ElevenlabsSpeechParams | ElevenlabsDesignParams>(row.paramsJson, { description: "", previewText: "", previews: 0 }),
    status: row.status,
    chars: row.chars,
    chargedChars: row.chargedChars ?? null,
    estimateUsd: row.estimateUsd,
    costUsd: row.costUsd ?? null,
    costBasis: (row.costBasis as ElevenlabsCostBasis | null) ?? null,
    outputs: parseJson<ElevenlabsJobOutput[]>(row.outputsJson, []),
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
    attempts: row.attempts,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    video: row.video ?? null,
  };
}

function requestHash(input: CreateJobInput, model: string, outputFormat: string): string {
  const canonical = { channelId: input.channelId, voice: input.voice, text: input.text, model, outputFormat, ...(input.videoNumber ? { videoNumber: input.videoNumber } : {}) };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** What a job counts against the character limits: a finished one what it was charged (0 when not), an active one its text. */
export function countedChars(row: Pick<StoredElevenlabsSpeechJob, "status" | "chars" | "chargedChars" | "costBasis">): number {
  if ((ELEVENLABS_ACTIVE_STATUSES as readonly string[]).includes(row.status)) return row.chars;
  if (row.costBasis === "not_charged") return 0;
  return row.chargedChars ?? row.chars;
}

export type ElevenlabsDesignedVoice = {
  jobId: string;
  model: string;
  previews: Array<{ generatedVoiceId: string; audio: { data: Buffer; extension: string; mimeType: string; sampleRateHz: number | null; durationSeconds: number | null } }>;
};

export function createElevenlabsSpeechServices(deps: ElevenlabsSpeechDeps) {
  const now = () => deps.clock.now();

  async function getSettings(): Promise<ElevenlabsSettings> {
    return settingsFromJson(await deps.store.getSettingsJson());
  }

  async function keyView(): Promise<ElevenlabsKeyView> {
    const [state, info] = await Promise.all([deps.secret.state(), deps.secret.info()]);
    if (!info) return { configured: false, keyHint: null, status: null, verifiedAt: null, updatedAt: null };
    const status = info.status === "ok" || info.status === "payment_required" ? info.status : null;
    return { configured: state === "set", keyHint: info.hints.keyHint ?? null, status, verifiedAt: info.verifiedAt ? new Date(info.verifiedAt).toISOString() : null, updatedAt: new Date(info.updatedAt).toISOString() };
  }

  async function readApiKeyWithVersion(): Promise<{ value: string; version: string } | null> {
    try {
      return await deps.secret.readWithVersion();
    } catch (error) {
      if (isDomainError(error) && (error.code === "device_secret_unreadable" || error.code === "encryption_key_not_configured")) {
        throw new DomainError({ code: "encryption_key_not_configured", message: "The stored ElevenLabs API key cannot be read on this computer; enter it again (Settings → Cloud APIs)." });
      }
      throw error;
    }
  }

  async function readApiKey(): Promise<string | null> {
    return (await readApiKeyWithVersion())?.value ?? null;
  }

  /** One free subscription read: a refused key throws; an account out of characters is accepted with that status. */
  async function checkKey(apiKey: string): Promise<"ok" | "payment_required"> {
    try {
      await deps.api.getSubscription(apiKey);
      return "ok";
    } catch (error) {
      if (isDomainError(error) && error.code === "elevenlabs_payment_required") return "payment_required";
      throw error;
    }
  }

  async function usage(at: Date = now()): Promise<ElevenlabsUsage> {
    const dayStart = startOfLocalDay(at).getTime();
    const [thisMonth, active] = await Promise.all([
      deps.store.listJobs({ createdSince: startOfLocalMonth(at), limit: 100_000 }),
      deps.store.listJobs({ statuses: ELEVENLABS_ACTIVE_STATUSES, limit: 100_000 }),
    ]);
    const usd = (row: StoredElevenlabsSpeechJob) => ((ELEVENLABS_ACTIVE_STATUSES as readonly string[]).includes(row.status) ? row.estimateUsd : (row.costUsd ?? 0));
    const today = thisMonth.filter((row) => row.createdAt.getTime() >= dayStart);
    return {
      todayChars: today.reduce((sum, row) => sum + countedChars(row), 0),
      monthChars: thisMonth.reduce((sum, row) => sum + countedChars(row), 0),
      activeChars: active.reduce((sum, row) => sum + countedChars(row), 0),
      activeJobs: active.length,
      todayUsd: round4(today.reduce((sum, row) => sum + usd(row), 0)),
      monthUsd: round4(thisMonth.reduce((sum, row) => sum + usd(row), 0)),
    };
  }

  function limitRefusal(settings: ElevenlabsSettings, current: ElevenlabsUsage, chars: number): ElevenlabsRefusal | null {
    const refuse = (limit: ElevenlabsLimitName, message: string, details: Record<string, unknown>): ElevenlabsRefusal => ({ code: "elevenlabs_limit_exceeded", message, details: { limit, ...details, chars } });
    if (chars > settings.maxCharsPerJob) return refuse("per_job", `The take is ${chars} characters, over the per-job limit of ${settings.maxCharsPerJob}.`, { limitChars: settings.maxCharsPerJob });
    if (current.todayChars + chars > settings.maxCharsPerDay) return refuse("per_day", `${current.todayChars} characters used or reserved today + ${chars} is over the daily limit of ${settings.maxCharsPerDay}.`, { limitChars: settings.maxCharsPerDay, usedChars: current.todayChars });
    if (current.monthChars + chars > settings.maxCharsPerMonth) return refuse("per_month", `${current.monthChars} characters used or reserved this month + ${chars} is over the monthly limit of ${settings.maxCharsPerMonth}.`, { limitChars: settings.maxCharsPerMonth, usedChars: current.monthChars });
    if (current.activeJobs + 1 > settings.maxActiveJobs) return refuse("active_jobs", `${current.activeJobs} ElevenLabs jobs are already queued or running (limit ${settings.maxActiveJobs}).`, { maxActiveJobs: settings.maxActiveJobs, activeJobs: current.activeJobs });
    return null;
  }

  async function preconditions(settings: ElevenlabsSettings): Promise<ElevenlabsRefusal | null> {
    if (!settings.enabled) return { code: "elevenlabs_disabled", message: "Speech through ElevenLabs is turned off on this computer (Settings → Cloud APIs)." };
    if ((await deps.secret.state()) !== "set") return { code: "elevenlabs_key_missing", message: "No ElevenLabs API key is stored on this computer (Settings → Cloud APIs)." };
    return null;
  }

  async function connected(channelId: string): Promise<void> {
    if (!(await deps.isChannelConnected(channelId))) {
      throw new DomainError({ code: "elevenlabs_workspace_unavailable", message: `${channelId} is not a channel connected on this computer (factory_list_channels).`, details: { channelId } });
    }
  }

  return {
    readApiKey,
    getSettings,
    usage,

    async getKey(): Promise<ElevenlabsKeyView> {
      return keyView();
    },

    /** Checks the key with ElevenLabs first: a refused key is never stored. Only the last 4 characters stay readable. */
    async setKey(raw: unknown): Promise<ElevenlabsKeyView> {
      const { apiKey } = parseWithSchema(setKeyInputSchema, raw, "ElevenLabs API key");
      const status = await checkKey(apiKey);
      await deps.secret.write(apiKey, { hints: { keyHint: apiKey.slice(-4) }, status, verifiedAt: now().getTime() });
      return keyView();
    },

    async testKey(): Promise<ElevenlabsKeyView> {
      const read = await readApiKeyWithVersion();
      if (!read) throw new DomainError({ code: "elevenlabs_key_missing", message: "No ElevenLabs API key is stored on this computer." });
      const status = await checkKey(read.value);
      await deps.secret.setStatus(read.version, { status, verifiedAt: now().getTime() });
      return keyView();
    },

    async clearKey(): Promise<ElevenlabsKeyView> {
      await deps.secret.clear();
      return keyView();
    },

    async updateSettings(raw: unknown): Promise<ElevenlabsSettings> {
      const patch = parseWithSchema(updateSettingsInputSchema, raw, "ElevenLabs settings");
      const next = { ...(await getSettings()), ...patch };
      await deps.store.setSettingsJson(JSON.stringify(next));
      return next;
    },

    /**
     * The status read (factory_speech_get_status): switch, key presence and hint (never the key), limits in characters, this
     * computer's usage, the models with list prices. `subscription` reads ElevenLabs' own character count only when asked (the
     * Settings card), never on the Operator's read.
     */
    async getStatus(options: { subscription?: boolean } = {}) {
      const [settings, key, current, gatewayEnabled] = await Promise.all([getSettings(), keyView(), usage(), deps.isGatewayEnabled()]);
      const { enabled, outputFormat, ...limits } = settings;
      let subscription: Record<string, unknown> | null = null;
      if (options.subscription && key.configured && gatewayEnabled) {
        try {
          const apiKey = await readApiKey();
          subscription = apiKey ? { ...(await deps.api.getSubscription(apiKey)) } : null;
        } catch (error) {
          subscription = { errorCode: isDomainError(error) ? error.code : "elevenlabs_unavailable" };
        }
      }
      return {
        units: "characters",
        enabled,
        keyConfigured: key.configured,
        keyHint: key.keyHint,
        keyStatus: key.status,
        gatewayEnabled,
        limits,
        outputFormat,
        outputFormats: [...ELEVENLABS_OUTPUT_FORMATS],
        usage: current,
        ...(options.subscription ? { subscription } : {}),
        pricesAsOf: ELEVENLABS_PRICES_AS_OF,
        defaultModel: ELEVENLABS_DEFAULT_MODEL,
        models: Object.entries(ELEVENLABS_SPEECH_MODELS).map(([model, spec]) => ({ model, kind: "speech" as const, label: spec.label, usdPer1kChars: spec.usdPer1kChars, maxChars: spec.maxChars })),
        designModel: ELEVENLABS_DESIGN_MODEL,
      };
    },

    /** One take (or, with dryRun, what it would count and whether it fits). Serialized; a repeated requestId replays the first job. */
    async createJob(raw: unknown, actor: string) {
      const input = parseWithSchema(createJobInputSchema, raw, "ElevenLabs speech job");
      const model = input.model ?? ELEVENLABS_DEFAULT_MODEL;
      return deps.withCreateLock(async () => {
        const settings = await getSettings();
        const outputFormat = input.outputFormat ?? settings.outputFormat;
        const hash = requestHash(input, model, outputFormat);
        if (input.requestId && !input.dryRun) {
          const existing = await deps.store.getJobByRequest(actor, input.requestId);
          if (existing) {
            if (existing.requestHash !== hash) throw new DomainError({ code: "elevenlabs_request_exists", message: `Request id ${input.requestId} was already used for a different job (${existing.jobId}).`, details: { requestId: input.requestId, jobId: existing.jobId } });
            return { job: jobView(existing), replayed: true };
          }
        }
        checkJobRules(input, model);
        const precondition = await preconditions(settings);
        if (precondition && !input.dryRun) throw new DomainError({ code: precondition.code, message: precondition.message });
        await connected(input.channelId);
        await deps.workspace.resolveOutputRoot(input.channelId);
        let voice: ElevenlabsSpeechParams["voice"] | null = null;
        let voiceRefusal: ElevenlabsRefusal | null = null;
        try {
          voice = await deps.voices.resolve({ channelId: input.channelId, provider: "elevenlabs", voice: input.voice });
        } catch (error) {
          if (!input.dryRun || !isDomainError(error) || error.code !== "voice_not_approved") throw error;
          voiceRefusal = { code: "voice_not_approved", message: error.message, details: error.details as Record<string, unknown> | undefined };
        }
        let video: string | null = null;
        if (deps.videoLink) video = await deps.videoLink.resolve({ channelId: input.channelId, videoNumber: input.videoNumber ?? null, storyboardId: null });
        else if (input.videoNumber) throw new DomainError({ code: "video_not_found", message: "Video numbers are not available on this server", details: { videoNumber: input.videoNumber } });
        const chars = charCount(input.text);
        const estimateUsd = listPriceUsd(model, chars);
        const current = await usage();
        const refusal = precondition ?? voiceRefusal ?? limitRefusal(settings, current, chars);
        if (input.dryRun) return { dryRun: true, chars, estimateUsd, allowed: refusal === null, refusal, usage: current };
        if (refusal) throw new DomainError({ code: refusal.code, message: refusal.message, details: refusal.details });
        const at = now();
        const params: ElevenlabsSpeechParams = { voice: voice!, outputFormat };
        const row: StoredElevenlabsSpeechJob = {
          jobId: `el_${deps.generateId()}`,
          channelId: input.channelId,
          requestId: input.requestId ?? null,
          requestHash: hash,
          kind: "speech",
          model,
          text: input.text,
          paramsJson: JSON.stringify(params),
          status: "queued",
          chars,
          estimateUsd,
          costUsd: null,
          costBasis: null,
          chargedChars: null,
          outputsJson: null,
          error: null,
          errorCode: null,
          attempts: 0,
          nextAttemptAt: null,
          createdBy: actor,
          createdAt: at,
          submittedAt: null,
          finishedAt: null,
          updatedAt: at,
          video,
        };
        if (!(await deps.store.insertJob(row))) throw new DomainError({ code: "elevenlabs_request_exists", message: `Request id ${input.requestId} was just used.`, details: { requestId: input.requestId } });
        return { job: jobView(row) };
      });
    },

    /**
     * Voice Design v3 (PAID: its preview text is counted against the character limits and recorded as a `voice_design` job). Returns
     * the previews for the voice registry to keep; nothing is saved at ElevenLabs until one is approved (`saveDesignedVoice`).
     */
    async designVoice(raw: unknown, actor: string): Promise<ElevenlabsDesignedVoice> {
      const input = parseWithSchema(designVoiceInputSchema, raw, "ElevenLabs voice design");
      const previewText = input.previewText ?? ELEVENLABS_LIMITS.defaultPreviewText;
      const count = input.count ?? ELEVENLABS_LIMITS.maxPreviews;
      const row = await deps.withCreateLock(async () => {
        const settings = await getSettings();
        const precondition = await preconditions(settings);
        if (precondition) throw new DomainError({ code: precondition.code, message: precondition.message });
        await connected(input.channelId);
        const chars = charCount(previewText);
        const refusal = limitRefusal(settings, await usage(), chars);
        if (refusal) throw new DomainError({ code: refusal.code, message: refusal.message, details: refusal.details });
        const at = now();
        const params: ElevenlabsDesignParams = { description: input.description, previewText, previews: count };
        const inserted: StoredElevenlabsSpeechJob = {
          jobId: `el_${deps.generateId()}`,
          channelId: input.channelId,
          requestId: null,
          requestHash: createHash("sha256").update(JSON.stringify({ kind: "voice_design", ...params, channelId: input.channelId })).digest("hex"),
          kind: "voice_design",
          model: ELEVENLABS_DESIGN_MODEL,
          text: previewText,
          paramsJson: JSON.stringify(params),
          status: "submitting",
          chars,
          estimateUsd: listPriceUsd(ELEVENLABS_DESIGN_MODEL, chars),
          costUsd: null,
          costBasis: null,
          chargedChars: null,
          outputsJson: null,
          error: null,
          errorCode: null,
          attempts: 1,
          nextAttemptAt: null,
          createdBy: actor,
          createdAt: at,
          submittedAt: at,
          finishedAt: null,
          updatedAt: at,
          video: null,
        };
        await deps.store.insertJob(inserted);
        return inserted;
      });
      const failRow = (errorCode: string, error: string, charged: boolean) =>
        deps.store.updateJob(row.jobId, "submitting", { status: "failed", errorCode, error: error.slice(0, 2000), costUsd: charged ? row.estimateUsd : 0, costBasis: charged ? "unknown_outcome" : "not_charged", finishedAt: now(), updatedAt: now() });
      const apiKey = await readApiKey().catch(async (error) => {
        await failRow("elevenlabs_key_missing", error instanceof Error ? error.message : String(error), false);
        throw error;
      });
      if (!apiKey) {
        await failRow("elevenlabs_key_missing", "The ElevenLabs API key was removed from this computer.", false);
        throw new DomainError({ code: "elevenlabs_key_missing", message: "No ElevenLabs API key is stored on this computer (Settings → Cloud APIs)." });
      }
      const settings = await getSettings();
      let result: Awaited<ReturnType<ElevenlabsApiPort["designVoice"]>>;
      try {
        result = await deps.api.designVoice(apiKey, { description: input.description, text: previewText, modelId: ELEVENLABS_DESIGN_MODEL, outputFormat: settings.outputFormat });
      } catch (error) {
        const details = isDomainError(error) ? ((error.details ?? {}) as Record<string, unknown>) : {};
        await failRow(isDomainError(error) ? error.code : "elevenlabs_unavailable", error instanceof Error ? error.message : String(error), !isDomainError(error) || details.outcome === "unknown");
        throw error;
      }
      const previews = result.previews.slice(0, count).map((p) => ({ generatedVoiceId: p.generatedVoiceId, audio: audioFileOf({ mimeType: p.mimeType, data: p.data }, 24_000) }));
      if (previews.length === 0) {
        await failRow("elevenlabs_output_failed", "ElevenLabs answered without a preview; it may have been charged.", true);
        throw new DomainError({ code: "elevenlabs_unavailable", message: "ElevenLabs designed no preview.", details: { outcome: "answered", jobId: row.jobId } });
      }
      await deps.store.updateJob(row.jobId, "submitting", { status: "done", costUsd: row.estimateUsd, costBasis: "list_price", chargedChars: row.chars, finishedAt: now(), updatedAt: now() });
      return { jobId: row.jobId, model: ELEVENLABS_DESIGN_MODEL, previews };
    },

    /** Saves one approved preview as a voice of the ElevenLabs account (free) -- only when a key is stored and the gateway is on. */
    async saveDesignedVoice(input: { name: string; description: string; generatedVoiceId: string }): Promise<{ providerVoiceId: string }> {
      const apiKey = await readApiKey();
      if (!apiKey) throw new DomainError({ code: "elevenlabs_key_missing", message: "No ElevenLabs API key is stored on this computer (Settings → Cloud APIs)." });
      const saved = await deps.api.createVoiceFromDesign(apiKey, input);
      return { providerVoiceId: saved.voiceId };
    },

    /** One job by id, or the newest (≤ 50) with optional channel / status filters. */
    async getJobs(raw: unknown) {
      const input = parseWithSchema(getJobsInputSchema, raw, "ElevenLabs job query");
      if (input.jobId) {
        const row = await deps.store.getJob(input.jobId);
        if (!row) throw elevenlabsJobNotFound(input.jobId);
        return { job: jobView(row) };
      }
      const rows = await deps.store.listJobs({ ...(input.channelId ? { channelId: input.channelId } : {}), ...(input.status ? { statuses: [input.status as ElevenlabsJobStatus] } : {}), limit: input.limit ?? 20 });
      return { jobs: rows.map(jobView) };
    },

    /** The owner cancels a job not yet sent (queued → failed, nothing charged); once sent, too late. */
    async cancelJob(jobId: string): Promise<{ job: ElevenlabsJobView }> {
      const row = await deps.store.getJob(jobId);
      if (!row) throw elevenlabsJobNotFound(jobId);
      const at = now();
      const cancelled = row.status === "queued" && (await deps.store.updateJob(jobId, "queued", { status: "failed", errorCode: "cancelled_by_owner", error: "Cancelled by the owner before it was sent to ElevenLabs.", costUsd: 0, costBasis: "not_charged", finishedAt: at, updatedAt: at }));
      if (!cancelled) throw new DomainError({ code: "gemini_cancel_too_late", message: `Job ${jobId} was already sent or finished; it cannot be cancelled now.`, details: { jobId, status: row.status } });
      return { job: jobView((await deps.store.getJob(jobId)) ?? row) };
    },
  };
}

export type ElevenlabsSpeechServices = ReturnType<typeof createElevenlabsSpeechServices>;
export type { ElevenlabsJobOutput };
