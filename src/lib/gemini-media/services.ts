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
  ownEntry,
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
  type GeminiPeerSpendReport,
  type GeminiRefusal,
  type GeminiSpend,
  type GeminiStoryboardGate,
  type GeminiStoryboardLink,
  type GeminiVideoLink,
  type GeminiVideoParams,
} from "./contracts";
import { accountWideSpend, geminiKeyFingerprint } from "./account";
import { estimateImageUsd, estimateVideoUsd, modelCatalog } from "./pricing";
import { checkJobRules, createJobInputSchema, getJobsInputSchema, parseWithSchema, setKeyInputSchema, updateSettingsInputSchema, type CreateJobInput } from "./schemas";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.2–§2.7): the key, the owner's settings and limits, the spend, and job creation / reads.
// The worker that runs jobs is `./worker.ts` (same dependencies). Pure logic over injected ports; `./index.ts` wires the
// real database, gateway, file system and key file.

export type GeminiStore = {
  getCredentials(): Promise<StoredGeminiCredentials | null>;
  upsertCredentials(input: Pick<StoredGeminiCredentials, "ciphertext" | "iv" | "authTag" | "keyHint" | "status" | "verifiedAt">): Promise<void>;
  /** Writes a check's result only while the stored key is still the one checked (its ciphertext); false otherwise. */
  setCredentialsStatus(checkedCiphertext: string, input: Pick<StoredGeminiCredentials, "status" | "verifiedAt">): Promise<boolean>;
  clearCredentials(): Promise<void>;
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  insertJob(row: StoredGeminiMediaJob): Promise<boolean>;
  getJob(jobId: string): Promise<StoredGeminiMediaJob | null>;
  getJobByRequest(createdBy: string, requestId: string): Promise<StoredGeminiMediaJob | null>;
  listJobs(filter: { channelId?: string; statuses?: readonly GeminiMediaJobStatusValue[]; createdSince?: Date; storyboardId?: string; limit: number }): Promise<StoredGeminiMediaJob[]>;
  updateJob(jobId: string, fromStatus: GeminiMediaJobStatusValue, set: Partial<StoredGeminiMediaJob>): Promise<boolean>;
};

export type GeminiApiPort = Pick<GeminiApiClient, "checkKey" | "generateImage" | "generateVideo" | "downloadVideo">;

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
  /** A job is only for a channel connected on this computer (the ones `factory_list_channels` shows). */
  isChannelConnected(channelId: string): Promise<boolean>;
  isGatewayEnabled(): Promise<boolean>;
  clock: { now(): Date };
  generateId(): string;
  /** Serializes job creation process-wide (held on `globalThis` by `./index.ts`): two creates never both pass a limit. */
  withCreateLock<T>(run: () => Promise<T>): Promise<T>;
  /** BL-184 stage 2: no first/last-frame video from two different images without an approved storyboard (ADR 0038 §4). */
  storyboardGate: GeminiStoryboardGate;
  /** BL-194: which video a job is made for (absent: jobs are not linked to videos here, and a `videoNumber` is refused). */
  videoLink?: GeminiVideoLink;
  /**
   * BL-193 (ADR 0039): the other computers' latest Gemini spend reports (the sync-gateway `gemini-spend` family). Absent = no other
   * computer is known (tests); a read that fails counts the others as 0 and is logged, as RunPod's shared cap does (ADR 0028 §5).
   */
  peerSpendReports?(): Promise<GeminiPeerSpendReport[]>;
  log?(line: string): void;
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
    storyboard: row.storyboardId && row.segmentId && row.storyboardVersion !== null ? { storyboardId: row.storyboardId, versionNumber: row.storyboardVersion, segmentId: row.segmentId } : null,
    video: row.video ?? null,
  };
}

