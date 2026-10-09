import { randomUUID } from "node:crypto";
import type { AgentTokenRecord, AgentTokenSyncPlan } from "./contracts";

const sameIdentity = (a: AgentTokenRecord, b: AgentTokenRecord) => a.role === b.role && a.channelId === b.channelId && a.userId === b.userId;
const slotOf = (record: AgentTokenRecord) => (record.role === "channel" ? `channel:${record.channelId}` : record.role);
const earlier = (a: Date | null, b: Date | null) => (a === null ? b : b === null ? a : a.getTime() <= b.getTime() ? a : b);

/** A peer record dated further ahead than this is ignored: a fast clock must not let a token win its slot for good. */
export const MAX_RECORD_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * The rules (plan §2), a pure function so every device computes the same result from the same records:
 * 1. Records are joined by hash. A hash revoked anywhere is revoked (the earliest `revokedAt`); a revocation is never undone.
 * 2. A peer record whose hash this device knows under another role, channel or Google account is ignored (the local row wins);
 *    peers disagreeing about a hash this device does not know: that hash is skipped.
 * 3. One active token per slot (each channel; the factory; the producer): among a slot's unrevoked tokens the newest `createdAt`
 *    wins (equal times: the larger hash); the others are revoked as of the winner's `createdAt`.
 * A peer record dated (created or revoked) more than 5 min after `now` is ignored, whatever the report's own date.
 * Returns what THIS device must change: rows to revoke, tokens to add, and local rows to re-date. A token's `createdAt` is the
 * earliest any device reports.
 */
export function reconcileAgentTokens(local: AgentTokenRecord[], peers: AgentTokenRecord[], options: { now?: Date } = {}): AgentTokenSyncPlan {
  const localByHash = new Map(local.map((record) => [record.hash, record]));
  const merged = new Map<string, AgentTokenRecord>(local.map((record) => [record.hash, { ...record }]));
  const ignored: AgentTokenSyncPlan["ignored"] = [];
  const ambiguous = new Set<string>();
  const latestAllowed = (options.now ?? new Date()).getTime() + MAX_RECORD_FUTURE_SKEW_MS;

  for (const peer of peers) {
    if (peer.createdAt.getTime() > latestAllowed || (peer.revokedAt !== null && peer.revokedAt.getTime() > latestAllowed)) {
      ignored.push({ hash: peer.hash, reason: "dated_in_future" });
      continue;
    }
    const own = localByHash.get(peer.hash);
    if (own && !sameIdentity(own, peer)) {
      ignored.push({ hash: peer.hash, reason: "conflicts_with_local" });
      continue;
    }
    if (ambiguous.has(peer.hash)) continue;
    const known = merged.get(peer.hash);
    if (!known) {
      merged.set(peer.hash, { ...peer });
      continue;
    }
    if (!sameIdentity(known, peer)) {
      // Only possible for a hash this device does not have: two peers describe it differently, so neither is trusted.
      merged.delete(peer.hash);
      ambiguous.add(peer.hash);
      ignored.push({ hash: peer.hash, reason: "peers_disagree" });
      continue;
    }
    if (peer.createdAt.getTime() < known.createdAt.getTime()) {
      known.createdAt = peer.createdAt;
      if (!own && peer.label !== null) known.label = peer.label;
    }
    if (!own && known.label === null) known.label = peer.label;
    known.revokedAt = earlier(known.revokedAt, peer.revokedAt);
  }

  // Rule 3: one active token per slot.
  const activeBySlot = new Map<string, AgentTokenRecord[]>();
  for (const record of merged.values()) {
    if (record.revokedAt !== null) continue;
    const slot = slotOf(record);
    activeBySlot.set(slot, [...(activeBySlot.get(slot) ?? []), record]);
  }
  for (const candidates of activeBySlot.values()) {
    if (candidates.length < 2) continue;
    const winner = candidates.reduce((best, record) => {
      const diff = record.createdAt.getTime() - best.createdAt.getTime();
      return diff > 0 || (diff === 0 && record.hash > best.hash) ? record : best;
    });
    for (const record of candidates) if (record !== winner) record.revokedAt = winner.createdAt;
  }

  const revoke: AgentTokenSyncPlan["revoke"] = [];
  const insert: AgentTokenRecord[] = [];
  const redate: AgentTokenSyncPlan["redate"] = [];
  for (const record of merged.values()) {
    const own = localByHash.get(record.hash);
    if (own) {
      if (own.revokedAt === null && record.revokedAt !== null) revoke.push({ role: own.role, hash: own.hash, revokedAt: record.revokedAt });
      if (record.createdAt.getTime() < own.createdAt.getTime()) redate.push({ role: own.role, hash: own.hash, createdAt: record.createdAt });
    } else {
      insert.push(record);
    }
  }
  return { revoke, insert, redate, ignored };
}

