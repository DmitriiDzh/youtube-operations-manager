import {
  approveMediaSessionGuarded,
  getMediaSessionById,
  insertMediaSession,
  listOpenMediaSessions,
  listMediaSessions,
  listMediaSessionsBillableSince,
  markMediaSessionSeenAlive,
  touchMediaSessionActivity,
  transitionMediaSession,
  type StoredMediaSession,
} from "@/lib/db";
import type { MediaSessionStore, StoredSessionRow } from "../sessions";

function fromDb(row: StoredMediaSession): StoredSessionRow {
  return {
    id: row.id,
    channelId: row.channelId,
    status: row.status,
    requestedBy: row.requestedBy,
    reason: row.reason ?? null,
    maxMinutes: row.maxMinutes,
    maxUsd: row.maxUsd ?? null,
    estimateUsd: row.estimateUsd,
    fitsToday: row.fitsToday,
    costPerHr: row.costPerHr ?? null,
    gpuTypeId: row.gpuTypeId ?? null,
    datacenterId: row.datacenterId ?? null,
    podId: row.podId ?? null,
    comfyUiProxyUrl: row.comfyUiProxyUrl ?? null,
    tokenCiphertext: row.tokenCiphertext ?? null,
    tokenIv: row.tokenIv ?? null,
    tokenAuthTag: row.tokenAuthTag ?? null,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt ?? null,
    approvedByUserId: row.approvedByUserId ?? null,
    startedAt: row.startedAt ?? null,
    readyAt: row.readyAt ?? null,
    lastActivityAt: row.lastActivityAt ?? null,
    stoppedAt: row.stoppedAt ?? null,
    secondsUsed: row.secondsUsed ?? null,
    usdCharged: row.usdCharged ?? null,
    stopReason: row.stopReason ?? null,
    error: row.error ?? null,
    stoppingOutcome: row.stoppingOutcome ?? null,
    lastSeenAliveAt: row.lastSeenAliveAt ?? null,
    terminateSentAt: row.terminateSentAt ?? null,
    releaseWhenDone: row.releaseWhenDone ?? false,
  };
}

export function createMediaSessionStore(): MediaSessionStore {
  return {
    async insert(row) {
      return fromDb(await insertMediaSession(row));
    },
    async get(id) {
      const row = await getMediaSessionById(id);
      return row ? fromDb(row) : null;
    },
    async listOpen() {
      return (await listOpenMediaSessions()).map(fromDb);
    },
    async approve(id, set, maxActive) {
      const row = await approveMediaSessionGuarded(id, set, maxActive);
      return row ? fromDb(row) : null;
    },
    async list(limit, channelId) {
      return (await listMediaSessions(limit, channelId)).map(fromDb);
    },
    async listBillableSince(since) {
      return (await listMediaSessionsBillableSince(since)).map(fromDb);
    },
    async transition(id, from, set) {
      const row = await transitionMediaSession(id, from, set);
      return row ? fromDb(row) : null;
    },
    touchActivity: (id, at) => touchMediaSessionActivity(id, at),
    markSeenAlive: (id, at) => markMediaSessionSeenAlive(id, at),
  };
}
