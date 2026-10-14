import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";
import {
  MEDIA_JOB_COMMAND_RESULTS_MAX,
  MEDIA_JOB_COMMANDS_KEEP_MS,
  MEDIA_JOB_COMMANDS_MAX,
  MEDIA_JOB_CREATE_COMMAND_MAX_AGE_MS,
  sharedJobCommandSchema,
  type MediaJobCommandKind,
  type MediaJobsReport,
  type SharedCommandResult,
  type SharedJobCommand,
} from "@/lib/sync-gateway";
import { POOL_PEER_STALE_AFTER_MS } from "./contracts";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.3/§2.4): the same actions on every computer. An action on another computer's job
// or session becomes a command in THIS computer's report; the computer that runs the job (or owns the session) applies it once,
// through the very service a local click uses -- its own checks and money limits -- and answers in ITS report. No I/O here:
// `./index.ts` wires the store, the reports and the feature modules.

/** A ledger row left `applying` longer than this is reported as interrupted (a restart in the middle); it is never retried. */
export const COMMAND_INTERRUPTED_AFTER_MS = 30 * 60_000;
/** Received commands are remembered this long -- longer than any issuer keeps a command in its report, so none is applied twice. */
export const COMMAND_LEDGER_KEEP_MS = 30 * 24 * 60 * 60_000;

export type StoredOutgoingCommand = { commandId: string; targetDeviceId: string; kind: string; commandJson: string; issuedAt: string };
export type StoredReceivedCommand = {
  commandId: string;
  issuerDeviceId: string;
  issuedOn: string | null;
  kind: string;
  targetJson: string;
  status: string;
  code: string | null;
  jobId: string | null;
  issuedAt: string;
  receivedAt: string;
  finishedAt: string | null;
};

export type CommandStore = {
  insertOutgoing(row: StoredOutgoingCommand): Promise<void>;
  /** Newest first; rows issued before `sinceIso` are dropped. */
  listOutgoing(sinceIso: string, limit: number): Promise<StoredOutgoingCommand[]>;
  /** Takes a received command (`applying`); false when it was received before. */
  claim(row: Omit<StoredReceivedCommand, "status" | "code" | "jobId" | "finishedAt">): Promise<boolean>;
  finish(commandId: string, set: { status: "applied" | "refused"; code: string | null; jobId: string | null; finishedAt: string }): Promise<void>;
  known(commandIds: readonly string[]): Promise<Set<string>>;
  /** Newest first; rows received before `sinceIso` are dropped. */
  listReceived(sinceIso: string, limit: number): Promise<StoredReceivedCommand[]>;
};

/** What a relayed action does on the executing computer -- each one the same service call a local click makes. */
export type CommandExecutors = {
  /** Resolves `already_finished` when the job had ended (nothing to cancel); throws a DomainError when refused. */
  cancelJob(input: { source: "runpod" | "gemini"; jobId: string; channelId: string | null }): Promise<"cancelled" | "already_finished">;
  createJob(input: { sessionId: string; channelId: string; templateId: string; params: Record<string, string | number | boolean> }): Promise<{ jobId: string }>;
  approveSession(input: { sessionId: string }): Promise<void>;
  rejectSession(input: { sessionId: string; reason: string }): Promise<void>;
};

/** A refusal's code as the report allows it (our own codes only); anything else becomes `command_failed`. */
export function refusalCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? (error as { code: unknown }).code : null;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "command_failed";
}

/** The command's target as the ledger keeps it (the audit of what was asked). */
function targetOf(command: SharedJobCommand): string {
  return JSON.stringify({
    source: command.source,
    jobId: command.jobId,
    sessionId: command.sessionId,
    channelId: command.channelId,
    ...(command.create ? { templateId: command.create.templateId, parameterNames: Object.keys(command.create.params).sort() } : {}),
  });
}

export type ApplyOutcome = { commandId: string; kind: MediaJobCommandKind; status: "applied" | "refused" | "skipped"; code: string | null };

/**
 * Applies the commands other computers sent to this one, oldest first: each is taken in the ledger BEFORE anything is done, so a
 * command is applied at most once (a replay, the same command in two reports, or a restart never repeats it). A `create_job`
 * first seen more than 15 minutes after it was issued is refused (`command_expired`): a stale "run" never starts spending.
 */