/** What a job asks for, independent of when it was asked: the idempotency check of a repeated `requestId`. */
function requestHash(input: CreateJobInput): string {
  const canonical =
    input.kind === "image"
      ? {
          channelId: input.channelId,
          kind: input.kind,
          model: input.model,
          prompt: input.prompt,
          size: input.image?.size,
          aspectRatio: input.image?.aspectRatio,
          images: input.image?.inputs?.images ?? [],
          // BL-194: only when given, so a job asked for before video numbers keeps its hash.
          ...(input.videoNumber ? { videoNumber: input.videoNumber } : {}),
        }
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
          // BL-184: only when given, so a job asked for before the storyboards keeps its hash (a replay still matches).
          ...(input.storyboardId ? { storyboardId: input.storyboardId, segmentId: input.segmentId } : {}),
          ...(input.videoNumber ? { videoNumber: input.videoNumber } : {}),
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

  /** BL-194: the video a new job is made for (see `GeminiVideoLink`); without the port a given number is refused. */
  async function resolveVideo(input: { channelId: string; videoNumber: string | null; storyboardId: string | null }): Promise<string | null> {
    if (deps.videoLink) return deps.videoLink.resolve(input);
    if (input.videoNumber) throw new DomainError({ code: "video_not_found", message: "Video numbers are not available on this server", details: { videoNumber: input.videoNumber } });
    return null;
  }

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
    if (!key) throw new DomainError({ code: "encryption_key_not_configured", message: "The Gemini key file is missing on this computer; enter the API key again (Settings → Cloud APIs)." });
    try {
      return decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag }, key);
    } catch {
      throw new DomainError({ code: "encryption_key_not_configured", message: "The stored Gemini API key cannot be decrypted with this computer's key file; enter it again (Settings → Cloud APIs)." });
    }
  }

  // BL-193: the fingerprint of the stored key, recomputed only when the stored key changes (its ciphertext).
  let fingerprintCache: { ciphertext: string; value: string } | null = null;
  /** The stored key's fingerprint (ADR 0039), or null when no usable key is stored here (then nothing is shared). Never throws. */
  async function keyFingerprint(): Promise<string | null> {
    try {
      const row = await deps.store.getCredentials();
      if (!row) return null;
      if (fingerprintCache?.ciphertext === row.ciphertext) return fingerprintCache.value;
      const apiKey = await readApiKey();
      if (!apiKey) return null;
      const value = geminiKeyFingerprint(apiKey);
      fingerprintCache = { ciphertext: row.ciphertext, value };
      return value;
    } catch {
      return null;
    }
  }

  /** BL-193: the same-key computers' spend added to this computer's (`local`); the others count 0 when they cannot be read. */
  async function accountSpend(local: { todayUsd: number; monthUsd: number }, at: Date): Promise<GeminiSpend["account"]> {
    const fingerprint = await keyFingerprint();
    let others: ReturnType<typeof accountWideSpend> = { otherTodayUsd: 0, otherMonthUsd: 0, otherComputers: [] };
    if (fingerprint && deps.peerSpendReports) {
      try {
        const [peers, device] = await Promise.all([deps.peerSpendReports(), deps.device()]);
        others = accountWideSpend({ peers, ownDeviceId: device.deviceId, ownFingerprint: fingerprint, dayStart: startOfLocalDay(at), monthStart: startOfLocalMonth(at), now: at });
      } catch (error) {
        deps.log?.(`[gemini-media] other computers' Gemini spend unknown, counted as 0: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { todayUsd: round4(local.todayUsd + others.otherTodayUsd), monthUsd: round4(local.monthUsd + others.otherMonthUsd), keyKnown: fingerprint !== null, otherComputers: others.otherComputers };
  }

  type CheckedGeminiKey = { apiKey: string; status: "ok" | "payment_required" };
  /** The key's format, then one free call to Google: a refused key throws; an empty prepaid balance (402) is accepted with its status. */
  async function checkKeyForImport(input: unknown): Promise<CheckedGeminiKey> {
    const { apiKey } = parseWithSchema(setKeyInputSchema, input, "Gemini API key");
    let status: "ok" | "payment_required" = "ok";
    try {
      await deps.api.checkKey(apiKey);
    } catch (error) {
      if (!(isDomainError(error) && error.code === "gemini_payment_required")) throw error;
      status = "payment_required";
    }
    return { apiKey, status };
  }
  async function storeCheckedKey(checked: CheckedGeminiKey): Promise<GeminiKeyView> {
    const { apiKey } = parseWithSchema(setKeyInputSchema, { apiKey: checked.apiKey }, "Gemini API key");
    const key = await deps.keyFile.readOrCreateKey();
    const sealed = encryptSecret(apiKey, key);
    await deps.store.upsertCredentials({ ...sealed, keyHint: apiKey.slice(-4), status: checked.status, verifiedAt: now() });
    return keyViewOf(await deps.store.getCredentials());
  }

  async function spend(at: Date = now()): Promise<GeminiSpend> {
    const local = await localSpend(at);
    return { ...local, account: await accountSpend(local, at) };
  }

  /** This computer's own spend (what its spend report publishes for the others). */
  async function localSpend(at: Date = now()): Promise<Omit<GeminiSpend, "account">> {
    const dayStart = startOfLocalDay(at);
    const [thisMonth, active] = await Promise.all([
      deps.store.listJobs({ createdSince: startOfLocalMonth(at), limit: 100_000 }),
      deps.store.listJobs({ statuses: GEMINI_ACTIVE_STATUSES, limit: 100_000 }),
    ]);
    const isActive = (row: StoredGeminiMediaJob) => (GEMINI_ACTIVE_STATUSES as readonly string[]).includes(row.status);
    // An active job reserves its estimate -- or, once Google's counts are in (an Omni video still being downloaded, BL-179), what
    // it cost; a finished one counts what it cost (0 when Google charged nothing).
    const amount = (row: StoredGeminiMediaJob) => (isActive(row) ? (row.costUsd ?? row.estimateUsd) : (row.costUsd ?? 0));
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
    // BL-193 (ADR 0039): the daily and monthly limits hold for the key -- every computer on it -- not for this computer alone.
    const today = current.account.todayUsd;
    const month = current.account.monthUsd;
    const otherToday = round4(today - current.todayUsd);
    const otherMonth = round4(month - current.monthUsd);
    const elsewhere = (amount: number) => (amount > 0 ? ` ($${amount} of it on your other computers)` : "");
    if (round4(today + estimateUsd) > settings.maxUsdPerDay) {
      return refuse("per_day", `$${today} spent or reserved today${elsewhere(otherToday)} + $${estimateUsd} is over the daily limit $${settings.maxUsdPerDay}.`, { limitUsd: settings.maxUsdPerDay, spentUsd: today, ...(otherToday > 0 ? { otherComputersUsd: otherToday } : {}) });
    }
    if (round4(month + estimateUsd) > settings.maxUsdPerMonth) {
      return refuse("per_month", `$${month} spent or reserved this month${elsewhere(otherMonth)} + $${estimateUsd} is over the monthly limit $${settings.maxUsdPerMonth}.`, { limitUsd: settings.maxUsdPerMonth, spentUsd: month, ...(otherMonth > 0 ? { otherComputersUsd: otherMonth } : {}) });
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
      const mimeType = ownEntry(GEMINI_INPUT_EXTENSIONS, path.extname(relativePath).slice(1).toLowerCase());
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
      : estimateVideoUsd({ model: input.model, resolution: input.video!.resolution, durationSeconds: input.video!.durationSeconds, promptChars: input.prompt.length, inputImages: inputCount });
  }

  return {
    readApiKey,
    getSettings,
    spend,
    localSpend,
    keyFingerprint,

    async getKey(): Promise<GeminiKeyView> {
      return keyViewOf(await deps.store.getCredentials());
    },

    /** Checks the key with Google first (AC-GM-01): a refused key is never stored; an empty balance (402) is stored with that status. */
    async setKey(input: unknown): Promise<GeminiKeyView> {
      const checked = await checkKeyForImport(input);
      return storeCheckedKey(checked);
    },

    /**
     * BL-193 (ADR 0039 §6): the stored key in clear for the shared cloud-credentials file (`src/lib/cloud-credentials-transfer`,
     * which encrypts it under the owner's password at once), or null when none is stored. Never returned by any route; a key
     * that cannot be decrypted here throws (`encryption_key_not_configured`).
     */
    exportKeyForTransfer: readApiKey,
    /** BL-193: an imported key, validated and checked with Google BEFORE anything is stored (a refused key throws). Stores nothing. */
    checkKeyForImport,
    /** BL-193: stores a key `checkKeyForImport` accepted, exactly like a typed one. */
    storeImportedKey: storeCheckedKey,

    async testKey(): Promise<GeminiKeyView> {
      const row = await deps.store.getCredentials();
      const apiKey = await readApiKey();
      if (!row || !apiKey) throw new DomainError({ code: "gemini_key_missing", message: "No Gemini API key is stored on this computer." });
      let status: "ok" | "payment_required" = "ok";
      try {
        await deps.api.checkKey(apiKey);
      } catch (error) {
        if (!(isDomainError(error) && error.code === "gemini_payment_required")) throw error;
        status = "payment_required";
      }
      // Only the status of the key that was checked: a key saved meanwhile (another tab) is never overwritten (review round 1).
      await deps.store.setCredentialsStatus(row.ciphertext, { status, verifiedAt: now() });
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
          ? { code: "gemini_disabled", message: "Generation through Gemini is turned off on this computer (Settings → Cloud APIs)." }
          : !(await deps.store.getCredentials())
            ? { code: "gemini_key_missing", message: "No Gemini API key is stored on this computer (Settings → Cloud APIs)." }
            : null;
        if (preconditionRefusal && !input.dryRun) throw new DomainError({ code: preconditionRefusal.code, message: preconditionRefusal.message });
        if (!(await deps.isChannelConnected(input.channelId))) {
          throw new DomainError({ code: "gemini_workspace_unavailable", message: `${input.channelId} is not a channel connected on this computer (factory_list_channels).`, details: { channelId: input.channelId } });
        }
        await deps.workspace.resolveOutputRoot(input.channelId);
        const inputs = await readInputs(input.channelId, namedInputs(input));
        // BL-184 stage 2 (FO-REQ-0024 B4): the storyboard gate, with the frames' sha256 just read -- before the estimate, the limits
        // and any charge. A refusal ends a real create here; a dry-run reports it with the estimate (the Operator can probe).
        let storyboard: GeminiStoryboardLink | null = null;
        let storyboardRefusal: GeminiRefusal | null = null;
        if (input.kind === "video") {
          try {
            storyboard = await deps.storyboardGate.check({
              channelId: input.channelId,
              firstFrameSha256: inputs.find((i) => i.role === "first_frame")?.sha256 ?? null,
              lastFrameSha256: inputs.find((i) => i.role === "last_frame")?.sha256 ?? null,
              link: input.storyboardId && input.segmentId ? { storyboardId: input.storyboardId, segmentId: input.segmentId } : null,
            });
          } catch (error) {
            if (!input.dryRun || !isDomainError(error) || error.code !== "storyboard_not_approved") throw error;
            storyboardRefusal = { code: "storyboard_not_approved", message: error.message, details: error.details as Record<string, unknown> | undefined };
          }
        }
        // BL-194 (ADR 0040): the video this job is made for -- given, else its storyboard's. A given number that cannot be linked
        // refuses the job here, before the estimate, the limits and any charge.
        const video = await resolveVideo({ channelId: input.channelId, videoNumber: input.videoNumber ?? null, storyboardId: storyboard?.storyboardId ?? input.storyboardId ?? null });
        const estimateUsd = estimateOf(input, inputs.length);
        // Never compare a non-number against a limit: every comparison with NaN is false, so it would pass all of them.
        if (!Number.isFinite(estimateUsd) || estimateUsd <= 0) throw new DomainError({ code: "gemini_invalid_params", message: "No price is known for these settings.", details: { field: "model" } });
        const current = await spend();
        const refusal = preconditionRefusal ?? storyboardRefusal ?? limitRefusal(settings, current, estimateUsd);
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
          inputsJson: JSON.stringify(inputs.map((i): GeminiJobInput => ({ role: i.role, path: i.path, mimeType: i.mimeType, bytes: i.bytes, sha256: i.sha256 }))),
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
          storyboardId: storyboard?.storyboardId ?? null,
          storyboardVersion: storyboard?.versionNumber ?? null,
          segmentId: storyboard?.segmentId ?? null,
          video,
        };
        if (!(await deps.store.insertJob(row))) {
          // Only a concurrent create with the same request id can get here (the lock makes it a cross-process race).
          throw new DomainError({ code: "gemini_request_exists", message: `Request id ${input.requestId} was just used.`, details: { requestId: input.requestId } });
        }
        return { job: jobView(row) };
      });
    },

    /** BL-184 stage 3 (B5): the channel's video jobs that render a storyboard's segments (its takes), newest first. */
    async listJobsByStoryboard(channelId: string, storyboardId: string): Promise<GeminiJobView[]> {
      return (await deps.store.listJobs({ channelId, storyboardId, limit: 500 })).map(jobView);
    },

    /**
     * BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.1): this computer's jobs for the shared list -- every unfinished job plus the newest
     * `limit` (all channels), newest first; the shared list cuts it to its own window.
     */
    async listJobsForShare(limit: number): Promise<GeminiJobView[]> {
      const [recent, open] = await Promise.all([deps.store.listJobs({ limit }), deps.store.listJobs({ statuses: GEMINI_ACTIVE_STATUSES, limit: 10_000 })]);
      const byId = new Map<string, StoredGeminiMediaJob>();
      for (const row of [...open, ...recent]) byId.set(row.jobId, row);
      return [...byId.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.jobId < b.jobId ? 1 : -1)).map(jobView);
    },

    /**
     * BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.5): the owner cancels a job that has not been sent to Google yet -- `queued`
     * becomes `failed` (`cancelled_by_owner`, nothing charged) by the same compare-and-set the worker uses to claim it, so a job is
     * either cancelled or sent, never both. Once sent (`submitting`, `running`) Google's work cannot be withdrawn here:
     * `gemini_cancel_too_late`; a finished job is left as it is.
     */
    async cancelJob(jobId: string): Promise<{ job: GeminiJobView }> {
      const row = await deps.store.getJob(jobId);
      if (!row) throw geminiJobNotFound(jobId);
      const at = now();
      const cancelled =
        row.status === "queued" &&
        (await deps.store.updateJob(jobId, "queued", { status: "failed", errorCode: "cancelled_by_owner", error: "Cancelled by the owner before it was sent to Google.", costUsd: 0, costBasis: "not_charged", nextAttemptAt: null, finishedAt: at, updatedAt: at }));
      if (!cancelled) {
        const current = (await deps.store.getJob(jobId)) ?? row;
        throw new DomainError({
          code: "gemini_cancel_too_late",
          message: current.status === "done" || current.status === "failed" ? `Job ${jobId} is already ${current.status}.` : `Job ${jobId} was already sent to Google; it cannot be cancelled now.`,
          details: { jobId, status: current.status },
        });
      }
      const after = await deps.store.getJob(jobId);
      return { job: jobView(after ?? row) };
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
