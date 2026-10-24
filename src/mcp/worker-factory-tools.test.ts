import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { FactoryToolDeps } from "./factory-server";
import { pinFactoryDepsToChannel, workerFactoryTools, WORKER_FACTORY_TOOL_NAMES } from "./worker-factory-tools";

// WORKER_CAPABILITIES_PLAN.md stage 3 (AC-WF-01..05): the Operator's channel tools for a worker, its own channel only. FO-REQ-0037's
// acceptance: "A test call to Japan with the Tropico token is refused." Expected behavior from the plan, not from the code.

const TROPICO = "UCa2amtpeOmgP-HkiLKPm1gg";
const JAPAN = "UC-IdugmwWRvRo9-j0yK5AbA";
const code = (expected: string) => (error: unknown) => isDomainError(error) && error.code === expected;

/** Real-looking deps that record every call; plans P-T is Tropico's, P-J Japan's. */
function fakeDeps() {
  const calls: string[] = [];
  const note = (name: string) => async (input: unknown) => {
    calls.push(`${name}:${JSON.stringify(input)}`);
    return { ok: true };
  };
  const plansGet = async (input: unknown) => {
    const planId = (input as { planId: string }).planId;
    if (planId === "P-T") return { plan: { planId, channelId: TROPICO } };
    if (planId === "P-J") return { plan: { planId, channelId: JAPAN } };
    throw new Error("plan_not_found");
  };
  const deps = {
    plans: {
      create: note("plans.create"), importPlan: note("plans.importPlan"), update: note("plans.update"), close: note("plans.close"),
      get: plansGet, list: note("plans.list"), todo: note("plans.todo"), report: note("plans.report"), runStage: note("plans.runStage"),
      rerun: note("plans.rerun"), cloneGroup: note("plans.cloneGroup"), move: note("plans.move"), requestRecheck: note("plans.requestRecheck"),
      withdrawRecheck: note("plans.withdrawRecheck"),
    },
    gemini: { getStatus: note("gemini.getStatus"), createJob: note("gemini.createJob"), getJobs: note("gemini.getJobs") },
    live: { getStatus: note("live.getStatus"), mapSources: note("live.mapSources"), setLocalizations: note("live.setLocalizations") },
    channelLocalizations: { get: note("cl.get"), save: note("cl.save") },
    storyboards: {
      create: note("sb.create"), update: note("sb.update"), get: note("sb.get"), list: note("sb.list"), submit: note("sb.submit"),
      reply: note("sb.reply"), attachRender: note("sb.attachRender"),
    },
    videos: { create: note("videos.create"), list: note("videos.list"), cost: note("videos.cost") },
    jobs: { list: note("jobs.list") },
    media: new Proxy({}, { get: (_t, name) => note(`media.${String(name)}`) }),
    readLogicalPath: note("readLogicalPath"),
    listLogicalPaths: note("listLogicalPaths"),
    listChannels: note("listChannels"),
    recordOutcome: async () => undefined,
    assertMutationAllowed: async () => undefined,
  } as unknown as FactoryToolDeps;
  return { deps, calls };
}

test("AC-WF-01: a call naming another channel is refused before the module runs", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO);
  for (const call of [
    () => pinned.plans.create({ channelId: JAPAN, planId: "x" }),
    () => pinned.storyboards.create({ channelId: JAPAN }),
    () => pinned.storyboards.get({ channelId: JAPAN, storyboardId: "s" }),
    () => pinned.videos.create({ channelId: JAPAN }),
    () => pinned.live.mapSources({ channelId: JAPAN, items: [] }),
    () => pinned.channelLocalizations.save({ channelId: JAPAN, localizations: {} }),
    () => pinned.jobs.list({ channelId: JAPAN }),
    () => pinned.live.getStatus({ channelId: JAPAN }),
    () => pinned.plans.importPlan({ plan: { channelId: JAPAN } }),
    () => pinned.storyboards.list({}),
  ]) {
    await assert.rejects(call(), code("CHANNEL_NOT_ACTIVE"));
  }
  assert.deepEqual(calls, []);
});

test("AC-WF-02: a plan of another channel behaves as not found, the own plan reaches the module", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO);
  for (const call of [() => pinned.plans.update({ planId: "P-J" }), () => pinned.plans.get({ planId: "P-J" }), () => pinned.plans.report({ planId: "P-J", rows: [] }), () => pinned.plans.update({ planId: "P-missing" })]) {
    await assert.rejects(call(), code("plan_not_found"));
  }
  assert.deepEqual(calls, []);
  await pinned.plans.close({ planId: "P-T", status: "completed" });
  assert.deepEqual(calls, ['plans.close:{"planId":"P-T","status":"completed"}']);
});

test("AC-WF-03: where the channel may be left out, the token's channel is put in", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO);
  await pinned.live.getStatus({});
  await pinned.jobs.list({ limit: 5 });
  await pinned.gemini.getJobs({});
  await pinned.plans.list({ status: "active" });
  assert.deepEqual(calls, [
    `live.getStatus:{"channelId":"${TROPICO}"}`,
    `jobs.list:{"limit":5,"channelId":"${TROPICO}"}`,
    `gemini.getJobs:{"channelId":"${TROPICO}"}`,
    `plans.list:{"status":"active","channelId":"${TROPICO}"}`,
  ]);
});

test("AC-WF-04: shared and paid deps are refused: models, templates, runtimes, sessions, GPU data, other channels, paid runs", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO);
  const refusals: Array<() => unknown> = [
    () => pinned.media.listModels(),
    () => pinned.media.startSession({ channelId: TROPICO }),
    () => pinned.media.gpuStats({}),
    () => pinned.listChannels(),
    () => pinned.readLogicalPath({ name: "x" }),
    () => pinned.plans.runStage({ planId: "P-T" }),
    () => pinned.plans.rerun({ planId: "P-T" }),
    () => pinned.plans.move({ planId: "P-T", channelId: JAPAN }),
    () => pinned.gemini.createJob({ channelId: TROPICO }),
    () => pinned.gemini.getStatus(),
  ];
  for (const call of refusals) {
    await assert.rejects(async () => call(), code("AGENT_SESSION_OPERATOR_ONLY"));
  }
  assert.deepEqual(calls, []);
});

test("AC-WF-05: the worker gets exactly the listed tools, renamed, and none of the shared or paid ones", () => {
  const { deps } = fakeDeps();
  const names = workerFactoryTools(() => deps, TROPICO).map((tool) => tool.name).sort();
  assert.deepEqual(names, [...WORKER_FACTORY_TOOL_NAMES].sort());
  assert.equal(names.length, 28);
  for (const forbidden of ["agent_plan_run_stage", "agent_plan_rerun", "agent_plan_move", "agent_gemini_create_job", "agent_media_start_session"]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  assert.ok(names.every((name) => name.startsWith("agent_")));
});

test("AC-WF-01 through the tool: agent_plan_update with the Tropico token on a Japan plan answers plan_not_found", async () => {
  const { deps, calls } = fakeDeps();
  const tool = workerFactoryTools(() => deps, TROPICO).find((entry) => entry.name === "agent_plan_update");
  assert.ok(tool);
  const result = (await tool.handler({ planId: "P-J", title: "x" })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "plan_not_found");
  assert.deepEqual(calls, []);
});
