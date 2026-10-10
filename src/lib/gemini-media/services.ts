import { createHash } from "node:crypto";
import path from "node:path";
import type { KeyFile } from "@/lib/device-key-file";
import type { GeminiApiClient } from "@/lib/media-gateway";
import { decryptSecret, encryptSecret } from "@/lib/shared-crypto";
import type { GeminiMediaJobStatusValue, StoredGeminiCredentials, StoredGeminiMediaJob } from "@/lib/db";
import {
  DEFAULT_GEMINI_MEDIA_SETTINGS,
  DomainError,
  GEMINI_ACTIVE_STATUSES,
  GEMINI_INPUT_EXTENSIONS,
  GEMINI_LIMITS,
  GEMINI_PRICES_AS_OF,
  isDomainError,
  geminiJobNotFound,
  type GeminiCostBasis,
  type GeminiImageParams,
  type GeminiInputRole,
  type GeminiJobInput,
  type GeminiJobOutput,
  type GeminiJobStatus,
  type GeminiJobView,
  type GeminiKeyView,
  type GeminiLimitName,
  type GeminiMediaSettings,
  type GeminiRefusal,
  type GeminiSpend,
  type GeminiVideoParams,
} from "./contracts";
import { estimateImageUsd, estimateVideoUsd, modelCatalog } from "./pricing";
import { checkJobRules, createJobInputSchema, getJobsInputSchema, parseWithSchema, setKeyInputSchema, updateSettingsInputSchema, type CreateJobInput } from "./schemas";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.2–§2.7): the key, the owner's settings and limits, the spend, and job creation / reads.
// The worker that runs jobs is `./worker.ts` (same dependencies). Pure logic over injected ports; `./index.ts` wires the
// real database, gateway, file system and key file.

export type GeminiStore = {
  getCredentials(): Promise<StoredGeminiCredentials | null>;
  upsertCredentials(input: Pick<StoredGeminiCredentials, "ciphertext" | "iv" | "authTag" | "keyHint" | "status" | "verifiedAt">): Promise<void>;
  clearCredentials(): Promise<void>;
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  insertJob(row: StoredGeminiMediaJob): Promise<boolean>;
  getJob(jobId: string): Promise<StoredGeminiMediaJob | null>;
  getJobByRequest(createdBy: string, requestId: string): Promise<StoredGeminiMediaJob | null>;
  listJobs(filter: { channelId?: string; statuses?: readonly GeminiMediaJobStatusValue[]; createdSince?: Date; limit: number }): Promise<StoredGeminiMediaJob[]>;
  updateJob(jobId: string, fromStatus: GeminiMediaJobStatusValue, set: Partial<StoredGeminiMediaJob>): Promise<boolean>;
};

export type GeminiApiPort = Pick<GeminiApiClient, "checkKey" | "generateImage" | "startVideo" | "getVideoOperation" | "downloadVideo">;

export type ResolvedInputFile = { path: string; bytes: number; identity?: { dev: number; ino: number } };

export type GeminiWorkspacePort = {
  /** The channel's real `99 Data Exchange/From YTM` folder (created if missing); `gemini_workspace_unavailable` otherwise. */
  resolveOutputRoot(channelId: string): Promise<string>;
  /** A file named relative to the channel's `Sent to YTM`, proven contained; `gemini_input_unavailable` otherwise. */
  resolveInput(channelId: string, relativePath: string): Promise<ResolvedInputFile>;
};

export type GeminiFilesPort = {
  /** Reads the file it was given, refusing one swapped in since it was resolved (dev/ino) or larger than `maxBytes`. */
  readInput(file: ResolvedInputFile, maxBytes: number): Promise<Buffer>;
  /** Writes through `<path>.part` + rename (creating the folder); returns the size and SHA-256 of what was written. */
  writeOutput(filePath: string, data: Buffer): Promise<{ bytes: number; sha256: string }>;
  writeManifest(filePath: string, manifest: unknown): Promise<void>;
};

