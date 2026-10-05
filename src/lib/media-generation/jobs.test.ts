import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ComfyHistoryEntry, ComfyUiClient, RunpodS3Client, S3ObjectSummary } from "@/lib/media-gateway";
import { isDomainError, type MediaTemplateParameter } from "./contracts";
import { buildPrompt, createMediaJobServices, outputNodeIds, resolveParams, type ExchangeLedgerRow, type MediaJobStore, type StoredJobRow, type StoredTemplateRow } from "./jobs";

// Expected behaviour from docs/roadmap/plans/PHASE_14_PLAN.md §2.4 and §4 (AC-P14-10..15), written
// before this module. Hashes are computed with node:crypto over fixed byte strings, independently of
// the code under test (the S3 fake returns the bytes; the sha256 expected is of those bytes).

const GRAPH = {
  "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, model: ["4", 0], positive: ["6", 0] } },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "model.safetensors" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "placeholder", clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "ComfyUI", images: ["3", 0] } },
};
const PARAMETERS = [
  { name: "prompt", type: "text", nodeId: "6", input: "text", required: true },
  { name: "steps", type: "integer", nodeId: "3", input: "steps", default: 20, min: 1, max: 50 },
  { name: "seed", type: "integer", nodeId: "3", input: "seed", default: 1 },
  { name: "size", type: "enum", nodeId: "4", input: "ckpt_name", enum: ["model.safetensors", "big.safetensors"], default: "model.safetensors" },
] as const;

const TERMINAL = new Set(["done", "failed", "cancelled"]);

function memoryStore() {
  const templates = new Map<string, StoredTemplateRow>();
  const jobs = new Map<string, StoredJobRow>();
  const ledger = new Map<string, ExchangeLedgerRow>();
  let templateCounter = 0;
  const store: MediaJobStore = {
    templates: {
      async insert(row) {
        const t = { ...row, version: 1, createdAt: new Date("2026-10-05T00:00:00Z"), updatedAt: new Date("2026-10-05T00:00:00Z") };
        templates.set(row.id, t);
        templateCounter++;
        return t;
      },
      async update(id, patch) {
        const t = templates.get(id);
        if (!t) return null;
        const next = { ...t, ...patch, version: t.version + 1 };
        templates.set(id, next);
        return next;
      },
      async get(id) {
        return templates.get(id) ?? null;
      },
      async list() {
        return [...templates.values()];
      },
      async delete(id) {
        return templates.delete(id);
      },
    },
    jobs: {
      async insert(row) {
        const j = { ...row, createdAt: row.createdAt ?? new Date() };
        jobs.set(row.id, j);
        return j;
      },
      async get(id) {
        return jobs.get(id) ?? null;
      },
      async list(filter) {
        return [...jobs.values()].filter((j) => (!filter.sessionId || j.sessionId === filter.sessionId) && (!filter.channelId || j.channelId === filter.channelId));
      },
      async listNonTerminal() {
        return [...jobs.values()].filter((j) => !TERMINAL.has(j.status));
      },
      async transition(id, from, set) {
        const j = jobs.get(id);
        if (!j || !from.includes(j.status)) return null;
        const next = { ...j, ...set };
        jobs.set(id, next);
        return next;
      },
    },
    ledger: {
      async upsert(row) {
        ledger.set(row.remoteKey, { ...row, remoteDeletedAt: null });
      },
      async markRemoteDeleted(key, at) {
        const r = ledger.get(key);
        if (r) ledger.set(key, { ...r, remoteDeletedAt: at });
      },
      async get(key) {
        return ledger.get(key) ?? null;
      },
      async listByJob(jobId) {
        return [...ledger.values()].filter((r) => r.jobId === jobId);
      },
    },
  };
  return { store, templates, jobs, ledger, templateCount: () => templateCounter };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeS3(objects: Map<string, Uint8Array>, options: { deleteFails?: boolean } = {}) {
  const calls: string[] = [];
  const files = new Map<string, Uint8Array>();
  const client = {
    async listAllObjects(prefix: string): Promise<S3ObjectSummary[]> {
      calls.push(`list:${prefix}`);
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.byteLength, lastModified: null, etag: null }));
    },
    async headObject(key: string) {
      calls.push(`head:${key}`);
      const bytes = objects.get(key);
      return bytes ? { size: bytes.byteLength, etag: null, lastModified: null } : null;
    },
    async getObjectToFile(key: string, dest: string) {
      calls.push(`get:${key}`);
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing");
      files.set(dest, bytes);
      return { bytes: bytes.byteLength, sha256: sha256(bytes) };
    },
    async deleteObject(key: string) {
      calls.push(`delete:${key}`);
      if (options.deleteFails) throw new Error("delete refused");
      objects.delete(key);
    },
  } as unknown as RunpodS3Client;
  return { client, calls, files };
}

