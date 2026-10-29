import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore } from "@/lib/device-secrets";
import type { StoredElevenlabsSpeechJob } from "@/lib/db";
import type { ElevenlabsSpeechRequest, ElevenlabsSpeechResult, ElevenlabsVoiceDesignResult } from "@/lib/media-gateway";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { charCount } from "./contracts";
import { createElevenlabsSpeechServices, type ElevenlabsSpeechDeps, type ElevenlabsStore } from "./services";
import { createElevenlabsWorker } from "./worker";

// BL-236 (FO-REQ-0050, ADR 0057) acceptance for ElevenLabs. From the owner's decisions (Telegram 2026-10-29 msgs 3814-3817): limits
// in CHARACTERS (per job / day / month) and active jobs, switch off by default, the plan's output format (default mp3_44100_128),
// designed voices only, the key never shown (last 4 only). Dollar figures by hand from R-0005's list price ($0.08 per 1,000
// characters for Eleven v4). ElevenLabs is a fake; the files go to a real temporary folder.

const KEY = "sk_live_TESTKEY_0123456789abcd";

function memoryStore(): ElevenlabsStore & { jobs: Map<string, StoredElevenlabsSpeechJob> } {
  const jobs = new Map<string, StoredElevenlabsSpeechJob>();
  let settings: string | null = null;
  return {
    jobs,
    async getSettingsJson() {
      return settings;
    },
    async setSettingsJson(json) {
      settings = json;
    },
    async insertJob(row) {
      if (row.requestId && [...jobs.values()].some((j) => j.createdBy === row.createdBy && j.requestId === row.requestId)) return false;
      jobs.set(row.jobId, { ...row });
      return true;
    },
    async getJob(jobId) {
      return jobs.get(jobId) ?? null;
    },
    async getJobByRequest(createdBy, requestId) {
      return [...jobs.values()].find((j) => j.createdBy === createdBy && j.requestId === requestId) ?? null;
    },
    async listJobs(filter) {
      return [...jobs.values()]
        .filter((j) => (filter.channelId === undefined || j.channelId === filter.channelId) && (filter.statuses === undefined || filter.statuses.includes(j.status)) && (filter.createdSince === undefined || j.createdAt >= filter.createdSince))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.jobId < b.jobId ? 1 : -1))
        .slice(0, filter.limit)
        .map((j) => ({ ...j }));
    },
    async updateJob(jobId, fromStatus, set) {
      const job = jobs.get(jobId);
      if (!job || job.status !== fromStatus) return false;
      jobs.set(jobId, { ...job, ...set });
      return true;
    },
  };
}

