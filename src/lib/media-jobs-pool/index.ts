import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { isPathInsideOrEqual, validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createMediaGenerationCore, jobErrorCode, toSharedJobProgress } from "@/lib/media-generation";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createMediaJobsShareCoreForProduction, createMediaSessionsShareCoreForProduction, MEDIA_JOB_COMMAND_RESULTS_MAX, MEDIA_JOB_COMMANDS_MAX, MEDIA_JOBS_REPORT_MAX, type MediaJobsReport } from "@/lib/sync-gateway";
import { DomainError } from "@/lib/shared-domain";
import { createCommandStore } from "./adapters/store";
import {
  applyIncomingCommands,
  commandViews,
  outgoingSince,
  prepareCommand,
  receivedSince,
  toCommandResults,
  toReportCommands,
  type CommandExecutors,
  type CommandView,
  type PeerSessionRef,
} from "./commands";
import { createExchangeFs, resolveExchangeFile } from "@/lib/workspace-exchange";
import { POOL_JOB_OUTPUT_SUBDIRS, type PoolMediaKind, type PoolView } from "./contracts";
import { agentJobsList, buildMediaJobsReport, mergePool, reportHostName, toSharedGeminiJob, toSharedRunpodJob, type AgentJobsFilter, type AgentJobsList, type LocalRunpodJob } from "./services";
import type { GeminiJobView } from "@/lib/gemini-media";

// BL-188 (SHARED_MEDIA_JOBS_PLAN.md): the shared list wired to the real modules. It reads both feature modules and the
// sync-gateway family; neither feature module knows it exists (AGENTS.md §M). If one module cannot be read, the other one's jobs
// and the peers' are still listed.

export * from "./contracts";
export { applyIncomingCommands, commandViews, prepareCommand, toCommandResults, toReportCommands, issueCommandInputSchema, COMMAND_INTERRUPTED_AFTER_MS, COMMAND_LEDGER_KEEP_MS } from "./commands";
export type { CommandExecutors, CommandState, CommandStore, CommandView, IssueCommandInput, PeerSessionRef } from "./commands";
export { agentJobsList, AGENT_JOBS_LIST_DEFAULT, AGENT_JOBS_LIST_MAX, buildMediaJobsReport, isFinished, mergePool, runpodOutputPath, geminiOutputPath, selectReportJobs, toSharedGeminiJob, toSharedRunpodJob } from "./services";
export type { AgentJobsDevice, AgentJobsFilter, AgentJobsList, AgentJobsRow } from "./services";

const errorCode = (error: string | null) => jobErrorCode(error);

async function thisDevice(): Promise<{ deviceId: string; hostName: string | null }> {
  const deviceId = (await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath).ensureExists()).deviceId;
  let name: string | null = null;
  try {
    name = hostname();
  } catch {
    name = null;
  }
  return { deviceId, hostName: reportHostName(name) };
}

