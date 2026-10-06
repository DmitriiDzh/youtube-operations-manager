import type { MediaSessionsReport, SharedMediaSession } from "@/lib/sync-gateway";
import { MEDIA_SESSIONS_REPORT_FORMAT } from "@/lib/sync-gateway";
import { MEDIA_SESSION_TERMINAL_STATUSES, type MediaSession, type MediaSessionStatus } from "./contracts";

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
