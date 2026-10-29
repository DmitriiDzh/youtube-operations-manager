import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore } from "@/lib/device-secrets";
import type { StoredGeminiCredentials, StoredGeminiMediaJob } from "@/lib/db";
import {
  GEMINI_IMAGE_TIMEOUT_MS,
  GEMINI_INTERACTIONS_VIDEO_TIMEOUT_MS,
  type GeminiImageRequest,
  type GeminiImageResult,
  type GeminiInteractionsVideoRequest,
  type GeminiInteractionsVideoResult,
  type GeminiSpeechRequest,
  type GeminiSpeechResult,
  type GeminiVoiceDesignRequest,
  type GeminiVoiceDesignResult,
} from "@/lib/media-gateway";
import { ceil4 } from "@/lib/shared-money";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createGeminiFiles } from "./adapters/files";
import { GEMINI_LIMITS, type GeminiPeerSpendReport, type GeminiSpend } from "./contracts";
import { createSerialLock } from "./index";
import { estimateImageUsd, estimateVideoUsd, imageCostFromUsage } from "./pricing";
import { createGeminiMediaServices, type GeminiMediaDeps, type GeminiStore } from "./services";
import { createGeminiWorker } from "./worker";

// BL-174 acceptance criteria (docs/roadmap/plans/GEMINI_MEDIA_PLAN.md §3, AC-GM-01..12). Expected amounts are computed by hand
// from the official price table in §1.1 and the formulas in §2.3, never by running the implementation. Google is a fake that
// records calls; the file system is a real temporary folder (the workspace's `From YTM` and `Sent to YTM`).

const KEY = "AIzaSyTestKey0123456789abcd";

function memoryStore(): GeminiStore & { jobs: Map<string, StoredGeminiMediaJob>; creds: StoredGeminiCredentials | null; settings: string | null } {
  const state = { jobs: new Map<string, StoredGeminiMediaJob>(), creds: null as StoredGeminiCredentials | null, settings: null as string | null };
  return Object.assign(state, {
    async getSettingsJson() {
      return state.settings;
    },
    async setSettingsJson(json: string) {
      state.settings = json;
    },
    async insertJob(row: StoredGeminiMediaJob) {
      if (row.requestId && [...state.jobs.values()].some((j) => j.createdBy === row.createdBy && j.requestId === row.requestId)) return false;
      state.jobs.set(row.jobId, { ...row });
      return true;
    },
    async getJob(jobId: string) {
      return state.jobs.get(jobId) ?? null;
    },
    async getJobByRequest(createdBy: string, requestId: string) {
      return [...state.jobs.values()].find((j) => j.createdBy === createdBy && j.requestId === requestId) ?? null;
    },
    async listJobs(filter: { channelId?: string; statuses?: readonly string[]; createdSince?: Date; storyboardId?: string; limit: number }) {
      return [...state.jobs.values()]
        .filter((j) => (filter.channelId === undefined || j.channelId === filter.channelId) && (filter.statuses === undefined || filter.statuses.includes(j.status)) && (filter.createdSince === undefined || j.createdAt >= filter.createdSince) && (filter.storyboardId === undefined || j.storyboardId === filter.storyboardId))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.jobId < b.jobId ? 1 : -1))
        .slice(0, filter.limit)
        .map((j) => ({ ...j }));
    },
    async updateJob(jobId: string, fromStatus: string, set: Partial<StoredGeminiMediaJob>) {
      const job = state.jobs.get(jobId);
      if (!job || job.status !== fromStatus) return false;
      state.jobs.set(jobId, { ...job, ...set });
      return true;
    },
  });
}

type ApiCall = { method: string; apiKey: string; request?: unknown };

function fakeApi() {
  const calls: ApiCall[] = [];
  const behaviour = {
    checkKey: async (): Promise<void> => undefined,
    generateImage: async (): Promise<GeminiImageResult> => ({
      images: [{ mimeType: "image/png", data: Buffer.from("PNGDATA-1") }],
      usage: { inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: { image: 1680 } },
      status: "completed",
      blockReason: null,
    }),
    // BL-179: an Omni answer -- an 8-second 720p video (5,792 tokens per second), 3,000 input tokens, 500 thought tokens.
    generateVideo: async (): Promise<GeminiInteractionsVideoResult> => ({
      video: { mimeType: "video/mp4", data: Buffer.from("OMNI-MP4") },
      usage: { inputTokens: 3000, outputTokens: 46336, thoughtTokens: 500, outputByModality: { video: 46336 } },
      status: "completed",
      blockReason: null,
    }),
    // BL-236: 20 s of 24 kHz mono 16-bit PCM (960,000 bytes), Google counting 40 input and 300 audio tokens.
    generateSpeech: async (): Promise<GeminiSpeechResult> => ({
      audio: { mimeType: "audio/l16;codec=pcm;rate=24000", data: Buffer.alloc(960_000, 3) },
      usage: { inputTokens: 40, outputTokens: 300, thoughtTokens: 0, outputByModality: { audio: 300 } },
      status: "completed",
      blockReason: null,
    }),
    designVoice: async (): Promise<GeminiVoiceDesignResult> => ({
      voiceId: "voices/voice_designed1",
      sample: { mimeType: "audio/l16;codec=pcm;rate=24000", data: Buffer.alloc(240_000, 5) },
      usage: null,
    }),
    downloadVideo: async (_uri: string, dest: string) => {
      const data = Buffer.from("MP4DATA");
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, data);
      return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    },
  };
  const api = {
    async checkKey(apiKey: string) {
      calls.push({ method: "checkKey", apiKey });
      return behaviour.checkKey();
    },
    async generateImage(apiKey: string, request: GeminiImageRequest) {
      calls.push({ method: "generateImage", apiKey, request });
      return behaviour.generateImage();
    },
    async generateVideo(apiKey: string, request: GeminiInteractionsVideoRequest) {
      calls.push({ method: "generateVideo", apiKey, request });
      return behaviour.generateVideo();
    },
    async downloadVideo(apiKey: string, uri: string, dest: string) {
      calls.push({ method: "downloadVideo", apiKey, request: { uri, dest } });
      return behaviour.downloadVideo(uri, dest);
    },
    async generateSpeech(apiKey: string, request: GeminiSpeechRequest) {
      calls.push({ method: "generateSpeech", apiKey, request });
      return behaviour.generateSpeech();
    },
    async designVoice(apiKey: string, request: GeminiVoiceDesignRequest) {
      calls.push({ method: "designVoice", apiKey, request });
      return behaviour.designVoice();
    },
  };
  return { api, calls, behaviour };
}

function gatewayError(code: "gemini_unavailable" | "gemini_rate_limited" | "gemini_request_rejected" | "gemini_key_invalid" | "gemini_payment_required", details: Record<string, unknown> = {}) {
  return new DomainError({ code, message: `fake ${code}`, details: { outcome: "answered", ...details } });
}

async function harness(options: { now?: Date; enabled?: boolean; withKey?: boolean; settings?: Record<string, unknown>; peerSpendReports?: GeminiMediaDeps["peerSpendReports"] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "gemini-media-"));
  const fromYtm = path.join(root, "ws", "99 Data Exchange", "From YTM");
  const sent = path.join(root, "ws", "99 Data Exchange", "Sent to YTM");
  await mkdir(fromYtm, { recursive: true });
  await mkdir(sent, { recursive: true });
  let keyFileText: string | null = null;
  const keyAccess: KeyFileAccess = {
    async read() {
      return keyFileText;
    },
    async write(content) {
      keyFileText = JSON.stringify(content);
    },
    async remove() {
      keyFileText = null;
    },
    randomBytes: (size) => Buffer.alloc(size, 7),
  };
  const store = memoryStore();
  const secretStore = createMemoryDeviceSecretStore();
  const { api, calls, behaviour } = fakeApi();
  const clock = { at: options.now ?? new Date(2026, 9, 10, 15, 0, 0) };
  const registered: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  const failWrites = { value: false };
  type VideoInput = Parameters<NonNullable<GeminiMediaDeps["videoLink"]>["resolve"]>[0];
  const video = { calls: [] as VideoInput[], answer: (async () => null) as (input: VideoInput) => Promise<string | null> };
  // BL-236: a fake voice registry -- one APPROVED Gemini voice "Sumire" on UC1; anything else is not approved.
  const voiceCalls: Array<{ channelId: string; provider: string; voice: string }> = [];
  const gate = {
    calls: [] as Array<Parameters<GeminiMediaDeps["storyboardGate"]["check"]>[0]>,
    answer: (async () => null) as (input: Parameters<GeminiMediaDeps["storyboardGate"]["check"]>[0]) => Promise<Awaited<ReturnType<GeminiMediaDeps["storyboardGate"]["check"]>>>,
  };
  let id = 0;
  const files = createGeminiFiles();
  const deps: GeminiMediaDeps = {
    store,
    api,
    // BL-199 (ADR 0042): the key lives in the shared device-secret store; here an in-memory one over this harness's key file.
    secret: createDeviceSecrets({ store: secretStore, keyFile: createKeyFile(keyAccess, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })) }).slot("gemini"),
    workspace: {
      async resolveOutputRoot(channelId) {
        if (channelId === "UC_NOWS") throw new DomainError({ code: "gemini_workspace_unavailable", message: "no workspace" });
        return fromYtm;
      },
      async resolveInput(_channelId, relativePath) {
        if (relativePath.includes("..") || relativePath.startsWith("/")) throw new DomainError({ code: "gemini_input_unavailable", message: "not relative", details: { path: relativePath } });
        const full = path.join(sent, relativePath);
        const info = await stat(full).catch(() => null);
        if (!info) throw new DomainError({ code: "gemini_input_unavailable", message: "missing", details: { path: relativePath } });
        return { path: full, bytes: info.size, identity: { dev: info.dev, ino: info.ino } };
      },
    },
    files: {
      readInput: (file, max) => files.readInput(file, max),
      writeOutput: async (p, data) => {
        order.push(`write ${path.basename(p)}`);
        if (failWrites.value) throw new Error("disk full");
        return files.writeOutput(p, data);
      },
      writeManifest: async (p, m) => {
        order.push("manifest");
        return files.writeManifest(p, m);
      },
    },
    assets: {
      async register(input) {
        registered.push(input);
        return { assetId: `asset-${registered.length}` };
      },
      async findByLocalPath() {
        return null;
      },
    },
    device: async () => ({ deviceId: "dev-1", hostname: "mac" }),
    isChannelConnected: async (channelId) => channelId !== "UC_GONE",
    isGatewayEnabled: async () => true,
    clock: { now: () => new Date(clock.at) },
    generateId: () => `id${++id}`,
    // The module's own lock (review round 1: the concurrency test must exercise the real one).
    withCreateLock: createSerialLock(),
    // BL-184 stage 2: a fake storyboard gate that records what it was asked and answers as the test sets it (the real gate is
    // tested in src/lib/storyboards/gate.test.ts).
    storyboardGate: {
      async check(input) {
        gate.calls.push(input);
        return gate.answer(input);
      },
    },
    // BL-194: a fake video link that records what it was asked (the real rule is tested in src/lib/video-projects).
    videoLink: {
      async resolve(input) {
        video.calls.push(input);
        return video.answer(input);
      },
    },
    voices: {
      async resolve(input) {
        voiceCalls.push(input);
        if (input.channelId === "UC1" && (input.voice === "Sumire" || input.voice === "vc_sumire")) return { voiceId: "vc_sumire", name: "Sumire", providerVoiceId: "voices/voice_sumire" };
        throw new DomainError({ code: "voice_not_approved", message: `No approved gemini voice ${input.voice} on ${input.channelId}.`, details: { voice: input.voice } });
      },
    },
    // BL-193: the other computers' spend reports, when a test sets them.
    ...(options.peerSpendReports ? { peerSpendReports: options.peerSpendReports, log: () => undefined } : {}),
  };
  const services = createGeminiMediaServices(deps);
  const worker = createGeminiWorker(deps);
  if (options.withKey !== false) {
    await services.setKey({ apiKey: KEY });
    calls.length = 0;
  }
  await services.updateSettings({ enabled: options.enabled ?? true, maxUsdPerJob: 10, maxUsdPerDay: 20, maxUsdPerMonth: 100, ...(options.settings ?? {}) });
  const runTick = async () => Promise.all(await worker.tick());
  return {
    root,
    fromYtm,
    sent,
    store,
    calls,
    behaviour,
    clock,
    registered,
    order,
    services,
    worker,
    runTick,
    gate,
    video,
    voiceCalls,
    keyFileText: () => keyFileText,
    storedKey: () => secretStore.rows.get("gemini") ?? null,
    failWrites,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(isDomainError(error), String(error));
    assert.equal(error.code, code, error.message);
    return (error.details ?? {}) as Record<string, unknown>;
  }
  assert.fail(`expected ${code}`);
}

