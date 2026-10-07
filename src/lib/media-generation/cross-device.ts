import { z } from "zod";
import type { RunpodApiClient } from "@/lib/media-gateway";
import type { MediaSessionsReport, SharedJobProgress, SharedMediaSession, SharedSessionJobs } from "@/lib/sync-gateway";
import { MEDIA_SESSIONS_REPORT_FORMAT, MEDIA_SESSIONS_REPORT_VERSION, SHARED_CURRENT_JOBS_MAX, sharedSessionJobsSchema } from "@/lib/sync-gateway";
import { DomainError, MEDIA_JOB_TERMINAL_STATUSES, MEDIA_SESSION_TERMINAL_STATUSES, parseWithSchema, type MediaJob, type MediaSession, type MediaSessionStatus } from "./contracts";
import type { JobLiveProgress } from "./job-progress";
import { terminateAndConfirm } from "./pod-lifecycle";

// BL-138 (owner, Telegram 2026-10-06, msgs 1706/1735/1739; ADR 0028): this device's sessions published for the other devices
// (through the sync-gateway `media-sessions` family), and the other devices' reports checked against RunPod's live pod list.

/** A pod of a generation session is named `ytm-media-<sessionId[0..8]>` (`podNameFor`). */
export const SESSION_POD_PREFIX = "ytm-media-";
/** A peer report older than this is "stale": its device may be off, its numbers may be out of date. */
export const PEER_REPORT_STALE_AFTER_MS = 5 * 60_000;
/** How long a finished session stays in this device's report. */
export const REPORT_FINISHED_WINDOW_MS = 24 * 60 * 60_000;

/** The fields another device may see: no ComfyUI URL (it carries the proxy token), no error text from RunPod. */
export function toSharedSession(s: MediaSession): SharedMediaSession {
  return {
    sessionId: s.sessionId,
    channelId: s.channelId,
    status: s.status,
    requestedBy: s.requestedBy,
    gpuTypeId: s.gpuTypeId,
    datacenterId: s.datacenterId,
    podId: s.podId,
    costPerHr: s.costPerHr,
    maxMinutes: s.maxMinutes,
    maxUsd: s.maxUsd,
    createdAt: s.createdAt,
    approvedAt: s.approvedAt,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    secondsUsed: s.secondsUsed,
    usdCharged: s.usdCharged,
    stopReason: s.stopReason ? s.stopReason.slice(0, 200) : null,
  };
}

const isTerminal = (status: string) => (MEDIA_SESSION_TERMINAL_STATUSES as readonly string[]).includes(status);

// -- Jobs of an open session (BL-148, owner msg 1976: see the work's progress from another computer) ------------------------

const clampInt = (n: number, max: number) => Math.min(max, Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));

/**
 * BL-144 progress without `detail`: that can be ComfyUI's error text, which never leaves this device. Numbers are clamped to the
 * report's bounds (independent review): one odd value from ComfyUI must not make the whole sessions report invalid.
 */
export function toSharedJobProgress(p: JobLiveProgress): SharedJobProgress {
  return {
    state: p.state,
    percent: p.percent === null ? null : Math.min(100, Math.max(0, Number.isFinite(p.percent) ? p.percent : 0)),
    nodesTotal: p.nodesTotal === null ? null : clampInt(p.nodesTotal, 100_000),
    nodesDone: clampInt(p.nodesDone, 100_000),
    nodesCached: clampInt(p.nodesCached, 100_000),
    currentNodeType: p.currentNode ? (p.currentNode.type ?? `#${p.currentNode.id}`).slice(0, 128) : null,
    step: p.step && Number.isFinite(p.step.value) && Number.isFinite(p.step.max) ? { value: p.step.value, max: p.step.max } : null,
    startedAt: p.startedAt ? p.startedAt.slice(0, 40) : null,
    updatedAt: p.updatedAt.slice(0, 40),
  };
}

const RUNNING_JOB_STATUSES = new Set(["submitted", "generating", "transferring"]);