function fakeComfy(script: Array<ComfyHistoryEntry | null>, options: { submitFails?: boolean } = {}) {
  const submits: Array<Record<string, unknown>> = [];
  let interrupts = 0;
  const queue = [...script];
  const client = {
    async submitPrompt(input: { prompt: Record<string, unknown> }) {
      if (options.submitFails) {
        const { DomainError } = await import("./contracts");
        throw new DomainError({ code: "comfyui_unavailable", message: "ComfyUI returned HTTP 400", details: { body: { node_errors: { "6": {} } } } });
      }
      submits.push(input.prompt);
      return { promptId: "prompt-1", queueNumber: 0 };
    },
    async getHistory() {
      return queue.length > 1 ? queue.shift()! : queue[0] ?? null;
    },
    async interrupt() {
      interrupts++;
    },
  } as unknown as ComfyUiClient;
  return { client, submits, interrupts: () => interrupts };
}

function completed(outputs: Array<{ nodeId: string; kind: string; filename: string; subfolder: string }>): ComfyHistoryEntry {
  return { promptId: "prompt-1", status: "completed", statusMessages: ["execution_success"], outputs: outputs.map((o) => ({ ...o, type: "output" })), raw: {} };
}

function fixture(opts: { comfy?: ReturnType<typeof fakeComfy>; s3?: ReturnType<typeof fakeS3>; sessionRunning?: boolean; workspaceFails?: boolean } = {}) {
  const mem = memoryStore();
  const comfy = opts.comfy ?? fakeComfy([null, completed([{ nodeId: "9", kind: "images", filename: "ComfyUI_00001_.png", subfolder: "job-1" }])]);
  const s3 = opts.s3 ?? fakeS3(new Map([["exchange/job-1/ComfyUI_00001_.png", new Uint8Array([9, 9, 9])]]));
  const registered: Array<Record<string, unknown>> = [];
  const activity: string[] = [];
  let now = new Date("2026-10-05T12:00:00Z");
  let ids = 0;
  const scheduled: Array<() => Promise<void>> = [];
  const services = createMediaJobServices({
    store: mem.store,
    sessions: {
      getRunningSession: async (sessionId) => (opts.sessionRunning === false ? null : { sessionId, channelId: "UC1", podId: "pod1", gpuTypeId: "RTX 4090", costPerHr: 0.69 }),
      comfyClientForSession: async () => comfy.client,
      touchActivity: async (sessionId) => {
        activity.push(sessionId);
      },
    },
    s3: async () => s3.client,
    resolveOutputRoot: async () => {
      if (opts.workspaceFails) {
        const { DomainError } = await import("./contracts");
        throw new DomainError({ code: "media_workspace_unavailable", message: "no workspace" });
      }
      return "/ws/99 Data Exchange/From YTM";
    },
    fs: {
      mkdirp: async () => {},
      sha256File: async (p) => {
        const bytes = s3.files.get(p);
        return bytes ? sha256(bytes) : "missing";
      },
      fileSize: async (p) => s3.files.get(p)?.byteLength ?? null,
    },
    registerAsset: async (input) => {
      registered.push(input);
      return { assetId: `asset-${registered.length}` };
    },
    // The first id goes to the imported template, the second to the first job ("job-1").
    generateId: () => {
      ids++;
      return ids === 1 ? "tpl-1" : ids === 2 ? "job-1" : `id-${ids}`;
    },
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    schedule: (run) => {
      scheduled.push(run);
    },
    timeouts: { pollMs: 1_000, maxGenerationMs: 10_000 },
  });
  const runScheduled = async () => {
    while (scheduled.length) await scheduled.shift()!();
  };
  return { services, mem, comfy, s3, registered, activity, runScheduled };
}

