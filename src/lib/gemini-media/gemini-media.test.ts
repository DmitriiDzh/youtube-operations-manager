import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import type { StoredGeminiCredentials, StoredGeminiMediaJob } from "@/lib/db";
import type { GeminiImageRequest, GeminiImageResult, GeminiVideoOperation, GeminiVideoRequest } from "@/lib/media-gateway";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createGeminiFiles } from "./adapters/files";
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
    async getCredentials() {
      return state.creds;
    },
    async upsertCredentials(input: Pick<StoredGeminiCredentials, "ciphertext" | "iv" | "authTag" | "keyHint" | "status" | "verifiedAt">) {
      state.creds = { id: "default", ...input, updatedAt: new Date() };
    },
    async clearCredentials() {
      state.creds = null;
    },
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
    async listJobs(filter: { channelId?: string; statuses?: readonly string[]; createdSince?: Date; limit: number }) {
      return [...state.jobs.values()]
        .filter((j) => (filter.channelId === undefined || j.channelId === filter.channelId) && (filter.statuses === undefined || filter.statuses.includes(j.status)) && (filter.createdSince === undefined || j.createdAt >= filter.createdSince))
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
    checkKey: async (_key: string): Promise<void> => undefined,
    generateImage: async (_req: GeminiImageRequest): Promise<GeminiImageResult> => ({
      images: [{ mimeType: "image/png", data: Buffer.from("PNGDATA-1") }],
      usage: { inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: { image: 1680 } },
      status: "completed",
      blockReason: null,
    }),
    startVideo: async (_req: GeminiVideoRequest): Promise<string> => "models/veo-3.1-fast-generate-preview/operations/op1",
    getVideoOperation: async (_name: string): Promise<GeminiVideoOperation> => ({ done: true, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", error: null, blockReason: null }),
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
      return behaviour.checkKey(apiKey);
    },
    async generateImage(apiKey: string, request: GeminiImageRequest) {
      calls.push({ method: "generateImage", apiKey, request });
      return behaviour.generateImage(request);
    },
    async startVideo(apiKey: string, request: GeminiVideoRequest) {
      calls.push({ method: "startVideo", apiKey, request });
      return behaviour.startVideo(request);
    },
    async getVideoOperation(apiKey: string, name: string) {
      calls.push({ method: "getVideoOperation", apiKey, request: name });
      return behaviour.getVideoOperation(name);
    },
    async downloadVideo(apiKey: string, uri: string, dest: string) {
      calls.push({ method: "downloadVideo", apiKey, request: { uri, dest } });
      return behaviour.downloadVideo(uri, dest);
    },
  };
  return { api, calls, behaviour };
}

function gatewayError(code: "gemini_unavailable" | "gemini_rate_limited" | "gemini_request_rejected" | "gemini_key_invalid" | "gemini_payment_required", details: Record<string, unknown> = {}) {
  return new DomainError({ code, message: `fake ${code}`, details: { outcome: "answered", ...details } });
}