const imageJob = (overrides: Record<string, unknown> = {}) => ({
  channelId: "UC1",
  kind: "image",
  model: "gemini-nano-banana-2.1",
  prompt: "a".repeat(300),
  image: { size: "2K", aspectRatio: "16:9" },
  ...overrides,
});

// Changed 2026-10-17 (BL-180), with justification (AGENTS.md §L): this default was Veo 3.1 Fast 1080p 8 s ($0.96); Google shuts
// the Veo previews down on 2026-10-22 and the owner had them removed (msg 2902), so the default is the one video model left:
// Omni 1080p 4 s, "waves" -- 13,032 x 4 = 52,128 tokens x $17.50/1M = $0.91224 + 2 input tokens x $1.50/1M + 2,000 thinking
// tokens x $9/1M = $0.930243 -> $0.9303 (the BL-179 review figure below). Each limit test keeps its own meaning with it.
const videoJob = (overrides: Record<string, unknown> = {}) => ({
  channelId: "UC1",
  kind: "video",
  model: "gemini-omni-1.1-flash",
  prompt: "waves",
  video: { resolution: "1080p", aspectRatio: "16:9", durationSeconds: 4 },
  ...overrides,
});

function seedJob(store: ReturnType<typeof memoryStore>, jobId: string, fields: Partial<StoredGeminiMediaJob>) {
  const at = fields.createdAt ?? new Date(2026, 9, 10, 9, 0, 0);
  store.jobs.set(jobId, {
    jobId,
    channelId: "UC1",
    requestId: null,
    requestHash: "x",
    kind: "image",
    model: "gemini-nano-banana-2.1",
    prompt: "p",
    paramsJson: JSON.stringify({ size: "1K", aspectRatio: "1:1" }),
    inputsJson: "[]",
    status: "done",
    remoteName: null,
    estimateUsd: 0,
    costUsd: 0,
    costBasis: "usage",
    outputsJson: null,
    error: null,
    errorCode: null,
    attempts: 1,
    nextAttemptAt: null,
    createdBy: "factory",
    createdAt: at,
    submittedAt: at,
    finishedAt: at,
    updatedAt: at,
    storyboardId: null,
    storyboardVersion: null,
    segmentId: null,
    video: null,
    ...fields,
  });
}

// ---------------------------------------------------------------------------------------------------------------- AC-GM-03

