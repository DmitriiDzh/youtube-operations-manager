import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { FactoryChannelDeps } from "./factory-channel-deps";
import { createFactoryMcpServer, type FactoryToolContract, type FactoryToolDeps } from "./factory-server";

/**
 * BL-217 (docs/roadmap/plans/WORKER_CAPABILITIES_PLAN.md stage 3, FO-REQ-0037 item 2): the Factory Operator's channel tools for a
 * channel worker, its own channel only. Not a second implementation: the worker's `agent_*` tool IS the `factory_*` tool (same
 * input, output, checks and errors, built by `createFactoryMcpServer` with `collect`), run over CHANNEL-PINNED deps:
 * - an input's `channelId` must be the token's channel (`CHANNEL_NOT_ACTIVE` otherwise); where the factory tool lets it be left
 *   out (live status, the jobs list, Gemini jobs), the token's channel is put in;
 * - a call by plan id first checks the plan is the token's channel's (`plan_not_found` otherwise, the same as a missing plan);
 * - an imported plan file must name the token's channel;
 * - every other dep (models, templates, runtimes, GPU data, settings, sessions, other channels' list) is refused, so a tool left
 *   out of `WORKER_FACTORY_TOOLS` could not reach them even if it were exposed by mistake.
 * The modules still record the actor `factory` (their synced shapes accept only `factory` / `owner`); the worker log
 * (`worker_action_log`, ADR 0048) records which worker wrote what. Stage 4 (BL-218) adds the paid tools on the same terms as the
 * Operator: sessions, jobs, plan runs and Gemini jobs, within the owner's switches and limits.
 */

type FactoryName = Parameters<NonNullable<Parameters<typeof createFactoryMcpServer>[1]>["collect"] & object>[0];