/** Each module's own jobs, or none when that module cannot be read now (a broken one never hides the other). */
async function localJobs(): Promise<{ runpod: LocalRunpodJob[]; gemini: GeminiJobView[] }> {
  const [runpod, gemini] = await Promise.all([
    createMediaGenerationCore()
      .listJobsForShare(MEDIA_JOBS_REPORT_MAX)
      .catch((error: unknown) => {
        console.warn(`[media-jobs] RunPod jobs not read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }),
    Promise.resolve()
      .then(() => createGeminiMediaCore().listJobsForShare(MEDIA_JOBS_REPORT_MAX))
      .catch((error: unknown) => {
        console.warn(`[media-jobs] Gemini jobs not read: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }),
  ]);
  return { runpod, gemini };
}

let lastPublished = { key: "", at: 0 };

const commandStore = createCommandStore();

/** This computer's commands to other computers and the results of the ones it received, as its report carries them. */
async function reportCommands(now: Date) {
  const [outgoing, received] = await Promise.all([commandStore.listOutgoing(outgoingSince(now), MEDIA_JOB_COMMANDS_MAX), commandStore.listReceived(receivedSince(now), MEDIA_JOB_COMMAND_RESULTS_MAX)]);
  return { commands: toReportCommands(outgoing), commandResults: toCommandResults(received, now) };
}

/** This computer's jobs for the other computers: written when they changed, and at least every 5 minutes (freshness). */
export async function publishMediaJobsShare(now: Date = new Date(), options: { force?: boolean } = {}): Promise<void> {
  const [device, jobs, commands] = await Promise.all([thisDevice(), localJobs(), reportCommands(now)]);
  const report = buildMediaJobsReport({
    ...device,
    now,
    jobs: [...jobs.runpod.map((job) => toSharedRunpodJob(job, toSharedJobProgress, errorCode)), ...jobs.gemini.map(toSharedGeminiJob)],
    ...commands,
  });
  const key = JSON.stringify([report.hostName, report.jobs, report.commands, report.commandResults]);
  if (!options.force && key === lastPublished.key && now.getTime() - lastPublished.at < 5 * 60_000) return;
  await createMediaJobsShareCoreForProduction().publishLocalReport(report);
  lastPublished = { key, at: now.getTime() };
}

const TERMINAL_RUNPOD = new Set(["done", "failed", "cancelled"]);
const TERMINAL_GEMINI = new Set(["done", "failed"]);

async function isConnectedChannel(channelId: string): Promise<boolean> {
  return (await createChannelConnectionsCore().listConnectedChannels()).some((c) => c.channelId === channelId);
}

/**
 * The relayed actions, each through the service a local click calls (SHARED_MEDIA_JOBS_PLAN.md §2.4): the RunPod create runs
 * every check and limit of a local create (session running and owned here, template, inputs, storyboard gate), the approve
 * every device limit of a local approve. A job of another channel than the command names is refused.
 */
function productionExecutors(log: (line: string) => void): CommandExecutors {
  return {
    async cancelJob({ source, jobId, channelId }) {
      if (source === "runpod") {
        const core = createMediaGenerationCore();
        const job = await core.getJob({ jobId });
        if (job.channelId !== channelId) throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "The job belongs to another channel.", details: { jobId } });
        if (TERMINAL_RUNPOD.has(job.status)) return "already_finished";
        try {
          await core.cancelJob({ jobId });
          return "cancelled";
        } catch (error) {
          if (TERMINAL_RUNPOD.has((await core.getJob({ jobId })).status)) return "already_finished";
          throw error;
        }
      }
      const gemini = createGeminiMediaCore();
      const read = async () => {
        const found = await gemini.getJobs({ jobId });
        if (!("job" in found) || !found.job) throw new DomainError({ code: "gemini_job_not_found", message: `No Gemini job ${jobId} on this computer.`, details: { jobId } });
        return found.job;
      };
      const job = await read();
      if (job.channelId !== channelId) throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "The job belongs to another channel.", details: { jobId } });
      if (TERMINAL_GEMINI.has(job.status)) return "already_finished";
      try {
        await gemini.cancelJob(jobId);
        return "cancelled";
      } catch (error) {
        if (TERMINAL_GEMINI.has((await read()).status)) return "already_finished";
        throw error;
      }
    },
    async createJob({ sessionId, channelId, templateId, params }) {
      if (!(await isConnectedChannel(channelId))) throw new DomainError({ code: "channel_not_connected", message: "The channel is not connected on this computer.", details: { channelId } });
      const job = await createMediaGenerationCore().createJob({ sessionId, channelId, templateId, params, createdBy: "operator" });
      return { jobId: job.jobId };
    },
    async createGeminiJob({ commandId, channelId, request }) {
      // The owner's job (actor "owner", like a create from Media here); the request id comes from the command, so a create that
      // ran but whose ledger row was not finished returns the same job instead of a second paid one.
      const created = await createGeminiMediaCore().createJob({ ...request, channelId, requestId: `cmd-${commandId}` }, "owner");
      // Never a dry run here, so a job always comes back; anything else is reported as `command_failed`.
      if (!("job" in created) || !created.job) throw new Error("The Gemini create returned no job.");
      return { jobId: created.job.jobId };
    },
    async approveSession({ sessionId }) {
      const { started } = await createMediaGenerationCore().approveSession({ sessionId, approvedByUserId: null });
      void started.catch((error: unknown) => log(`[media-jobs] session ${sessionId} (approved from another computer) failed to start: ${error instanceof Error ? error.message : String(error)}`));
    },
    async rejectSession({ sessionId, reason }) {
      await createMediaGenerationCore().rejectSession({ sessionId, reason });
    },
  };
}