async function harness(options: { now?: Date; enabled?: boolean; withKey?: boolean; settings?: Record<string, unknown> } = {}) {
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
  const { api, calls, behaviour } = fakeApi();
  const clock = { at: options.now ?? new Date(2026, 9, 10, 15, 0, 0) };
  const registered: Array<Record<string, unknown>> = [];
  const order: string[] = [];
  let id = 0;
  const files = createGeminiFiles();
  const deps: GeminiMediaDeps = {
    store,
    api,
    keyFile: createKeyFile(keyAccess, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
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
    isGatewayEnabled: async () => true,
    clock: { now: () => new Date(clock.at) },
    generateId: () => `id${++id}`,
    withCreateLock: (() => {
      let tail: Promise<unknown> = Promise.resolve();
      return <T>(run: () => Promise<T>) => {
        const result = tail.then(run, run);
        tail = result.catch(() => undefined);
        return result;
      };
    })(),
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
    keyFileText: () => keyFileText,
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

const videoJob = (overrides: Record<string, unknown> = {}) => ({
  channelId: "UC1",
  kind: "video",
  model: "veo-3.1-fast-generate-preview",
  prompt: "waves",
  video: { resolution: "1080p", aspectRatio: "16:9", durationSeconds: 8 },
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
  assert.equal(estimateVideoUsd({ model: "veo-3.1-fast-generate-preview", resolution: "1080p", durationSeconds: 8 }), 0.96);
  assert.equal(estimateVideoUsd({ model: "veo-3.1-lite-generate-preview", resolution: "720p", durationSeconds: 4 }), 0.2);
  assert.equal(estimateVideoUsd({ model: "veo-3.1-generate-preview", resolution: "4k", durationSeconds: 8 }), 4.8);
  // AC-GM-07's usage: 1000×1.5e-6 + 1680×30e-6 + 300×7.5e-6 = 0.0015 + 0.0504 + 0.00225 = 0.05415 → 0.0542
  assert.equal(imageCostFromUsage("gemini-nano-banana-2.1", { inputTokens: 1000, outputTokens: 1680, thoughtTokens: 300, outputByModality: { image: 1680 } }), 0.0542);
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-01

test("AC-GM-01: a key is checked with Google, stored encrypted, shown only by its last 4 characters, and removed with its key file", async () => {
  const h = await harness({ withKey: false });
  try {
    const view = await h.services.setKey({ apiKey: KEY });
    assert.deepEqual(h.calls.map((c) => [c.method, c.apiKey]), [["checkKey", KEY]]);
    assert.deepEqual([view.configured, view.keyHint, view.status], [true, "abcd", "ok"]);
    assert.ok(!JSON.stringify(view).includes(KEY.slice(0, 10)), "the view never carries the key");
    assert.ok(h.store.creds && !h.store.creds.ciphertext.includes(KEY) && !Buffer.from(h.store.creds.ciphertext, "base64").toString("utf8").includes(KEY), "stored encrypted");
    assert.ok(h.keyFileText(), "the module's key file was created");
    assert.equal(await h.services.readApiKey(), KEY);
    assert.ok(!JSON.stringify(await h.services.getStatus()).includes(KEY.slice(0, 10)));
    await h.services.clearKey();
    assert.equal(h.store.creds, null);
    assert.equal(h.keyFileText(), null, "its key file is removed too");
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
    assert.equal(h.store.creds, null);
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
    assert.deepEqual([dry.estimateUsd, dry.allowed], [0.96, false]);
    assert.deepEqual((dry.refusal as { details: unknown }).details, { limit: "per_day", limitUsd: 5, spentUsd: 4.5, estimateUsd: 0.96 });
    assert.equal(h.store.jobs.size, 2, "a dry-run stores nothing");
    const details = await expectCode(h.services.createJob(videoJob(), "factory"), "gemini_limit_exceeded");
    assert.deepEqual(details, { limit: "per_day", limitUsd: 5, spentUsd: 4.5, estimateUsd: 0.96 });
    const spend = await h.services.spend();
    assert.deepEqual([spend.todayUsd, spend.monthUsd], [4.5, 9], "yesterday's job counts toward the month only");
    assert.deepEqual(h.calls, []);
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
      [imageJob({ model: "veo-3.1-generate-preview" }), "model"],
      [videoJob({ model: "veo-3.1-lite-generate-preview", video: { resolution: "4k", aspectRatio: "16:9", durationSeconds: 8 } }), "video.resolution"],
      [videoJob({ video: { resolution: "1080p", aspectRatio: "16:9", durationSeconds: 6 } }), "video.durationSeconds"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "1:1", durationSeconds: 4 } }), "video.aspectRatio"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 5 } }), "video.durationSeconds"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { lastFrame: "a.png" } } }), "video.inputs.lastFrame"],
      [videoJob({ model: "veo-3.1-lite-generate-preview", video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { referenceImages: ["a.png"] } } }), "video.inputs.referenceImages"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 4, inputs: { referenceImages: ["a.png"] } } }), "video.durationSeconds"],
      [videoJob({ video: { resolution: "720p", aspectRatio: "16:9", durationSeconds: 8, inputs: { firstFrame: "a.png", referenceImages: ["b.png"] } } }), "video.inputs.referenceImages"],
      [videoJob({ prompt: "x".repeat(4001) }), "prompt"],
      [{ ...videoJob(), image: { size: "1K", aspectRatio: "1:1" } }, "image"],
    ];
    for (const [input, field] of cases) {
      const details = await expectCode(h.services.createJob(input, "factory"), "gemini_invalid_params");
      assert.equal(details.field, field, JSON.stringify(input));
    }
    await expectCode(h.services.createJob({ ...imageJob(), extra: 1 }, "factory"), "validation_failed");
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
    assert.deepEqual([h.registered[0].assetType, h.registered[0].referenceKind, h.registered[0].referenceValue], ["generated_image", "local_path", path.join(dir, "image-1.png")]);
  } finally {
    await h.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-08

test("AC-GM-08: a video job starts the operation, stays running while Google works, then downloads video-1.mp4 and costs its table price", async () => {
  const h = await harness();
  try {
    await writeFile(path.join(h.sent, "first.png"), "F");
    await writeFile(path.join(h.sent, "last.jpg"), "L");
    const { job } = (await h.services.createJob(videoJob({ video: { resolution: "1080p", aspectRatio: "9:16", durationSeconds: 8, inputs: { firstFrame: "first.png", lastFrame: "last.jpg" } } }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const started = h.calls[0].request as GeminiVideoRequest;
    assert.deepEqual([started.model, started.resolution, started.aspectRatio, started.durationSeconds], ["veo-3.1-fast-generate-preview", "1080p", "9:16", 8]);
    assert.deepEqual([started.firstFrame, started.lastFrame], [{ mimeType: "image/png", dataBase64: Buffer.from("F").toString("base64") }, { mimeType: "image/jpeg", dataBase64: Buffer.from("L").toString("base64") }]);
    let row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.remoteName], ["running", "models/veo-3.1-fast-generate-preview/operations/op1"]);
    h.behaviour.getVideoOperation = async () => ({ done: false });
    await h.runTick();
    assert.equal(h.calls.length, 1, "not polled before its next time");
    h.clock.at = new Date(h.clock.at.getTime() + 11_000);
    await h.runTick();
    assert.deepEqual(h.calls.map((c) => c.method), ["startVideo", "getVideoOperation"]);
    assert.equal(h.store.jobs.get(job.jobId)!.status, "running");
    h.behaviour.getVideoOperation = async () => ({ done: true, videoUri: "https://generativelanguage.googleapis.com/v1beta/files/f:download?alt=media", error: null, blockReason: null });
    h.clock.at = new Date(h.clock.at.getTime() + 11_000);
    await h.runTick();
    row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costUsd, row.costBasis], ["done", 0.96, "price_table"]);
    const dir = path.join(h.fromYtm, "gemini", job.jobId);
    assert.deepEqual(await readFile(path.join(dir, "video-1.mp4")), Buffer.from("MP4DATA"));
    assert.equal(h.registered[0].assetType, "generated_video");
    assert.equal(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")).outputs[0].path, `gemini/${job.jobId}/video-1.mp4`);
  } finally {
    await h.cleanup();
  }
});

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

test("AC-GM-09: a finished Veo operation with an error, or with no video, is not charged", async () => {
  for (const [operation, code] of [
    [{ done: true, videoUri: null, error: null, blockReason: "child safety" }, "gemini_blocked"],
    [{ done: true, videoUri: null, error: { code: "invalid_argument", message: "bad aspect" }, blockReason: null }, "gemini_invalid_request"],
  ] as const) {
    const h = await harness();
    try {
      h.behaviour.getVideoOperation = async () => operation;
      const { job } = (await h.services.createJob(videoJob(), "factory")) as { job: { jobId: string } };
      await h.runTick();
      h.clock.at = new Date(h.clock.at.getTime() + 11_000);
      await h.runTick();
      const row = h.store.jobs.get(job.jobId)!;
      assert.deepEqual([row.status, row.errorCode, row.costUsd, row.costBasis], ["failed", code, 0, "not_charged"]);
    } finally {
      await h.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------- AC-GM-10

test("AC-GM-10: at startup a job cut mid-call fails at its estimate; a running video is polled again; an uncollected video gives up after 47 h", async () => {
  const h = await harness();
  try {
    seedJob(h.store, "gm_cut", { status: "submitting", estimateUsd: 0.0656, costUsd: null, costBasis: null });
    seedJob(h.store, "gm_video", { kind: "video", model: "veo-3.1-fast-generate-preview", status: "running", remoteName: "models/veo-3.1-fast-generate-preview/operations/op9", estimateUsd: 0.96, costUsd: null, costBasis: null, submittedAt: new Date(h.clock.at.getTime() - 60_000), paramsJson: JSON.stringify({ resolution: "1080p", aspectRatio: "16:9", durationSeconds: 8 }) });
    seedJob(h.store, "gm_old", { kind: "video", status: "running", remoteName: "models/v/operations/old", estimateUsd: 0.4, costUsd: null, costBasis: null, submittedAt: new Date(h.clock.at.getTime() - 48 * 3600_000) });
    assert.equal(await h.worker.bootSweep(), 1);
    const cut = h.store.jobs.get("gm_cut")!;
    assert.deepEqual([cut.status, cut.errorCode, cut.costUsd, cut.costBasis], ["failed", "gemini_interrupted", 0.0656, "unknown_outcome"]);
    assert.equal(h.store.jobs.get("gm_video")!.status, "running");
    await h.runTick();
    assert.equal(h.store.jobs.get("gm_video")!.status, "done");
    assert.deepEqual(h.calls.filter((c) => c.method === "getVideoOperation").map((c) => c.request), ["models/veo-3.1-fast-generate-preview/operations/op9"]);
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
    seedJob(h.store, "gm_video", { kind: "video", model: "veo-3.1-fast-generate-preview", status: "running", remoteName: "models/veo-3.1-fast-generate-preview/operations/op2", estimateUsd: 0.96, costUsd: null, costBasis: null, submittedAt: h.clock.at, paramsJson: JSON.stringify({ resolution: "1080p", aspectRatio: "16:9", durationSeconds: 8 }) });
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
