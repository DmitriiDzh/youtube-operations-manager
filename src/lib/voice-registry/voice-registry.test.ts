import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { StoredChannelVoice } from "@/lib/db";
import { isDomainError } from "@/lib/shared-domain";
import type { VoiceProviderPort } from "./contracts";
import { createVoiceRegistryServices, type VoiceStore } from "./services";
import { createVoiceFiles } from "./adapters/files";

// BL-236 (FO-REQ-0050 §1, ADR 0057) acceptance: a channel's voices are designed from a description (several previews kept as files),
// the owner approves ONE preview which becomes the voice; a speech job resolves only an APPROVED voice of that channel and provider;
// names are unique per channel and provider among voices that are not archived; nothing takes recorded audio. Providers are fakes.

function memoryStore(): VoiceStore & { rows: Map<string, StoredChannelVoice> } {
  const rows = new Map<string, StoredChannelVoice>();
  return {
    rows,
    async insert(row) {
      if ([...rows.values()].some((r) => r.channelId === row.channelId && r.provider === row.provider && r.status !== "archived" && r.name === row.name)) return false;
      rows.set(row.voiceId, { ...row });
      return true;
    },
    async get(voiceId) {
      return rows.get(voiceId) ?? null;
    },
    async list(filter) {
      return [...rows.values()].filter((r) => r.channelId === filter.channelId && (filter.provider === undefined || r.provider === filter.provider)).map((r) => ({ ...r }));
    },
    async update(voiceId, fromStatus, set) {
      const row = rows.get(voiceId);
      if (!row || row.status !== fromStatus) return false;
      rows.set(voiceId, { ...row, ...set });
      return true;
    },
  };
}

function fakeProvider(kind: "gemini" | "elevenlabs") {
  const calls: Array<{ method: string; input: unknown; actor?: string }> = [];
  const port: VoiceProviderPort = {
    async design(input, actor) {
      calls.push({ method: "design", input, actor });
      return {
        model: kind === "elevenlabs" ? "eleven_ttv_v3" : null,
        previews: Array.from({ length: input.count }, (_, i) => ({
          providerRef: `${kind}-ref-${i + 1}`,
          audio: { data: Buffer.from(`AUDIO-${i + 1}`), extension: kind === "gemini" ? "wav" : "mp3", mimeType: kind === "gemini" ? "audio/wav" : "audio/mpeg", sampleRateHz: kind === "gemini" ? 24_000 : null, durationSeconds: kind === "gemini" ? 3 : null },
          jobId: `job-${i + 1}`,
        })),
      };
    },
    async save(input) {
      calls.push({ method: "save", input });
      return { providerVoiceId: kind === "elevenlabs" ? `el_voice_for_${input.providerRef}` : input.providerRef };
    },
  };
  return { port, calls };
}

async function harness(options: { failWriteAt?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "voice-registry-"));
  const store = memoryStore();
  const gemini = fakeProvider("gemini");
  const elevenlabs = fakeProvider("elevenlabs");
  let id = 0;
  const workspaces: Record<string, string> = { UC1: path.join(root, "ws1"), UC2: path.join(root, "ws2") };
  // Both exchange folders exist, as in a real workspace (two first calls at once would race to create them).
  for (const dir of Object.values(workspaces)) for (const sub of ["From YTM", "Sent to YTM"]) await mkdir(path.join(dir, "99 Data Exchange", sub), { recursive: true });
  const services = createVoiceRegistryServices({
    store,
    files: (() => {
      const real = createVoiceFiles(async (channelId) => (workspaces[channelId] ? { configured: true as const, path: workspaces[channelId] } : { configured: false as const }));
      let writes = 0;
      return { ...real, write: async (p: string, data: Buffer) => {
        writes += 1;
        if (options.failWriteAt === writes) throw new Error("disk full");
        return real.write(p, data);
      } };
    })(),
    providers: { gemini: gemini.port, elevenlabs: elevenlabs.port },
    clock: { now: () => new Date(Date.UTC(2026, 9, 29, 12)) },
    generateId: () => `id${++id}`,
  });
  return { root, store, gemini, elevenlabs, services, fromYtm: (channel: string) => path.join(workspaces[channel], "99 Data Exchange", "From YTM"), cleanup: () => rm(root, { recursive: true, force: true }) };
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

const design = (overrides: Record<string, unknown> = {}) => ({ channelId: "UC1", provider: "elevenlabs", name: "Sumire", description: "young adult woman ~20, soft warm voice, calm, slightly playful", ...overrides });