export async function applyIncomingCommands(input: {
  ownDeviceId: string;
  peers: readonly MediaJobsReport[];
  store: CommandStore;
  executors: CommandExecutors;
  now: () => Date;
}): Promise<ApplyOutcome[]> {
  const byId = new Map<string, { command: SharedJobCommand; issuerDeviceId: string }>();
  for (const report of input.peers) {
    if (report.deviceId === input.ownDeviceId) continue;
    for (const command of report.commands ?? []) {
      if (command.targetDeviceId !== input.ownDeviceId || byId.has(command.commandId)) continue;
      byId.set(command.commandId, { command, issuerDeviceId: report.deviceId });
    }
  }
  const ordered = [...byId.values()].sort((a, b) => Date.parse(a.command.issuedAt) - Date.parse(b.command.issuedAt) || (a.command.commandId < b.command.commandId ? -1 : 1));
  const known = await input.store.known(ordered.map((o) => o.command.commandId));
  const outcomes: ApplyOutcome[] = [];
  for (const { command, issuerDeviceId } of ordered) {
    if (known.has(command.commandId)) continue;
    const receivedAt = input.now();
    const taken = await input.store.claim({
      commandId: command.commandId,
      issuerDeviceId,
      issuedOn: command.issuedOn,
      kind: command.kind,
      targetJson: targetOf(command),
      issuedAt: command.issuedAt,
      receivedAt: receivedAt.toISOString(),
    });
    if (!taken) {
      outcomes.push({ commandId: command.commandId, kind: command.kind, status: "skipped", code: null });
      continue;
    }
    const age = receivedAt.getTime() - Date.parse(command.issuedAt);
    let result: { status: "applied" | "refused"; code: string | null; jobId: string | null };
    if (age > MEDIA_JOB_COMMANDS_KEEP_MS || (command.kind === "create_job" && age > MEDIA_JOB_CREATE_COMMAND_MAX_AGE_MS)) {
      result = { status: "refused", code: "command_expired", jobId: null };
    } else {
      try {
        result = await execute(command, input.executors);
      } catch (error) {
        result = { status: "refused", code: refusalCode(error), jobId: null };
      }
    }
    await input.store.finish(command.commandId, { ...result, finishedAt: input.now().toISOString() });
    outcomes.push({ commandId: command.commandId, kind: command.kind, status: result.status, code: result.code });
  }
  return outcomes;
}

async function execute(command: SharedJobCommand, executors: CommandExecutors): Promise<{ status: "applied"; code: string | null; jobId: string | null }> {
  switch (command.kind) {
    case "cancel_job": {
      const done = await executors.cancelJob({ source: command.source!, jobId: command.jobId!, channelId: command.channelId });
      return { status: "applied", code: done === "already_finished" ? "already_finished" : null, jobId: command.jobId };
    }
    case "create_job": {
      const { jobId } = await executors.createJob({ sessionId: command.sessionId!, channelId: command.channelId!, templateId: command.create!.templateId, params: command.create!.params });
      return { status: "applied", code: null, jobId };
    }
    case "approve_session":
      await executors.approveSession({ sessionId: command.sessionId! });
      return { status: "applied", code: null, jobId: null };
    case "reject_session":
      await executors.rejectSession({ sessionId: command.sessionId!, reason: command.reason?.trim() || "Rejected from another computer." });
      return { status: "applied", code: null, jobId: null };
  }
}

/** The ledger as this computer's report carries it, newest first; a row stuck in `applying` is reported as interrupted. */
export function toCommandResults(rows: readonly StoredReceivedCommand[], now: Date): SharedCommandResult[] {
  return rows.slice(0, MEDIA_JOB_COMMAND_RESULTS_MAX).map((row) => {
    const stuck = row.status === "applying" && now.getTime() - Date.parse(row.receivedAt) > COMMAND_INTERRUPTED_AFTER_MS;
    const status = stuck ? "refused" : row.status === "applied" || row.status === "refused" ? row.status : "applying";
    return {
      commandId: row.commandId,
      issuerDeviceId: row.issuerDeviceId,
      kind: row.kind as MediaJobCommandKind,
      status,
      code: stuck ? "command_interrupted" : row.code,
      jobId: row.jobId,
      at: row.finishedAt ?? row.receivedAt,
    };
  });
}