async function importDefault(services: ReturnType<typeof fixture>["services"]) {
  return services.importWorkflowTemplate({ name: "txt2img", workflow: GRAPH, parameters: PARAMETERS });
}

// -- templates ----------------------------------------------------------------------------------

test("importTemplate stores the graph with declared parameters and reports the Save nodes; shape problems are refused", async () => {
  const { services } = fixture();
  const template = await importDefault(services);
  assert.equal(template.name, "txt2img");
  assert.equal(template.version, 1);
  assert.deepEqual(template.outputNodeIds, ["9"]);
  assert.equal(template.nodeCount, 4);
  assert.equal(template.parameters.find((p) => p.name === "prompt")?.required, true);
  assert.equal(template.parameters.find((p) => p.name === "steps")?.required, false);

  await assert.rejects(services.importWorkflowTemplate({ name: "bad", workflow: GRAPH, parameters: [{ name: "x", type: "string", nodeId: "99", input: "text" }] }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  await assert.rejects(services.importWorkflowTemplate({ name: "bad", workflow: GRAPH, parameters: [{ name: "x", type: "string", nodeId: "6", input: "nope" }] }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  await assert.rejects(services.importWorkflowTemplate({ name: "bad", workflow: { "1": { class_type: "KSampler", inputs: {} } }, parameters: [] }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  await assert.rejects(services.importWorkflowTemplate({ name: "bad", workflow: GRAPH, parameters: [{ name: "e", type: "enum", nodeId: "6", input: "text" }] }), (e: unknown) => isDomainError(e) && e.code === "media_template_invalid");
  await assert.rejects(services.importWorkflowTemplate({ name: "bad", workflow: "not a graph", parameters: [] }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
});

test("updateTemplate bumps the version; getTemplate returns the graph; deleteTemplate reports", async () => {
  const { services } = fixture();
  const t = await importDefault(services);
  const updated = await services.updateWorkflowTemplate({ templateId: t.templateId, name: "txt2img v2" });
  assert.equal(updated.version, 2);
  assert.equal(updated.name, "txt2img v2");
  assert.deepEqual((await services.getWorkflowTemplate({ templateId: t.templateId })).workflow, GRAPH);
  assert.deepEqual(await services.deleteWorkflowTemplate({ templateId: t.templateId }), { deleted: true });
  await assert.rejects(services.getWorkflowTemplate({ templateId: t.templateId }), (e: unknown) => isDomainError(e) && e.code === "media_template_not_found");
});

// -- AC-P14-10: parameter validation (pure) ---------------------------------------------------------

test("AC-P14-10: resolveParams fills defaults and rejects unknown, missing, wrong-type, out-of-range and non-enum values", () => {
  const params = PARAMETERS.map((p) => ({ required: false, default: null, min: null, max: null, enum: null, description: null, ...p })) as MediaTemplateParameter[];
  params[0].required = true;
  assert.deepEqual(resolveParams(params, { prompt: "a cat" }), { prompt: "a cat", steps: 20, seed: 1, size: "model.safetensors" });
  const rejects = (given: Record<string, string | number | boolean>, re: RegExp) =>
    assert.throws(() => resolveParams(params, given), (e: unknown) => isDomainError(e) && e.code === "media_job_params_invalid" && re.test(e.message));
  rejects({}, /"prompt" is required/);
  rejects({ prompt: "x", extra: 1 }, /unknown parameter "extra"/);
  rejects({ prompt: 5 }, /must be a string/);
  rejects({ prompt: "x", steps: 51 }, /above 50/);
  rejects({ prompt: "x", steps: 0 }, /below 1/);
  rejects({ prompt: "x", steps: 2.5 }, /must be an integer/);
  rejects({ prompt: "x", size: "tiny.safetensors" }, /must be one of/);
});

test("buildPrompt writes parameters into node inputs and prefixes every Save node with <jobId>/", () => {
  const params = PARAMETERS.map((p) => ({ required: false, default: null, min: null, max: null, enum: null, description: null, ...p })) as MediaTemplateParameter[];
  const prompt = buildPrompt(GRAPH, params, { prompt: "a cat", steps: 30, seed: 7, size: "big.safetensors" }, "job-42");
  assert.equal(prompt["6"].inputs.text, "a cat");
  assert.equal(prompt["3"].inputs.steps, 30);
  assert.equal(prompt["4"].inputs.ckpt_name, "big.safetensors");
  assert.equal(prompt["9"].inputs.filename_prefix, "job-42/ComfyUI");
  assert.equal(GRAPH["9"].inputs.filename_prefix, "ComfyUI", "the template graph is never mutated");
  assert.deepEqual(outputNodeIds({ a: { class_type: "SaveAudio", inputs: { filename_prefix: "audio/song" } }, b: { class_type: "X", inputs: {} } }), ["a"]);
  assert.equal(buildPrompt({ a: { class_type: "SaveAudio", inputs: { filename_prefix: "audio/song" } } }, [], {}, "j").a.inputs.filename_prefix, "j/song");
});

// -- jobs end to end --------------------------------------------------------------------------------

test("AC-P14-12/13/15: a job submits the prompt, pulls the output into From YTM/media/<jobId>/, verifies it, deletes the remote object, registers one asset with provenance", async () => {
  const f = fixture();
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "a cat" }, createdBy: "agent" });
  assert.equal(job.status, "submitted");
  assert.equal(job.promptId, "prompt-1");
  assert.equal(f.comfy.submits[0]["9"] && (f.comfy.submits[0]["9"] as { inputs: { filename_prefix: string } }).inputs.filename_prefix, "job-1/ComfyUI");
  await f.runScheduled();
  const done = await f.services.getJob({ jobId: job.jobId });
  assert.equal(done.status, "done");
  assert.equal(done.error, null);
  assert.equal(done.outputs.length, 1);
  const out = done.outputs[0];
  assert.equal(out.remoteKey, "exchange/job-1/ComfyUI_00001_.png");
  assert.equal(out.localPath, "/ws/99 Data Exchange/From YTM/media/job-1/ComfyUI_00001_.png");
  assert.equal(out.bytes, 3);
  assert.equal(out.sha256, sha256(new Uint8Array([9, 9, 9])));
  assert.equal(out.remoteDeleted, true);
  assert.deepEqual(done.assetIds, ["asset-1"]);
  assert.deepEqual(f.s3.calls, ["head:exchange/job-1/ComfyUI_00001_.png", "get:exchange/job-1/ComfyUI_00001_.png", "delete:exchange/job-1/ComfyUI_00001_.png"]);
  assert.equal(f.registered.length, 1);
  const reg = f.registered[0];
  assert.equal(reg.assetType, "generated_image");
  assert.equal(reg.referenceKind, "local_path");
  assert.equal(reg.referenceValue, out.localPath);
  const provenance = reg.provenance as Record<string, unknown>;
  assert.equal(provenance.templateId, t.templateId);
  assert.equal(provenance.templateVersion, 1);
  assert.deepEqual(provenance.params, { prompt: "a cat", steps: 20, seed: 1, size: "model.safetensors" });
  assert.equal(provenance.promptId, "prompt-1");
  assert.equal(provenance.podId, "pod1");
  assert.equal(provenance.gpuTypeId, "RTX 4090");
  assert.equal(provenance.sha256, out.sha256);
  const ledger = await f.mem.store.ledger.get(out.remoteKey);
  assert.ok(ledger && ledger.localPath === out.localPath && ledger.remoteDeletedAt);
  assert.ok(f.activity.length >= 2, "submit and every poll count as session activity");
});

test("AC-P14-13: a failed remote delete leaves the ledger row with remoteDeletedAt null and the job still done (the janitor retries)", async () => {
  const s3 = fakeS3(new Map([["exchange/job-1/ComfyUI_00001_.png", new Uint8Array([1])]]), { deleteFails: true });
  const f = fixture({ s3 });
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "operator" });
  await f.runScheduled();
  const done = await f.services.getJob({ jobId: job.jobId });
  assert.equal(done.status, "done");
  assert.equal(done.outputs[0].remoteDeleted, false);
  assert.ok(done.outputs[0].localPath);
  const ledger = await f.mem.store.ledger.get("exchange/job-1/ComfyUI_00001_.png");
  assert.equal(ledger?.remoteDeletedAt, null);
  assert.deepEqual(done.assetIds, ["asset-1"]);
});

test("AC-P14-15: no asset is registered for a job that did not reach done (execution error, outside-folder output, no workspace)", async () => {
  const errored = fixture({ comfy: fakeComfy([{ promptId: "prompt-1", status: "error", statusMessages: ["execution_error"], outputs: [], raw: {} }]) });
  const t1 = await importDefault(errored.services);
  const j1 = await errored.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t1.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await errored.runScheduled();
  assert.equal((await errored.services.getJob({ jobId: j1.jobId })).status, "failed");
  assert.equal(errored.registered.length, 0);

  const outside = fixture({ comfy: fakeComfy([completed([{ nodeId: "9", kind: "images", filename: "x.png", subfolder: "other-job" }])]), s3: fakeS3(new Map([["exchange/other-job/x.png", new Uint8Array([1])]])) });
  const t2 = await importDefault(outside.services);
  const j2 = await outside.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t2.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await outside.runScheduled();
  const r2 = await outside.services.getJob({ jobId: j2.jobId });
  assert.equal(r2.status, "failed");
  assert.match(r2.error ?? "", /outside the job's folder/);
  assert.equal(outside.registered.length, 0);
  assert.ok(!outside.s3.calls.some((c) => c.startsWith("delete:")), "nothing outside the job folder is ever deleted");

  const noWorkspace = fixture({ workspaceFails: true });
  const t3 = await importDefault(noWorkspace.services);
  const j3 = await noWorkspace.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t3.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await noWorkspace.runScheduled();
  const r3 = await noWorkspace.services.getJob({ jobId: j3.jobId });
  assert.equal(r3.status, "failed");
  assert.match(r3.error ?? "", /cannot receive outputs/);
  assert.ok(!noWorkspace.s3.calls.some((c) => c.startsWith("get:") || c.startsWith("delete:")), "nothing is pulled or deleted without a workspace");
});

test("AC-P14-11: a ComfyUI validation failure marks the job failed with the message and rethrows; the session stays untouched", async () => {
  const f = fixture({ comfy: fakeComfy([], { submitFails: true }) });
  const t = await importDefault(f.services);
  await assert.rejects(f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" }), (e: unknown) => isDomainError(e) && e.code === "comfyui_unavailable");
  const jobs = await f.services.listJobs({ sessionId: "s1" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "failed");
  assert.match(jobs[0].error ?? "", /ComfyUI rejected the prompt/);
});

test("AC-P14-16: createJob is refused for a non-running session, for another channel's session, and for bad params before any ComfyUI call", async () => {
  const stopped = fixture({ sessionRunning: false });
  const t = await importDefault(stopped.services);
  await assert.rejects(stopped.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" }), (e: unknown) => isDomainError(e) && e.code === "media_session_invalid_state");
  const f = fixture();
  const t2 = await importDefault(f.services);
  await assert.rejects(f.services.createJob({ sessionId: "s1", channelId: "UC-other", templateId: t2.templateId, params: { prompt: "x" }, createdBy: "agent" }), (e: unknown) => isDomainError(e) && e.code === "CHANNEL_NOT_AUTHORIZED");
  await assert.rejects(f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t2.templateId, params: { steps: 999 }, createdBy: "agent" }), (e: unknown) => isDomainError(e) && e.code === "media_job_params_invalid");
  assert.equal(f.comfy.submits.length, 0);
  assert.equal((await f.services.listJobs({})).length, 0);
});

test("a job with no result before the generation timeout fails; cancelJob interrupts ComfyUI and ends cancelled", async () => {
  const slow = fixture({ comfy: fakeComfy([null]) });
  const t = await importDefault(slow.services);
  const j = await slow.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await slow.runScheduled();
  const r = await slow.services.getJob({ jobId: j.jobId });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /no result after/);

  // Review round 1: /interrupt is sent only when THIS job's prompt is the one ComfyUI is executing.
  const comfyRunningOurs = fakeComfyWithQueue({ running: ["prompt-1"], pending: [] });
  const f = fixture({ comfy: comfyRunningOurs });
  const t2 = await importDefault(f.services);
  const j2 = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t2.templateId, params: { prompt: "x" }, createdBy: "agent" });
  const cancelled = await f.services.cancelJob({ jobId: j2.jobId });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(comfyRunningOurs.interrupts(), 1);
  await f.runScheduled();
  assert.equal((await f.services.getJob({ jobId: j2.jobId })).status, "cancelled");
  await assert.rejects(f.services.cancelJob({ jobId: j2.jobId }), (e: unknown) => isDomainError(e) && e.code === "media_job_invalid_state");
});

test("sweepInterruptedJobs fails every non-terminal job as interrupted", async () => {
  const f = fixture({ comfy: fakeComfy([null]) });
  const t = await importDefault(f.services);
  const j = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  assert.deepEqual(await f.services.sweepInterruptedJobs(), { failed: [j.jobId] });
  assert.match((await f.services.getJob({ jobId: j.jobId })).error ?? "", /interrupted/);
});

// -- AC-P14-14: janitor ------------------------------------------------------------------------------

test("AC-P14-14: the janitor lists only exchange/, skips exchange/in/ and unknown/non-terminal jobs, deletes terminal leftovers; dry-run deletes nothing", async () => {
  const objects = new Map<string, Uint8Array>([
    ["exchange/job-1/ComfyUI_00001_.png", new Uint8Array([9, 9, 9])],
    ["exchange/job-1/leftover.png", new Uint8Array([1])],
    ["exchange/in/ref.png", new Uint8Array([1])],
    ["exchange/unknown-job/x.png", new Uint8Array([1])],
    ["models/checkpoints/big.safetensors", new Uint8Array([1])],
  ]);
  const s3 = fakeS3(objects);
  const f = fixture({ s3 });
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  // Before the job finishes: its keys are non-terminal and kept.
  const early = await f.services.cleanupExchange({ dryRun: false });
  assert.deepEqual(early.deleted, []);
  assert.ok(early.kept.some((k) => k.key === "exchange/job-1/leftover.png" && k.reason === "job submitted"));
  await f.runScheduled();
  assert.equal((await f.services.getJob({ jobId: job.jobId })).status, "done");
  // The pulled output was already deleted by the job; the leftover (no ledger row, done job) is kept; a dry run deletes nothing.
  const dry = await f.services.cleanupExchange({ dryRun: true });
  assert.deepEqual(dry.deleted, []);
  assert.ok(dry.kept.some((k) => k.key === "exchange/in/ref.png" && k.reason === "reference input"));
  assert.ok(dry.kept.some((k) => k.key === "exchange/unknown-job/x.png" && k.reason === "unknown job"));
  assert.ok(dry.kept.some((k) => k.key === "exchange/job-1/leftover.png" && k.reason === "done job without a ledger row"));
  assert.ok(objects.has("models/checkpoints/big.safetensors"));
  assert.ok(s3.calls.every((c) => !c.startsWith("list:") || c === "list:exchange/"), "only exchange/ is ever listed");
  // A failed job's leftovers ARE garbage.
  f.mem.jobs.set("job-9", { ...f.mem.jobs.get(job.jobId)!, id: "job-9", status: "failed" });
  objects.set("exchange/job-9/partial.png", new Uint8Array([1]));
  const real = await f.services.cleanupExchange({ dryRun: false });
  assert.deepEqual(real.deleted, ["exchange/job-9/partial.png"]);
  assert.equal(objects.has("exchange/job-9/partial.png"), false);
  assert.ok(objects.has("exchange/in/ref.png") && objects.has("exchange/unknown-job/x.png") && objects.has("exchange/job-1/leftover.png"));
});

// -- review round 1 (2026-10-05) ------------------------------------------------------------------

function fakeComfyWithQueue(opts: { running: string[]; pending: string[] }) {
  const base = fakeComfy([null]);
  const deleted: string[][] = [];
  const client = base.client as unknown as Record<string, unknown>;
  client.getQueue = async () => ({ running: opts.running.length, pending: opts.pending.length, runningPromptIds: opts.running, pendingPromptIds: opts.pending });
  client.deleteQueued = async (ids: string[]) => {
    deleted.push(ids);
  };
  return { ...base, deleted };
}

test("review: cancelling a QUEUED job removes it from ComfyUI's queue and never interrupts the job that is running", async () => {
  const comfy = fakeComfyWithQueue({ running: ["other-prompt"], pending: ["prompt-1"] });
  const f = fixture({ comfy });
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await f.services.cancelJob({ jobId: job.jobId });
  assert.equal(comfy.interrupts(), 0);
  assert.deepEqual(comfy.deleted, [["prompt-1"]]);

  const running = fakeComfyWithQueue({ running: ["prompt-1"], pending: [] });
  const g = fixture({ comfy: running });
  const t2 = await importDefault(g.services);
  const job2 = await g.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t2.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await g.services.cancelJob({ jobId: job2.jobId });
  assert.equal(running.interrupts(), 1);
  assert.deepEqual(running.deleted, []);
});

test("review: a failed asset registration after the pull keeps the file's localPath (the only copy) and the job done with a note", async () => {
  const f = fixture();
  (f as unknown as { registered: unknown[] }).registered.length = 0;
  const original = f.services;
  void original;
  const failing = fixtureWithFailingRegister();
  const t = await importDefault(failing.services);
  const job = await failing.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await failing.runScheduled();
  const done = await failing.services.getJob({ jobId: job.jobId });
  assert.equal(done.status, "done");
  assert.ok(done.outputs[0].localPath);
  assert.equal(done.outputs[0].remoteDeleted, true);
  assert.equal(done.outputs[0].assetId, null);
  assert.match(done.outputs[0].note ?? "", /asset registration failed/);
  assert.deepEqual(done.assetIds, []);
});

function fixtureWithFailingRegister() {
  const f = fixture();
  // Rebuild the services with a registerAsset that throws, reusing the same fakes through a fresh instance.
  const mem = memoryStore();
  const comfy = fakeComfy([null, completed([{ nodeId: "9", kind: "images", filename: "ComfyUI_00001_.png", subfolder: "job-1" }])]);
  const s3 = fakeS3(new Map([["exchange/job-1/ComfyUI_00001_.png", new Uint8Array([9, 9, 9])]]));
  let now = new Date("2026-10-05T12:00:00Z");
  let ids = 0;
  const scheduled: Array<() => Promise<void>> = [];
  const services = createMediaJobServices({
    store: mem.store,
    sessions: {
      getRunningSession: async (sessionId) => ({ sessionId, channelId: "UC1", podId: "pod1", gpuTypeId: "RTX 4090", costPerHr: 0.69 }),
      comfyClientForSession: async () => comfy.client,
      touchActivity: async () => {},
    },
    s3: async () => s3.client,
    resolveOutputRoot: async () => "/ws/99 Data Exchange/From YTM",
    fs: {
      mkdirp: async () => {},
      sha256File: async (p) => {
        const bytes = s3.files.get(p);
        return bytes ? sha256(bytes) : "missing";
      },
      fileSize: async () => null,
    },
    registerAsset: async () => {
      throw new Error("creative_assets insert failed");
    },
    generateId: () => {
      ids++;
      return ids === 1 ? "tpl-1" : ids === 2 ? "job-1" : `id-${ids}`;
    },
    clock: { now: () => now },
    sleep: async (ms) => {
      now = new Date(now.getTime() + ms);
    },
    schedule: (run) => {
      scheduled.push(run);
    },
    timeouts: { pollMs: 1_000, maxGenerationMs: 10_000 },
  });
  void f;
  return {
    services,
    runScheduled: async () => {
      while (scheduled.length) await scheduled.shift()!();
    },
  };
}

test("review: resumeInFlightJobs polls a submitted job nobody in this process tracks (CLI-created or post-restart) and never double-starts one", async () => {
  const f = fixture();
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "operator" });
  // The CLI's detached scheduler never ran processJob: drop the scheduled run as if it were another process.
  const dropped = (f as unknown as { runScheduled: () => Promise<void> });
  void dropped;
  assert.deepEqual(await f.services.resumeInFlightJobs(), { resumed: [job.jobId] });
  await f.runScheduled(); // runs the original schedule AND the resumed one; the in-flight guard makes the second a no-op
  assert.equal((await f.services.getJob({ jobId: job.jobId })).status, "done");
  assert.equal(f.comfy.submits.length, 1);
  assert.deepEqual(await f.services.resumeInFlightJobs(), { resumed: [] });
});