test("AC-GM-03: estimates from the price table (hand-computed)", () => {
  // 1680×30e-6 + ceil(300/3)×1.5e-6 + 2000×7.5e-6 = 0.0504 + 0.00015 + 0.015 = 0.06555 → 0.0656
  assert.equal(estimateImageUsd({ model: "gemini-nano-banana-2.1", size: "2K", promptChars: 300, inputImages: 0 }), 0.0656);
  // 1120×30e-6 + (10 + 1120)×0.25e-6 + 2000×1.5e-6 = 0.0336 + 0.0002825 + 0.003 = 0.0368825 → 0.0369
  assert.equal(estimateImageUsd({ model: "gemini-3.1-flash-lite-image", size: "1K", promptChars: 30, inputImages: 1 }), 0.0369);
  // 2000×120e-6 + 10×2e-6 + 2000×12e-6 = 0.24 + 0.00002 + 0.024 = 0.26402 → 0.2641
  assert.equal(estimateImageUsd({ model: "gemini-3-pro-image", size: "4K", promptChars: 30, inputImages: 0 }), 0.2641);
  // BL-180: the Veo table lines went with the Veo previews. Omni 720p 4 s: 5,792 x 4 = 23,168 x $17.50/1M = $0.40544 + 2 input
  // tokens x $1.50/1M + 2,000 x $9/1M = $0.423443 -> $0.4235; 6 s: 34,752 x $17.50/1M = $0.60816 + $0.018003 = $0.626163 -> $0.6262.
  assert.equal(estimateVideoUsd({ model: "gemini-omni-1.1-flash", resolution: "720p", durationSeconds: 4, promptChars: 5, inputImages: 0 }), 0.4235);
  assert.equal(estimateVideoUsd({ model: "gemini-omni-1.1-flash", resolution: "720p", durationSeconds: 6, promptChars: 5, inputImages: 0 }), 0.6262);
  // AC-GM-07's usage: 1000×1.5e-6 + 1680×30e-6 + 300×7.5e-6 = 0.0015 + 0.0504 + 0.00225 = 0.05415 → 0.0542
  assert.equal(imageCostFromUsage("gemini-nano-banana-2.1", { inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: { image: 1680 } }), 0.0542);
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-01

test("AC-GM-01: a key is checked with Google, stored encrypted, shown only by its last 4 characters, and removed (the shared key file stays, BL-199)", async () => {
  const h = await harness({ withKey: false });
  try {
    const view = await h.services.setKey({ apiKey: KEY });
    assert.deepEqual(h.calls.map((c) => [c.method, c.apiKey]), [["checkKey", KEY]]);
    assert.deepEqual([view.configured, view.keyHint, view.status], [true, "abcd", "ok"]);
    assert.ok(!JSON.stringify(view).includes(KEY.slice(0, 10)), "the view never carries the key");
    const stored = h.storedKey();
    assert.ok(stored && !stored.ciphertext.includes(KEY) && !Buffer.from(stored.ciphertext, "base64").toString("utf8").includes(KEY), "stored encrypted");
    assert.ok(h.keyFileText(), "the key file was created");
    assert.equal(await h.services.readApiKey(), KEY);
    assert.ok(!JSON.stringify(await h.services.getStatus()).includes(KEY.slice(0, 10)));
    await h.services.clearKey();
    assert.equal(h.storedKey(), null);
    // BL-199 changed this (ADR 0042 §4, owner msg 3007): the key file is now shared by every secret of this computer, so clearing
    // the Gemini key keeps it (the RunPod rule, AC-P14-21); only the key's row goes.
    assert.ok(h.keyFileText(), "the shared key file stays");
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-01: a key Google refuses is never stored; a key with an empty balance (402) is stored with that status", async () => {
  const h = await harness({ withKey: false });
  try {
    h.behaviour.checkKey = async () => {
      throw gatewayError("gemini_key_invalid", { status: 400 });
    };
    await expectCode(h.services.setKey({ apiKey: KEY }), "gemini_key_invalid");
    assert.equal(h.storedKey(), null);
    assert.equal(h.keyFileText(), null, "no key file for a refused key");
    h.behaviour.checkKey = async () => {
      throw gatewayError("gemini_payment_required", { status: 402 });
    };
    const view = await h.services.setKey({ apiKey: KEY });
    assert.equal(view.status, "payment_required");
    await expectCode(h.services.setKey({ apiKey: "short" }), "validation_failed");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-02

test("AC-GM-02: off by default -- a create is refused with gemini_disabled and nothing reaches Google; on without a key → gemini_key_missing", async () => {
  const h = await harness({ withKey: false });
  try {
    await h.services.updateSettings({ enabled: false });
    assert.equal((await h.services.getSettings()).enabled, false);
    const fresh = createGeminiMediaServices({ ...({} as GeminiMediaDeps), store: memoryStore() });
    assert.equal((await fresh.getSettings()).enabled, false, "the default is off");
    await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_disabled");
    await h.services.updateSettings({ enabled: true });
    await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_key_missing");
    assert.equal(h.store.jobs.size, 0);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-04

test("AC-GM-04: a request over the day's limit is refused naming it; a dry-run answers the same and stores nothing", async () => {
  const h = await harness({ settings: { maxUsdPerDay: 5 } });
  try {
    seedJob(h.store, "gm_today", { costUsd: 4.5 });
    seedJob(h.store, "gm_yesterday", { createdAt: new Date(2026, 9, 9, 23, 0, 0), costUsd: 4.5 });
    const dry = (await h.services.createJob({ ...videoJob(), dryRun: true }, "factory")) as Record<string, unknown>;
    assert.deepEqual([dry.estimateUsd, dry.allowed], [0.9303, false]);
    assert.deepEqual((dry.refusal as { details: unknown }).details, { limit: "per_day", limitUsd: 5, spentUsd: 4.5, estimateUsd: 0.9303 });
    assert.equal(h.store.jobs.size, 2, "a dry-run stores nothing");
    const details = await expectCode(h.services.createJob(videoJob(), "factory"), "gemini_limit_exceeded");
    assert.deepEqual(details, { limit: "per_day", limitUsd: 5, spentUsd: 4.5, estimateUsd: 0.9303 });
    const spend = await h.services.spend();
    assert.deepEqual([spend.todayUsd, spend.monthUsd], [4.5, 9], "yesterday's job counts toward the month only");
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- BL-193
// ADR 0039 (owner msgs 2864/2867): the daily and monthly limits hold for the KEY -- every computer that reports the same key
// fingerprint adds its spend -- and a computer with another key, its own stale-or-not report, or reports that cannot be read
// never block a job. The fingerprint is the spec's HMAC-SHA256 under the fixed label, computed here independently.

const fingerprintOf = (apiKey: string) => createHmac("sha256", "ytm/gemini-key-fingerprint/v1").update(apiKey, "utf8").digest("hex").slice(0, 32);
const peerReport = (fields: Partial<GeminiPeerSpendReport>): GeminiPeerSpendReport => ({
  deviceId: "dev-2",
  hostname: "pc",
  keyFingerprint: fingerprintOf(KEY),
  updatedAt: new Date(2026, 9, 10, 14, 0, 0).toISOString(),
  spentTodayUsd: 0,
  spentMonthUsd: 0,
  ...fields,
});

test("BL-193: another computer on the same key counts toward the daily limit -- a job that fits this computer's spend alone is refused", async () => {
  // Local today $2 + the other computer's $3.5 + the estimate $0.0656 = $5.5656 > $5.55; locally alone $2.0656 would fit.
  const h = await harness({ settings: { maxUsdPerDay: 5.55 }, peerSpendReports: async () => [peerReport({ spentTodayUsd: 3.5, spentMonthUsd: 3.5 })] });
  try {
    seedJob(h.store, "gm_today", { costUsd: 2 });
    const dry = (await h.services.createJob({ ...imageJob(), dryRun: true }, "factory")) as { allowed: boolean; refusal: { details: unknown }; spend: GeminiSpend };
    assert.equal(dry.allowed, false);
    assert.deepEqual(dry.refusal.details, { limit: "per_day", limitUsd: 5.55, spentUsd: 5.5, otherComputersUsd: 3.5, estimateUsd: 0.0656 });
    assert.deepEqual([dry.spend.todayUsd, dry.spend.account.todayUsd, dry.spend.account.monthUsd, dry.spend.account.keyKnown], [2, 5.5, 5.5, true]);
    assert.deepEqual(dry.spend.account.otherComputers.map((p) => [p.deviceId, p.todayUsd, p.monthUsd]), [["dev-2", 3.5, 3.5]]);
    await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_limit_exceeded");
    assert.equal(h.store.jobs.size, 1, "nothing was created");
  } finally {
    await h.cleanup();
  }
});

test("BL-193: the monthly limit adds the other computers' month; a report from earlier in the month counts toward the month, not today", async () => {
  // The other computer last reported on Oct 2: $50 "today" then (not today now), $90 this month. Local month $2.
  // Month: $2 + $90 + $0.0656 = $92.0656 > $92 → refused; today stays $2.
  const h = await harness({ settings: { maxUsdPerDay: 100, maxUsdPerMonth: 92 }, peerSpendReports: async () => [peerReport({ updatedAt: new Date(2026, 9, 2, 12, 0, 0).toISOString(), spentTodayUsd: 50, spentMonthUsd: 90 })] });
  try {
    seedJob(h.store, "gm_today", { costUsd: 2 });
    const details = await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_limit_exceeded");
    assert.deepEqual(details, { limit: "per_month", limitUsd: 92, spentUsd: 92, otherComputersUsd: 90, estimateUsd: 0.0656 });
    const spend = await h.services.spend();
    assert.deepEqual([spend.account.todayUsd, spend.account.monthUsd], [2, 92]);
  } finally {
    await h.cleanup();
  }
});

test("BL-193: another key, this computer's own report, and unreadable reports never count; without a key nothing is matched", async () => {
  const otherKey = await harness({
    settings: { maxUsdPerDay: 5.55 },
    peerSpendReports: async () => [peerReport({ keyFingerprint: fingerprintOf("AIzaSyAnotherKey9876543210zz"), spentTodayUsd: 3.5 }), peerReport({ deviceId: "dev-1", spentTodayUsd: 3.5 })],
  });
  try {
    seedJob(otherKey.store, "gm_today", { costUsd: 2 });
    const dry = (await otherKey.services.createJob({ ...imageJob(), dryRun: true }, "factory")) as { allowed: boolean; spend: GeminiSpend };
    assert.equal(dry.allowed, true);
    assert.deepEqual([dry.spend.account.todayUsd, dry.spend.account.otherComputers.length], [2, 0]);
  } finally {
    await otherKey.cleanup();
  }
  const unreadable = await harness({
    settings: { maxUsdPerDay: 5.55 },
    peerSpendReports: async () => {
      throw new Error("share folder unreadable");
    },
  });
  try {
    seedJob(unreadable.store, "gm_today", { costUsd: 2 });
    const dry = (await unreadable.services.createJob({ ...imageJob(), dryRun: true }, "factory")) as { allowed: boolean; spend: GeminiSpend };
    assert.deepEqual([dry.allowed, dry.spend.account.todayUsd, dry.spend.account.keyKnown], [true, 2, true]);
  } finally {
    await unreadable.cleanup();
  }
  const noKey = await harness({ withKey: false, peerSpendReports: async () => [peerReport({ spentTodayUsd: 3.5 })] });
  try {
    const spend = await noKey.services.spend();
    assert.deepEqual([spend.account.keyKnown, spend.account.todayUsd, spend.account.otherComputers.length], [false, 0, 0]);
    assert.equal(await noKey.services.keyFingerprint(), null);
  } finally {
    await noKey.cleanup();
  }
});

test("BL-193: the published fingerprint is the key's HMAC under the fixed label -- never the key, its tail, or its plain SHA-256", async () => {
  const h = await harness();
  try {
    const fingerprint = await h.services.keyFingerprint();
    assert.equal(fingerprint, fingerprintOf(KEY));
    assert.match(fingerprint ?? "", /^[0-9a-f]{32}$/);
    assert.ok(!fingerprint!.includes(KEY), "the key never appears in its fingerprint");
    assert.notEqual(fingerprint, createHash("sha256").update(KEY).digest("hex").slice(0, 32));
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-04: an active job counts with its estimate; per-job, per-month and active-job limits each name themselves", async () => {
  const h = await harness({ settings: { maxUsdPerJob: 0.5, maxUsdPerDay: 100, maxUsdPerMonth: 1, maxActiveJobs: 2 } });
  try {
    assert.equal(((await expectCode(h.services.createJob(videoJob(), "factory"), "gemini_limit_exceeded")) as { limit: string }).limit, "per_job");
    seedJob(h.store, "gm_running", { kind: "video", status: "running", estimateUsd: 0.96, costUsd: null, costBasis: null });
    assert.equal((await h.services.spend()).activeUsd, 0.96);
    const month = await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_limit_exceeded");
    assert.deepEqual([month.limit, month.spentUsd, month.estimateUsd], ["per_month", 0.96, 0.0656]);
    await h.services.updateSettings({ maxUsdPerMonth: 100 });
    seedJob(h.store, "gm_queued", { status: "queued", estimateUsd: 0.05, costUsd: null, costBasis: null });
    const active = await expectCode(h.services.createJob(imageJob(), "factory"), "gemini_limit_exceeded");
    assert.deepEqual([active.limit, active.activeJobs], ["active_jobs", 2]);
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-04: two concurrent creates that each fit the day's limit alone but not together → exactly one job", async () => {
  const h = await harness({ settings: { maxUsdPerDay: 1.5 } });
  try {
    const results = await Promise.allSettled([h.services.createJob(videoJob(), "factory"), h.services.createJob(videoJob(), "factory")]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(h.store.jobs.size, 1);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-05

test("AC-GM-05: per-model rules refuse with gemini_invalid_params naming the field, before anything is stored", async () => {
  const h = await harness();
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [imageJob({ model: "gemini-3.1-flash-lite-image", image: { size: "2K", aspectRatio: "1:1" } }), "image.size"],
      [imageJob({ image: { size: "2k", aspectRatio: "1:1" } }), "image.size"],
      [imageJob({ image: { size: "1K", aspectRatio: "7:5" } }), "image.aspectRatio"],
      // Changed 2026-10-17 (BL-180, AGENTS.md §L): the Veo-only cases (4k, 1080p needing 8 s, reference images on 4 s) went with
      // the Veo previews; a Veo id is now refused as a model.
      [imageJob({ model: "gemini-omni-1.1-flash" }), "model"],
      [videoJob({ model: "veo-3.1-fast-generate-preview" }), "model"],
      [videoJob({ video: { resolution: "4k", aspectRatio: "16:9", durationSeconds: 8 } }), "video.resolution"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "1:1", durationSeconds: 4 } }), "video.aspectRatio"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 5 } }), "video.durationSeconds"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { lastFrame: "a.png" } } }), "video.inputs.lastFrame"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { referenceImages: ["a.png"] } } }), "video.inputs.referenceImages"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { firstFrame: "a.png", referenceImages: ["b.png"] } } }), "video.inputs.referenceImages"],
      [videoJob({ prompt: "x".repeat(4001) }), "prompt"],
      [{ ...videoJob(), image: { size: "1K", aspectRatio: "1:1" } }, "image"],
    ];
    for (const [input, field] of cases) {
      const details = await expectCode(h.services.createJob(input, "factory"), "gemini_invalid_params");
      assert.equal(details.field, field, JSON.stringify(input));
    }
    await expectCode(h.services.createJob({ ...imageJob(), extra: 1 }, "factory"), "validation_failed");
    await expectCode(h.services.createJob(imageJob({ channelId: "UC_GONE" }), "factory"), "gemini_workspace_unavailable");
    await expectCode(h.services.createJob(imageJob({ channelId: "UC_NOWS" }), "factory"), "gemini_workspace_unavailable");
    assert.equal(h.store.jobs.size, 0);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-06

test("AC-GM-06: inputs must be png/jpg/jpeg/webp files in Sent to YTM, ≤ 7 MB each and ≤ 12 MB together; nothing is stored or sent otherwise", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.sent, "anim.gif"), "GIF89a");
    await writeFile(path.join(h.sent, "big.png"), Buffer.alloc(7 * 1024 * 1024 + 1));
    await writeFile(path.join(h.sent, "a.png"), Buffer.alloc(6 * 1024 * 1024, 1));
    await writeFile(path.join(h.sent, "b.png"), Buffer.alloc(6 * 1024 * 1024 + 1, 2));
    for (const images of [["../x.png"], ["/abs.png"], ["missing.png"], ["anim.gif"], ["big.png"], ["a.png", "b.png"]]) {
      await expectCode(h.services.createJob(imageJob({ image: { size: "1K", aspectRatio: "1:1", inputs: { images } } }), "factory"), "gemini_input_unavailable");
    }
    assert.equal(h.store.jobs.size, 0);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-06: an input changed between create and run fails the job (gemini_input_changed, cost 0) with no call to Google", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.sent, "ref.jpg"), "first version");
    const { job } = (await h.services.createJob(imageJob({ image: { size: "1K", aspectRatio: "1:1", inputs: { images: ["ref.jpg"] } } }), "factory")) as { job: { jobId: string; inputs: Array<{ sha256: string }> } };
    assert.equal(job.inputs[0].sha256, createHash("sha256").update("first version").digest("hex"));
    await writeFile(path.join(h.sent, "ref.jpg"), "edited afterwards");
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_input_changed", 0, "not_charged"]);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-07

test("AC-GM-07: an image job makes one call, writes the image under From YTM/gemini/<jobId>/, registers it, writes the manifest last, costs Google's counts", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.sent, "ref.webp"), "REF");
    const { job } = (await h.services.createJob(imageJob({ image: { size: "2K", aspectRatio: "16:9", inputs: { images: ["ref.webp"] } } }), "factory")) as { job: { jobId: string; status: string; estimateUsd: number } };
    assert.equal(job.status, "queued");
    // 1680×30e-6 + (100 + 1120)×1.5e-6 + 2000×7.5e-6 = 0.0504 + 0.00183 + 0.015 = 0.06723 → 0.0673
    assert.equal(job.estimateUsd, 0.0673);
    await h.runTick();
    assert.equal(h.calls.length, 1);
    const request = h.calls[0].request as GeminiImageRequest;
    assert.deepEqual([h.calls[0].method, h.calls[0].apiKey, request.model, request.aspectRatio, request.imageSize], ["generateImage", KEY, "gemini-nano-banana-2.1", "16:9", "2K"]);
    assert.deepEqual(request.images, [{ mimeType: "image/webp", dataBase64: Buffer.from("REF").toString("base64") }]);
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costUsd, row.costBasis, row.errorCode], ["done", 0.0542, "usage", null]);
    const dir = path.join(h.fromYtm, "gemini", job.jobId);
    assert.deepEqual(await readFile(path.join(dir, "image-1.png")), Buffer.from("PNGDATA-1"));
    const outputs = JSON.parse(row.outputsJson!);
    assert.deepEqual(outputs, [
      { path: `gemini/${job.jobId}/image-1.png`, localPath: path.join(dir, "image-1.png"), kind: "image", mimeType: "image/png", bytes: 9, sha256: createHash("sha256").update("PNGDATA-1").digest("hex"), assetId: "asset-1", note: null },
    ]);
    assert.deepEqual(h.order, ["write image-1.png", "manifest"], "the manifest is written after the files");
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.deepEqual([manifest.schema, manifest.schemaVersion, manifest.jobId, manifest.status, manifest.costUsd, manifest.costBasis, manifest.device.deviceId], ["ytm.gemini-job-manifest", 1, job.jobId, "done", 0.0542, "usage", "dev-1"]);
    assert.ok(!JSON.stringify(manifest).includes(KEY), "no key in the manifest");
    assert.equal(manifest.submittedAt, row.submittedAt?.toISOString(), "the submission time, as the job shows it (FO-MSG-0016)");
    assert.notEqual(manifest.submittedAt, null);
    assert.deepEqual([h.registered[0].assetType, h.registered[0].referenceKind, h.registered[0].referenceValue], ["generated_image", "local_path", path.join(dir, "image-1.png")]);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-08