/** This computer's outgoing commands as its report carries them (a stored row that no longer fits the schema is left out). */
export function toReportCommands(rows: readonly StoredOutgoingCommand[]): SharedJobCommand[] {
  const out: SharedJobCommand[] = [];
  for (const row of rows.slice(0, MEDIA_JOB_COMMANDS_MAX)) {
    try {
      const parsed = sharedJobCommandSchema.safeParse(JSON.parse(row.commandJson));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // an unreadable row is skipped
    }
  }
  return out;
}

export type CommandState = "waiting" | "applying" | "applied" | "refused" | "expired";

/** One outgoing command as Media shows it: sent, waiting for the other computer, then done or refused (with its code). */
export type CommandView = {
  commandId: string;
  kind: MediaJobCommandKind;
  targetDeviceId: string;
  targetHostName: string | null;
  /** The target computer's report is older than 5 minutes (or missing): the command runs when it is back. */
  targetOffline: boolean;
  targetUpdatedAt: string | null;
  source: "runpod" | "gemini" | null;
  jobId: string | null;
  sessionId: string | null;
  channelId: string | null;
  label: string | null;
  issuedAt: string;
  state: CommandState;
  code: string | null;
  /** create_job: the job it made on the other computer. */
  createdJobId: string | null;
  resultAt: string | null;
};

/**
 * Matches this computer's outgoing commands with the results in the target computers' reports. A `create_job` with no answer
 * after 15 minutes is shown as expired: the target refuses it when it sees it (it never starts late).
 */
export function commandViews(input: { ownDeviceId: string; outgoing: readonly SharedJobCommand[]; peers: readonly MediaJobsReport[]; now: Date }): CommandView[] {
  const reports = new Map(input.peers.filter((r) => r.deviceId !== input.ownDeviceId).map((r) => [r.deviceId, r]));
  return input.outgoing.map((command) => {
    const target = reports.get(command.targetDeviceId) ?? null;
    const result = target?.commandResults?.find((r) => r.commandId === command.commandId && r.issuerDeviceId === input.ownDeviceId) ?? null;
    const waitedMs = input.now.getTime() - Date.parse(command.issuedAt);
    const state: CommandState = result ? result.status : command.kind === "create_job" && waitedMs > MEDIA_JOB_CREATE_COMMAND_MAX_AGE_MS ? "expired" : "waiting";
    return {
      commandId: command.commandId,
      kind: command.kind,
      targetDeviceId: command.targetDeviceId,
      targetHostName: target?.hostName ?? null,
      targetOffline: !target || input.now.getTime() - Date.parse(target.updatedAt) > POOL_PEER_STALE_AFTER_MS,
      targetUpdatedAt: target?.updatedAt ?? null,
      source: command.source,
      jobId: command.jobId,
      sessionId: command.sessionId,
      channelId: command.channelId,
      label: command.create?.templateId ?? null,
      issuedAt: command.issuedAt,
      state,
      code: result?.code ?? null,
      createdJobId: command.kind === "create_job" ? (result?.jobId ?? null) : null,
      resultAt: result?.at ?? null,
    };
  });
}

/** Since when outgoing commands are kept and reported. */
export const outgoingSince = (now: Date) => new Date(now.getTime() - MEDIA_JOB_COMMANDS_KEEP_MS).toISOString();
export const receivedSince = (now: Date) => new Date(now.getTime() - COMMAND_LEDGER_KEEP_MS).toISOString();

// ---------------------------------------------------------------------------
// Issuing (the clicking computer). Every target is checked against the other computer's own report before a command is stored:
// the job or session must be there, in the active channel (ADR 0004 (b)) for jobs and runs, and still able to take the action.
// The executor checks everything again; this only keeps a command that can never apply from being sent.
// ---------------------------------------------------------------------------