/** What `jobs.sessionJobsForShare` reads for one open session: the count per status (all jobs) and the first unfinished ones. */
export type SessionJobsInput = { counts: Record<string, number>; open: MediaJob[] };

/**
 * A session's jobs for the report: the database's count per status (no cap) and the unfinished jobs -- running first, then the
 * queue in order -- with their live progress when this device watches it. Null when the result would not fit the report's
 * schema: that session then shows no jobs, and every other session is still reported.
 */
export function summarizeSessionJobs(input: SessionJobsInput): SharedSessionJobs | null {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const [status, n] of Object.entries(input.counts)) {
    if (status === "queued") counts.queued += n;
    else if (RUNNING_JOB_STATUSES.has(status)) counts.running += n;
    else if (status === "done") counts.done += n;
    else if (status === "failed") counts.failed += n;
    else if (status === "cancelled") counts.cancelled += n;
  }
  const open = input.open
    .filter((j) => !(MEDIA_JOB_TERMINAL_STATUSES as readonly string[]).includes(j.status))
    .sort((a, b) => Number(RUNNING_JOB_STATUSES.has(b.status)) - Number(RUNNING_JOB_STATUSES.has(a.status)) || a.createdAt.localeCompare(b.createdAt));
  const summary: SharedSessionJobs = {
    counts,
    current: open.slice(0, SHARED_CURRENT_JOBS_MAX).map((j) => ({
      jobId: j.jobId,
      templateId: j.templateId.slice(0, 128),
      status: j.status,
      createdBy: j.createdBy,
      submittedAt: j.submittedAt,
      planItemKey: j.plan?.itemKey ? j.plan.itemKey.slice(0, 200) : null,
      progress: j.progress ? toSharedJobProgress(j.progress) : null,
    })),
  };
  return sharedSessionJobsSchema.safeParse(summary).success ? summary : null;
}

/** Open sessions, plus the ones finished within the last day. */
export function buildSessionsReport(input: {
  deviceId: string;
  hostname: string | null;
  runpodAccountId: string | null;
  now: Date;
  sessions: MediaSession[];
  spentTodayUsd: number;
  /** BL-148: the jobs of each open session (`jobs.sessionJobsForShare`); a session missing here has none listed. */
  jobsBySession?: Record<string, SessionJobsInput>;
}): MediaSessionsReport {
  const cutoff = input.now.getTime() - REPORT_FINISHED_WINDOW_MS;
  const sessions = input.sessions
    .filter((s) => !isTerminal(s.status) || Date.parse(s.stoppedAt ?? s.createdAt) >= cutoff)
    .slice(0, 200)
    .map((s) => {
      const shared = toSharedSession(s);
      const jobs = isTerminal(s.status) ? undefined : input.jobsBySession?.[s.sessionId];
      const summary = jobs ? summarizeSessionJobs(jobs) : null;
      return summary ? { ...shared, jobs: summary } : shared;
    });
  return {
    format: MEDIA_SESSIONS_REPORT_FORMAT,
    version: MEDIA_SESSIONS_REPORT_VERSION,
    deviceId: input.deviceId,
    hostname: input.hostname,
    runpodAccountId: input.runpodAccountId,
    updatedAt: input.now.toISOString(),
    spentTodayUsd: input.spentTodayUsd,
    sessions,
  };
}

/** What RunPod says about a peer's session right now. */
export type PeerSessionLiveState = "pod_running" | "pod_gone" | "no_pod_yet" | "ended";
export type PeerSessionView = SharedMediaSession & { live: PeerSessionLiveState };
export type OtherDeviceView = {
  deviceId: string;
  hostname: string | null;
  updatedAt: string;
  stale: boolean;
  /** Both devices reported the same RunPod account id (null on either side = unknown, counted as not shared). */
  sameAccount: boolean;
  spentTodayUsd: number;
  sessions: PeerSessionView[];
};
export type UnknownPodView = { podId: string; name: string; costPerHr: number | null; status: string };
export type OtherDevicesView = {
  devices: OtherDeviceView[];
  /** Live `ytm-media-*` pods no device reports: spend nobody shows. Null when RunPod's pod list could not be read. */
  unknownPods: UnknownPodView[] | null;
  podsError: string | null;
};