/**
 * One tick of the shared pool (SHARED_MEDIA_JOBS_PLAN.md §2.3): apply the commands other computers sent to this one, then
 * publish this computer's report (its jobs, its own commands, the results). Called from `src/instrumentation.ts`.
 */
export async function runMediaJobsPoolTick(options: { now?: () => Date; mayApply?: () => Promise<boolean> } = {}): Promise<void> {
  const now = options.now ?? (() => new Date());
  const outcomes = (await (options.mayApply?.() ?? Promise.resolve(true)))
    ? await (async () => {
        const [device, peers] = await Promise.all([thisDevice(), createMediaJobsShareCoreForProduction().listPeerReports()]);
        return applyIncomingCommands({ ownDeviceId: device.deviceId, peers, store: commandStore, executors: productionExecutors((line) => console.warn(line)), now });
      })()
    : [];
  for (const o of outcomes) {
    if (o.status !== "skipped") console.info(`[media-jobs] command ${o.commandId} (${o.kind}) from another computer: ${o.status}${o.code ? ` (${o.code})` : ""}`);
  }
  await publishMediaJobsShare(now(), { force: outcomes.length > 0 });
}

/** The other computers' sessions as their media-sessions reports show them (for a run or an approve on them). */
async function peerSessionRefs(ownDeviceId: string): Promise<Array<PeerSessionRef & { hostName: string | null; gpuTypeId: string | null; startedAt: string | null }>> {
  const reports = await createMediaSessionsShareCoreForProduction()
    .listPeerReports()
    .catch(() => []);
  return reports
    .filter((r) => r.deviceId !== ownDeviceId)
    .flatMap((r) => r.sessions.map((s) => ({ deviceId: r.deviceId, hostName: r.hostname, sessionId: s.sessionId, channelId: s.channelId, status: s.status, gpuTypeId: s.gpuTypeId, startedAt: s.startedAt })));
}

async function peerJobReports(): Promise<MediaJobsReport[]> {
  return createMediaJobsShareCoreForProduction()
    .listPeerReports()
    .catch(() => []);
}

/** This computer's outgoing commands with what the other computers answered, newest first. */
export async function listMediaJobCommands(now: Date = new Date()): Promise<CommandView[]> {
  const [device, peers, outgoing] = await Promise.all([thisDevice(), peerJobReports(), commandStore.listOutgoing(outgoingSince(now), MEDIA_JOB_COMMANDS_MAX)]);
  return commandViews({ ownDeviceId: device.deviceId, outgoing: toReportCommands(outgoing), peers, now });
}

/**
 * The owner's click on another computer's job or session (the route's call): checked against that computer's report, stored as
 * an outgoing command and published at once. The same action clicked again while the first one still waits returns the first.
 */