// BL-180 (AGENTS.md §L): this criterion's Veo operation flow (start, poll, download at the table price) went with the Veo
// previews (owner, msg 2902). Omni's one-call flow and its link-delivered download are proven by the BL-179 tests below.

// ---------------------------------------------------------------------------------------------------------------- AC-GM-09

test("AC-GM-09: Google's refusals end the job at no cost, each with its own code", async () => {
  const cases: Array<[unknown, string]> = [
    [gatewayError("gemini_request_rejected", { blocked: true, googleCode: "image_safety", status: 400 }), "gemini_blocked"],
    [gatewayError("gemini_request_rejected", { blocked: false, status: 400 }), "gemini_invalid_request"],
    [gatewayError("gemini_payment_required", { status: 402 }), "gemini_payment_required"],
    [gatewayError("gemini_key_invalid", { status: 401 }), "gemini_key_invalid"],
  ];
  for (const [error, code] of cases) {
    const h = await harness();
    try {
      h.behaviour.generateImage = async () => {
        throw error;
      };
      const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
      await h.runTick();
      const row = h.store.jobs.get(job.jobId)!;
      assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis, row.attempts], ["failed", code, 0, "not_charged", 1], code);
    } finally {
      await h.cleanup();
    }
  }
});

test("AC-GM-09: an answer with no image is gemini_blocked; Google's own counts (input, thinking) are what it cost", async () => {
  const h = await harness();
  try {
    h.behaviour.generateImage = async () => ({ images: [], usage: { inputTokens: 100, outputTokens: 0, thoughtTokens: 200, outputByModality: {} }, status: "failed", blockReason: "image_safety" });
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    // 100×1.5e-6 + 200×7.5e-6 = 0.00015 + 0.0015 = 0.00165 → 0.0017
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_blocked", 0.0017, "usage"]);
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-09: 429 / a connection that never reached Google is retried with backoff; after the 3rd attempt the job fails at no cost", async () => {
  const h = await harness();
  try {
    let n = 0;
    h.behaviour.generateImage = async () => {
      n += 1;
      throw n === 2 ? gatewayError("gemini_unavailable", { outcome: "not_sent" }) : gatewayError("gemini_rate_limited", { status: 429 });
    };
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    let row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt?.getTime()], ["queued", 1, h.clock.at.getTime() + 30_000]);
    await h.runTick();
    assert.equal(n, 1, "not before its backoff");
    h.clock.at = new Date(h.clock.at.getTime() + 30_000);
    await h.runTick();
    row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.attempts, row.nextAttemptAt?.getTime()], ["queued", 2, h.clock.at.getTime() + 120_000]);
    h.clock.at = new Date(h.clock.at.getTime() + 120_000);
    await h.runTick();
    row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis, row.attempts], ["failed", "gemini_rate_limited", 0, "not_charged", 3]);
  } finally {
    await h.cleanup();
  }
});

test("AC-GM-09: a request that was sent and then timed out is gemini_timeout at its estimate (unknown outcome), never retried", async () => {
  const h = await harness();
  try {
    h.behaviour.generateImage = async () => {
      throw gatewayError("gemini_unavailable", { outcome: "unknown", timedOut: true });
    };
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis, row.attempts], ["failed", "gemini_timeout", 0.0656, "unknown_outcome", 1]);
    assert.equal((await h.services.spend()).todayUsd, 0.0656, "counted toward the limits");
  } finally {
    await h.cleanup();
  }
});

// BL-180: the "finished Veo operation with an error" case went with Veo; an Omni block is the BL-179 test below.

// ---------------------------------------------------------------------------------------------------------------- AC-GM-10

const OMNI_LINK = "https://generativelanguage.googleapis.com/v1beta/files/f9:download?alt=media";