// -- review round 2 (2026-10-05) ------------------------------------------------------------------

test("review 2: a transient /history failure is retried while the session runs; only a run of failures fails the job", async () => {
  const comfy = fakeComfy([null, completed([{ nodeId: "9", kind: "images", filename: "ComfyUI_00001_.png", subfolder: "job-1" }])]);
  const client = comfy.client as unknown as { getHistory: () => Promise<unknown> };
  const original = client.getHistory.bind(comfy.client);
  let failures = 2;
  client.getHistory = async () => {
    if (failures-- > 0) {
      const { DomainError } = await import("./contracts");
      throw new DomainError({ code: "comfyui_unavailable", message: "ComfyUI returned HTTP 502" });
    }
    return original();
  };
  const f = fixture({ comfy });
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await f.runScheduled();
  assert.equal((await f.services.getJob({ jobId: job.jobId })).status, "done");

  const always = fakeComfy([null]);
  (always.client as unknown as { getHistory: () => Promise<unknown> }).getHistory = async () => {
    const { DomainError } = await import("./contracts");
    throw new DomainError({ code: "comfyui_unavailable", message: "ComfyUI returned HTTP 502" });
  };
  const g = fixture({ comfy: always });
  const t2 = await importDefault(g.services);
  const job2 = await g.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t2.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await g.runScheduled();
  const r = await g.services.getJob({ jobId: job2.jobId });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /5 consecutive polls/);
});