/** factory tool → worker tool name, and whether it writes (local state only; nothing here writes to YouTube or spends money). */
export const WORKER_FACTORY_TOOLS: Readonly<Record<string, { agentName: string; writes: boolean }>> = Object.freeze({
  factory_plan_get: { agentName: "agent_plan_get", writes: false },
  factory_plan_list: { agentName: "agent_plan_list", writes: false },
  factory_plan_todo: { agentName: "agent_plan_todo", writes: false },
  factory_plan_create: { agentName: "agent_plan_create", writes: true },
  factory_plan_import: { agentName: "agent_plan_import", writes: true },
  factory_plan_update: { agentName: "agent_plan_update", writes: true },
  factory_plan_close: { agentName: "agent_plan_close", writes: true },
  factory_plan_report: { agentName: "agent_plan_report", writes: true },
  factory_plan_clone_group: { agentName: "agent_plan_clone_group", writes: true },
  factory_plan_request_recheck: { agentName: "agent_plan_request_recheck", writes: true },
  factory_plan_withdraw_recheck: { agentName: "agent_plan_withdraw_recheck", writes: true },
  factory_storyboard_get: { agentName: "agent_storyboard_get", writes: false },
  factory_storyboard_list: { agentName: "agent_storyboard_list", writes: false },
  factory_storyboard_create: { agentName: "agent_storyboard_create", writes: true },
  factory_storyboard_update: { agentName: "agent_storyboard_update", writes: true },
  factory_storyboard_submit: { agentName: "agent_storyboard_submit", writes: true },
  factory_storyboard_reply: { agentName: "agent_storyboard_reply", writes: true },
  factory_storyboard_attach_render: { agentName: "agent_storyboard_attach_render", writes: true },
  factory_video_create: { agentName: "agent_video_create", writes: true },
  factory_video_list: { agentName: "agent_video_list", writes: false },
  factory_video_get_cost: { agentName: "agent_video_get_cost", writes: false },
  factory_jobs_list: { agentName: "agent_jobs_list", writes: false },
  factory_live_get_status: { agentName: "agent_live_get_status", writes: false },
  factory_live_map_sources: { agentName: "agent_live_map_sources", writes: true },
  factory_live_save_localizations: { agentName: "agent_live_save_localizations", writes: true },
  // Not factory_channel_get/save_localizations: ADR 0047 (AGENTS.md §F) names the owner and the Factory Operator as the only ones
  // who save a channel's own translations, and AC-CL-10 keeps every channel-translation tool out of channel sessions.
  // BL-223 (ADR 0050, FO-REQ-0039): the channel's description, keywords and banner -- a draft for the owner's «Применить», own channel.
  factory_channel_get_branding: { agentName: "agent_channel_get_branding", writes: false },
  factory_channel_save_branding: { agentName: "agent_channel_save_branding", writes: true },
  factory_gemini_get_job: { agentName: "agent_gemini_get_job", writes: false },
  // BL-225 (ADR 0051, FO-REQ-0040): the channel's weekly publishing plan -- a draft for the owner's approval, own channel only.
  factory_publishing_plan_save: { agentName: "agent_publishing_plan_save", writes: true },
  // BL-227 (ADR 0052): a check report on a change set of the worker's own channel.
  factory_localization_report_checks: { agentName: "agent_localization_report_checks", writes: true },
  // BL-227 stage 2: the owner's translation requests of the worker's own channel.
  factory_localization_requests_list: { agentName: "agent_localization_requests_list", writes: false },
  factory_localization_request_claim: { agentName: "agent_localization_request_claim", writes: true },
  factory_localization_request_complete: { agentName: "agent_localization_request_complete", writes: true },
  factory_localization_request_fail: { agentName: "agent_localization_request_fail", writes: true },
  factory_publishing_plan_get: { agentName: "agent_publishing_plan_get", writes: false },
  factory_publishing_plan_list: { agentName: "agent_publishing_plan_list", writes: false },
  // BL-235: which days ahead are covered on YouTube (video published or scheduled with every tracked translation), own channel only.
  factory_publishing_coverage: { agentName: "agent_publishing_coverage", writes: false },
  // BL-218 (stage 4, owner msg 3402 "может, как оператор"): paid work, exactly as the Operator does it -- a session the worker starts
  // is approved by itself only within the owner's factory limits and while the owner's factory-sessions switch is on (otherwise it
  // waits for the owner), Gemini jobs only within the owner's Gemini switch and limits. Only for this channel; each call is logged.
  // `agent_factory_*`: the Operator's way (a factory session); the older `agent_request_media_session` / `agent_create_media_job`
  // path (every session approved by the owner) stays as it is.
  factory_media_start_session: { agentName: "agent_factory_start_session", writes: true },
  factory_media_get_session: { agentName: "agent_factory_get_session", writes: false },
  factory_media_stop_session: { agentName: "agent_factory_stop_session", writes: true },
  factory_media_create_job: { agentName: "agent_factory_create_job", writes: true },
  factory_media_get_job: { agentName: "agent_factory_get_job", writes: false },
  factory_media_cancel_job: { agentName: "agent_factory_cancel_job", writes: true },
  factory_plan_run_stage: { agentName: "agent_plan_run_stage", writes: true },
  factory_plan_rerun: { agentName: "agent_plan_rerun", writes: true },
  factory_gemini_get_status: { agentName: "agent_gemini_get_status", writes: false },
  factory_gemini_create_job: { agentName: "agent_gemini_create_job", writes: true },
});

/** BL-218: the Operator's media wiring a channel route injects (sessions and jobs); without it those tools refuse. */
export type WorkerMediaDeps = FactoryToolDeps["media"];

/** The worker tool names, for the classification and capability inventories. */
export const WORKER_FACTORY_TOOL_NAMES: readonly string[] = Object.freeze(Object.values(WORKER_FACTORY_TOOLS).map((entry) => entry.agentName));

/** Worker tools that change local state -- each call is a worker-log row (ADR 0048). */
export const WORKER_FACTORY_WRITE_TOOL_NAMES: readonly string[] = Object.freeze(
  Object.values(WORKER_FACTORY_TOOLS)
    .filter((entry) => entry.writes)
    .map((entry) => entry.agentName)
);