async function harness(options: { enabled?: boolean; withKey?: boolean; settings?: Record<string, unknown>; now?: Date } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "elevenlabs-speech-"));
  const fromYtm = path.join(root, "From YTM");
  await mkdir(fromYtm, { recursive: true });
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
    randomBytes: (size) => Buffer.alloc(size, 9),
  };
  const store = memoryStore();
  const calls: Array<{ method: string; apiKey: string; request?: unknown }> = [];
  const behaviour = {
    textToSpeech: async (): Promise<ElevenlabsSpeechResult> => ({ audio: { mimeType: "audio/mpeg", data: Buffer.from("ID3-take") }, chargedChars: 120, requestId: "r1" }),
    designVoice: async (): Promise<ElevenlabsVoiceDesignResult> => ({
      previews: [1, 2, 3].map((n) => ({ generatedVoiceId: `gen${n}`, mimeType: "audio/mpeg", data: Buffer.from(`P${n}`), durationSeconds: 4 })),
      text: null,
    }),
  };
  const order: string[] = [];
  const clock = { at: options.now ?? new Date(2026, 9, 29, 15, 0, 0) };
  let id = 0;
  const deps: ElevenlabsSpeechDeps = {
    store,
    api: {
      async getSubscription(apiKey) {
        calls.push({ method: "getSubscription", apiKey });
        return { tier: "starter", characterCount: 500, characterLimit: 30_000, nextResetAt: null };
      },
      async textToSpeech(apiKey, request: ElevenlabsSpeechRequest) {
        calls.push({ method: "textToSpeech", apiKey, request });
        return behaviour.textToSpeech();
      },
      async designVoice(apiKey, request) {
        calls.push({ method: "designVoice", apiKey, request });
        return behaviour.designVoice();
      },
      async createVoiceFromDesign(apiKey, request) {
        calls.push({ method: "createVoiceFromDesign", apiKey, request });
        return { voiceId: `saved_${request.generatedVoiceId}` };
      },
    },
    secret: createDeviceSecrets({ store: createMemoryDeviceSecretStore(), keyFile: createKeyFile(keyAccess, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })) }).slot("elevenlabs"),
    workspace: {
      async resolveOutputRoot(channelId) {
        if (channelId === "UC_NOWS") throw new DomainError({ code: "elevenlabs_workspace_unavailable", message: "no workspace" });
        return fromYtm;
      },
    },
    files: {
      async writeOutput(p, data) {
        order.push(`write ${path.basename(p)}`);
        await mkdir(path.dirname(p), { recursive: true });
        await (await import("node:fs/promises")).writeFile(p, data);
        return { bytes: data.length, sha256: "sha" };
      },
      async writeManifest(p, manifest) {
        order.push("manifest");
        await (await import("node:fs/promises")).writeFile(p, JSON.stringify(manifest));
      },
    },
    assets: { register: async () => ({ assetId: "asset-1" }), findByLocalPath: async () => null },
    device: async () => ({ deviceId: "dev-1", hostname: "mac" }),
    isChannelConnected: async (channelId) => channelId !== "UC_GONE",
    isGatewayEnabled: async () => true,
    voices: {
      async resolve(input) {
        if (input.channelId === "UC1" && input.voice === "Sumire") return { voiceId: "vc_s", name: "Sumire", providerVoiceId: "el_voice_sumire" };
        throw new DomainError({ code: "voice_not_approved", message: "not approved", details: { reason: "not_found" } });
      },
    },
    clock: { now: () => new Date(clock.at) },
    generateId: () => `id${++id}`,
    withCreateLock: async (run) => run(),
  };
  const services = createElevenlabsSpeechServices(deps);
  const worker = createElevenlabsWorker(deps);
  if (options.withKey !== false) await services.setKey({ apiKey: KEY });
  calls.length = 0;
  await services.updateSettings({ enabled: options.enabled ?? true, ...(options.settings ?? {}) });
  return { root, fromYtm, store, calls, behaviour, order, clock, services, worker, runTick: async () => Promise.all(await worker.tick()), keyFileText: () => keyFileText, cleanup: () => rm(root, { recursive: true, force: true }) };
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

const take = (overrides: Record<string, unknown> = {}) => ({ channelId: "UC1", voice: "Sumire", text: "a".repeat(100), ...overrides });

test("AC-EL-01: the switch is off by default; off or without a key nothing is created; a queued take is failed unsent (0 characters) when it goes off", async () => {
  const fresh = await harness({ withKey: false, enabled: false });
  const noKey = await harness({ withKey: false });
  const later = await harness();
  try {
    assert.equal((await fresh.services.getSettings()).enabled, false);
    await fresh.services.updateSettings({});
    await expectCode(fresh.services.createJob(take(), "factory"), "elevenlabs_disabled");
    await expectCode(noKey.services.createJob(take(), "factory"), "elevenlabs_key_missing");
    const { job } = (await later.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await later.services.updateSettings({ enabled: false });
    await later.runTick();
    const row = later.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.costBasis, row.chargedChars], ["failed", "elevenlabs_disabled", "not_charged", 0]);
    assert.equal(later.calls.length, 0);
  } finally {
    await fresh.cleanup();
    await noKey.cleanup();
    await later.cleanup();
  }
});