export const issueCommandInputSchema = z
  .object({
    kind: z.enum(["cancel_job", "create_job", "approve_session", "reject_session"]),
    targetDeviceId: z.string().min(1).max(128),
    source: z.enum(["runpod", "gemini"]).optional(),
    jobId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
    sessionId: z.string().min(1).max(64).optional(),
    templateId: z.string().min(1).max(128).optional(),
    params: z.record(z.string().max(128), z.union([z.string().max(20_000), z.number().finite(), z.boolean()])).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict();
export type IssueCommandInput = z.infer<typeof issueCommandInputSchema>;

/** A peer's session as its media-sessions report shows it (only what issuing needs). */
export type PeerSessionRef = { deviceId: string; sessionId: string; channelId: string; status: string };

const RUNPOD_OPEN = new Set(["queued", "submitted", "generating"]);

function invalid(message: string, details: Record<string, unknown>): DomainError {
  return new DomainError({ code: "media_job_command_invalid", message, details });
}

/**
 * Builds the command for a click on another computer's job or session, or throws: `validation_failed` (a malformed request, or
 * this computer itself as the target -- its own actions are called directly), `media_job_command_invalid` (the computer, job or
 * session is not in its report, belongs to another channel, or can no longer take the action), `channel_not_connected`.
 */
export async function prepareCommand(input: {
  raw: unknown;
  ownDeviceId: string;
  ownHostName: string | null;
  activeChannelId: string | null;
  jobReports: readonly MediaJobsReport[];
  peerSessions: readonly PeerSessionRef[];
  isConnectedChannel: (channelId: string) => Promise<boolean>;
  now: Date;
  newId: () => string;
}): Promise<SharedJobCommand> {
  const parsed = issueCommandInputSchema.safeParse(input.raw);
  if (!parsed.success) throw new DomainError({ code: "validation_failed", message: parsed.error.issues.map((i) => i.message).join("; "), details: {} });
  const req = parsed.data;
  if (req.targetDeviceId === input.ownDeviceId) throw new DomainError({ code: "validation_failed", message: "This computer's own jobs and sessions are changed directly, not by a command.", details: {} });
  const base = {
    commandId: input.newId(),
    kind: req.kind,
    targetDeviceId: req.targetDeviceId,
    source: null,
    jobId: null,
    sessionId: null,
    channelId: null,
    create: null,
    reason: null,
    issuedAt: input.now.toISOString(),
    issuedOn: input.ownHostName,
  } satisfies SharedJobCommand;
  let command: SharedJobCommand;
  if (req.kind === "cancel_job") {
    if (!req.source || !req.jobId) throw new DomainError({ code: "validation_failed", message: "cancel_job needs source and jobId", details: {} });
    const report = input.jobReports.find((r) => r.deviceId === req.targetDeviceId);
    const job = report?.jobs.find((j) => j.source === req.source && j.jobId === req.jobId);
    if (!job || job.channelId !== input.activeChannelId) throw invalid("That job is not in the other computer's report for the active channel.", { jobId: req.jobId });
    const cancellable = job.source === "runpod" ? RUNPOD_OPEN.has(job.status) : job.status === "queued";
    if (!cancellable) throw invalid(`The job is ${job.status}; it cannot be cancelled.`, { jobId: req.jobId, status: job.status });
    command = { ...base, source: job.source, jobId: job.jobId, channelId: job.channelId };
  } else {
    if (!req.sessionId) throw new DomainError({ code: "validation_failed", message: `${req.kind} needs sessionId`, details: {} });
    const session = input.peerSessions.find((s) => s.deviceId === req.targetDeviceId && s.sessionId === req.sessionId);
    if (!session) throw invalid("That session is not in the other computer's report.", { sessionId: req.sessionId });
    if (req.kind === "create_job") {
      if (!req.templateId) throw new DomainError({ code: "validation_failed", message: "create_job needs templateId", details: {} });
      if (session.channelId !== input.activeChannelId) throw invalid("The session belongs to another channel than the active one.", { sessionId: req.sessionId });
      if (session.status !== "running") throw invalid(`The session is ${session.status}; a job needs a running session.`, { sessionId: req.sessionId, status: session.status });
      command = { ...base, sessionId: session.sessionId, channelId: session.channelId, create: { templateId: req.templateId, params: req.params ?? {} } };
    } else {
      if (session.status !== "pending") throw invalid(`The session is ${session.status}; only a pending request can be approved or rejected.`, { sessionId: req.sessionId, status: session.status });
      if (!(await input.isConnectedChannel(session.channelId))) {
        throw new DomainError({ code: "channel_not_connected", message: "The session's channel is not connected on this computer.", details: { channelId: session.channelId } });
      }
      command = { ...base, sessionId: session.sessionId, channelId: session.channelId, reason: req.kind === "reject_session" ? (req.reason?.trim() || null) : null };
    }
  }
  return sharedJobCommandSchema.parse(command);
}