function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function notThisChannel(channelId: unknown): DomainError {
  return new DomainError({
    code: "CHANNEL_NOT_ACTIVE",
    message: "A channel worker works only on its own channel.",
    details: { channelId },
  });
}

function refused(): never {
  throw new DomainError({ code: "AGENT_SESSION_OPERATOR_ONLY", message: "This is the Factory Operator's, not a channel worker's." });
}

/** `channelId` of the input must be the bound channel. `optional`: when left out, the bound channel is put in. */
function pinChannel(input: unknown, channelId: string, optional = false): Record<string, unknown> {
  const fields = record(input);
  if (fields.channelId === undefined && optional) return { ...fields, channelId };
  if (fields.channelId !== channelId) throw notThisChannel(fields.channelId);
  return fields;
}

/** The factory deps confined to one channel. Reads `real` lazily, so an unused module is never built. */
export function pinFactoryDepsToChannel(
  real: () => FactoryChannelDeps,
  channelId: string,
  assertMutationAllowed: () => Promise<void>,
  realMedia?: () => FactoryToolDeps["media"]
): FactoryToolDeps {
  const deps = () => real();
  const media = (): FactoryToolDeps["media"] => {
    if (!realMedia) refused();
    return realMedia();
  };
  const sessionNotFound = (sessionId: unknown) => new DomainError({ code: "media_session_not_found", message: "No session with this id", details: { sessionId } });
  const jobNotFound = (jobId: unknown) => new DomainError({ code: "media_job_not_found", message: "No job with this id", details: { jobId } });
  /** A session id of this channel's (the factory's own check already refuses a session that is not a factory session). */
  async function requireOwnSession(sessionId: unknown): Promise<void> {
    if (typeof sessionId !== "string") return;
    let owner: unknown;
    try {
      owner = record(record(await media().getSession({ sessionId })).session).channelId;
    } catch {
      throw sessionNotFound(sessionId);
    }
    if (owner !== channelId) throw sessionNotFound(sessionId);
  }
  async function requireOwnJob(jobId: unknown): Promise<void> {
    if (typeof jobId !== "string") return;
    let owner: unknown;
    try {
      owner = record(record(await media().getJob({ jobId })).job).channelId;
    } catch {
      throw jobNotFound(jobId);
    }
    if (owner !== channelId) throw jobNotFound(jobId);
  }
  async function requireOwnPlan(input: unknown): Promise<void> {
    const planId = record(input).planId;
    const planNotFound = new DomainError({ code: "plan_not_found", message: "plan not found", details: { planId } });
    if (typeof planId !== "string") return; // the plans core refuses the input itself
    let owner: unknown;
    try {
      owner = record(record(await deps().plans.get({ planId, latest: true })).plan).channelId;
    } catch {
      throw planNotFound;
    }
    if (owner !== channelId) throw planNotFound;
  }
  const byPlan =
    <K extends keyof FactoryToolDeps["plans"]>(name: K) =>
    async (input: unknown) => {
      await requireOwnPlan(input);
      return (deps().plans[name] as (input: unknown) => Promise<Record<string, unknown>>)(input);
    };
  const byChannel = (call: (input: unknown) => Promise<Record<string, unknown>>, optional = false) => async (input: unknown) => call(pinChannel(input, channelId, optional));

  return {
    readLogicalPath: refused,
    listLogicalPaths: refused,
    listChannels: refused,
    recordOutcome: async () => undefined,
    // BL-218: only the session and job part, for this channel; models, templates, runtimes, GPU data and settings stay refused.
    media: new Proxy({} as FactoryToolDeps["media"], {
      get: (_target, name) => {
        switch (name) {
          case "startSession":
            return async (input: Parameters<FactoryToolDeps["media"]["startSession"]>[0]) => {
              pinChannel(input, channelId);
              if (input.planId !== undefined) await requireOwnPlan({ planId: input.planId });
              return media().startSession(input);
            };
          case "getSession":
            return async (input: { sessionId?: string }) => {
              if (input.sessionId !== undefined) {
                await requireOwnSession(input.sessionId);
                return media().getSession(input);
              }
              const listed = record(await media().getSession({ channelId }));
              const sessions = Array.isArray(listed.sessions) ? listed.sessions.filter((session) => record(session).channelId === channelId) : [];
              return { sessions };
            };
          case "endSession":
            return async (input: { sessionId: string }) => {
              await requireOwnSession(input.sessionId);
              return media().endSession(input);
            };
          case "createJob":
            return async (input: Parameters<FactoryToolDeps["media"]["createJob"]>[0]) => {
              await requireOwnSession(input.sessionId);
              if (input.planId !== undefined) await requireOwnPlan({ planId: input.planId });
              return media().createJob(input);
            };
          case "getJob":
            return async (input: { jobId?: string; sessionId?: string }) => {
              if (input.jobId !== undefined) await requireOwnJob(input.jobId);
              else await requireOwnSession(input.sessionId);
              return media().getJob(input);
            };
          case "cancelJob":
            return async (input: { jobId: string }) => {
              await requireOwnJob(input.jobId);
              return media().cancelJob(input);
            };
          default:
            return refused;
        }
      },
    }),
    plans: {
      create: byChannel((input) => deps().plans.create(input)),
      importPlan: async (input) => {
        if (record(record(input).plan).channelId !== channelId) throw notThisChannel(record(record(input).plan).channelId);
        return deps().plans.importPlan(input);
      },
      update: byPlan("update"),
      close: byPlan("close"),
      get: byPlan("get"),
      list: byChannel((input) => deps().plans.list(input), true),
      todo: byPlan("todo"),
      report: byPlan("report"),
      runStage: async (input) => {
        await requireOwnPlan(input);
        await requireOwnSession(record(input).sessionId);
        return deps().plans.runStage(input);
      },
      rerun: async (input) => {
        await requireOwnPlan(input);
        await requireOwnSession(record(input).sessionId);
        return deps().plans.rerun(input);
      },
      cloneGroup: byPlan("cloneGroup"),
      move: refused,
      requestRecheck: byPlan("requestRecheck"),
      withdrawRecheck: byPlan("withdrawRecheck"),
    },
    gemini: {
      getStatus: () => deps().gemini.getStatus(),
      // Re-check: a requestId another channel already used is refused without naming that channel's job (the Operator and every
      // worker share the actor "factory", so the module's replay lookup can hit another channel's job).
      createJob: byChannel(async (input) => {
        try {
          return await deps().gemini.createJob(input);
        } catch (error) {
          if (isDomainError(error) && error.code === "gemini_request_exists") {
            throw new DomainError({ code: "gemini_request_exists", message: "This requestId was already used for another request; choose a new requestId." });
          }
          throw error;
        }
      }),
      // Review (HIGH): the Gemini module ignores channelId when a jobId is given -- the job's own channel is checked here.
      getJobs: async (input) => {
        const pinned = pinChannel(input, channelId, true);
        if (typeof pinned.jobId !== "string") return deps().gemini.getJobs(pinned);
        const notFound = new DomainError({ code: "gemini_job_not_found", message: `No Gemini job ${pinned.jobId} on this computer.`, details: { jobId: pinned.jobId } });
        let answer: Record<string, unknown>;
        try {
          answer = await deps().gemini.getJobs(pinned);
        } catch {
          throw notFound;
        }
        if (record(answer.job).channelId !== channelId) throw notFound;
        return answer;
      },
    },
    live: {
      getStatus: async (input) => deps().live.getStatus({ ...record(input), channelId: pinChannel(input, channelId, true).channelId as string }),
      mapSources: async (input) => deps().live.mapSources(pinChannel(input, channelId) as Parameters<FactoryToolDeps["live"]["mapSources"]>[0]),
      setLocalizations: async (input) => deps().live.setLocalizations(pinChannel(input, channelId) as Parameters<FactoryToolDeps["live"]["setLocalizations"]>[0]),
    },
    // ADR 0047: a channel's own translations are the owner's and the Factory Operator's only.
    channelLocalizations: { get: refused, save: refused },
    // BL-223: the branding draft of the worker's own channel, recorded as saved by a worker (never an apply).
    channelBranding: {
      get: async (input) => deps().channelBranding.get(pinChannel(input, channelId) as { channelId: string }),
      save: async (input) => deps().channelBranding.save(pinChannel(input, channelId) as Parameters<FactoryToolDeps["channelBranding"]["save"]>[0], "worker"),
    },
    // BL-227: a check report on a set of the worker's own channel (a report decides nothing).
    localizationChecks: {
      report: byChannel((input) => deps().localizationChecks.report(input, "worker")),
      listRequests: byChannel((input) => deps().localizationChecks.listRequests(input)),
      claimRequest: byChannel((input) => deps().localizationChecks.claimRequest(input, "worker")),
      completeRequest: byChannel((input) => deps().localizationChecks.completeRequest(input, "worker")),
      failRequest: byChannel((input) => deps().localizationChecks.failRequest(input, "worker")),
    },
    // BL-225: the weekly plan of the worker's own channel, saved as a worker's (never a decision: the surface has none).
    publishingPlans: {
      save: byChannel((input) => deps().publishingPlans.save(input, "worker")),
      get: byChannel((input) => deps().publishingPlans.get(input)),
      list: byChannel((input) => deps().publishingPlans.list(input)),
    },
    // BL-235: the coverage of the worker's own channel (a read).
    publishingCoverage: {
      get: async (input) => deps().publishingCoverage.get(pinChannel(input, channelId) as { channelId: string; days?: number }),
    },
    storyboards: {
      create: byChannel((input) => deps().storyboards.create(input)),
      update: byChannel((input) => deps().storyboards.update(input)),
      get: byChannel((input) => deps().storyboards.get(input)),
      list: byChannel((input) => deps().storyboards.list(input)),
      submit: byChannel((input) => deps().storyboards.submit(input)),
      reply: byChannel((input) => deps().storyboards.reply(input)),
      attachRender: byChannel((input) => deps().storyboards.attachRender(input)),
    },
    videos: {
      create: byChannel((input) => deps().videos.create(input)),
      list: byChannel((input) => deps().videos.list(input)),
      cost: byChannel((input) => deps().videos.cost(input)),
    },
    jobs: {
      list: async (input) => deps().jobs.list({ ...record(input), channelId: pinChannel(input, channelId, true).channelId as string }),
    },
    // BL-220: a worker's restart tools are its own (src/mcp/server.ts, holds as worker:<channel>); none is re-exposed from here.
    restart: { status: refused, hold: refused, release: refused },
    assertMutationAllowed: () => assertMutationAllowed(),
  };
}