test("AC-VR-01: a design keeps every preview as a file under From YTM/<provider>/voices/<voiceId>/ and the voice is a draft", async () => {
  const h = await harness();
  try {
    const { voice } = await h.services.design(design(), "factory");
    assert.equal(voice.status, "draft");
    assert.equal(voice.providerVoiceId, null);
    assert.equal(voice.previews.length, 3, "ElevenLabs gives three previews by default");
    assert.deepEqual(voice.previews.map((p) => p.file), [1, 2, 3].map((n) => `elevenlabs/voices/${voice.voiceId}/preview-${n}.mp3`));
    const files = await readdir(path.join(h.fromYtm("UC1"), "elevenlabs", "voices", voice.voiceId));
    assert.deepEqual(files.sort(), ["preview-1.mp3", "preview-2.mp3", "preview-3.mp3"]);
    assert.equal(String(await readFile(path.join(h.fromYtm("UC1"), "elevenlabs", "voices", voice.voiceId, "preview-2.mp3"))), "AUDIO-2");
    assert.equal(h.elevenlabs.calls[0].actor, "factory");
    const gemini = await h.services.design(design({ provider: "gemini", previews: 2 }), "factory");
    assert.equal(gemini.voice.previews.length, 2);
  } finally {
    await h.cleanup();
  }
});

test("AC-VR-02: a taken name is refused BEFORE the paid design; another provider or channel may use it", async () => {
  const h = await harness();
  try {
    await h.services.design(design(), "factory");
    await expectCode(h.services.design(design({ name: "sumire" }), "factory"), "voice_name_taken");
    assert.equal(h.elevenlabs.calls.filter((c) => c.method === "design").length, 1, "no second paid design");
    await h.services.design(design({ provider: "gemini" }), "factory");
    await h.services.design(design({ channelId: "UC2" }), "factory");
  } finally {
    await h.cleanup();
  }
});