test("AC-GM-10: at startup a job cut mid-call fails at its estimate; a running video is polled again; an uncollected video gives up after 47 h", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_cut", { status: "submitting", estimateUsd: 0.0656, costUsd: null, costBasis: null });
    // Changed 2026-10-17 (BL-180): the running videos were Veo operations; since Veo was removed a running video is an Omni
    // video Google delivered as a link, whose cost is already known from its counts.
    seedJob(h.store, "gm_video", { kind: "video", model: "gemini-omni-1.1-flash", status: "running", remoteName: OMNI_LINK, estimateUsd: 0.9303, costUsd: 0.91, costBasis: "usage", submittedAt: new Date(h.clock.at.getTime() - 60_000), paramsJson: JSON.stringify({ resolution: "1080p", aspectRatio: "16:9", durationSeconds: 4 }) });
    seedJob(h.store, "gm_old", { kind: "video", model: "gemini-omni-1.1-flash", status: "running", remoteName: OMNI_LINK, estimateUsd: 0.4, costUsd: null, costBasis: null, submittedAt: new Date(h.clock.at.getTime() - 48 * 3600_000) });
    assert.equal(await h.worker.bootSweep(), 1);
    const cut = h.store.jobs.get("gm_cut")!;
    assert.deepEqual([cut.status, cut.errorCode, cut.costUsd, cut.costBasis], ["failed", "gemini_interrupted", 0.0656, "unknown_outcome"]);
    assert.equal(h.store.jobs.get("gm_video")!.status, "running");
    await h.runTick();
    assert.deepEqual([h.store.jobs.get("gm_video")!.status, h.store.jobs.get("gm_video")!.costUsd], ["done", 0.91]);
    assert.deepEqual(h.calls.filter((c) => c.method === "downloadVideo").map((c) => (c.request as { uri: string }).uri), [OMNI_LINK]);
    const old = h.store.jobs.get("gm_old")!;
    assert.deepEqual([old.status, old.errorCode, old.costUsd, old.costBasis], ["failed", "gemini_expired", 0.4, "unknown_outcome"]);
    assert.equal(await h.worker.hasActiveJobs(), false);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-11

test("AC-GM-11: the same request id with the same content returns the first job; with other content it is refused", async () => {
  const h = await harness();
  try {
    const first = (await h.services.createJob(imageJob({ requestId: "cover-1" }), "factory")) as { job: { jobId: string } };
    const again = (await h.services.createJob(imageJob({ requestId: "cover-1" }), "factory")) as { job: { jobId: string }; replayed?: boolean };
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(again.replayed, true);
    assert.equal(h.store.jobs.size, 1);
    const details = await expectCode(h.services.createJob(imageJob({ requestId: "cover-1", prompt: "another" }), "factory"), "gemini_request_exists");
    assert.equal(details.jobId, first.job.jobId);
    // A replay is answered even after the owner switched generation off: it creates nothing.
    await h.services.updateSettings({ enabled: false });
    assert.equal(((await h.services.createJob(imageJob({ requestId: "cover-1" }), "factory")) as { job: { jobId: string } }).job.jobId, first.job.jobId);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-12

test("AC-GM-12: switched off, a queued job fails gemini_disabled unsent at no cost; a running video is still collected", async () => {
  const h = await harness();
  try {
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    seedJob(h.store, "gm_video", { kind: "video", model: "gemini-omni-1.1-flash", status: "running", remoteName: OMNI_LINK, estimateUsd: 0.9303, costUsd: 0.91, costBasis: "usage", submittedAt: h.clock.at, paramsJson: JSON.stringify({ resolution: "1080p", aspectRatio: "16:9", durationSeconds: 4 }) });
    await h.services.updateSettings({ enabled: false });
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_disabled", 0, "not_charged"]);
    assert.equal(h.calls.filter((c) => c.method === "generateImage").length, 0);
    assert.equal(h.store.jobs.get("gm_video")!.status, "done");
  } finally {
    await h.cleanup();
  }
});

test("getJobs: one job by id (unknown → gemini_job_not_found), or the newest with filters", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_a", { channelId: "UC1", createdAt: new Date(2026, 9, 10, 9) });
    seedJob(h.store, "gm_b", { channelId: "UC2", createdAt: new Date(2026, 9, 10, 10), status: "failed" });
    assert.equal(((await h.services.getJobs({ jobId: "gm_a" })) as { job: { jobId: string } }).job.jobId, "gm_a");
    await expectCode(h.services.getJobs({ jobId: "gm_zzz" }), "gemini_job_not_found");
    assert.deepEqual(((await h.services.getJobs({})) as { jobs: Array<{ jobId: string }> }).jobs.map((j) => j.jobId), ["gm_b", "gm_a"]);
    assert.deepEqual(((await h.services.getJobs({ channelId: "UC1" })) as { jobs: Array<{ jobId: string }> }).jobs.map((j) => j.jobId), ["gm_a"]);
    assert.deepEqual(((await h.services.getJobs({ status: "failed" })) as { jobs: Array<{ jobId: string }> }).jobs.map((j) => j.jobId), ["gm_b"]);
    await expectCode(h.services.getJobs({ limit: 51 }), "validation_failed");
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------- review round 1 additions

test("review 1: an image's cost is never below its table price -- Google's counts without the modality split price all output as image", async () => {
  // Pro 4K, no split: 2000 output tokens × 120e-6 = 0.24 (not 2000 × 12e-6 = 0.024).
  assert.equal(imageCostFromUsage("gemini-3-pro-image", { inputTokens: 0, outputTokens: 2000, thoughtTokens: 0, outputByModality: {} }, 1), 0.24);
  // With the split the image tokens alone are priced as image.
  assert.equal(imageCostFromUsage("gemini-3-pro-image", { inputTokens: 0, outputTokens: 2000, thoughtTokens: 0, outputByModality: { image: 2000 } }, 1), 0.24);
  for (const [usage, expected] of [
    // No split: 1000×1.5e-6 + 1680×30e-6 + 300×7.5e-6 = 0.05415 → 0.0542 (as with the split).
    [{ inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: {} }, 0.0542],
    // Counts below the table: 100×1.5e-6 + 1000×30e-6 = 0.03015 → the table's 0.0504 for one 2K image.
    [{ inputTokens: 100, outputTokens: 1000, thoughtTokens: 0, outputByModality: { image: 1000 } }, 0.0504],
  ] as const) {
    const h = await harness();
    try {
      h.behaviour.generateImage = async () => ({ images: [{ mimeType: "image/png", data: Buffer.from("x") }], usage: { ...usage, outputByModality: { ...usage.outputByModality } }, status: "completed", blockReason: null });
      const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
      await h.runTick();
      const row = h.store.jobs.get(job.jobId)!;
      assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", expected, "usage"]);
    } finally {
      await h.cleanup();
    }
  }
});

test("review 1: without Google's counts an image costs the table price (2.1 2K: 0.0504)", async () => {
  const h = await harness();
  try {
    h.behaviour.generateImage = async () => ({ images: [{ mimeType: "image/jpeg", data: Buffer.from("j") }], usage: null, status: "completed", blockReason: null });
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", 0.0504, "price_table"]);
    assert.ok(JSON.parse(row.outputsJson!)[0].path.endsWith("/image-1.jpg"));
  } finally {
    await h.cleanup();
  }
});

test("review 1: a 2xx with no image, no final status and no counts may have been charged: failed at its estimate", async () => {
  const h = await harness();
  try {
    h.behaviour.generateImage = async () => ({ images: [], usage: null, status: null, blockReason: null });
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_unavailable", 0.0656, "unknown_outcome"]);
  } finally {
    await h.cleanup();
  }
});

test("review 1: other failures -- the gateway toggle off and a refused key cost 0; an unexpected error or an unknown outcome counts the estimate", async () => {
  const cases: Array<[unknown, string, number, string]> = [
    [new DomainError({ code: "media_gateway_disabled", message: "off" }), "media_gateway_disabled", 0, "not_charged"],
    [new TypeError("something broke"), "gemini_unavailable", 0.0656, "unknown_outcome"],
    [gatewayError("gemini_unavailable", { outcome: "unknown", timedOut: false }), "gemini_unavailable", 0.0656, "unknown_outcome"],
  ];
  for (const [error, code, cost, basis] of cases) {
    const h = await harness();
    try {
      h.behaviour.generateImage = async () => {
        throw error;
      };
      const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
      await h.runTick();
      const row = h.store.jobs.get(job.jobId)!;
      assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis, row.attempts], ["failed", code, cost, basis, 1], code);
    } finally {
      await h.cleanup();
    }
  }
});

test("review 1: a key removed between create and run fails the job unsent at no cost", async () => {
  const h = await harness();
  try {
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.services.clearKey();
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_key_missing", 0, "not_charged"]);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

test("review 1: an image that cannot be written keeps its cost (it was paid)", async () => {
  const h = await harness();
  try {
    h.failWrites.value = true;
    const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_output_failed", 0.0542, "usage"]);
  } finally {
    await h.cleanup();
  }
});

// Changed 2026-10-13 (BL-179 review item 3), with justification (AGENTS.md §L): the rule "swept well after the longest call"
// is unchanged; the longest call is now Omni's 15-minute video, so the threshold moved from 15 to 20 minutes.
test("review 1: a job left `submitting` by a failed write is failed at its estimate after 20 minutes; a recent one is left alone", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_stale", { status: "submitting", estimateUsd: 0.96, costUsd: null, costBasis: null, updatedAt: new Date(h.clock.at.getTime() - 21 * 60_000) });
    // 16 minutes: past the Omni call's own timeout, still inside the margin -- left alone.
    seedJob(h.store, "gm_recent", { status: "submitting", estimateUsd: 0.96, costUsd: null, costBasis: null, updatedAt: new Date(h.clock.at.getTime() - 16 * 60_000) });
    await h.runTick();
    const stale = h.store.jobs.get("gm_stale")!;
    assert.deepEqual([stale.status, stale.errorCode, stale.costUsd, stale.costBasis], ["failed", "gemini_interrupted", 0.96, "unknown_outcome"]);
    assert.equal(h.store.jobs.get("gm_recent")!.status, "submitting");
  } finally {
    await h.cleanup();
  }
});

test("review 1: inherited object keys are never a model, a size or an input type", async () => {
  const h = await harness();
  try {
    for (const input of [
      imageJob({ image: { size: "toString", aspectRatio: "1:1" } }),
      imageJob({ image: { size: "__proto__", aspectRatio: "1:1" } }),
      imageJob({ model: "toString" }),
      videoJob({ model: "constructor" }),
      videoJob({ video: { resolution: "valueOf", aspectRatio: "16:9", durationSeconds: 8 } }),
    ]) {
      await expectCode(h.services.createJob(input, "factory"), "gemini_invalid_params");
      await expectCode(h.services.createJob({ ...input, dryRun: true }, "factory"), "gemini_invalid_params");
    }
    await writeFile(path.join(h.sent, "x.constructor"), "x");
    await expectCode(h.services.createJob(imageJob({ image: { size: "1K", aspectRatio: "1:1", inputs: { images: ["x.constructor"] } } }), "factory"), "gemini_input_unavailable");
    assert.equal(h.store.jobs.size, 0);
  } finally {
    await h.cleanup();
  }
});

test("review 1: checking the key never overwrites a key saved meanwhile", async () => {
  const h = await harness();
  try {
    const NEW_KEY = "AIzaSyNewerKey9876543210wxyz";
    let first = true;
    h.behaviour.checkKey = async () => {
      if (!first) return;
      first = false;
      await h.services.setKey({ apiKey: NEW_KEY }); // another tab saves a new key while the check is with Google
    };
    await h.services.testKey();
    assert.equal(await h.services.readApiKey(), NEW_KEY);
    assert.equal((await h.services.getKey()).keyHint, "wxyz");
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------- review round 2 additions

test("review 2: no image with a non-terminal status counts the estimate whatever its counts; a completed answer with counts costs the counts", async () => {
  for (const [answer, code, cost, basis] of [
    [{ images: [], usage: { inputTokens: 1000, outputTokens: 0, thoughtTokens: 0, outputByModality: {} }, status: "in_progress", blockReason: null }, "gemini_unavailable", 0.0656, "unknown_outcome"],
    [{ images: [], usage: null, status: "queued", blockReason: null }, "gemini_unavailable", 0.0656, "unknown_outcome"],
    // 1000×1.5e-6 = 0.0015
    [{ images: [], usage: { inputTokens: 1000, outputTokens: 0, thoughtTokens: 0, outputByModality: {} }, status: "completed", blockReason: null }, "gemini_blocked", 0.0015, "usage"],
    [{ images: [], usage: null, status: "failed", blockReason: null }, "gemini_blocked", 0, "not_charged"],
  ] as const) {
    const h = await harness();
    try {
      h.behaviour.generateImage = async () => ({ ...answer, images: [], usage: answer.usage ? { ...answer.usage, outputByModality: {} } : null });
      const { job } = (await h.services.createJob(imageJob(), "factory")) as { job: { jobId: string } };
      await h.runTick();
      const row = h.store.jobs.get(job.jobId)!;
      assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", code, cost, basis], String(answer.status));
      assert.ok(Object.is(row.costUsd, cost), "never -0");
    } finally {
      await h.cleanup();
    }
  }
});

// BL-180: "a Veo operation Google no longer has" went with Veo; a link Google no longer has is the BL-179 review test below.

test("review 2: a key with an invisible character is refused before Google is called", async () => {
  const h = await harness({ withKey: false });
  try {
    await expectCode(h.services.setKey({ apiKey: "AIzaSyTestKey0123​456789abcd" }), "validation_failed");
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

// Extended 2026-10-13 (BL-179 review item 3), with justification (AGENTS.md §L): the requirement is unchanged -- the sweep comes
// well after the longest call -- and Omni's synchronous video call (15 min) is now the longest call.
test("review 2: an abandoned `submitting` job is only swept well after the longest call could still be running", () => {
  // The sweep must never fail a job whose image, video-start or Omni video call can still be in flight in another bundle.
  assert.ok(GEMINI_LIMITS.staleSubmittingMs >= Math.max(GEMINI_IMAGE_TIMEOUT_MS, GEMINI_INTERACTIONS_VIDEO_TIMEOUT_MS) + 5 * 60_000);
  assert.ok(Object.is(ceil4(0), 0));
});

// ---------------------------------------------------------------------------------------------------------------- BL-179
// FO-REQ-0021 (docs/roadmap/plans/GEMINI_OMNI_PLAN.md). Facts the expectations come from, not from the code:
// - Omni (`gemini-omni-1.1-flash`) is called through the Interactions API and answers with the video; its pricing page gives
//   input $1.50 / 1M tokens, video output $17.50 / 1M, text and thinking output $9.00 / 1M, and 5,792 tokens per second of 720p;
// - the Veo 3.1 previews reject first/last frames on `predictLongRunning` (HTTP 400, job gm_7d1d80b2) and shut down 2026-10-22;
// - the Operator's acceptance case: 8 s, 720p, 16:9, first frame = last frame = pick_still01.jpg, about $0.80.
const omniJob = (overrides: Record<string, unknown> = {}) =>
  videoJob({ model: "gemini-omni-1.1-flash", video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { firstFrame: "pick_still01.jpg", lastFrame: "pick_still01.jpg" } }, ...overrides });

test("BL-179: the acceptance case -- Omni 8 s 720p with first = last frame is estimated, sent with both frames in order, saved and priced by Google's counts", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.sent, "pick_still01.jpg"), "STILL");
    // Estimate by hand: video 5,792 x 8 = 46,336 tokens x $17.50/1M = $0.81088; input ceil(5/3) = 2 + 2 frames x 1,120 = 2,242
    // tokens x $1.50/1M = $0.003363; thinking allowance 2,000 x $9/1M = $0.018 -> $0.832243 -> $0.8323 (rounded up).
    const dry = (await h.services.createJob(omniJob({ dryRun: true }), "factory")) as { estimateUsd: number };
    assert.equal(dry.estimateUsd, 0.8323);
    const { job } = (await h.services.createJob(omniJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    assert.deepEqual(h.calls.map((c) => c.method), ["generateVideo"], "one synchronous call, no operation to poll");
    const sentRequest = h.calls[0].request as GeminiInteractionsVideoRequest;
    const still = { mimeType: "image/jpeg", dataBase64: Buffer.from("STILL").toString("base64") };
    assert.deepEqual(sentRequest, { model: "gemini-omni-1.1-flash", prompt: "waves", frames: [still, still], aspectRatio: "16:9", resolution: "720p", durationSeconds: 8 });
    const row = h.store.jobs.get(job.jobId)!;
    // Cost by hand from the fake's counts: 3,000 x $1.50/1M + 46,336 x $17.50/1M + 500 x $9/1M = $0.81988 -> $0.8199.
    assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", 0.8199, "usage"]);
    const dir = path.join(h.fromYtm, "gemini", job.jobId);
    assert.deepEqual(await readFile(path.join(dir, "video-1.mp4")), Buffer.from("OMNI-MP4"));
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.deepEqual([manifest.status, manifest.costUsd, manifest.costBasis, manifest.outputs[0].path], ["done", 0.8199, "usage", `gemini/${job.jobId}/video-1.mp4`]);
    // FO-MSG-0016: the manifest carries the submission time `factory_gemini_get_job` shows (it was null for an inline answer).
    assert.equal(manifest.submittedAt, h.clock.at.toISOString());
    assert.equal(manifest.submittedAt, row.submittedAt?.toISOString());
    assert.equal(h.registered[0].assetType, "generated_video");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- BL-180
// Owner, Telegram msg 2902: the three Veo 3.1 previews are removed (Google shuts them down on 2026-10-22). Expected: a Veo id is
// refused as a model before anything is stored or sent; the status lists Omni as the only video model; a Veo job left queued is
// never sent (cost 0); a Veo job left running (an operation name, not a link) is not polled and fails at its estimate.
const VEO_IDS = ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview", "veo-3.1-lite-generate-preview"];

test("BL-180: a Veo id is refused as a model before anything is stored or sent; the status lists Omni as the only video model", async () => {
  const h = await harness();
  try {
    for (const model of VEO_IDS) {
      const details = await expectCode(h.services.createJob(videoJob({ model, video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory"), "gemini_invalid_params");
      assert.equal(details.field, "model", model);
    }
    assert.equal(h.store.jobs.size, 0);
    assert.deepEqual(h.calls, []);
    const status = (await h.services.getStatus()) as { models: Array<{ model: string; kind: string }> };
    assert.deepEqual(status.models.filter((m) => m.kind === "video").map((m) => m.model), ["gemini-omni-1.1-flash"]);
  } finally {
    await h.cleanup();
  }
});

test("BL-180 review: a retry of a Veo job created before the removal (same requestId, same content) still returns that job", async () => {
  const h = await harness();
  try {
    const veo = videoJob({ model: "veo-3.1-fast-generate-preview", requestId: "r1", video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } });
    // The documented idempotency content of a video create (AC-GM-11), in its fixed order.
    const hash = createHash("sha256")
      .update(JSON.stringify({ channelId: "UC1", kind: "video", model: "veo-3.1-fast-generate-preview", prompt: "waves", resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, personGeneration: null, firstFrame: null, lastFrame: null, referenceImages: [] }))
      .digest("hex");
    seedJob(h.store, "gm_veo_first", { kind: "video", model: "veo-3.1-fast-generate-preview", requestId: "r1", requestHash: hash, status: "done", costUsd: 0.8, costBasis: "price_table" });
    const again = (await h.services.createJob(veo, "factory")) as { job: { jobId: string }; replayed?: boolean };
    assert.deepEqual([again.job.jobId, again.replayed], ["gm_veo_first", true]);
    // A new Veo create (no matching request) is still refused as a model.
    assert.equal((await expectCode(h.services.createJob({ ...veo, requestId: "r2" }, "factory"), "gemini_invalid_params")).field, "model");
    assert.equal(h.store.jobs.size, 1);
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

test("BL-180: a Veo job left queued is failed unsent at no cost; one left running is not polled and fails at its estimate", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_veo_queued", { kind: "video", model: "veo-3.1-lite-generate-preview", status: "queued", estimateUsd: 0.4, costUsd: null, costBasis: null, submittedAt: null, finishedAt: null, paramsJson: JSON.stringify({ resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 }) });
    seedJob(h.store, "gm_veo_running", { kind: "video", model: "veo-3.1-fast-generate-preview", status: "running", remoteName: "models/veo-3.1-fast-generate-preview/operations/op9", estimateUsd: 0.96, costUsd: null, costBasis: null, submittedAt: h.clock.at, finishedAt: null, paramsJson: JSON.stringify({ resolution: "1080p", aspectRatio: "16:9", durationSeconds: 8 }) });
    await h.runTick();
    const queued = h.store.jobs.get("gm_veo_queued")!;
    assert.deepEqual([queued.status, queued.errorCode, queued.costUsd, queued.costBasis], ["failed", "gemini_invalid_request", 0, "not_charged"]);
    const running = h.store.jobs.get("gm_veo_running")!;
    assert.deepEqual([running.status, running.errorCode, running.costUsd, running.costBasis], ["failed", "gemini_expired", 0.96, "unknown_outcome"]);
    assert.deepEqual(h.calls, [], "nothing is sent to Google for either");
  } finally {
    await h.cleanup();
  }
});

test("BL-179: Omni's own rules -- 720p/1080p only, no personGeneration, no reference images", async () => {
  const h = await harness();
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [omniJob({ video: { resolution: "4k", aspectRatio: "16:9", durationSeconds: 8 } }), "video.resolution"],
      [omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, personGeneration: "allow_adult" } }), "video.personGeneration"],
      [omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { referenceImages: ["a.png"] } } }), "video.inputs.referenceImages"],
    ];
    for (const [input, field] of cases) {
      const details = await expectCode(h.services.createJob(input, "factory"), "gemini_invalid_params");
      assert.equal(details.field, field, JSON.stringify(input));
    }
    assert.deepEqual(h.calls, []);
  } finally {
    await h.cleanup();
  }
});

test("BL-179: an Omni video delivered as a URI is collected by the next poll and keeps Google's cost", async () => {
  const h = await harness();
  try {
    const uri = "https://generativelanguage.googleapis.com/v1beta/files/omni1:download?alt=media";
    h.behaviour.generateVideo = async () => ({ video: { mimeType: "video/mp4", uri }, usage: { inputTokens: 3000, outputTokens: 46336, thoughtTokens: 500, outputByModality: { video: 46336 } }, status: "completed", blockReason: null });
    const { job } = (await h.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    let row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.remoteName, row.costUsd, row.costBasis], ["running", uri, 0.8199, "usage"]);
    await h.runTick();
    assert.deepEqual(h.calls.map((c) => c.method), ["generateVideo", "downloadVideo"], "no Veo operation is polled");
    row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", 0.8199, "usage"]);
  } finally {
    await h.cleanup();
  }
});

test("BL-179: Omni with no video -- a block is gemini_blocked at Google's counted cost; an answer still in progress counts its estimate", async () => {
  const blocked = await harness();
  try {
    blocked.behaviour.generateVideo = async () => ({ video: null, usage: { inputTokens: 2000, outputTokens: 0, thoughtTokens: 100, outputByModality: {} }, status: "completed", blockReason: "safety" });
    const { job } = (await blocked.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 4 } }), "factory")) as { job: { jobId: string } };
    await blocked.runTick();
    const row = blocked.store.jobs.get(job.jobId)!;
    // 2,000 x $1.50/1M + 100 x $9/1M = $0.0039.
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_blocked", 0.0039, "usage"]);
  } finally {
    await blocked.cleanup();
  }
  const pending = await harness();
  try {
    pending.behaviour.generateVideo = async () => ({ video: null, usage: null, status: "in_progress", blockReason: null });
    const { job } = (await pending.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 4 } }), "factory")) as { job: { jobId: string } };
    await pending.runTick();
    const row = pending.store.jobs.get(job.jobId)!;
    // Its estimate by hand: 5,792 x 4 x $17.50/1M = $0.40544 + 2 input tokens x $1.50/1M + 2,000 x $9/1M = $0.423443 -> $0.4235.
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_unavailable", 0.4235, "unknown_outcome"]);
  } finally {
    await pending.cleanup();
  }
});