export type GeminiMediaDeps = {
  store: GeminiStore;
  api: GeminiApiPort;
  keyFile: KeyFile;
  workspace: GeminiWorkspacePort;
  files: GeminiFilesPort;
  assets: {
    register(input: { channelId: string; assetType: "generated_image" | "generated_video"; referenceKind: "local_path"; referenceValue: string; title: string; provenance: Record<string, unknown> }): Promise<{ assetId: string }>;
    findByLocalPath(channelId: string, localPath: string): Promise<{ assetId: string } | null>;
  };
  device(): Promise<{ deviceId: string | null; hostname: string | null }>;
  isGatewayEnabled(): Promise<boolean>;
  clock: { now(): Date };
  generateId(): string;
  /** Serializes job creation process-wide (held on `globalThis` by `./index.ts`): two creates never both pass a limit. */
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

/** Forgiving per field (like the media settings): a bad stored value falls back to its own default only. */
export function settingsFromJson(json: string | null): GeminiMediaSettings {
  const stored = parseJson<Record<string, unknown>>(json, {});
  const settings: GeminiMediaSettings = { ...DEFAULT_GEMINI_MEDIA_SETTINGS };
  for (const key of Object.keys(DEFAULT_GEMINI_MEDIA_SETTINGS) as Array<keyof GeminiMediaSettings>) {
    const parsed = updateSettingsInputSchema.safeParse({ [key]: stored[key] });
    if (parsed.success && parsed.data[key] !== undefined) (settings as Record<string, unknown>)[key] = parsed.data[key];
  }
  return settings;
}

export function jobView(row: StoredGeminiMediaJob): GeminiJobView {
  return {
    jobId: row.jobId,
    channelId: row.channelId,
    requestId: row.requestId ?? null,
    kind: row.kind,
    model: row.model,
    prompt: row.prompt,
    params: parseJson<GeminiImageParams | GeminiVideoParams>(row.paramsJson, { size: "", aspectRatio: "" }),
    inputs: parseJson<GeminiJobInput[]>(row.inputsJson, []),
    status: row.status,
    estimateUsd: row.estimateUsd,
    costUsd: row.costUsd ?? null,
    costBasis: (row.costBasis as GeminiCostBasis | null) ?? null,
    outputs: parseJson<GeminiJobOutput[]>(row.outputsJson, []),
    error: row.error ?? null,
    errorCode: row.errorCode ?? null,
    attempts: row.attempts,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** What a job asks for, independent of when it was asked: the idempotency check of a repeated `requestId`. */
function requestHash(input: CreateJobInput): string {
  const canonical =
    input.kind === "image"
      ? { channelId: input.channelId, kind: input.kind, model: input.model, prompt: input.prompt, size: input.image?.size, aspectRatio: input.image?.aspectRatio, images: input.image?.inputs?.images ?? [] }
      : {
          channelId: input.channelId,
          kind: input.kind,
          model: input.model,
          prompt: input.prompt,
          resolution: input.video?.resolution,
          aspectRatio: input.video?.aspectRatio,
          durationSeconds: input.video?.durationSeconds,
          personGeneration: input.video?.personGeneration ?? null,
          firstFrame: input.video?.inputs?.firstFrame ?? null,
          lastFrame: input.video?.inputs?.lastFrame ?? null,
          referenceImages: input.video?.inputs?.referenceImages ?? [],
        };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The inputs a create names, in a fixed order, with their roles. */
export function namedInputs(input: Pick<CreateJobInput, "kind" | "image" | "video">): Array<{ role: GeminiInputRole; path: string }> {
  if (input.kind === "image") return (input.image?.inputs?.images ?? []).map((p) => ({ role: "image" as const, path: p }));
  const inputs = input.video?.inputs ?? {};
  return [
    ...(inputs.firstFrame ? [{ role: "first_frame" as const, path: inputs.firstFrame }] : []),
    ...(inputs.lastFrame ? [{ role: "last_frame" as const, path: inputs.lastFrame }] : []),
    ...(inputs.referenceImages ?? []).map((p) => ({ role: "reference" as const, path: p })),
  ];
}

export function createGeminiMediaServices(deps: GeminiMediaDeps) {
  const now = () => deps.clock.now();

  function inputUnavailable(relativePath: string, reason: string): DomainError {
    return new DomainError({ code: "gemini_input_unavailable", message: `Input ${relativePath}: ${reason}`, details: { path: relativePath, reason } });
  }

  async function getSettings(): Promise<GeminiMediaSettings> {
    return settingsFromJson(await deps.store.getSettingsJson());
  }

  function keyViewOf(row: StoredGeminiCredentials | null): GeminiKeyView {
    if (!row) return { configured: false, keyHint: null, status: null, verifiedAt: null, updatedAt: null };
    return { configured: true, keyHint: row.keyHint, status: row.status, verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null, updatedAt: row.updatedAt.toISOString() };
  }

  /** The stored key in clear, or `null` when none is stored. A key file that is missing or unusable fails closed. */
  async function readApiKey(): Promise<string | null> {
    const row = await deps.store.getCredentials();
    if (!row) return null;
    const key = await deps.keyFile.readKey();
    if (!key) throw new DomainError({ code: "encryption_key_not_configured", message: "The Gemini key file is missing on this computer; enter the API key again (Settings → Gemini)." });
    try {
      return decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag }, key);
    } catch {
      throw new DomainError({ code: "encryption_key_not_configured", message: "The stored Gemini API key cannot be decrypted with this computer's key file; enter it again (Settings → Gemini)." });
    }
  }

  async function spend(at: Date = now()): Promise<GeminiSpend> {
    const dayStart = startOfLocalDay(at);
    const [thisMonth, active] = await Promise.all([
      deps.store.listJobs({ createdSince: startOfLocalMonth(at), limit: 100_000 }),
      deps.store.listJobs({ statuses: GEMINI_ACTIVE_STATUSES, limit: 100_000 }),
    ]);
    const isActive = (row: StoredGeminiMediaJob) => (GEMINI_ACTIVE_STATUSES as readonly string[]).includes(row.status);
    // An active job reserves its estimate; a finished one counts what it cost (0 when Google charged nothing).
    const amount = (row: StoredGeminiMediaJob) => (isActive(row) ? row.estimateUsd : (row.costUsd ?? 0));
    const sum = (rows: StoredGeminiMediaJob[]) => round4(rows.reduce((total, row) => total + amount(row), 0));
    return {
      todayUsd: sum(thisMonth.filter((row) => row.createdAt.getTime() >= dayStart.getTime())),
      monthUsd: sum(thisMonth),
      activeUsd: sum(active),
      activeJobs: active.length,
    };
  }

  function limitRefusal(settings: GeminiMediaSettings, current: GeminiSpend, estimateUsd: number): GeminiRefusal | null {
    const refuse = (limit: GeminiLimitName, message: string, details: Record<string, unknown>): GeminiRefusal => ({ code: "gemini_limit_exceeded", message, details: { limit, ...details, estimateUsd } });
    if (estimateUsd > settings.maxUsdPerJob) return refuse("per_job", `The job's estimate $${estimateUsd} is over the per-job limit $${settings.maxUsdPerJob}.`, { limitUsd: settings.maxUsdPerJob });
    if (round4(current.todayUsd + estimateUsd) > settings.maxUsdPerDay) {
      return refuse("per_day", `$${current.todayUsd} spent or reserved today + $${estimateUsd} is over the daily limit $${settings.maxUsdPerDay}.`, { limitUsd: settings.maxUsdPerDay, spentUsd: current.todayUsd });
    }
    if (round4(current.monthUsd + estimateUsd) > settings.maxUsdPerMonth) {
      return refuse("per_month", `$${current.monthUsd} spent or reserved this month + $${estimateUsd} is over the monthly limit $${settings.maxUsdPerMonth}.`, { limitUsd: settings.maxUsdPerMonth, spentUsd: current.monthUsd });
    }
    if (current.activeJobs + 1 > settings.maxActiveJobs) {
      return refuse("active_jobs", `${current.activeJobs} Gemini jobs are already queued or running (limit ${settings.maxActiveJobs}).`, { maxActiveJobs: settings.maxActiveJobs, activeJobs: current.activeJobs });
    }
    return null;
  }

  /** Resolves and reads every named input now (before anything is stored or sent), with the size bounds of §2.4. */
  async function readInputs(channelId: string, named: Array<{ role: GeminiInputRole; path: string }>): Promise<Array<GeminiJobInput & { data: Buffer }>> {
    const out: Array<GeminiJobInput & { data: Buffer }> = [];
    let total = 0;
    for (const { role, path: relativePath } of named) {
      const mimeType = GEMINI_INPUT_EXTENSIONS[path.extname(relativePath).slice(1).toLowerCase()];
      if (!mimeType) throw inputUnavailable(relativePath, "only .png, .jpg, .jpeg and .webp images are accepted");
      const resolved = await deps.workspace.resolveInput(channelId, relativePath);
      if (resolved.bytes <= 0) throw inputUnavailable(relativePath, "the file is empty");
      if (resolved.bytes > GEMINI_LIMITS.inputBytes) throw inputUnavailable(relativePath, `the file is ${resolved.bytes} bytes, over ${GEMINI_LIMITS.inputBytes}`);
      total += resolved.bytes;
      if (total > GEMINI_LIMITS.inputTotalBytes) throw inputUnavailable(relativePath, `the inputs together are over ${GEMINI_LIMITS.inputTotalBytes} bytes`);
      let data: Buffer;
      try {
        data = await deps.files.readInput(resolved, GEMINI_LIMITS.inputBytes);
      } catch (error) {
        if (isDomainError(error)) throw error;
        throw inputUnavailable(relativePath, error instanceof Error ? error.message : String(error));
      }
      out.push({ role, path: relativePath, mimeType, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), data });
    }
    return out;
  }

  function estimateOf(input: CreateJobInput, inputCount: number): number {
    return input.kind === "image"
      ? estimateImageUsd({ model: input.model, size: input.image!.size, promptChars: input.prompt.length, inputImages: inputCount })
      : estimateVideoUsd({ model: input.model, resolution: input.video!.resolution, durationSeconds: input.video!.durationSeconds });
  }

  return {
    readApiKey,
    getSettings,
    spend,

    async getKey(): Promise<GeminiKeyView> {
      return keyViewOf(await deps.store.getCredentials());
    },

    /** Checks the key with Google first (AC-GM-01): a refused key is never stored; an empty balance (402) is stored with that status. */
    async setKey(input: unknown): Promise<GeminiKeyView> {
      const { apiKey } = parseWithSchema(setKeyInputSchema, input, "Gemini API key");
      let status: "ok" | "payment_required" = "ok";
      try {
        await deps.api.checkKey(apiKey);
      } catch (error) {
        if (!(isDomainError(error) && error.code === "gemini_payment_required")) throw error;
        status = "payment_required";
      }
      const key = await deps.keyFile.readOrCreateKey();
      const sealed = encryptSecret(apiKey, key);
      await deps.store.upsertCredentials({ ...sealed, keyHint: apiKey.slice(-4), status, verifiedAt: now() });
      return keyViewOf(await deps.store.getCredentials());
    },

    async testKey(): Promise<GeminiKeyView> {
      const apiKey = await readApiKey();
      if (!apiKey) throw new DomainError({ code: "gemini_key_missing", message: "No Gemini API key is stored on this computer." });
      const row = await deps.store.getCredentials();
      let status: "ok" | "payment_required" = "ok";
      try {
        await deps.api.checkKey(apiKey);
      } catch (error) {
        if (!(isDomainError(error) && error.code === "gemini_payment_required")) throw error;
        status = "payment_required";
      }
      if (row) await deps.store.upsertCredentials({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyHint: row.keyHint, status, verifiedAt: now() });
      return keyViewOf(await deps.store.getCredentials());
    },

    /** Removes the stored key and this module's key file (never the RunPod one). */
    async clearKey(): Promise<GeminiKeyView> {
      await deps.store.clearCredentials();
      await deps.keyFile.removeKey();
      return keyViewOf(null);
    },

    async updateSettings(input: unknown): Promise<GeminiMediaSettings> {
      const patch = parseWithSchema(updateSettingsInputSchema, input, "Gemini settings");
      const next = { ...(await getSettings()), ...patch };
      await deps.store.setSettingsJson(JSON.stringify(next));
      return next;
    },

    /** The operator's read (`factory_gemini_get_status`): switch, key presence (never the key), limits, spend, models and prices. */
    async getStatus() {
      const [settings, row, current, gatewayEnabled] = await Promise.all([getSettings(), deps.store.getCredentials(), spend(), deps.isGatewayEnabled()]);
      const key = keyViewOf(row);
      const { enabled, ...limits } = settings;
      return {
        enabled,
        keyConfigured: key.configured,
        keyHint: key.keyHint,
        keyStatus: key.status,
        gatewayEnabled,
        limits,
        spend: current,
        pricesAsOf: GEMINI_PRICES_AS_OF,
        models: modelCatalog(),
      };
    },

    /**
     * Creates a job (or, with `dryRun`, only answers what it would cost and whether it fits). Serialized process-wide so two
     * creates never both pass a limit (AC-GM-04). A repeated `requestId` with the same content returns the first job
     * (AC-GM-11), before any other check, so a retry after a lost answer never creates a second paid job.
     */
    async createJob(raw: unknown, actor: string) {
      const input = parseWithSchema(createJobInputSchema, raw, "Gemini job");
      checkJobRules(input);
      const hash = requestHash(input);
      return deps.withCreateLock(async () => {
        if (input.requestId && !input.dryRun) {
          const existing = await deps.store.getJobByRequest(actor, input.requestId);
          if (existing) {
            if (existing.requestHash !== hash) {
              throw new DomainError({ code: "gemini_request_exists", message: `Request id ${input.requestId} was already used for a different job (${existing.jobId}).`, details: { requestId: input.requestId, jobId: existing.jobId } });
            }
            return { job: jobView(existing), replayed: true };
          }
        }
        const settings = await getSettings();
        const preconditionRefusal: GeminiRefusal | null = !settings.enabled
          ? { code: "gemini_disabled", message: "Generation through Gemini is turned off on this computer (Settings → Gemini)." }
          : !(await deps.store.getCredentials())
            ? { code: "gemini_key_missing", message: "No Gemini API key is stored on this computer (Settings → Gemini)." }
            : null;
        if (preconditionRefusal && !input.dryRun) throw new DomainError({ code: preconditionRefusal.code, message: preconditionRefusal.message });
        await deps.workspace.resolveOutputRoot(input.channelId);
        const inputs = await readInputs(input.channelId, namedInputs(input));
        const estimateUsd = estimateOf(input, inputs.length);
        const current = await spend();
        const refusal = preconditionRefusal ?? limitRefusal(settings, current, estimateUsd);
        if (input.dryRun) return { dryRun: true, estimateUsd, allowed: refusal === null, refusal, spend: current };
        if (refusal) throw new DomainError({ code: refusal.code, message: refusal.message, details: refusal.details });
        const at = now();
        const params: GeminiImageParams | GeminiVideoParams =
          input.kind === "image"
            ? { size: input.image!.size, aspectRatio: input.image!.aspectRatio }
            : {
                resolution: input.video!.resolution,
                aspectRatio: input.video!.aspectRatio,
                durationSeconds: input.video!.durationSeconds,
                ...(input.video!.personGeneration ? { personGeneration: input.video!.personGeneration } : {}),
              };
        const row: StoredGeminiMediaJob = {
          jobId: `gm_${deps.generateId()}`,
          channelId: input.channelId,
          requestId: input.requestId ?? null,
          requestHash: hash,
          kind: input.kind,
          model: input.model,
          prompt: input.prompt,
          paramsJson: JSON.stringify(params),
          inputsJson: JSON.stringify(inputs.map(({ data: _data, ...rest }) => rest)),
          status: "queued",
          remoteName: null,
          estimateUsd,
          costUsd: null,
          costBasis: null,
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
        };
        if (!(await deps.store.insertJob(row))) {
          // Only a concurrent create with the same request id can get here (the lock makes it a cross-process race).
          throw new DomainError({ code: "gemini_request_exists", message: `Request id ${input.requestId} was just used.`, details: { requestId: input.requestId } });
        }
        return { job: jobView(row) };
      });
    },

    /** One job by id, or the newest jobs (≤ 50) with optional channel / status filters. */
    async getJobs(raw: unknown) {
      const input = parseWithSchema(getJobsInputSchema, raw, "Gemini job query");
      if (input.jobId) {
        const row = await deps.store.getJob(input.jobId);
        if (!row) throw geminiJobNotFound(input.jobId);
        return { job: jobView(row) };
      }
      const rows = await deps.store.listJobs({
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.status ? { statuses: [input.status as GeminiJobStatus] } : {}),
        limit: input.limit ?? 20,
      });
      return { jobs: rows.map(jobView) };
    },
  };
}

export type GeminiMediaServices = ReturnType<typeof createGeminiMediaServices>;
