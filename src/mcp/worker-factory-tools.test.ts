import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, isDomainError } from "@/lib/shared-domain";
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
    gemini: {
      getStatus: note("gemini.getStatus"),
      createJob: async (input: unknown) => {
        if ((input as { requestId?: string }).requestId === "used-by-japan") {
          throw new DomainError({ code: "gemini_request_exists", message: "requestId used by job G-J", details: { jobId: "G-J" } });
        }
        return note("gemini.createJob")(input);
      },
      // Like the real module: a jobId is looked up by id alone, whatever channelId says.
      getJobs: async (input: unknown) => {
        const jobId = (input as { jobId?: string }).jobId;
        if (jobId === "G-J") return { job: { jobId, channelId: JAPAN } };
        if (jobId === "G-T") return { job: { jobId, channelId: TROPICO } };
        return note("gemini.getJobs")(input);
      },
    },
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
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
  for (const call of [
    () => pinned.plans.create({ channelId: JAPAN, planId: "x" }),
    () => pinned.storyboards.create({ channelId: JAPAN }),
    () => pinned.storyboards.get({ channelId: JAPAN, storyboardId: "s" }),
    () => pinned.videos.create({ channelId: JAPAN }),
    () => pinned.live.mapSources({ channelId: JAPAN, items: [] }),
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
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
  for (const call of [() => pinned.plans.update({ planId: "P-J" }), () => pinned.plans.get({ planId: "P-J" }), () => pinned.plans.report({ planId: "P-J", rows: [] }), () => pinned.plans.update({ planId: "P-missing" })]) {
    await assert.rejects(call(), code("plan_not_found"));
  }
  assert.deepEqual(calls, []);
  await pinned.plans.close({ planId: "P-T", status: "completed" });
  assert.deepEqual(calls, ['plans.close:{"planId":"P-T","status":"completed"}']);
});

