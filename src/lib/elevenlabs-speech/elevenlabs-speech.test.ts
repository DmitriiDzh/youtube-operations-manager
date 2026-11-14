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
import { elevenlabsKeyFingerprint } from "./account";
import { charCount } from "./contracts";
import { createElevenlabsSpendSharePublisher } from "./spend-share";
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
  let account: string | null = null;
  return {
    jobs,
    async getSettingsJson() {
      return settings;
    },
    async setSettingsJson(json) {
      settings = json;
    },
    async getAccountJson() {
      return account;
    },
    async setAccountJson(json) {
      account = json;
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

// BL-250: the account's subscription the fake answers. By default it has NO character limit, so nothing is stored and every test
// written before BL-250 runs in state A (the owner's monthly number) unchanged; the BL-250 tests pass their own account.
type FakeAccount = { tier: string | null; characterCount: number | null; characterLimit: number | null; nextResetAt: string | null } | "fail";

async function harness(options: { enabled?: boolean; withKey?: boolean; settings?: Record<string, unknown>; now?: Date; peerSpendReports?: ElevenlabsSpeechDeps["peerSpendReports"]; account?: FakeAccount } = {}) {
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
  /** BL-250: the free account reads, kept apart from the paid calls the older tests count. */
  const subscriptionCalls: string[] = [];
  const account = { value: (options.account ?? { tier: "starter", characterCount: 500, characterLimit: null, nextResetAt: null }) as FakeAccount };
  const behaviour = {
    textToSpeech: async (): Promise<ElevenlabsSpeechResult> => ({ audio: { mimeType: "audio/mpeg", data: Buffer.from("ID3-take") }, chargedChars: 120, requestId: "r1" }),
    soundGeneration: async (): Promise<ElevenlabsSpeechResult> => ({ audio: { mimeType: "audio/mpeg", data: Buffer.from("ID3-sfx") }, chargedChars: null, requestId: "r2" }),
    composeMusic: async (): Promise<ElevenlabsSpeechResult> => ({ audio: { mimeType: "audio/mpeg", data: Buffer.from("ID3-music") }, chargedChars: null, requestId: "r3" }),
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
        subscriptionCalls.push(apiKey);
        if (account.value === "fail") throw new DomainError({ code: "elevenlabs_unavailable", message: "ElevenLabs did not answer", details: { outcome: "not_sent" } });
        return { ...account.value };
      },
      async textToSpeech(apiKey, request: ElevenlabsSpeechRequest) {
        calls.push({ method: "textToSpeech", apiKey, request });
        return behaviour.textToSpeech();
      },
      async soundGeneration(apiKey, request) {
        calls.push({ method: "soundGeneration", apiKey, request });
        return behaviour.soundGeneration();
      },
      async composeMusic(apiKey, request) {
        calls.push({ method: "composeMusic", apiKey, request });
        return behaviour.composeMusic();
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
    ...(options.peerSpendReports ? { peerSpendReports: options.peerSpendReports, log: () => undefined } : {}),
  };
  const services = createElevenlabsSpeechServices(deps);
  const worker = createElevenlabsWorker(deps);
  if (options.withKey !== false) await services.setKey({ apiKey: KEY });
  calls.length = 0;
  subscriptionCalls.length = 0; // the key save's own read is set-up, not part of a test
  await services.updateSettings({ enabled: options.enabled ?? true, ...(options.settings ?? {}) });
  return { root, fromYtm, store, calls, subscriptionCalls, account, behaviour, order, clock, services, worker, runTick: async () => Promise.all(await worker.tick()), keyFileText: () => keyFileText, cleanup: () => rm(root, { recursive: true, force: true }) };
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

// BL-236 (owner, Telegram 2026-10-29, msg 3823): the day and month character limits hold for every computer on the same ElevenLabs key.
const peer = (deviceId: string, apiKey: string, at: Date, today: number, month: number) => ({
  deviceId,
  hostname: deviceId,
  keyFingerprint: elevenlabsKeyFingerprint(apiKey),
  updatedAt: at.toISOString(),
  usedTodayChars: today,
  usedMonthChars: month,
  spentTodayUsd: 0,
  spentMonthUsd: 0,
});

test("AC-EL-SH-04: another computer's characters on the same key count against the daily limit (200 there + 100 here > 250)", async () => {
  const h = await harness({ settings: { maxCharsPerDay: 250, maxCharsPerMonth: 100_000 }, peerSpendReports: async () => [peer("pc", KEY, new Date(2026, 9, 29, 14), 200, 200)] });
  try {
    const details = await expectCode(h.services.createJob(take(), "factory"), "elevenlabs_limit_exceeded");
    assert.deepEqual([details.limit, details.usedChars, details.otherComputersChars], ["per_day", 200, 200]);
    const usage = await h.services.usage();
    assert.deepEqual([usage.account.todayChars, usage.account.keyKnown, usage.account.otherComputers.length], [200, true, 1]);
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-SH-05: the month sums too -- yesterday's 350 elsewhere + 100 here > 400 -- while the day is free", async () => {
  const h = await harness({ settings: { maxCharsPerDay: 1_000, maxCharsPerMonth: 400 }, peerSpendReports: async () => [peer("pc", KEY, new Date(2026, 9, 28, 20), 50, 350)] });
  try {
    const details = await expectCode(h.services.createJob(take(), "factory"), "elevenlabs_limit_exceeded");
    assert.deepEqual([details.limit, details.usedChars], ["per_month", 350]);
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-SH-06: a computer on a different ElevenLabs key is not summed", async () => {
  const h = await harness({ settings: { maxCharsPerDay: 250 }, peerSpendReports: async () => [peer("pc", "sk_other_account_key_000000000", new Date(2026, 9, 29, 14), 9_000, 9_000)] });
  try {
    const created = (await h.services.createJob(take(), "factory")) as { job: { jobId: string } };
    assert.ok(created.job.jobId);
    assert.equal((await h.services.usage()).account.todayChars, 100);
  } finally {
    await h.cleanup();
  }
});

test("AC-EL-SH-07: the spend report carries this computer's characters and the key's fingerprint (never the key)", async () => {
  const published: unknown[] = [];
  const publish = createElevenlabsSpendSharePublisher({
    localUsage: async () => ({ todayChars: 120, monthChars: 900, todayUsd: 0.0096, monthUsd: 0.072 }),
    keyFingerprint: async () => elevenlabsKeyFingerprint(KEY),
    deviceId: async () => "mac",
    hostname: () => "mac",
    publish: async (report) => void published.push(report),
    now: () => new Date("2026-10-29T12:00:00Z"),
  });
  assert.equal(await publish(), true);
  assert.equal(await publish(), false, "nothing changed: not rewritten within 5 minutes");
  const [report] = published as Array<Record<string, unknown>>;
  assert.deepEqual([report.format, report.usedTodayChars, report.usedMonthChars, report.keyFingerprint], ["ytm-elevenlabs-spend", 120, 900, elevenlabsKeyFingerprint(KEY)]);
  assert.equal(JSON.stringify(report).includes(KEY), false);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// BL-250 (owner msgs 4203/4205/4207; docs/roadmap/plans/ELEVENLABS_ACCOUNT_LIMIT_PLAN.md AC-EA-1..8): the monthly threshold is the
// ElevenLabs account's own, read and stored here. Numbers by hand from the plan's three-state table.
// ---------------------------------------------------------------------------------------------------------------------------------

const ACCOUNT = { tier: "creator", characterCount: 29_000, characterLimit: 30_000, nextResetAt: "2026-11-20T00:00:00.000Z" };
const doneJob = (id: string, chars: number, submittedAt: Date): StoredElevenlabsSpeechJob => ({
  jobId: id, channelId: "UC1", requestId: null, requestHash: id, kind: "speech", model: "eleven_v4", text: "x", paramsJson: "{}", status: "done",
  chars, estimateUsd: 0, costUsd: 0, costBasis: "list_price", chargedChars: chars, outputsJson: null, error: null, errorCode: null, attempts: 1,
  nextAttemptAt: null, createdBy: "factory", createdAt: submittedAt, submittedAt, finishedAt: submittedAt, updatedAt: submittedAt, video: null,
});

test("AC-EA-1/7: saving the key stores the account snapshot bound to that key; a missing limit is never stored; removing the key drops it", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z") });
  const none = await harness({ now: new Date("2026-11-14T10:00:00.000Z") });
  try {
    const snap = await h.services.accountSnapshot();
    assert.deepEqual(snap, { ...ACCOUNT, readAt: "2026-11-14T10:00:00.000Z", keyFingerprint: elevenlabsKeyFingerprint(KEY) });
    assert.equal(await none.services.accountSnapshot(), null); // the fake answers characterLimit null
    // a failed read keeps the stored snapshot
    h.account.value = "fail";
    const r = await h.services.refreshAccount();
    assert.deepEqual(r, { errorCode: "elevenlabs_unavailable" });
    assert.equal((await h.services.accountSnapshot())?.characterCount, 29_000);
    await h.services.clearKey();
    assert.equal(await h.store.getAccountJson(), null);
  } finally {
    await h.cleanup();
    await none.cleanup();
  }
});

test("AC-EA-2: state B -- limit 30 000, count 29 000 + 600 submitted after the read = 29 600; 400 fits (equal passes), 401 is per_month from the account", async () => {
  const at = new Date("2026-11-14T10:00:00.000Z");
  const h = await harness({ account: ACCOUNT, now: at, settings: { maxCharsPerJob: 5_000, maxCharsPerDay: 100_000, maxCharsPerMonth: 1_000_000 } });
  try {
    h.store.jobs.set("old", doneJob("old", 700, new Date("2026-11-14T09:00:00.000Z"))); // before the read: already in characterCount
    h.store.jobs.set("new", doneJob("new", 600, new Date("2026-11-14T10:00:01.000Z")));
    h.clock.at = new Date("2026-11-14T10:05:00.000Z"); // 5 min: fresh, no re-read
    const m = await h.services.monthlyLimit(await h.services.getSettings(), await h.services.usage());
    assert.deepEqual(m, { source: "elevenlabs_account", limitChars: 30_000, usedChars: 29_600, resetAt: ACCOUNT.nextResetAt });
    const ok = (await h.services.createJob(take({ text: "a".repeat(400), dryRun: true }), "factory")) as { allowed: boolean };
    assert.equal(ok.allowed, true);
    const no = (await h.services.createJob(take({ text: "a".repeat(401), dryRun: true }), "factory")) as { allowed: boolean; refusal: { details: Record<string, unknown> } };
    assert.equal(no.allowed, false);
    assert.deepEqual(
      { limit: no.refusal.details.limit, limitChars: no.refusal.details.limitChars, usedChars: no.refusal.details.usedChars, source: no.refusal.details.source, resetAt: no.refusal.details.resetAt },
      { limit: "per_month", limitChars: 30_000, usedChars: 29_600, source: "elevenlabs_account", resetAt: ACCOUNT.nextResetAt }
    );
    assert.equal(h.subscriptionCalls.length, 0); // fresh snapshot: no read before the takes
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-3: state A -- no snapshot (or another key's) means the owner's maxCharsPerMonth and the old counting", async () => {
  const at = new Date("2026-11-14T10:00:00.000Z");
  const h = await harness({ now: at, settings: { maxCharsPerMonth: 1_000 } });
  try {
    h.store.jobs.set("j", doneJob("j", 900, new Date("2026-11-14T09:00:00.000Z")));
    const m = await h.services.monthlyLimit(await h.services.getSettings(), await h.services.usage());
    assert.deepEqual(m, { source: "settings", limitChars: 1_000, usedChars: 900, resetAt: null });
    await h.store.setAccountJson(JSON.stringify({ ...ACCOUNT, readAt: at.toISOString(), keyFingerprint: "someoneelse" }));
    assert.equal((await h.services.monthlyLimit(await h.services.getSettings(), await h.services.usage())).source, "settings");
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-4: state C -- past the reset date only this computer's jobs since the reset count against the stored limit", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z"), enabled: false });
  try {
    h.store.jobs.set("before", doneJob("before", 5_000, new Date("2026-11-19T12:00:00.000Z")));
    h.store.jobs.set("after", doneJob("after", 250, new Date("2026-11-20T01:00:00.000Z")));
    h.clock.at = new Date("2026-11-20T02:00:00.000Z");
    const m = await h.services.monthlyLimit(await h.services.getSettings(), await h.services.usage());
    assert.deepEqual(m, { source: "elevenlabs_account", limitChars: 30_000, usedChars: 250, resetAt: null });
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-5: a take reads the account first when the snapshot is older than 10 minutes, not when fresher; a failed read keeps the stored threshold", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z"), settings: { maxCharsPerJob: 5_000, maxCharsPerDay: 100_000 } });
  try {
    h.clock.at = new Date("2026-11-14T10:09:59.000Z");
    await h.services.createJob(take({ dryRun: true }), "factory");
    assert.equal(h.subscriptionCalls.length, 0);
    h.clock.at = new Date("2026-11-14T10:10:01.000Z");
    h.account.value = { ...ACCOUNT, characterCount: 29_950 };
    await h.services.createJob(take({ dryRun: true }), "factory");
    assert.equal(h.subscriptionCalls.length, 1);
    assert.equal((await h.services.accountSnapshot())?.characterCount, 29_950);
    // 29 950 + 100 > 30 000: refused by the fresh number
    assert.equal(((await h.services.createJob(take({ dryRun: true }), "factory")) as { allowed: boolean }).allowed, false);
    h.clock.at = new Date("2026-11-14T10:30:00.000Z");
    h.account.value = "fail";
    const r = (await h.services.createJob(take({ text: "a".repeat(40), dryRun: true }), "factory")) as { allowed: boolean };
    assert.equal(r.allowed, true); // the stored 29 950 still decides: 29 950 + 40 fits
    assert.equal(h.subscriptionCalls.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-6: the loop reads at start and right after the reset date, only with the switch on", async () => {
  const off = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z"), enabled: false });
  const on = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z") });
  try {
    off.subscriptionCalls.length = 0;
    assert.deepEqual(await off.services.accountTick({ startedRead: false }), { read: false, startedRead: false, lastAttemptAt: null });
    assert.equal(off.subscriptionCalls.length, 0);
    on.subscriptionCalls.length = 0;
    const first = await on.services.accountTick({ startedRead: false });
    assert.deepEqual(first, { read: true, startedRead: true, lastAttemptAt: Date.parse("2026-11-14T10:00:00.000Z") });
    assert.deepEqual(await on.services.accountTick({ startedRead: true, lastAttemptAt: first.lastAttemptAt }), { read: false, startedRead: true, lastAttemptAt: first.lastAttemptAt }); // no periodic read
    on.clock.at = new Date("2026-11-20T00:00:30.000Z");
    assert.equal((await on.services.accountTick({ startedRead: true })).read, true); // right after the reset date
    assert.equal((await on.services.accountTick({ startedRead: true })).read, false); // read after the reset: done
    assert.equal(on.subscriptionCalls.length, 2);
  } finally {
    await off.cleanup();
    await on.cleanup();
  }
});

test("AC-EA-8: the status shows the stored threshold and what the monthly check uses, without calling ElevenLabs", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z") });
  try {
    h.subscriptionCalls.length = 0;
    const s = (await h.services.getStatus()) as { accountLimit: Record<string, unknown>; monthlyLimit: Record<string, unknown> };
    assert.deepEqual(s.accountLimit, { tier: "creator", characterLimit: 30_000, characterCount: 29_000, nextResetAt: ACCOUNT.nextResetAt, readAt: "2026-11-14T10:00:00.000Z" });
    assert.deepEqual(s.monthlyLimit, { source: "elevenlabs_account", limitChars: 30_000, usedChars: 29_000, resetAt: ACCOUNT.nextResetAt });
    assert.equal(h.subscriptionCalls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-6b (review): a failing account is not re-read every tick -- the start read is done once, a failed post-reset read retries at most hourly", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z") });
  try {
    h.account.value = "fail"; // ElevenLabs stops answering after the key was saved
    await h.store.setAccountJson(null);
    let st: { startedRead: boolean; lastAttemptAt: number | null } = { startedRead: false, lastAttemptAt: null };
    for (let i = 0; i < 5; i++) {
      st = await h.services.accountTick(st);
      h.clock.at = new Date(h.clock.at.getTime() + 30_000);
    }
    assert.equal(h.subscriptionCalls.length, 1); // five ticks, one read
    // a stored snapshot whose reset passed, and ElevenLabs failing: one read, then nothing for the next hour
    await h.store.setAccountJson(JSON.stringify({ ...ACCOUNT, readAt: "2026-11-14T10:00:00.000Z", keyFingerprint: elevenlabsKeyFingerprint(KEY) }));
    h.clock.at = new Date("2026-11-20T00:00:10.000Z");
    h.subscriptionCalls.length = 0;
    for (let i = 0; i < 10; i++) {
      st = await h.services.accountTick(st);
      h.clock.at = new Date(h.clock.at.getTime() + 30_000);
    }
    assert.equal(h.subscriptionCalls.length, 1);
    h.clock.at = new Date("2026-11-20T01:00:15.000Z");
    st = await h.services.accountTick(st);
    assert.equal(h.subscriptionCalls.length, 2); // an hour later: one retry
  } finally {
    await h.cleanup();
  }
});

test("AC-EA-2b (review): a take sent before the read but finished after it still counts (it may not have been charged when the account answered)", async () => {
  const h = await harness({ account: ACCOUNT, now: new Date("2026-11-14T10:00:00.000Z") });
  try {
    const inflight = doneJob("inflight", 2_000, new Date("2026-11-14T09:59:50.000Z"));
    inflight.finishedAt = new Date("2026-11-14T10:00:20.000Z");
    h.store.jobs.set("inflight", inflight);
    h.clock.at = new Date("2026-11-14T10:01:00.000Z");
    const m = await h.services.monthlyLimit(await h.services.getSettings(), await h.services.usage());
    assert.equal(m.usedChars, 29_000 + 2_000);
  } finally {
    await h.cleanup();
  }
});

// -- BL-253 (FO-REQ-0054, docs/roadmap/plans/ELEVENLABS_SFX_MUSIC_PLAN.md AC-1..AC-8): sound effects and music. Credits from
// elevenlabs.io (14.11): sound effects 40 per second of a given length; music about 900 per minute.
const sfx = (overrides: Record<string, unknown> = {}) => ({ channelId: "UC1", text: "soft felt ding", durationSeconds: 1.2, ...overrides });
const music = (overrides: Record<string, unknown> = {}) => ({ channelId: "UC1", prompt: "light curious explainer, pizzicato, 100 bpm", durationSeconds: 90, ...overrides });

test("BL-253 AC-1/AC-3: credits -- sfx 1.2 s = ceil(40 x 1.2) = 48, music 90 s = ceil(900 x 1.5) = 1350; a dry run sends and stores nothing", async () => {
  const h = await harness();
  const off = await harness({ enabled: false });
  try {
    const a = (await h.services.createSoundJob(sfx({ dryRun: true }), "factory", "sfx")) as Record<string, unknown>;
    assert.deepEqual([a.dryRun, a.kind, a.credits, a.allowed], [true, "sfx", 48, true]);
    const b = (await h.services.createSoundJob(music({ dryRun: true }), "factory", "music")) as Record<string, unknown>;
    assert.deepEqual([b.credits, b.allowed], [1350, true]);
    const c = (await h.services.createSoundJob(sfx({ durationSeconds: undefined, dryRun: true }), "factory", "sfx")) as Record<string, unknown>;
    assert.equal(c.credits, 1200, "no duration: the 30 s maximum is reserved");
    assert.equal(h.store.jobs.size, 0);
    assert.equal(h.calls.length, 0);
    const d = (await off.services.createSoundJob(sfx({ dryRun: true }), "factory", "sfx")) as { allowed: boolean; refusal: { code: string } };
    assert.deepEqual([d.allowed, d.refusal.code], [false, "elevenlabs_disabled"]);
    await expectCode(off.services.createSoundJob(sfx(), "factory", "sfx"), "elevenlabs_disabled");
  } finally {
    await h.cleanup();
    await off.cleanup();
  }
});

test("BL-253 AC-4/AC-6: the speech limits hold (credits); out-of-range fields are refused before anything is stored", async () => {
  const h = await harness({ settings: { maxCharsPerJob: 1000 } });
  try {
    assert.equal((await expectCode(h.services.createSoundJob(music(), "factory", "music"), "elevenlabs_limit_exceeded")).limit, "per_job");
    for (const bad of [sfx({ durationSeconds: 0.2 }), sfx({ durationSeconds: 31 }), sfx({ promptInfluence: 1.5 }), sfx({ text: "x".repeat(1001) }), sfx({ voice: "Sumire" })]) {
      await expectCode(h.services.createSoundJob(bad, "factory", "sfx"), "validation_failed");
    }
    for (const bad of [music({ durationSeconds: 5 }), music({ durationSeconds: 181 }), music({ prompt: "" })]) {
      await expectCode(h.services.createSoundJob(bad, "factory", "music"), "validation_failed");
    }
    assert.equal(h.store.jobs.size, 0);
  } finally {
    await h.cleanup();
  }
});

test("BL-253 AC-5/AC-8: the worker sends the sound and the music as ElevenLabs asks; sfx-1.mp3 / music-1.mp3, manifest last with kind and params", async () => {
  const h = await harness();
  try {
    const s = (await h.services.createSoundJob(sfx({ promptInfluence: 0.6, loop: true }), "factory", "sfx")) as { job: { jobId: string; kind: string; chars: number } };
    const m = (await h.services.createSoundJob(music(), "factory", "music")) as { job: { jobId: string } };
    assert.deepEqual([s.job.kind, s.job.chars], ["sfx", 48]);
    await h.runTick();
    const sent = Object.fromEntries(h.calls.map((c) => [c.method, c.request]));
    assert.deepEqual(sent.soundGeneration, { text: "soft felt ding", modelId: "eleven_text_to_sound_v2", outputFormat: "mp3_44100_128", durationSeconds: 1.2, promptInfluence: 0.6, loop: true });
    assert.deepEqual(sent.composeMusic, { prompt: "light curious explainer, pizzicato, 100 bpm", modelId: "music_v2_5", outputFormat: "mp3_44100_128", durationMs: 90_000, forceInstrumental: true });
    const rs = h.store.jobs.get(s.job.jobId)!;
    const rm_ = h.store.jobs.get(m.job.jobId)!;
    assert.deepEqual([rs.status, rs.chargedChars, rm_.status, rm_.chargedChars], ["done", 48, "done", 1350]);
    assert.ok(h.order.includes("write sfx-1.mp3") && h.order.includes("write music-1.mp3"));
    const man = JSON.parse(await readFile(path.join(h.fromYtm, "elevenlabs", s.job.jobId, "manifest.json"), "utf8"));
    assert.deepEqual([man.kind, man.text, man.params.durationSeconds, man.params.loop, man.voice], ["sfx", "soft felt ding", 1.2, true, undefined]);
    assert.equal(man.outputs[0].path, `elevenlabs/${s.job.jobId}/sfx-1.mp3`);
    const got = (await h.services.getJobs({ jobId: m.job.jobId })) as { job: { kind: string; params: { forceInstrumental: boolean } } };
    assert.deepEqual([got.job.kind, got.job.params.forceInstrumental], ["music", true]);
  } finally {
    await h.cleanup();
  }
});

test("BL-253 AC-2: a sound without a length reserves 1200 credits and is counted at 40 x the file's length (2 s of PCM = 80)", async () => {
  const h = await harness();
  try {
    h.behaviour.soundGeneration = async () => ({ audio: { mimeType: "application/octet-stream", data: Buffer.alloc(24_000 * 2 * 2) }, chargedChars: null, requestId: "r9" });
    const { job } = (await h.services.createSoundJob(sfx({ durationSeconds: undefined, outputFormat: "pcm_24000" }), "factory", "sfx")) as { job: { jobId: string; chars: number } };
    assert.equal(job.chars, 1200);
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.chargedChars], ["done", 80]);
    assert.ok(h.order.includes("write sfx-1.wav"));
  } finally {
    await h.cleanup();
  }
});

test("BL-253 AC-7: switched off, a queued sound is failed unsent (0 credits)", async () => {
  const h = await harness();
  try {
    const { job } = (await h.services.createSoundJob(sfx(), "factory", "sfx")) as { job: { jobId: string } };
    await h.services.updateSettings({ enabled: false });
    await h.runTick();
    const row = h.store.jobs.get(job.jobId)!;
    assert.deepEqual([row.status, row.errorCode, row.chargedChars], ["failed", "elevenlabs_disabled", 0]);
    assert.equal(h.calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("BL-253 review 1/2: an automatic-length sfx in the default mp3 is counted from size x bitrate (16 000 bytes at 128 kbps = 1 s = 40); music is priced at $0.15 a minute", async () => {
  const h = await harness();
  try {
    h.behaviour.soundGeneration = async () => ({ audio: { mimeType: "audio/mpeg", data: Buffer.alloc(16_000) }, chargedChars: null, requestId: "r10" });
    const { job } = (await h.services.createSoundJob(sfx({ durationSeconds: undefined }), "factory", "sfx")) as { job: { jobId: string } };
    const m = (await h.services.createSoundJob(music(), "factory", "music")) as { job: { jobId: string; estimateUsd: number } };
    assert.equal(m.job.estimateUsd, 0.225, "90 s at $0.15 a minute");
    await h.runTick();
    assert.equal(h.store.jobs.get(job.jobId)!.chargedChars, 40);
    assert.equal(h.store.jobs.get(m.job.jobId)!.costUsd, 0.225);
  } finally {
    await h.cleanup();
  }
});
