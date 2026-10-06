import { z } from "zod";
import type { RunpodApiClient } from "@/lib/media-gateway";
import type { MediaSessionsReport, SharedMediaSession } from "@/lib/sync-gateway";
import { MEDIA_SESSIONS_REPORT_FORMAT } from "@/lib/sync-gateway";
import { DomainError, MEDIA_SESSION_TERMINAL_STATUSES, parseWithSchema, type MediaSession, type MediaSessionStatus } from "./contracts";
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

/** Open sessions, plus the ones finished within the last day. */
export function buildSessionsReport(input: {
  deviceId: string;
  hostname: string | null;
  runpodAccountId: string | null;
  now: Date;
  sessions: MediaSession[];
  spentTodayUsd: number;
}): MediaSessionsReport {
  const cutoff = input.now.getTime() - REPORT_FINISHED_WINDOW_MS;
  const sessions = input.sessions
    .filter((s) => !isTerminal(s.status) || Date.parse(s.stoppedAt ?? s.createdAt) >= cutoff)
    .slice(0, 200)
    .map(toSharedSession);
  return {
    format: MEDIA_SESSIONS_REPORT_FORMAT,
    version: 1,
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
  const live = input.livePods ? new Set(input.livePods.map((p) => p.id)) : null;
  const liveState = (s: SharedMediaSession): PeerSessionLiveState => {
    if (isTerminal(s.status as MediaSessionStatus)) return "ended";
    if (!s.podId) return "no_pod_yet";
    if (!live) return "pod_running"; // unknown: RunPod not readable, keep the peer's word
    return live.has(s.podId) ? "pod_running" : "pod_gone";
  };
  const devices = input.peers.map((r) => ({
    deviceId: r.deviceId,
    hostname: r.hostname,
    updatedAt: r.updatedAt,
    stale: input.now.getTime() - Date.parse(r.updatedAt) > PEER_REPORT_STALE_AFTER_MS,
    sameAccount: r.runpodAccountId !== null && input.ownAccountId !== null && r.runpodAccountId === input.ownAccountId,
    spentTodayUsd: r.spentTodayUsd,
    sessions: r.sessions.map((s) => ({ ...s, live: liveState(s) })),
  }));
  let unknownPods: UnknownPodView[] | null = null;
  if (input.livePods) {
    const known = new Set([...input.localPodIds, ...input.peers.flatMap((r) => r.sessions.map((s) => s.podId).filter((id): id is string => Boolean(id)))]);
    unknownPods = input.livePods.filter((p) => p.name.startsWith(SESSION_POD_PREFIX) && !known.has(p.id)).map((p) => ({ podId: p.id, name: p.name, costPerHr: p.costPerHr, status: p.status }));
  }
  return { devices, unknownPods, podsError: input.podsError ?? null };
}

// -- Stop a session of another device (owner, msg 1739: "да") -------------------------------------------------------------

export const stopPeerSessionInputSchema = z.object({ deviceId: z.string().min(1).max(128), sessionId: z.string().min(1).max(64) }).strict();
const PEER_STOP_TIMEOUT_MS = 90_000;
const PEER_STOP_POLL_MS = 5_000;

export type PeerStopDeps = {
  listPeerReports(): Promise<MediaSessionsReport[]>;
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
  const own = await deps.ownAccountId();
  if (!own || !report.runpodAccountId || own !== report.runpodAccountId) {
    throw new DomainError({
      code: "validation_failed",
      message: "That device uses another RunPod account (or the account could not be read on one side); its pods can only be stopped there.",
      details: { deviceId, sessionId },
    });
  }
  const client = await deps.runpodClient();
  const pod = (await client.listPods()).find((p) => p.id === session.podId);
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
  livePods: Array<{ id: string; name: string }>;
  localPodIds: string[];
  dayStart: Date;
}): { otherActiveSessions: number; otherSpentTodayUsd: number } {
  if (!input.ownAccountId) return { otherActiveSessions: 0, otherSpentTodayUsd: 0 };
  const local = new Set(input.localPodIds);
  const otherActiveSessions = input.livePods.filter((p) => p.name.startsWith(SESSION_POD_PREFIX) && !local.has(p.id)).length;
  const otherSpentTodayUsd = input.peers
    .filter((r) => r.runpodAccountId === input.ownAccountId && Date.parse(r.updatedAt) >= input.dayStart.getTime())
    .reduce((sum, r) => sum + Math.max(0, r.spentTodayUsd), 0);
  return { otherActiveSessions, otherSpentTodayUsd: Math.round(otherSpentTodayUsd * 100) / 100 };
}