// BL-179 independent review: money rules on the Omni path (GEMINI_MEDIA_PLAN.md §2.4 "never under-count"; a lost answer counts
// its estimate and is never re-sent; a paid video is never dropped for a file that can still be collected).
test("BL-179 review: a saved video costs at least its table price even when Google's counts are incomplete", async () => {
  const h = await harness();
  try {
    h.behaviour.generateVideo = async () => ({ video: { mimeType: "video/mp4", data: Buffer.from("V") }, usage: { inputTokens: 3000, outputTokens: 0, thoughtTokens: 0, outputByModality: {} }, status: "completed", blockReason: null });
    const { job } = (await h.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    // Floor by hand: 5,792 x 8 = 46,336 video tokens x $17.50/1M = $0.81088 -> $0.8109 (the counts alone said $0.0045).
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", 0.8109, "usage"]);
  } finally {
    await h.cleanup();
  }
});

test("BL-179 review: audio and other non-text output are priced at the video rate", async () => {
  const h = await harness();
  try {
    h.behaviour.generateVideo = async () => ({
      video: { mimeType: "video/mp4", data: Buffer.from("V") },
      usage: { inputTokens: 0, outputTokens: 50000, thoughtTokens: 0, outputByModality: { video: 46336, audio: 3000, text: 664 } },
      status: "completed",
      blockReason: null,
    });
    const { job } = (await h.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    // (46,336 + 3,000) x $17.50/1M + 664 x $9/1M = $0.86338 + $0.005976 = $0.869356 -> $0.8694.
    assert.equal(h.store.jobs.get(job.jobId)!.costUsd, 0.8694);
  } finally {
    await h.cleanup();
  }
});

test("BL-179 review: a lost Omni answer counts its estimate and is not re-sent; a 429 is re-queued", async () => {
  const lost = await harness();
  try {
    lost.behaviour.generateVideo = async () => {
      throw gatewayError("gemini_unavailable", { outcome: "unknown", timedOut: true });
    };
    const { job } = (await lost.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 4 } }), "factory")) as { job: { jobId: string } };
    await lost.runTick();
    lost.clock.at = new Date(lost.clock.at.getTime() + 10 * 60_000);
    await lost.runTick();
    const row = lost.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_timeout", 0.4235, "unknown_outcome"]);
    assert.equal(lost.calls.filter((c) => c.method === "generateVideo").length, 1, "never re-sent");
  } finally {
    await lost.cleanup();
  }
  const limited = await harness();
  try {
    limited.behaviour.generateVideo = async () => {
      throw gatewayError("gemini_rate_limited", { status: 429 });
    };
    const { job } = (await limited.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 4 } }), "factory")) as { job: { jobId: string } };
    await limited.runTick();
    const row = limited.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.attempts], ["queued", "gemini_rate_limited", 1]);
  } finally {
    await limited.cleanup();
  }
});