test("AC-VR-03: no cloning -- a design takes a description only; an audio, file or URL field is refused", async () => {
  const h = await harness();
  try {
    await expectCode(h.services.design({ ...design(), referenceAudio: "real-person.wav" }, "factory"), "validation_failed");
    await expectCode(h.services.design({ ...design(), audio: "AAAA" }, "factory"), "validation_failed");
    await expectCode(h.services.design({ ...design(), files: ["a.mp3"] }, "factory"), "validation_failed");
    assert.equal(h.elevenlabs.calls.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("AC-VR-04: approving a preview makes the voice: ElevenLabs saves the generated voice (its voice_id), Gemini keeps the preview's voice id", async () => {
  const h = await harness();
  try {
    const el = (await h.services.design(design(), "factory")).voice;
    const approved = (await h.services.approve({ channelId: "UC1", voiceId: el.voiceId, previewId: "p2" }, "owner")).voice;
    assert.deepEqual([approved.status, approved.providerVoiceId, approved.approvedPreviewId, approved.approvedBy], ["approved", "el_voice_for_elevenlabs-ref-2", "p2", "owner"]);
    assert.deepEqual(h.elevenlabs.calls.find((c) => c.method === "save")?.input, { channelId: "UC1", name: "Sumire", description: design().description, providerRef: "elevenlabs-ref-2" });
    const gm = (await h.services.design(design({ provider: "gemini" }), "factory")).voice;
    const gApproved = (await h.services.approve({ channelId: "UC1", voiceId: gm.voiceId, previewId: "p1" }, "owner")).voice;
    assert.equal(gApproved.providerVoiceId, "gemini-ref-1");
    await expectCode(h.services.approve({ channelId: "UC1", voiceId: el.voiceId, previewId: "p1" }, "owner"), "voice_invalid_state");
    await expectCode(h.services.approve({ channelId: "UC1", voiceId: gm.voiceId, previewId: "p9" }, "owner"), "voice_invalid_state");
  } finally {
    await h.cleanup();
  }
});

test("AC-VR-05: a speech job resolves only an APPROVED voice of its channel and provider (by name or id); draft, archived, other channel, other provider are refused", async () => {
  const h = await harness();
  try {
    const draft = (await h.services.design(design({ provider: "gemini", name: "Draft" }), "factory")).voice;
    const sumire = (await h.services.design(design({ provider: "gemini" }), "factory")).voice;
    await h.services.approve({ channelId: "UC1", voiceId: sumire.voiceId, previewId: "p1" }, "owner");
    assert.deepEqual(await h.services.resolve({ channelId: "UC1", provider: "gemini", voice: "Sumire" }), { voiceId: sumire.voiceId, name: "Sumire", providerVoiceId: "gemini-ref-1" });
    assert.equal((await h.services.resolve({ channelId: "UC1", provider: "gemini", voice: sumire.voiceId })).voiceId, sumire.voiceId);
    assert.equal((await expectCode(h.services.resolve({ channelId: "UC1", provider: "gemini", voice: "Draft" }), "voice_not_approved")).reason, "draft");
    assert.equal((await expectCode(h.services.resolve({ channelId: "UC2", provider: "gemini", voice: "Sumire" }), "voice_not_approved")).reason, "not_found");
    assert.equal((await expectCode(h.services.resolve({ channelId: "UC1", provider: "elevenlabs", voice: "Sumire" }), "voice_not_approved")).reason, "other_provider");
    await h.services.update({ channelId: "UC1", voiceId: sumire.voiceId, archived: true });
    assert.equal((await expectCode(h.services.resolve({ channelId: "UC1", provider: "gemini", voice: "Sumire" }), "voice_not_approved")).reason, "archived");
    assert.ok(draft.voiceId);
  } finally {
    await h.cleanup();
  }
});

test("AC-VR-06: rename keeps names unique; an archived voice frees its name and cannot change; another channel's voice is not found", async () => {
  const h = await harness();
  try {
    const a = (await h.services.design(design({ name: "Sumire" }), "factory")).voice;
    const b = (await h.services.design(design({ name: "Other" }), "factory")).voice;
    await expectCode(h.services.update({ channelId: "UC1", voiceId: b.voiceId, name: "SUMIRE" }), "voice_name_taken");
    assert.equal((await h.services.update({ channelId: "UC1", voiceId: b.voiceId, name: "Sumire 2" })).voice.name, "Sumire 2");
    await h.services.update({ channelId: "UC1", voiceId: a.voiceId, archived: true });
    await expectCode(h.services.update({ channelId: "UC1", voiceId: a.voiceId, name: "Back" }), "voice_invalid_state");
    await h.services.design(design({ name: "Sumire" }), "factory");
    await expectCode(h.services.update({ channelId: "UC2", voiceId: b.voiceId, archived: true }), "voice_not_found");
    await expectCode(h.services.approve({ channelId: "UC2", voiceId: b.voiceId, previewId: "p1" }, "owner"), "voice_not_found");
    await expectCode(h.services.previewFile("UC2", b.voiceId, "p1"), "voice_not_found");
    const listed = await h.services.list({ channelId: "UC1" });
    assert.equal(listed.voices.length, 2, "archived voices are left out unless asked");
    assert.equal((await h.services.list({ channelId: "UC1", includeArchived: true })).voices.length, 3);
    const file = await h.services.previewFile("UC1", b.voiceId, "p1");
    assert.equal(String(await readFile(file.localPath)), "AUDIO-1");
  } finally {
    await h.cleanup();
  }
});

test("review item 2: two concurrent designs with the same name -- the draft is reserved first, so only one pays", async () => {
  const h = await harness();
  try {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const design0 = h.elevenlabs.port.design;
    h.elevenlabs.port.design = async (input, actor) => {
      await gate;
      return design0(input, actor);
    };
    const first = h.services.design(design(), "factory");
    const second = h.services.design(design(), "factory");
    const secondResult = await second.then(() => "ok", (error: unknown) => (isDomainError(error) ? error.code : "other"));
    release();
    await first;
    assert.equal(secondResult, "voice_name_taken");
    assert.equal(h.elevenlabs.calls.filter((c) => c.method === "design").length, 1, "only one paid design");
  } finally {
    await h.cleanup();
  }
});

test("review item 2: a failed design archives its reserved draft (the name is free again); previews that cannot be written leave a draft with the error", async () => {
  const h = await harness({ failWriteAt: 2 });
  try {
    const design0 = h.gemini.port.design;
    h.gemini.port.design = async () => {
      throw new Error("provider refused");
    };
    await assert.rejects(h.services.design(design({ provider: "gemini" }), "factory"), /provider refused/);
    const archived = (await h.services.list({ channelId: "UC1", includeArchived: true })).voices;
    assert.deepEqual(archived.map((v) => [v.status, v.error?.includes("provider refused")]), [["archived", true]]);
    h.gemini.port.design = design0;
    await expectCode(h.services.design(design(), "factory"), "voice_registry_unavailable");
    const [draft] = (await h.services.list({ channelId: "UC1", provider: "elevenlabs" })).voices;
    assert.equal(draft.status, "draft");
    assert.equal(draft.previews.length, 1, "the one preview written before the failure is kept");
    assert.match(draft.error ?? "", /2 of 3 previews could not be written/);
  } finally {
    await h.cleanup();
  }
});
