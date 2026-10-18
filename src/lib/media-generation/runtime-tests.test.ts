import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEDIA_SETTINGS, isDomainError, type MediaSession, type MediaSettings } from "./contracts";
import type { MediaControlEvent } from "./models";
import type { RuntimeBuildJob } from "./runtime-builds";
import { createRuntimeTestServices, runtimeTestMinutes, type RuntimeTestTemplate } from "./runtime-tests";
import { missingNodeTypes, requiredNodeTypes, type RuntimeTestResult } from "./runtimes";

// BL-200 stage 3 (POD_RUNTIMES_PLAN.md §5, AC-RT-05 and AC-RT-09; ADR 0043). AC-RT-05: the test writes the per-template result; a
// template using a class_type absent from the node list fails with that type. AC-RT-09: the test's GPU minutes never exceed
// runtimeTestMaxUsd at the session's price.

const RID = "comfy-0410-flux3";
const graph = (...types: string[]) => JSON.stringify(Object.fromEntries(types.map((t, i) => [String(i + 1), { class_type: t, inputs: {} }])));
const TEMPLATES: RuntimeTestTemplate[] = [
  { templateId: "p1-flux-schnell", version: 2, source: "factory", workflowJson: graph("CheckpointLoaderSimple", "KSampler", "SaveImage") },
  { templateId: "p3-flux3-klein-edit", version: 1, source: "factory", workflowJson: graph("ReferenceMultiLatent", "Flux3LayoutPrompt", "SaveImage") },
  { templateId: "owner-local", version: 1, source: "owner", workflowJson: graph("SAM3Segment") },
];