test("BL-179 review: a video that cannot be written keeps its cost", async () => {
  const h = await harness();
  try {
    const { job } = (await h.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    h.failWrites.value = true;
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_output_failed", 0.8199, "usage"]);
  } finally {
    await h.cleanup();
  }
});

test("BL-179 review: a link-delivered video Google no longer has, or one never collected, fails at its known cost; a link that cannot be followed is never polled", async () => {
  const usage = { inputTokens: 3000, outputTokens: 46336, thoughtTokens: 500, outputByModality: { video: 46336 } };
  const gone = await harness();
  try {
    gone.behaviour.generateVideo = async () => ({ video: { mimeType: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/x:download?alt=media" }, usage, status: "completed", blockReason: null });
    gone.behaviour.downloadVideo = async () => {
      throw gatewayError("gemini_request_rejected", { status: 404 });
    };
    const { job } = (await gone.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await gone.runTick();
    await gone.runTick();
    const row = gone.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_expired", 0.8199, "usage"]);
  } finally {
    await gone.cleanup();
  }
  const late = await harness();
  try {
    seedJob(late.store, "gm_late", {
      kind: "video",
      model: "gemini-omni-1.1-flash",
      status: "running",
      remoteName: "https://generativelanguage.googleapis.com/v1beta/files/y:download?alt=media",
      estimateUsd: 0.8323,
      costUsd: 0.8199,
      costBasis: "usage",
      submittedAt: new Date(late.clock.at.getTime() - 48 * 3600_000),
      paramsJson: JSON.stringify({ resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 }),
    });
    await late.runTick();
    const row = late.store.jobs.get("gm_late")!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_expired", 0.8199, "usage"]);
  } finally {
    await late.cleanup();
  }
  const notVideo = await harness();
  try {
    notVideo.behaviour.generateVideo = async () => ({ video: { mimeType: "video/mp4", uri: "https://generativelanguage.googleapis.com/v1beta/files/z:download?alt=media" }, usage, status: "completed", blockReason: null });
    notVideo.behaviour.downloadVideo = async () => {
      throw gatewayError("gemini_unavailable", { status: 200, notAVideo: true });
    };
    const { job } = (await notVideo.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await notVideo.runTick();
    await notVideo.runTick();
    const row = notVideo.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_output_failed", 0.8199, "usage"], "a link that gives no video is not retried for 47 h");
  } finally {
    await notVideo.cleanup();
  }
  const odd = await harness();
  try {
    odd.behaviour.generateVideo = async () => ({ video: { mimeType: "video/mp4", uri: "gs://bucket/x.mp4" }, usage, status: "completed", blockReason: null });
    const { job } = (await odd.services.createJob(omniJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8 } }), "factory")) as { job: { jobId: string } };
    await odd.runTick();
    const row = odd.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_output_failed", 0.8199, "usage"]);
    assert.deepEqual(odd.calls.map((c) => c.method), ["generateVideo"]);
  } finally {
    await odd.cleanup();
  }
});

test("BL-179 review: the 1080p estimate (2.25 x 720p tokens) -- 8 s is over the default $1 per-job limit, 4 s fits", () => {
  // 8 s: 13,032 x 8 = 104,256 x $17.50/1M = $1.82448 + 2 input tokens x $1.50/1M + 2,000 x $9/1M = $1.842483 -> $1.8425.
  assert.equal(estimateVideoUsd({ model: "gemini-omni-1.1-flash", resolution: "1080p", durationSeconds: 8, promptChars: 5, inputImages: 0 }), 1.8425);
  // 4 s: 52,128 x $17.50/1M = $0.91224 + $0.000003 + $0.018 = $0.930243 -> $0.9303.
  assert.equal(estimateVideoUsd({ model: "gemini-omni-1.1-flash", resolution: "1080p", durationSeconds: 4, promptChars: 5, inputImages: 0 }), 0.9303);
});

// ---------------------------------------------------------------------------------------------------------------- BL-184
// FO-REQ-0024 §4 B4 / §5 step 4 (STORYBOARD_PLAN.md §3 stage 2 item 2): the storyboard gate is asked right after the inputs are
// read -- with the sha256 of the frames as read -- and before the estimate, the limits and any charge; a refusal leaves nothing
// stored and nothing sent; a dry-run reports it; a link the gate returns is recorded on the job.

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const flfJob = (overrides: Record<string, unknown> = {}) =>
  videoJob({ model: "gemini-omni-1.1-flash", video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { firstFrame: "bar/v2/K0.jpg", lastFrame: "bar/v2/K1.jpg" } }, ...overrides });

test("BL-184: the gate gets the frames' sha256; its refusal stores nothing and sends nothing; a dry-run reports it with the estimate", async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.sent, "bar", "v2"), { recursive: true });
    await writeFile(path.join(h.sent, "bar", "v2", "K0.jpg"), "K0 bytes");
    await writeFile(path.join(h.sent, "bar", "v2", "K1.jpg"), "K1 bytes");
    h.gate.answer = async () => {
      throw new DomainError({ code: "storyboard_not_approved", message: "needs an approved storyboard", details: { reason: "no_link" } });
    };
    await assert.rejects(h.services.createJob(flfJob(), "factory"), (e: unknown) => isDomainError(e) && e.code === "storyboard_not_approved");
    assert.deepEqual(h.gate.calls, [{ channelId: "UC1", firstFrameSha256: sha256("K0 bytes"), lastFrameSha256: sha256("K1 bytes"), link: null }]);
    assert.equal(h.store.jobs.size, 0, "nothing stored");
    await h.runTick();
    assert.deepEqual(h.calls, [], "nothing sent to Google");
    const dry = (await h.services.createJob(flfJob({ dryRun: true }), "factory")) as unknown as { allowed: boolean; refusal: { code: string; details: { reason: string } }; estimateUsd: number };
    assert.deepEqual([dry.allowed, dry.refusal.code, dry.refusal.details.reason, dry.estimateUsd > 0], [false, "storyboard_not_approved", "no_link", true]);
    // Any other failure of the gate is not a dry-run answer: it propagates.
    h.gate.answer = async () => {
      throw new Error("document unreadable");
    };
    await assert.rejects(h.services.createJob(flfJob({ dryRun: true }), "factory"), /document unreadable/);
    // An image job never asks the gate.
    h.gate.calls.length = 0;
    await h.services.createJob({ channelId: "UC1", kind: "image", model: "gemini-nano-banana-2.1", prompt: "p", image: { size: "1K", aspectRatio: "1:1" } }, "factory");
    assert.deepEqual(h.gate.calls, []);
  } finally {
    await h.cleanup();
  }
});

test("BL-184: a link the gate lets through is passed on and recorded on the job; a link without its segment, or on an image, is refused first", async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.sent, "bar", "v2"), { recursive: true });
    await writeFile(path.join(h.sent, "bar", "v2", "K0.jpg"), "K0 bytes");
    await writeFile(path.join(h.sent, "bar", "v2", "K1.jpg"), "K1 bytes");
    h.gate.answer = async (input) => (input.link ? { storyboardId: input.link.storyboardId, versionNumber: 2, segmentId: input.link.segmentId } : null);
    const { job } = (await h.services.createJob(flfJob({ storyboardId: "bar-loop", segmentId: "S1", requestId: "r-s1" }), "factory")) as { job: { jobId: string; storyboard: unknown } };
    assert.deepEqual(h.gate.calls[0].link, { storyboardId: "bar-loop", segmentId: "S1" });
    assert.deepEqual(job.storyboard, { storyboardId: "bar-loop", versionNumber: 2, segmentId: "S1" });
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.storyboardId, row.storyboardVersion, row.segmentId], ["bar-loop", 2, "S1"]);
    // B5: the storyboard's takes are exactly its linked jobs on that channel.
    assert.deepEqual((await h.services.listJobsByStoryboard("UC1", "bar-loop")).map((j) => [j.jobId, j.storyboard?.segmentId]), [[job.jobId, "S1"]]);
    assert.deepEqual(await h.services.listJobsByStoryboard("UC1", "other"), []);
    // The same request id with another segment is another job, not a replay.
    await assert.rejects(h.services.createJob(flfJob({ storyboardId: "bar-loop", segmentId: "S2", requestId: "r-s1" }), "factory"), (e: unknown) => isDomainError(e) && e.code === "gemini_request_exists");
    for (const bad of [flfJob({ storyboardId: "bar-loop" }), flfJob({ segmentId: "S1" }), { channelId: "UC1", kind: "image", model: "gemini-nano-banana-2.1", prompt: "p", image: { size: "1K", aspectRatio: "1:1" }, storyboardId: "bar-loop", segmentId: "S1" }]) {
      await assert.rejects(h.services.createJob(bad, "factory"), (e: unknown) => isDomainError(e) && e.code === "gemini_invalid_params");
    }
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- BL-194