test("AC-EL-02: limits are characters -- per job, per day (today's used + reserved), per month, and active jobs", async () => {
  const h = await harness({ settings: { maxCharsPerJob: 100, maxCharsPerDay: 250, maxCharsPerMonth: 400, maxActiveJobs: 10 } });
  try {
    assert.equal((await expectCode(h.services.createJob(take({ text: "a".repeat(101) }), "factory"), "elevenlabs_limit_exceeded")).limit, "per_job");
    await h.services.createJob(take(), "factory");
    await h.services.createJob(take({ text: "b".repeat(100) }), "factory");
    const day = await expectCode(h.services.createJob(take({ text: "c".repeat(100) }), "factory"), "elevenlabs_limit_exceeded");
    assert.deepEqual([day.limit, day.usedChars, day.limitChars, day.chars], ["per_day", 200, 250, 100]);
    // Next day: the month (200 + 100 + 100 = 400) still fits once, then not.
    h.clock.at = new Date(2026, 9, 30, 10);
    await h.services.createJob(take({ text: "d".repeat(100) }), "factory");
    await h.services.createJob(take({ text: "e".repeat(100) }), "factory");
    assert.equal((await expectCode(h.services.createJob(take({ text: "f".repeat(50) }), "factory"), "elevenlabs_limit_exceeded")).limit, "per_month");
  } finally {
    await h.cleanup();
  }
  const active = await harness({ settings: { maxActiveJobs: 1 } });
  try {
    await active.services.createJob(take(), "factory");
    assert.equal((await expectCode(active.services.createJob(take({ text: "z" }), "factory"), "elevenlabs_limit_exceeded")).limit, "active_jobs");
  } finally {
    await active.cleanup();
  }
});