export type WorkerFactoryTool = { name: string; contract: FactoryToolContract; handler: (args: unknown) => Promise<unknown> };

/**
 * The worker tools of one channel session: each factory tool of `WORKER_FACTORY_TOOLS`, renamed, with a description that says it is
 * the worker's version, over `pinFactoryDepsToChannel`. The `real` deps are the factory's own channel wiring (`./factory-channel-deps.ts`); `assertMutationAllowed` is the device mutation gate.
 */
export function workerFactoryTools(
  real: () => FactoryChannelDeps,
  channelId: string,
  assertMutationAllowed: () => Promise<void>,
  realMedia?: () => FactoryToolDeps["media"]
): WorkerFactoryTool[] {
  const tools: WorkerFactoryTool[] = [];
  createFactoryMcpServer(pinFactoryDepsToChannel(real, channelId, assertMutationAllowed, realMedia), {
    collect: (name: FactoryName, contract, handler) => {
      const entry = WORKER_FACTORY_TOOLS[name];
      if (!entry) return;
      tools.push({
        name: entry.agentName,
        contract: {
          description: `Channel worker's version of ${name} (BL-217): the same input, output and checks, for YOUR channel only -- channelId must be your own channel (CHANNEL_NOT_ACTIVE otherwise) and a plan of another channel is plan_not_found. Where the text below says "factory" or "the Operator", read "you". ${contract.description}`,
          inputSchema: contract.inputSchema,
        },
        handler,
      });
    },
  });
  return tools;
}