test("BL-194: a Gemini job's video is the given number, else its storyboard's; it is stored; a given number the channel cannot link refuses before any charge", async () => {
  const h = await harness();
  try {
    await mkdir(path.join(h.sent, "bar", "v2"), { recursive: true });
    await writeFile(path.join(h.sent, "bar", "v2", "K0.jpg"), "K0 bytes");
    await writeFile(path.join(h.sent, "bar", "v2", "K1.jpg"), "K1 bytes");
    h.gate.answer = async (input) => (input.link ? { storyboardId: input.link.storyboardId, versionNumber: 2, segmentId: input.link.segmentId } : null);
    h.video.answer = async (input) => input.videoNumber ?? (input.storyboardId === "bar-loop" ? "V49" : null);
    const { job } = (await h.services.createJob(flfJob({ storyboardId: "bar-loop", segmentId: "S1", requestId: "r-v49" }), "factory")) as { job: { jobId: string; video: string | null } };
    assert.deepEqual(h.video.calls[0], { channelId: "UC1", videoNumber: null, storyboardId: "bar-loop" });
    assert.equal(job.video, "V49");
    assert.equal(h.store.jobs.get(job.jobId)!.video, "V49");
    const named = (await h.services.createJob({ channelId: "UC1", kind: "image", model: "gemini-nano-banana-2.1", prompt: "a still", image: { size: "1K", aspectRatio: "1:1" }, videoNumber: "V50" }, "factory")) as { job: { video: string | null } };
    assert.equal(named.job.video, "V50");

    h.video.answer = async () => {
      const { DomainError } = await import("./contracts");
      throw new DomainError({ code: "video_not_found", message: "V77 is not a video of UC1" });
    };
    const before = h.store.jobs.size;
    const callsBefore = h.calls.length;
    await assert.rejects(
      h.services.createJob({ channelId: "UC1", kind: "image", model: "gemini-nano-banana-2.1", prompt: "a still", image: { size: "1K", aspectRatio: "1:1" }, videoNumber: "V77" }, "factory"),
      (e: unknown) => isDomainError(e) && e.code === "video_not_found"
    );
    assert.equal(h.store.jobs.size, before, "nothing stored");
    assert.equal(h.calls.length, callsBefore, "nothing sent to Google");
    await assert.rejects(
      h.services.createJob({ channelId: "UC1", kind: "image", model: "gemini-nano-banana-2.1", prompt: "a still", image: { size: "1K", aspectRatio: "1:1" }, videoNumber: "V049" }, "factory"),
      (e: unknown) => isDomainError(e) && e.code === "validation_failed"
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- BL-188

test("BL-188: listJobsForShare gives every unfinished job plus the newest `limit`, newest first, across channels", async () => {
  const h = await harness();
  try {
    const at = (day: number) => new Date(2026, 9, day, 9, 0, 0);
    seedJob(h.store, "gm_old_queued", { status: "queued", createdAt: at(1), channelId: "UC2" });
    seedJob(h.store, "gm_old_running", { status: "running", createdAt: at(2) });
    seedJob(h.store, "gm_old_done", { status: "done", createdAt: at(3) });
    seedJob(h.store, "gm_new_done", { status: "done", createdAt: at(9) });
    seedJob(h.store, "gm_new_failed", { status: "failed", createdAt: at(8), channelId: "UC2" });
    // The newest 2 are the two recent ones; the old unfinished ones are added; the old finished one is left out.
    assert.deepEqual(
      (await h.services.listJobsForShare(2)).map((j) => j.jobId),
      ["gm_new_done", "gm_new_failed", "gm_old_running", "gm_old_queued"]
    );
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- BL-188 stage 2
// SHARED_MEDIA_JOBS_PLAN.md §2.5 / §4.1 item 8: a `queued` job becomes `failed` with `cancelled_by_owner` and is never sent;
// `submitting` / `running` → `gemini_cancel_too_late`; nothing is charged for a cancelled job.

test("BL-188 AC 8: a queued Gemini job is cancelled before anything is sent to Google, at no cost", async () => {
  const h = await harness();
  try {
    const created = await h.services.createJob(imageJob(), "factory");
    assert.ok("job" in created && created.job);
    const job = created.job;
    assert.equal(job.status, "queued");
    const cancelled = await h.services.cancelJob(job.jobId);
    assert.equal(cancelled.job.status, "failed");
    assert.equal(cancelled.job.errorCode, "cancelled_by_owner");
    const row = h.store.jobs.get(job.jobId)!;
    assert.equal(row.costUsd, 0);
    assert.equal(row.costBasis, "not_charged");
    assert.ok(row.finishedAt);
    // The worker never picks it up: no request reaches Google.
    await h.runTick();
    assert.deepEqual(
      h.calls.filter((c) => c.method !== "checkKey"),
      []
    );
    assert.equal(h.store.jobs.get(job.jobId)!.status, "failed");
  } finally {
    await h.cleanup();
  }
});

test("BL-188 AC 8: a Gemini job already sent (submitting, running) or finished cannot be cancelled; an unknown one is not found", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_submitting", { status: "submitting" });
    seedJob(h.store, "gm_running", { status: "running" });
    seedJob(h.store, "gm_done", { status: "done" });
    for (const id of ["gm_submitting", "gm_running", "gm_done"]) {
      const before = { ...h.store.jobs.get(id)! };
      const details = await expectCode(h.services.cancelJob(id), "gemini_cancel_too_late");
      assert.equal(details.status, before.status);
      assert.deepEqual(h.store.jobs.get(id), before, `${id} unchanged`);
    }
    await expectCode(h.services.cancelJob("gm_missing"), "gemini_job_not_found");
  } finally {
    await h.cleanup();
  }
});

test("BL-188 AC 8: a cancel that loses the race to the worker's claim is refused, the job stays the worker's", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_race", { status: "queued" });
    // The worker claims the job (queued -> submitting) between the cancel's read and its compare-and-set.
    const realGet = h.store.getJob.bind(h.store);
    let reads = 0;
    h.store.getJob = async (jobId: string) => {
      const row = await realGet(jobId);
      reads += 1;
      if (reads === 1 && row) h.store.jobs.set(jobId, { ...row, status: "submitting" });
      return row;
    };
    await expectCode(h.services.cancelJob("gm_race"), "gemini_cancel_too_late");
    assert.equal(h.store.jobs.get("gm_race")!.status, "submitting");
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// BL-236 (FO-REQ-0050, ADR 0057): speech. Expected amounts by hand from the Gemini TTS prices R-0005 records (Flash TTS $0.50 in /
// $9 audio out per 1M tokens until 2026-12-31, then $1 / $18; audio 25 tokens per second) and the estimate rule of the plan (5
// characters a second, input at 3 characters a token), never from the implementation.
// ---------------------------------------------------------------------------------------------------------------------------

const speechJob = (overrides: Record<string, unknown> = {}) => ({ channelId: "UC1", model: "gemini-3.8-flash-tts", voice: "Sumire", text: "x".repeat(100), ...overrides });

test("AC-SP-01: a speech estimate is 20 s (100 chars / 5) x 25 tokens x $9/M + 34 input tokens x $0.50/M = $0.0046; from 2027-01-01 the doubled rate: $0.0091", async () => {
  const before = await harness({ now: new Date(2026, 9, 29, 12) });
  const after = await harness({ now: new Date(2027, 0, 2, 12) });
  try {
    const a = (await before.services.createSpeechJob({ ...speechJob(), dryRun: true }, "factory")) as { estimateUsd: number; allowed: boolean };
    assert.equal(a.estimateUsd, 0.0046);
    assert.equal(a.allowed, true);
    const b = (await after.services.createSpeechJob({ ...speechJob(), dryRun: true }, "factory")) as { estimateUsd: number };
    assert.equal(b.estimateUsd, 0.0091);
  } finally {
    await before.cleanup();
    await after.cleanup();
  }
});

test("AC-SP-02: a speech job speaks the APPROVED voice's provider id with the style; take-1.wav at Google's 24 kHz, manifest written last with kind speech", async () => {
  const h = await harness();
  try {
    const created = (await h.services.createSpeechJob(speechJob({ style: "like a bedtime story" }), "factory")) as { job: { jobId: string; kind: string; status: string; params: unknown } };
    assert.equal(created.job.kind, "speech");
    assert.equal(created.job.status, "queued");
    assert.deepEqual(created.job.params, { voice: { voiceId: "vc_sumire", name: "Sumire", providerVoiceId: "voices/voice_sumire" }, style: "like a bedtime story" });
    assert.deepEqual(h.voiceCalls, [{ channelId: "UC1", provider: "gemini", voice: "Sumire" }]);
    await h.runTick();
    const sent = h.calls.find((c) => c.method === "generateSpeech");
    assert.deepEqual(sent?.request, { model: "gemini-3.8-flash-tts", text: "x".repeat(100), voice: "voices/voice_sumire", style: "like a bedtime story" });
    const job = h.store.jobs.get(created.job.jobId)!;
    assert.equal(job.status, "done");
    const dir = path.join(h.fromYtm, "gemini", created.job.jobId);
    const wav = await readFile(path.join(dir, "take-1.wav"));
    assert.equal(wav.length, 44 + 960_000);
    assert.equal(wav.readUInt32LE(24), 24_000, "the sample rate Google delivered, not resampled");
    assert.deepEqual(h.order, ["write take-1.wav", "manifest"], "the manifest is written last");
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "speech");
    assert.deepEqual(manifest.outputs.map((o: Record<string, unknown>) => [o.path, o.kind, o.mimeType, o.sampleRateHz, o.durationSeconds]), [[`gemini/${created.job.jobId}/take-1.wav`, "audio", "audio/wav", 24_000, 20]]);
    assert.equal(h.registered[0].assetType, "generated_audio");
  } finally {
    await h.cleanup();
  }
});

test("AC-SP-03: the cost is never below the file's length: Google's 40 in / 300 out = $0.0028, the 20 s file is 500 tokens x $9/M = $0.0045", async () => {
  const h = await harness();
  try {
    const created = (await h.services.createSpeechJob(speechJob(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const job = h.store.jobs.get(created.job.jobId)!;
    assert.equal(job.costUsd, 0.0045);
    assert.equal(job.costBasis, "usage");
    // Google counting more than the file: its count (40 x 0.5 + 1000 x 9 = 9,020 per million → $0.0091).
    h.behaviour.generateSpeech = async () => ({ audio: { mimeType: "audio/l16;codec=pcm;rate=24000", data: Buffer.alloc(960_000) }, usage: { inputTokens: 40, outputTokens: 1000, thoughtTokens: 0, outputByModality: {} }, status: "completed", blockReason: null });
    const second = (await h.services.createSpeechJob(speechJob({ text: "y".repeat(100) }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    assert.equal(h.store.jobs.get(second.job.jobId)!.costUsd, 0.0091);
    // Without counts: the file at the table price.
    h.behaviour.generateSpeech = async () => ({ audio: { mimeType: "audio/l16;codec=pcm;rate=24000", data: Buffer.alloc(960_000) }, usage: null, status: "completed", blockReason: null });
    const third = (await h.services.createSpeechJob(speechJob({ text: "z".repeat(100) }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(third.job.jobId)!;
    assert.deepEqual([row.costUsd, row.costBasis], [0.0045, "price_table"]);
  } finally {
    await h.cleanup();
  }
});

test("AC-SP-04: a voice that is not approved for this channel is refused before any charge; a dry run reports it as the refusal", async () => {
  const h = await harness();
  try {
    await expectCode(h.services.createSpeechJob(speechJob({ voice: "Stranger" }), "factory"), "voice_not_approved");
    await expectCode(h.services.createSpeechJob(speechJob({ channelId: "UC2" }), "factory"), "voice_not_approved");
    assert.equal(h.store.jobs.size, 0);
    const dry = (await h.services.createSpeechJob({ ...speechJob({ voice: "Stranger" }), dryRun: true }, "factory")) as { allowed: boolean; refusal: { code: string } };
    assert.equal(dry.allowed, false);
    assert.equal(dry.refusal.code, "voice_not_approved");
  } finally {
    await h.cleanup();
  }
});

test("AC-SP-05: the owner's switch off or no key refuses speech; a queued take is failed unsent at 0 when the switch goes off", async () => {
  const off = await harness({ enabled: false });
  const noKey = await harness({ withKey: false });
  const later = await harness();
  try {
    await expectCode(off.services.createSpeechJob(speechJob(), "factory"), "gemini_disabled");
    await expectCode(noKey.services.createSpeechJob(speechJob(), "factory"), "gemini_key_missing");
    const created = (await later.services.createSpeechJob(speechJob(), "factory")) as { job: { jobId: string } };
    await later.services.updateSettings({ enabled: false });
    await later.runTick();
    const row = later.store.jobs.get(created.job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", "gemini_disabled", 0, "not_charged"]);
    assert.equal(later.calls.filter((c) => c.method === "generateSpeech").length, 0);
  } finally {
    await off.cleanup();
    await noKey.cleanup();
    await later.cleanup();
  }
});

test("AC-SP-06: a repeated requestId with the same take returns the first job; with other words it is gemini_request_exists", async () => {
  const h = await harness();
  try {
    const first = (await h.services.createSpeechJob(speechJob({ requestId: "greet-1" }), "factory")) as { job: { jobId: string } };
    const again = (await h.services.createSpeechJob(speechJob({ requestId: "greet-1" }), "factory")) as { job: { jobId: string }; replayed: boolean };
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(again.replayed, true);
    await expectCode(h.services.createSpeechJob(speechJob({ requestId: "greet-1", text: "different words" }), "factory"), "gemini_request_exists");
    assert.equal(h.store.jobs.size, 1);
  } finally {
    await h.cleanup();
  }
});

test("AC-SP-07: speech takes text only -- an audio field is refused by the schema; an image model or unknown model is gemini_invalid_params; the per-job limit holds", async () => {
  const h = await harness({ settings: { maxUsdPerJob: 0.001 } });
  try {
    await expectCode(h.services.createSpeechJob({ ...speechJob(), referenceAudio: "voice.wav" }, "factory"), "validation_failed");
    await expectCode(h.services.createSpeechJob({ ...speechJob(), audio: "AAAA" }, "factory"), "validation_failed");
    const details = await expectCode(h.services.createSpeechJob(speechJob({ model: "gemini-3-pro-image" }), "factory"), "gemini_invalid_params");
    assert.equal(details.field, "model");
    const limit = await expectCode(h.services.createSpeechJob(speechJob(), "factory"), "gemini_limit_exceeded");
    assert.equal(limit.limit, "per_job");
    // factory_gemini_create_job's own path never makes speech.
    await expectCode(h.services.createJob({ channelId: "UC1", kind: "speech", model: "gemini-3.8-flash-tts", prompt: "hi" }, "factory"), "validation_failed");
  } finally {
    await h.cleanup();
  }
});

test("AC-SP-08: a voice design is paid and recorded: refused when the switch is off, otherwise a done voice_design job with its cost (the 5 s sample: 125 tokens x $9/M = $0.0012)", async () => {
  const off = await harness({ enabled: false });
  const h = await harness();
  try {
    await expectCode(off.services.designVoice({ channelId: "UC1", description: "soft warm voice", displayName: "Sumire" }, "factory"), "gemini_disabled");
    assert.equal(off.calls.length, 0);
    const designed = await h.services.designVoice({ channelId: "UC1", description: "young adult woman, soft warm voice", displayName: "Sumire" }, "factory");
    assert.equal(designed.providerVoiceId, "voices/voice_designed1");
    assert.equal(designed.sample.extension, "wav");
    assert.equal(designed.sample.durationSeconds, 5);
    const row = h.store.jobs.get(designed.jobId)!;
    assert.deepEqual([row.kind, row.status, row.costUsd, row.costBasis], ["voice_design", "done", 0.0012, "price_table"]);
    assert.equal((await h.services.spend()).todayUsd, 0.0012, "a design counts in the spend");
    const sent = h.calls.find((c) => c.method === "designVoice")!.request as Record<string, unknown>;
    assert.equal(sent.description, "young adult woman, soft warm voice");
  } finally {
    await off.cleanup();
    await h.cleanup();
  }
});