test("AC-EL-03: a take speaks the approved voice's id with the default model and format; take-1.mp3 then manifest.json last; 120 charged characters = $0.0096", async () => {
  const h = await harness();
  try {
    const { job } = (await h.services.createJob(take(), "factory")) as { job: { jobId: string; estimateUsd: number; chars: number } };
    assert.equal(job.chars, 100);
    assert.equal(job.estimateUsd, 0.008);
    await h.runTick();
    assert.deepEqual(h.calls[0].request, { voiceId: "el_voice_sumire", text: "a".repeat(100), modelId: "eleven_v4", outputFormat: "mp3_44100_128" });
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.chargedChars, row.costUsd, row.costBasis], ["done", 120, 0.0096, "list_price"]);
    assert.deepEqual(h.order, ["write take-1.mp3", "manifest"]);
    const manifest = JSON.parse(await readFile(path.join(h.fromYtm, "elevenlabs", job.jobId, "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "speech");
    assert.equal(manifest.outputs[0].path, `elevenlabs/${job.jobId}/take-1.mp3`);
    assert.equal(manifest.outputs[0].sampleRateHz, 44_100);
    assert.equal((await h.services.usage()).todayChars, 120, "the charged characters count once done");
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-04: a pcm_24000 format is saved as a WAV at 24 kHz (no resampling)", async () => {
  const h = await harness({ settings: { outputFormat: "pcm_24000" } });
  try {
    h.behaviour.textToSpeech = async () => ({ audio: { mimeType: "audio/pcm", data: Buffer.alloc(48_000) }, chargedChars: null, requestId: null });
    const { job } = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const wav = await readFile(path.join(h.fromYtm, "elevenlabs", job.jobId, "take-1.wav"));
    assert.equal(wav.readUInt32LE(24), 24_000);
    const row = h.store.jobs.get(job.jobId)!;
    assert.equal(row.chargedChars, 100, "without ElevenLabs' count, the text's characters");
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-05: only an approved voice of this channel speaks (dry run reports it); a Japanese character counts as one", async () => {
  const h = await harness();
  try {
    await expectCode(h.services.createJob(take({ voice: "Other" }), "factory"), "voice_not_approved");
    await expectCode(h.services.createJob(take({ channelId: "UC2" }), "factory"), "voice_not_approved");
    const dry = (await h.services.createJob({ ...take({ voice: "Other" }), dryRun: true }, "factory")) as { allowed: boolean; refusal: { code: string } };
    assert.deepEqual([dry.allowed, dry.refusal.code], [false, "voice_not_approved"]);
    assert.equal(h.store.jobs.size, 0);
    assert.equal(charCount("すみれです"), 5);
    const ja = (await h.services.createJob({ ...take({ text: "すみれです" }), dryRun: true }, "factory")) as { chars: number };
    assert.equal(ja.chars, 5);
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-06: the key never leaves -- not in the status, a job, the manifest or the stored hint (last 4 only)", async () => {
  const h = await harness();
  try {
    const status = await h.services.getStatus();
    assert.equal(status.keyHint, "abcd");
    assert.equal(JSON.stringify(status).includes(KEY), false);
    const { job } = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    assert.equal(JSON.stringify(await h.services.getJobs({ jobId: job.jobId })).includes(KEY), false);
    assert.equal((await readFile(path.join(h.fromYtm, "elevenlabs", job.jobId, "manifest.json"), "utf8")).includes(KEY), false);
    assert.equal(String(h.keyFileText()).includes(KEY), false, "the key file holds no key in clear");
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-07: a repeated requestId with the same take returns the first job; other words are elevenlabs_request_exists", async () => {
  const h = await harness();
  try {
    const first = (await h.services.createJob(take({ requestId: "story-1" }), "factory")) as { job: { jobId: string } };
    const again = (await h.services.createJob(take({ requestId: "story-1" }), "factory")) as { job: { jobId: string }; replayed: boolean };
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(again.replayed, true);
    await expectCode(h.services.createJob(take({ requestId: "story-1", text: "other words" }), "factory"), "elevenlabs_request_exists");
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-08: unsent (connection refused) is retried at no charge; sent and lost counts its characters (never under-counted); a block is not charged", async () => {
  const h = await harness();
  try {
    h.behaviour.textToSpeech = async () => {
      throw new DomainError({ code: "elevenlabs_unavailable", message: "refused", details: { outcome: "not_sent" } });
    };
    const a = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    assert.equal(h.store.jobs.get(a.job.jobId)!.status, "queued");
    h.store.jobs.set(a.job.jobId, { ...h.store.jobs.get(a.job.jobId)!, status: "failed" });
    h.behaviour.textToSpeech = async () => {
      throw new DomainError({ code: "elevenlabs_unavailable", message: "timeout", details: { outcome: "unknown" } });
    };
    const b = (await h.services.createJob(take({ text: "b".repeat(100) }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const lost = h.store.jobs.get(b.job.jobId)!;
    assert.deepEqual([lost.status, lost.costBasis, lost.chargedChars, lost.costUsd], ["failed", "unknown_outcome", 100, 0.008]);
    h.behaviour.textToSpeech = async () => {
      throw new DomainError({ code: "elevenlabs_request_rejected", message: "moderation", details: { outcome: "answered", blocked: true } });
    };
    const c = (await h.services.createJob(take({ text: "c".repeat(100) }), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const blocked = h.store.jobs.get(c.job.jobId)!;
    assert.deepEqual([blocked.errorCode, blocked.costBasis, blocked.chargedChars], ["elevenlabs_blocked", "not_charged", 0]);
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-09: a voice design is paid -- refused when off; otherwise its preview text counts against the limits and it is recorded done; saving a preview answers the voice id", async () => {
  const off = await harness({ enabled: false });
  const h = await harness();
  try {
    await expectCode(off.services.designVoice({ channelId: "UC1", description: "soft warm voice" }, "factory"), "elevenlabs_disabled");
    const designed = await h.services.designVoice({ channelId: "UC1", description: "young adult woman, soft warm voice", count: 2 }, "factory");
    assert.equal(designed.previews.length, 2);
    assert.deepEqual(designed.previews.map((p) => [p.generatedVoiceId, p.audio.extension]), [["gen1", "mp3"], ["gen2", "mp3"]]);
    const row = h.store.jobs.get(designed.jobId)!;
    assert.deepEqual([row.kind, row.status, row.costBasis], ["voice_design", "done", "list_price"]);
    assert.equal(row.chargedChars, row.chars);
    assert.equal((await h.services.usage()).todayChars, row.chars);
    const sent = h.calls.find((c) => c.method === "designVoice")!.request as Record<string, unknown>;
    assert.equal(sent.modelId, "eleven_ttv_v3");
    assert.equal((sent.text as string).length >= 100, true, "ElevenLabs asks for 100+ characters of preview text");
    assert.deepEqual(await h.services.saveDesignedVoice({ name: "Sumire", description: "soft", generatedVoiceId: "gen2" }), { providerVoiceId: "saved_gen2" });
  } finally {
    await off.cleanup();
    await h.cleanup();
  }
});

test("review item 1: a pcm_44100 take answered as octet-stream is a WAV at 44.1 kHz; a preview with no media type under PCM is a WAV, not .mp3", async () => {
  const h = await harness({ settings: { outputFormat: "pcm_44100" } });
  try {
    h.behaviour.textToSpeech = async () => ({ audio: { mimeType: "application/octet-stream", data: Buffer.alloc(88_200) }, chargedChars: null, requestId: null });
    const { job } = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const wav = await readFile(path.join(h.fromYtm, "elevenlabs", job.jobId, "take-1.wav"));
    assert.equal(wav.readUInt32LE(24), 44_100);
    const output = JSON.parse(h.store.jobs.get(job.jobId)!.outputsJson!)[0];
    assert.deepEqual([output.mimeType, output.sampleRateHz, output.durationSeconds], ["audio/wav", 44_100, 1]);
    h.behaviour.designVoice = async () => ({ previews: [{ generatedVoiceId: "g1", mimeType: null, data: Buffer.alloc(88_200), durationSeconds: null }], text: null });
    const designed = await h.services.designVoice({ channelId: "UC1", description: "soft warm voice", count: 1 }, "factory");
    assert.deepEqual([designed.previews[0].audio.extension, designed.previews[0].audio.sampleRateHz], ["wav", 44_100]);
  } finally {
    await h.cleanup();
  }
});

test("review item 6: an oversized answer is not retried and is counted as charged at its estimate", async () => {
  const h = await harness();
  try {
    h.behaviour.textToSpeech = async () => {
      throw new DomainError({ code: "elevenlabs_unavailable", message: "too big", details: { outcome: "unknown", oversized: true } });
    };
    const { job } = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.costBasis, row.costUsd, row.attempts], ["failed", "unknown_outcome", 0.008, 1]);
  } finally {
    await h.cleanup();
  }
});

test("review item 7: the boot sweep leaves a voice design whose call may still be running; a take left half-sent is failed", async () => {
  const h = await harness();
  try {
    const now = new Date(h.clock.at);
    const base = { channelId: "UC1", requestId: null, requestHash: "h", model: "eleven_ttv_v3", text: "t", paramsJson: "{}", status: "submitting" as const, chars: 100, estimateUsd: 0.008, costUsd: null, costBasis: null, chargedChars: null, outputsJson: null, error: null, errorCode: null, attempts: 1, nextAttemptAt: null, createdBy: "factory", createdAt: now, submittedAt: now, finishedAt: null, updatedAt: new Date(now.getTime() - 30_000), video: null };
    await h.store.insertJob({ ...base, jobId: "el_design", kind: "voice_design" });
    await h.store.insertJob({ ...base, jobId: "el_take", kind: "speech", model: "eleven_v4" });
    await h.worker.bootSweep();
    assert.equal(h.store.jobs.get("el_design")!.status, "submitting");
    assert.deepEqual([h.store.jobs.get("el_take")!.status, h.store.jobs.get("el_take")!.errorCode], ["failed", "elevenlabs_interrupted"]);
  } finally {
    await h.cleanup();
  }
});