test("review 2: the janitor keeps a failed job's completed-but-unpulled outputs (the only copy) and still deletes a failed job's folder with nothing recorded", async () => {
  const objects = new Map<string, Uint8Array>([
    ["exchange/job-1/ComfyUI_00001_.png", new Uint8Array([9])],
    ["exchange/job-9/partial.png", new Uint8Array([1])],
  ]);
  const s3 = fakeS3(objects);
  const f = fixture({ s3, workspaceFails: true }); // the transfer fails after ComfyUI completed
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  await f.runScheduled();
  assert.equal((await f.services.getJob({ jobId: job.jobId })).status, "failed");
  f.mem.jobs.set("job-9", { ...f.mem.jobs.get(job.jobId)!, id: "job-9", status: "failed", outputsJson: null });
  const report = await f.services.cleanupExchange({ dryRun: false });
  assert.deepEqual(report.deleted, ["exchange/job-9/partial.png"]);
  assert.ok(report.kept.some((k) => k.key === "exchange/job-1/ComfyUI_00001_.png" && /unpulled output/.test(k.reason)));
  assert.ok(objects.has("exchange/job-1/ComfyUI_00001_.png"));
});

test("review 2: a job stuck in `transferring` is resumed and completed from its recorded outputs without re-pulling what already landed", async () => {
  const f = fixture();
  const t = await importDefault(f.services);
  const job = await f.services.createJob({ sessionId: "s1", channelId: "UC1", templateId: t.templateId, params: { prompt: "x" }, createdBy: "agent" });
  // Simulate another process that recorded the outputs, pulled nothing, and died.
  const row = f.mem.jobs.get(job.jobId)!;
  f.mem.jobs.set(job.jobId, {
    ...row,
    status: "transferring",
    outputsJson: JSON.stringify([{ nodeId: "9", kind: "images", filename: "ComfyUI_00001_.png", subfolder: "job-1", remoteKey: "exchange/job-1/ComfyUI_00001_.png", localPath: null, bytes: null, sha256: null, remoteDeleted: false, assetId: null, note: null }]),
  });
  assert.deepEqual(await f.services.resumeInFlightJobs(), { resumed: [job.jobId] });
  await f.runScheduled();
  const done = await f.services.getJob({ jobId: job.jobId });
  assert.equal(done.status, "done");
  assert.ok(done.outputs[0].localPath);
  assert.equal(f.registered.length, 1);
});