export function deriveOtherDevices(input: {
  peers: MediaSessionsReport[];
  ownAccountId: string | null;
  localPodIds: string[];
  livePods: Array<{ id: string; name: string; costPerHr: number | null; status: string }> | null;
  podsError?: string | null;
  now: Date;
}): OtherDevicesView {
  // RunPod can still list a TERMINATED pod for a while (pod-lifecycle's own filter): it is not running and not billed.
  const livePods = input.livePods ? input.livePods.filter((p) => p.status !== "TERMINATED") : null;
  const live = livePods ? new Set(livePods.map((p) => p.id)) : null;
  const liveState = (s: SharedMediaSession, sameAccount: boolean): PeerSessionLiveState => {
    if (isTerminal(s.status as MediaSessionStatus)) return "ended";
    if (!s.podId) return "no_pod_yet";
    // This account's pod list says nothing about another account's pods (independent review): keep the peer's word.
    if (!live || !sameAccount) return "pod_running";
    return live.has(s.podId) ? "pod_running" : "pod_gone";
  };
  const devices = input.peers.map((r) => {
    const sameAccount = r.runpodAccountId !== null && input.ownAccountId !== null && r.runpodAccountId === input.ownAccountId;
    return {
      deviceId: r.deviceId,
      hostname: r.hostname,
      updatedAt: r.updatedAt,
      stale: input.now.getTime() - Date.parse(r.updatedAt) > PEER_REPORT_STALE_AFTER_MS,
      sameAccount,
      spentTodayUsd: r.spentTodayUsd,
      sessions: r.sessions.map((s) => ({ ...s, live: liveState(s, sameAccount) })),
    };
  });
  let unknownPods: UnknownPodView[] | null = null;
  if (livePods) {
    const known = new Set([...input.localPodIds, ...input.peers.flatMap((r) => r.sessions.map((s) => s.podId).filter((id): id is string => Boolean(id)))]);
    unknownPods = livePods.filter((p) => p.name.startsWith(SESSION_POD_PREFIX) && !known.has(p.id)).map((p) => ({ podId: p.id, name: p.name, costPerHr: p.costPerHr, status: p.status }));
  }
  return { devices, unknownPods, podsError: input.podsError ?? null };
}

// -- Stop a session of another device (owner, msg 1739: "да") -------------------------------------------------------------

export const stopPeerSessionInputSchema = z.object({ deviceId: z.string().min(1).max(128), sessionId: z.string().min(1).max(64) }).strict();
const PEER_STOP_TIMEOUT_MS = 90_000;
const PEER_STOP_POLL_MS = 5_000;

export type PeerStopDeps = {
  listPeerReports(): Promise<MediaSessionsReport[]>;
  /** Pods of this device's own sessions: a peer report can never direct a Stop at one of them. */
  localPodIds(): Promise<string[]>;
  ownAccountId(): Promise<string | null>;
  runpodClient(): Promise<RunpodApiClient>;
  podNameFor(sessionId: string): string;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  record(event: { action: string; subject: string; details: Record<string, unknown> }): Promise<void>;
};

/**
 * Terminates the pod of a session another device started, through RunPod directly (it works while that device is off; the
 * device marks the session interrupted, "pod disappeared", when its watcher next runs). Guards, all before any DELETE: the
 * session must be in that device's latest report and not finished; both devices must report the same RunPod account; and the
 * live pod must carry the session's own deterministic name -- a report can never point this at an unrelated pod.
 */