/** What a published report carries of a token (the shape of the `agent-tokens` family's records). */
export type SharedTokenView = {
  hash: string;
  role: AgentTokenRecord["role"];
  channelId: string | null;
  userId: string | null;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
};

export type AgentTokenSyncDeps = {
  store: {
    listAll(): Promise<AgentTokenRecord[]>;
    apply(plan: { revoke: AgentTokenSyncPlan["revoke"]; insert: Array<AgentTokenRecord & { id: string }>; redate: AgentTokenSyncPlan["redate"] }): Promise<void>;
  };
  share: {
    listPeerTokens(): Promise<SharedTokenView[]>;
    publish(tokens: SharedTokenView[]): Promise<void>;
  };
  /** Pushes this device's report to the shared folder right away (the family's sync cycle); best effort. */
  pushNow?: () => Promise<unknown>;
  logger?: { info(payload: { event: string; context?: Record<string, unknown> }): void };
  newId?: () => string;
  clock?: { now(): Date };
};

/** An unchanged report is still republished this often, so its date stays fresh for every reader (review round 1). */
export const REPUBLISH_UNCHANGED_AFTER_MS = 24 * 60 * 60_000;

function toRecord(view: SharedTokenView): AgentTokenRecord {
  return { ...view, createdAt: new Date(view.createdAt), revokedAt: view.revokedAt === null ? null : new Date(view.revokedAt) };
}

/** Exactly the shared fields: nothing else a store may carry (a row id, say) ever reaches the report. */
function toView(record: AgentTokenRecord): SharedTokenView {
  return {
    hash: record.hash,
    role: record.role,
    channelId: record.channelId,
    userId: record.userId,
    label: record.label,
    createdAt: record.createdAt.toISOString(),
    revokedAt: record.revokedAt?.toISOString() ?? null,
  };
}

export function createAgentTokenSyncServices(deps: AgentTokenSyncDeps) {
  const newId = deps.newId ?? randomUUID;
  const now = () => (deps.clock ?? { now: () => new Date() }).now();
  let lastPublished: { text: string; at: number } | null = null;
  let inFlight: Promise<{ applied: boolean; published: boolean }> | null = null;

  async function runTick(applyPeers: boolean): Promise<{ applied: boolean; published: boolean }> {
    const plan: AgentTokenSyncPlan = applyPeers
      ? reconcileAgentTokens(await deps.store.listAll(), (await deps.share.listPeerTokens()).map(toRecord), { now: now() })
      : { revoke: [], insert: [], redate: [], ignored: [] };
    const applied = plan.revoke.length > 0 || plan.insert.length > 0 || plan.redate.length > 0;
    if (applied) {
      await deps.store.apply({ revoke: plan.revoke, insert: plan.insert.map((record) => ({ ...record, id: newId() })), redate: plan.redate });
      deps.logger?.info({ event: "agent_tokens.synced", context: { revoked: plan.revoke.length, added: plan.insert.length, redated: plan.redate.length } });
    }
    if (plan.ignored.length > 0) {
      deps.logger?.info({ event: "agent_tokens.peer_records_ignored", context: { count: plan.ignored.length, reasons: [...new Set(plan.ignored.map((i) => i.reason))] } });
    }
    // Publish what this device now knows: when it changed, once after start, and at least daily (a fresh date for every reader).
    const tokens = (await deps.store.listAll()).map(toView).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    const text = JSON.stringify(tokens);
    const at = now().getTime();
    if (lastPublished && text === lastPublished.text && at - lastPublished.at < REPUBLISH_UNCHANGED_AFTER_MS) return { applied, published: false };
    await deps.share.publish(tokens);
    lastPublished = { text, at };
    if (deps.pushNow) {
      // A cycle already running may have read the previous report and is handed back; the second push then runs a fresh cycle.
      await deps.pushNow().catch(() => undefined);
      await deps.pushNow().catch(() => undefined);
    }
    return { applied, published: true };
  }

  return {
    /**
     * One step: apply the other devices' latest reports to this device's token tables (unless `applyPeers` is false: a local
     * change only publishes, the scheduled step applies), then publish this device's report if it changed. Runs one at a time; a
     * caller arriving mid-step waits for it and then runs its own (it may follow a local change).
     */
    async tick(options: { applyPeers?: boolean } = {}): Promise<{ applied: boolean; published: boolean }> {
      while (inFlight) await inFlight.catch(() => undefined);
      const run = runTick(options.applyPeers ?? true).finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },
  };
}

export type AgentTokenSyncServices = ReturnType<typeof createAgentTokenSyncServices>;