test("AC-WF-03: where the channel may be left out, the token's channel is put in", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
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

test("AC-WF-04: shared deps are refused: models, templates, runtimes, GPU data, other channels, plan moves, channel translations", async () => {
  const { deps, calls } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
  const refusals: Array<() => unknown> = [
    () => pinned.media.listModels(),
    () => pinned.media.gpuStats({}),
    () => pinned.media.pullModel({ repoId: "r", file: "f", folder: "x", sha256: "0".repeat(64) }),
    () => pinned.media.createRuntime({}),
    () => pinned.listChannels(),
    () => pinned.readLogicalPath({ name: "x" }),
    () => pinned.plans.move({ planId: "P-T", channelId: JAPAN }),
    // Stage 4's session tools refuse when the route gave no media wiring.
    () => pinned.media.startSession({ channelId: TROPICO }),
    // ADR 0047 / AC-CL-10: the channel's own translations stay the owner's and the Operator's.
    () => pinned.channelLocalizations.get({ channelId: TROPICO }),
    () => pinned.channelLocalizations.save({ channelId: TROPICO, localizations: {} }),
  ];
  for (const call of refusals) {
    await assert.rejects(async () => call(), code("AGENT_SESSION_OPERATOR_ONLY"));
  }
  assert.deepEqual(calls, []);
});

test("AC-WF-05/06: the worker gets exactly the listed tools, renamed, and none of the shared ones", () => {
  const { deps } = fakeDeps();
  const names = workerFactoryTools(() => deps, TROPICO, async () => undefined).map((tool) => tool.name).sort();
  assert.deepEqual(names, [...WORKER_FACTORY_TOOL_NAMES].sort());
  assert.equal(names.length, 36);
  for (const forbidden of ["agent_plan_move", "agent_media_pull_model", "agent_media_list_models", "agent_media_create_runtime", "agent_media_get_gpu_stats", "agent_channel_get_localizations", "agent_channel_save_localizations"]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  assert.ok(names.every((name) => name.startsWith("agent_")));
});

test("AC-WF-01 through the tool: agent_plan_update with the Tropico token on a Japan plan answers plan_not_found", async () => {
  const { deps, calls } = fakeDeps();
  const tool = workerFactoryTools(() => deps, TROPICO, async () => undefined).find((entry) => entry.name === "agent_plan_update");
  assert.ok(tool);
  const result = (await tool.handler({ planId: "P-J", title: "x" })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, "plan_not_found");
  assert.deepEqual(calls, []);
});

// Stage 4 (BL-218, owner msg 3402 "может, как оператор"): paid work for the own channel only.
function fakeMedia(calls: string[]) {
  const sessions: Record<string, string> = { "S-T": TROPICO, "S-J": JAPAN };
  const jobs: Record<string, string> = { "J-T": TROPICO, "J-J": JAPAN };
  const note = (name: string) => async (input: unknown) => {
    calls.push(`${name}:${JSON.stringify(input)}`);
    return { ok: true };
  };
  return {
    startSession: note("startSession"),
    getSession: async (input: { sessionId?: string }) => {
      if (input.sessionId === undefined) return { sessions: [{ id: "S-T", channelId: TROPICO }, { id: "S-J", channelId: JAPAN }] };
      const channel = sessions[input.sessionId];
      if (!channel) throw new Error("media_session_not_found");
      return { session: { id: input.sessionId, channelId: channel } };
    },
    endSession: note("endSession"),
    createJob: note("createJob"),
    getJob: async (input: { jobId?: string }) => {
      const channel = input.jobId ? jobs[input.jobId] : undefined;
      if (!channel) throw new Error("media_job_not_found");
      return { job: { jobId: input.jobId, channelId: channel } };
    },
    cancelJob: note("cancelJob"),
  } as unknown as FactoryToolDeps["media"];
}

test("AC-WF-06: a worker starts, uses and stops only its own channel's sessions and jobs; a Japan session is not found", async () => {
  const { deps, calls } = fakeDeps();
  const mediaCalls: string[] = [];
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined, () => fakeMedia(mediaCalls));
  await assert.rejects(pinned.media.startSession({ channelId: JAPAN }), code("CHANNEL_NOT_ACTIVE"));
  await assert.rejects(pinned.media.startSession({ channelId: TROPICO, planId: "P-J" }), code("plan_not_found"));
  await assert.rejects(pinned.media.endSession({ sessionId: "S-J" }), code("media_session_not_found"));
  await assert.rejects(pinned.media.createJob({ sessionId: "S-J", templateId: "t", params: {} }), code("media_session_not_found"));
  await assert.rejects(pinned.media.cancelJob({ jobId: "J-J" }), code("media_job_not_found"));
  await assert.rejects(pinned.media.getJob({ jobId: "J-J" }), code("media_job_not_found"));
  await assert.rejects(pinned.plans.runStage({ planId: "P-J", sessionId: "S-T" }), code("plan_not_found"));
  await assert.rejects(pinned.plans.rerun({ planId: "P-T", sessionId: "S-J", itemKey: "i" }), code("media_session_not_found"));
  await assert.rejects(pinned.gemini.createJob({ channelId: JAPAN }), code("CHANNEL_NOT_ACTIVE"));
  assert.deepEqual(mediaCalls, []);

  await pinned.media.startSession({ channelId: TROPICO, planId: "P-T" });
  await pinned.media.createJob({ sessionId: "S-T", templateId: "t", params: {} });
  await pinned.media.endSession({ sessionId: "S-T" });
  await pinned.media.cancelJob({ jobId: "J-T" });
  assert.deepEqual((mediaCalls as string[]).map((call) => call.split(":")[0]), ["startSession", "createJob", "endSession", "cancelJob"]);
  const listed = (await pinned.media.getSession({})) as { sessions: Array<{ id: string }> };
  assert.deepEqual(listed.sessions.map((session) => session.id), ["S-T"]);
  await pinned.plans.runStage({ planId: "P-T", sessionId: "S-T" });
  await pinned.gemini.createJob({ channelId: TROPICO });
  assert.ok(calls.some((call) => call.startsWith("plans.runStage")) && calls.some((call) => call.startsWith("gemini.createJob")));
});

test("review (HIGH): a Gemini job of another channel, asked for by id, is not found", async () => {
  const { deps } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
  await assert.rejects(pinned.gemini.getJobs({ jobId: "G-J" }), code("gemini_job_not_found"));
  assert.deepEqual(await pinned.gemini.getJobs({ jobId: "G-T" }), { job: { jobId: "G-T", channelId: TROPICO } });
});

test("re-check: a requestId another channel used is refused without naming that channel's job", async () => {
  const { deps } = fakeDeps();
  const pinned = pinFactoryDepsToChannel(() => deps, TROPICO, async () => undefined);
  await assert.rejects(pinned.gemini.createJob({ channelId: TROPICO, requestId: "used-by-japan" }), (error: unknown) => {
    assert.ok(isDomainError(error) && error.code === "gemini_request_exists");
    assert.equal(JSON.stringify({ message: (error as Error).message, details: (error as DomainError).details ?? null }).includes("G-J"), false);
    return true;
  });
});