export async function stopPeerSession(deps: PeerStopDeps, input: unknown): Promise<{ podId: string; alreadyGone: boolean; confirmed: boolean }> {
  const { deviceId, sessionId } = parseWithSchema(stopPeerSessionInputSchema, input, "stop another device's session");
  const report = (await deps.listPeerReports()).find((r) => r.deviceId === deviceId);
  const session = report?.sessions.find((s) => s.sessionId === sessionId);
  if (!report || !session) throw new DomainError({ code: "media_session_not_found", message: "That device has not reported this session.", details: { deviceId, sessionId } });
  if (isTerminal(session.status) || !session.podId) {
    throw new DomainError({ code: "media_session_conflict", message: `The session is ${session.status}${session.podId ? "" : " and has no pod"}; there is nothing to stop.`, details: { deviceId, sessionId } });
  }
  if ((await deps.localPodIds()).includes(session.podId)) {
    throw new DomainError({ code: "validation_failed", message: "That pod belongs to a session of this device; stop it in the list above.", details: { deviceId, sessionId, podId: session.podId } });
  }
  const own = await deps.ownAccountId();
  if (!own || !report.runpodAccountId || own !== report.runpodAccountId) {
    throw new DomainError({
      code: "validation_failed",
      message: "That device uses another RunPod account (or the account could not be read on one side); its pods can only be stopped there.",
      details: { deviceId, sessionId },
    });
  }
  const client = await deps.runpodClient();
  const pod = (await client.listPods()).find((p) => p.id === session.podId && p.status !== "TERMINATED");
  if (!pod) {
    return { podId: session.podId, alreadyGone: true, confirmed: true };
  }
  if (pod.name !== deps.podNameFor(sessionId)) {
    throw new DomainError({
      code: "validation_failed",
      message: `Pod ${pod.id} is named ${pod.name}, not ${deps.podNameFor(sessionId)}: it is not this session's pod, so it is not stopped.`,
      details: { deviceId, sessionId, podId: pod.id },
    });
  }
  const outcome = await terminateAndConfirm(client, pod.id, { now: () => deps.clock.now(), sleep: deps.sleep }, { timeoutMs: PEER_STOP_TIMEOUT_MS, pollMs: PEER_STOP_POLL_MS });
  await deps.record({ action: "stop_peer_session", subject: sessionId, details: { deviceId, hostname: report.hostname, podId: pod.id, confirmed: outcome.confirmed } }).catch(() => undefined);
  return { podId: pod.id, alreadyGone: outcome.alreadyGone, confirmed: outcome.confirmed };
}

// -- Shared limits for devices on one RunPod account (owner, msg 1739) ------------------------------------------------------

/**
 * What the OTHER devices on this RunPod account use, for this device's limits. Concurrency comes from RunPod itself (live
 * `ytm-media-*` pods that are not this device's), never from the reports, so it is right even when a device is off or its
 * report is late. Today's spend comes from the reports of devices on the same account written since `dayStart` (spend is
 * history: a device that went off at noon still spent its morning). Unknown own account = nothing shared.
 */
export function accountWideUsage(input: {
  peers: MediaSessionsReport[];
  ownAccountId: string | null;
  /** null = RunPod's pod list could not be read: no slots counted, the reported spend still is. */
  livePods: Array<{ id: string; name: string; status?: string }> | null;
  localPodIds: string[];
  dayStart: Date;
  now: Date;
}): { otherActiveSessions: number; otherSpentTodayUsd: number } {
  if (!input.ownAccountId) return { otherActiveSessions: 0, otherSpentTodayUsd: 0 };
  const local = new Set(input.localPodIds);
  const otherActiveSessions = (input.livePods ?? []).filter((p) => p.name.startsWith(SESSION_POD_PREFIX) && p.status !== "TERMINATED" && !local.has(p.id)).length;
  const otherSpentTodayUsd = input.peers
    // A future-dated report (a peer clock running fast) is not "today's" spend.
    .filter((r) => r.runpodAccountId === input.ownAccountId && Date.parse(r.updatedAt) >= input.dayStart.getTime() && Date.parse(r.updatedAt) <= input.now.getTime() + 5 * 60_000)
    .reduce((sum, r) => sum + Math.max(0, r.spentTodayUsd), 0);
  return { otherActiveSessions, otherSpentTodayUsd: Math.round(otherSpentTodayUsd * 100) / 100 };
}