function harness(options: { ready?: boolean; nodes?: string[]; approved?: boolean; settings?: Partial<MediaSettings> } = {}) {
  let ready = options.ready ?? true;
  let now = new Date("2026-10-18T16:00:00Z");
  const builds: RuntimeBuildJob[] = [];
  const written: RuntimeTestResult[] = [];
  const events: MediaControlEvent[] = [];
  const started: Array<{ channelId: string; runtimeId: string; maxMinutes: number; maxUsd: number; actor: string }> = [];
  const stopped: string[] = [];
  let sessionStatus: MediaSession["status"] = "starting";
  let json: string | null = null;
  const session = (): MediaSession =>
    ({ sessionId: "s1", status: sessionStatus, startedAt: "2026-10-18T16:01:00Z", readyAt: sessionStatus === "running" ? "2026-10-18T16:01:32Z" : null, usdCharged: stopped.length > 0 ? 0.04 : null, comfyVersion: "0.41.0", error: null, stopReason: null }) as unknown as MediaSession;
  const services = createRuntimeTestServices({
    store: { getJson: async () => json, updateJson: async (mutate) => (json = mutate(json)) },
    getSettings: async () => ({ ...DEFAULT_MEDIA_SETTINGS, gpuOnDemandPricePerHr: 0.89, ...options.settings }),
    runtimes: {
      getRuntime: async (id) => {
        if (id !== RID) throw Object.assign(new Error("no such runtime"), { code: "not_found" });
        return { ready };
      },
      writeTestResult: async (_id, result) => void written.push(result),
    },
    builds: {
      start: async (runtimeId) => {
        builds.push({ jobId: "b1", runtimeId, podId: "cpu1", status: "running", startedAt: now.toISOString(), finishedAt: null, seconds: null, error: null, requestedBy: "factory", image: "img" });
        return { alreadyBuilt: false };
      },
      list: async () => builds,
    },
    sessions: {
      start: async (input) => {
        started.push(input);
        return { sessionId: "s1", approved: options.approved ?? true, heldBy: options.approved === false ? "Factory sessions are switched off (Servers → Setup)" : null };
      },
      get: async () => session(),
      readNodes: async () => ({ nodes: options.nodes ?? ["CheckpointLoaderSimple", "KSampler", "SaveImage", "ReferenceMultiLatent", "Flux3LayoutPrompt"], comfyVersion: "0.41.0" }),
      stop: async (id) => {
        stopped.push(id);
        return session();
      },
    },
    templates: async () => TEMPLATES,
    events: { record: async (e) => void events.push(e) },
    generateId: () => "t1",
    clock: { now: () => now },
  });
  return {
    services,
    builds,
    written,
    events,
    started,
    stopped,
    setReady: (v: boolean) => (ready = v),
    setSession: (s: MediaSession["status"]) => (sessionStatus = s),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

test("AC-RT-09: the test's minutes are what the owner's cap buys at the session's price (bounded to 3..15), never more", () => {
  // Expected values by hand: $0.5 at $0.89/h buys 33.7 min -> the 15 min ceiling; at $6/h exactly 5 min; at $12/h 2.5 min -> too few.
  assert.equal(runtimeTestMinutes(0.5, 0.89), 15);
  assert.equal(runtimeTestMinutes(0.5, 6), 5);
  assert.equal(runtimeTestMinutes(0.5, 12), null);
  for (const price of [0.34, 0.89, 1.99, 2.69, 6, 9.99]) {
    const minutes = runtimeTestMinutes(0.5, price);
    if (minutes !== null) assert.ok((minutes * price) / 60 <= 0.5 + 1e-9, `${minutes} min at $${price}/h`);
  }
});

test("AC-RT-05/07: a graph needs exactly its class_type values; the missing ones are named", () => {
  assert.deepEqual(requiredNodeTypes(graph("KSampler", "SaveImage", "KSampler")), ["KSampler", "SaveImage"]);
  assert.equal(requiredNodeTypes("not json"), null);
  assert.deepEqual(missingNodeTypes(graph("ReferenceMultiLatent", "SaveImage"), new Set(["SaveImage"])), ["ReferenceMultiLatent"]);
});

test("AC-RT-05/09: a built runtime -- a GPU session capped at runtimeTestMaxUsd, the node list, test.json per registry template, the session stopped", async () => {
  const h = harness();
  const job = await h.services.testRuntime({ runtimeId: RID, channelId: "UC1" }, { actor: "factory" });
  assert.equal(job.status, "starting");
  assert.deepEqual(h.started, [{ channelId: "UC1", runtimeId: RID, maxMinutes: 15, maxUsd: 0.5, actor: "factory" }]);
  await h.services.pollRuntimeTests(); // still starting
  assert.equal(h.written.length, 0);
  h.setSession("running");
  const [done] = await h.services.pollRuntimeTests();
  assert.equal(done.status, "passed");
  assert.deepEqual(h.stopped, ["s1"]);
  assert.equal(h.written.length, 1);
  const result = h.written[0];
  assert.equal(result.ok, true);
  assert.equal(result.comfyVersion, "0.41.0");
  assert.equal(result.bootSeconds, 32);
  assert.equal(result.costUsd, 0.04);
  // Registry templates only (source factory) by default; the owner's local one is not checked.
  assert.deepEqual(result.templates, [
    { templateId: "p1-flux-schnell", version: 2, ok: true, missing: [] },
    { templateId: "p3-flux3-klein-edit", version: 1, ok: true, missing: [] },
  ]);
  assert.ok(h.events.some((e) => e.action === "runtime_tested" && e.actor === "factory"));
});

test("AC-RT-05: a template using a node type the runtime lacks fails with that type; the test fails", async () => {
  const h = harness({ nodes: ["CheckpointLoaderSimple", "KSampler", "SaveImage"] });
  await h.services.testRuntime({ runtimeId: RID, channelId: "UC1" });
  h.setSession("running");
  const [done] = await h.services.pollRuntimeTests();
  assert.equal(done.status, "failed");
  assert.deepEqual(h.written[0].templates.find((t) => t.templateId === "p3-flux3-klein-edit"), { templateId: "p3-flux3-klein-edit", version: 1, ok: false, missing: ["Flux3LayoutPrompt", "ReferenceMultiLatent"] });
  assert.equal(h.written[0].ok, false);
});

test("an unbuilt runtime is built first; the session starts only once .ready exists; a failed build fails the test without a GPU session", async () => {
  const h = harness({ ready: false });
  const job = await h.services.testRuntime({ runtimeId: RID, channelId: "UC1", templateIds: ["owner-local"] });
  assert.equal(job.status, "building");
  assert.equal(h.builds.length, 1);
  assert.equal(h.started.length, 0);
  await h.services.pollRuntimeTests();
  assert.equal(h.started.length, 0, "no GPU while the build runs");
  h.setReady(true);
  h.builds[0].status = "built";
  await h.services.pollRuntimeTests();
  assert.equal(h.started.length, 1);

  const broken = harness({ ready: false });
  await broken.services.testRuntime({ runtimeId: RID, channelId: "UC1" });
  broken.builds[0].status = "failed";
  broken.builds[0].error = "pip install failed (see build.log)";
  const [failed] = await broken.services.pollRuntimeTests();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /pip install failed/);
  assert.equal(broken.started.length, 0);
});

test("a held test session is withdrawn and the test fails naming the limit; a cap too small for 3 min starts no session", async () => {
  const held = harness({ approved: false });
  const job = await held.services.testRuntime({ runtimeId: RID, channelId: "UC1" }, { actor: "factory" });
  assert.equal(job.status, "failed");
  assert.match(job.error ?? "", /held: Factory sessions are switched off/);
  assert.deepEqual(held.stopped, ["s1"]);

  const poor = harness({ settings: { runtimeTestMaxUsd: 0.04 } });
  const refused = await poor.services.testRuntime({ runtimeId: RID, channelId: "UC1" });
  assert.equal(refused.status, "failed");
  assert.equal(poor.started.length, 0);
});

test("a test session that ends before ComfyUI answers fails the test; a second test of the same runtime is refused while one is open; unknown templates are refused", async () => {
  const h = harness();
  await h.services.testRuntime({ runtimeId: RID, channelId: "UC1" });
  await assert.rejects(h.services.testRuntime({ runtimeId: RID, channelId: "UC1" }), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
  h.setSession("failed");
  const [failed] = await h.services.pollRuntimeTests();
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /ended failed before ComfyUI answered/);
  assert.equal(h.written.length, 0, "no test.json without a node list");

  const other = harness();
  await assert.rejects(other.services.testRuntime({ runtimeId: RID, channelId: "UC1", templateIds: ["nope"] }), (e: unknown) => isDomainError(e) && e.code === "media_template_not_found");
});

test("AC-RT-06 input: a test of every registry template records allTemplates; a chosen subset does not", async () => {
  const all = harness();
  await all.services.testRuntime({ runtimeId: RID, channelId: "UC1" });
  all.setSession("running");
  await all.services.pollRuntimeTests();
  assert.equal(all.written[0].allTemplates, true);
  const some = harness();
  await some.services.testRuntime({ runtimeId: RID, channelId: "UC1", templateIds: ["p1-flux-schnell"] });
  some.setSession("running");
  await some.services.pollRuntimeTests();
  assert.equal(some.written[0].allTemplates, false);
});