export async function issueMediaJobCommand(input: { raw: unknown; activeChannelId: string | null }, now: Date = new Date()): Promise<CommandView> {
  const [device, jobReports] = await Promise.all([thisDevice(), peerJobReports()]);
  const command = await prepareCommand({
    raw: input.raw,
    ownDeviceId: device.deviceId,
    ownHostName: device.hostName,
    activeChannelId: input.activeChannelId,
    jobReports,
    peerSessions: await peerSessionRefs(device.deviceId),
    isConnectedChannel,
    now,
    newId: randomUUID,
  });
  const views = await listMediaJobCommands(now);
  if (command.kind !== "create_job") {
    const same = views.find((v) => v.kind === command.kind && v.targetDeviceId === command.targetDeviceId && v.jobId === command.jobId && v.sessionId === command.sessionId && (v.state === "waiting" || v.state === "applying"));
    if (same) return same;
  }
  await commandStore.insertOutgoing({ commandId: command.commandId, targetDeviceId: command.targetDeviceId, kind: command.kind, commandJson: JSON.stringify(command), issuedAt: command.issuedAt });
  await publishMediaJobsShare(now, { force: true }).catch((error: unknown) => console.warn(`[media-jobs] the command was saved but not published yet: ${error instanceof Error ? error.message : String(error)}`));
  const view = commandViews({ ownDeviceId: device.deviceId, outgoing: [command], peers: jobReports, now })[0];
  return view;
}

/** The shared list for Media: the active channel's jobs of one kind (or every kind) on every computer, newest first. */
export async function listMediaJobsPool(input: { channelId: string; kind: PoolMediaKind | null; limit: number }): Promise<PoolView> {
  const [device, jobs, peers, workspace] = await Promise.all([
    thisDevice(),
    localJobs(),
    createMediaJobsShareCoreForProduction()
      .listPeerReports()
      .catch(() => []),
    createChannelWorkspacesCore()
      .getWorkspace({ channelId: input.channelId })
      .catch(() => ({ configured: false as const })),
  ]);
  const hasLocalFile = async (relativePath: string) => {
    if (!workspace.configured) return false;
    return resolveExchangeFile({
      workspace: workspace.path,
      relativePath,
      jobSubdirs: POOL_JOB_OUTPUT_SUBDIRS,
      fs: createExchangeFs(),
      validateWorkspacePath: validateOperatorDirectoryPath,
      isPathInsideOrEqual,
      unavailable: (reason) => new Error(reason),
    }).then(
      () => true,
      () => false
    );
  };
  const now = new Date();
  const [view, commands, sessions] = await Promise.all([
    mergePool({ own: { ...device, ...jobs }, peers, now, channelId: input.channelId, kind: input.kind, shareProgress: toSharedJobProgress, errorCode, hasLocalFile, limit: input.limit }),
    listMediaJobCommands(now).catch(() => [] as CommandView[]),
    peerSessionRefs(device.deviceId),
  ]);
  return {
    ...view,
    commands: commands.filter((c) => c.channelId === input.channelId && (c.kind === "cancel_job" || c.kind === "create_job")),
    peerSessions: sessions
      .filter((s) => s.channelId === input.channelId && s.status === "running")
      .map((s) => ({ deviceId: s.deviceId, hostName: s.hostName, sessionId: s.sessionId, gpuTypeId: s.gpuTypeId, startedAt: s.startedAt })),
  };
}

/**
 * BL-188 stage 3 (SHARED_MEDIA_JOBS_PLAN.md §2.7): `factory_jobs_list` -- every computer's jobs, read-only, in the shared shape
 * (codes only), with the computer and its report's age. The Operator still acts only on this computer's jobs, through its own
 * tools (owner msg 2806: read-only).
 */
export async function listMediaJobsForAgent(filter: AgentJobsFilter, now: Date = new Date()): Promise<AgentJobsList> {
  const [device, jobs, peers] = await Promise.all([thisDevice(), localJobs(), peerJobReports()]);
  return agentJobsList({
    own: { ...device, jobs: [...jobs.runpod.map((job) => toSharedRunpodJob(job, toSharedJobProgress, errorCode)), ...jobs.gemini.map(toSharedGeminiJob)] },
    peers,
    now,
    filter,
  });
}
