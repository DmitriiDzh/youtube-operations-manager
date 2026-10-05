import type { EncryptedPayload } from "@/lib/shared-crypto";
import type { ComfyUiClient, RunpodApiClient, RunpodPod } from "@/lib/media-gateway";
import {
  COMFY_PROXY_PORT,
  DomainError,
  MEDIA_SESSION_NON_TERMINAL_STATUSES,
  type MediaSession,
  type MediaSessionLimits,
  type MediaSessionStatus,
  type MediaSettings,
} from "./contracts";
import { findLivePodByName, terminateAndConfirm as terminateAndConfirmPod, type TerminateOutcome } from "./pod-lifecycle";
import type { VolumeLock } from "./volume-lock";
import { round2 } from "@/lib/shared-async";
import { parseWithSchema, rejectSessionInputSchema, requestSessionInputSchema, sessionIdInputSchema, stopSessionInputSchema } from "./schemas";

// ---------------------------------------------------------------------------
// Phase 14 slice 2 (docs/roadmap/plans/PHASE_14_PLAN.md §2.3, owner decisions D2/D3): a generation
// session is one RunPod pod. The operator (or, from slice 5, an agent) REQUESTS one with caps; a human
// APPROVES it in the Web UI, which creates the pod and waits until ComfyUI answers behind the token
// proxy; a watcher terminates it on idle / minutes / USD; the app's boot sweep and shutdown hook make
// sure no pod outlives the process that started it. There is no "stop pod" anywhere -- a stopped
// pod's disk costs double -- so every terminal state means TERMINATED or absent, confirmed via the API.
// ---------------------------------------------------------------------------

export type StoredSessionRow = {
  id: string;
  channelId: string;
  status: MediaSessionStatus;
  requestedBy: "operator" | "agent";
  reason: string | null;
  maxMinutes: number;
  maxUsd: number | null;
  estimateUsd: number;
  fitsToday: boolean;
  costPerHr: number | null;
  gpuTypeId: string | null;
  datacenterId: string | null;
  podId: string | null;
  comfyUiProxyUrl: string | null;
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenAuthTag: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  startedAt: Date | null;
  readyAt: Date | null;
  lastActivityAt: Date | null;
  stoppedAt: Date | null;
  secondsUsed: number | null;
  usdCharged: number | null;
  stopReason: string | null;
  error: string | null;
  /** The terminal status a `stopping` row is heading for (schema v53), so a retried stop reports it truthfully. */
  stoppingOutcome: StoppingOutcome | null;
  /** When this app last saw the pod alive (schema v54): the billable window of a pod found already gone closes here. */
  lastSeenAliveAt: Date | null;
};

export type StoppingOutcome = "done" | "failed" | "interrupted";

export type SessionPatch = Partial<Omit<StoredSessionRow, "id" | "status">> & { status: MediaSessionStatus };

export type MediaSessionStore = {
  /** `null` = the device's single open slot is taken (AC-P14-05). */
  insert(row: Omit<StoredSessionRow, "createdAt"> & { createdAt?: Date }): Promise<StoredSessionRow | null>;
  get(id: string): Promise<StoredSessionRow | null>;
  getOpen(): Promise<StoredSessionRow | null>;
  /** Newest first; `channelId` filters in the query itself (never a post-filter of a capped page). */
  list(limit: number, channelId?: string): Promise<StoredSessionRow[]>;
  /** Sessions with a pod that bills in the window: `startedAt` set and (`stoppedAt` null, or `startedAt` ≥ since, or `stoppedAt` ≥ since). */
  listBillableSince(since: Date): Promise<StoredSessionRow[]>;
  /** Atomic `from -> set.status`; `null` = not in `from`. */
  transition(id: string, from: readonly MediaSessionStatus[], set: SessionPatch): Promise<StoredSessionRow | null>;
  touchActivity(id: string, at: Date): Promise<void>;
  /** The pod was seen alive at `at` (readiness, every watcher tick); a terminal row ignores it. */
  markSeenAlive(id: string, at: Date): Promise<void>;
};

export type SessionServiceDependencies = {
  store: MediaSessionStore;
  base: {
    getSettings(): Promise<MediaSettings>;
    getOverview(): Promise<{ ready: boolean; missing: string[]; gatewayEnabled: boolean }>;
    resolveRunpodClient(): Promise<RunpodApiClient>;
    sealSecret(plaintext: string): Promise<EncryptedPayload>;
    openSecret(payload: EncryptedPayload): Promise<string>;
  };
  createComfyClient(args: { baseUrl: string; token: string }): ComfyUiClient;
  comfyUiProxyBaseUrl(podId: string, port: number): string;
  generateId(): string;
  generateToken(): string;
  clock: { now(): Date };
  sleep(ms: number): Promise<void>;
  /** Start: pod creation -> ComfyUI answering. Stop: terminate -> confirmed gone. */
  timeouts?: { startMs?: number; pollMs?: number; stopMs?: number };
  /**
   * AC-P14-18 as a constraint (review round 9, `volume-lock.ts`): the session holds the one "volume busy" lock
   * from its `approved` write until it is terminal, so a model pull cannot write the volume meanwhile.
   */
  volumeLock: VolumeLock;
  log?: (line: string) => void;
};

const DEFAULT_START_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 90_000;
/**
 * An `approved`/`starting` row older than start + stop timeout plus this margin has no approve request
 * behind it any more: it was abandoned mid-start. The margin covers the request's real worst case beyond
 * those two budgets (review round 9): the last poll iteration already begun at the deadline (one RunPod
 * call + one ComfyUI call, 30 s each, + a sleep), then abortStart's terminate (30 s) and a trailing getPod
 * (30 s) after the stop budget -- about 2.5 min -- with 5 min there is room, not a 30 s coin toss.
 */
const ABANDONED_START_GRACE_MS = 5 * 60_000;
/** Consecutive RunPod failures tolerated while waiting for a new pod (the same tolerance the job poller has). */
const MAX_START_POLL_FAILURES = 5;

/** The pod's name is deterministic so a pod created before the `starting` write can still be found at boot. */
export function podNameFor(sessionId: string): string {
  return `ytm-media-${sessionId.slice(0, 8)}`;
}

/** The cap's day is the operator's machine's local day (this app runs on that machine), not UTC. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function liveSeconds(row: StoredSessionRow, now: Date): number | null {
  if (!row.startedAt) return null;
  const end = row.stoppedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 1000));
}

export function liveUsd(row: StoredSessionRow, now: Date): number | null {
  const seconds = liveSeconds(row, now);
  if (seconds === null || row.costPerHr === null) return row.usdCharged;
  return round2((seconds * row.costPerHr) / 3600);
}

export function toPublicSession(row: StoredSessionRow, now: Date): MediaSession {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    sessionId: row.id,
    channelId: row.channelId,
    status: row.status,
    requestedBy: row.requestedBy,
    reason: row.reason,
    maxMinutes: row.maxMinutes,
    maxUsd: row.maxUsd,
    estimateUsd: row.estimateUsd,
    fitsToday: row.fitsToday,
    costPerHr: row.costPerHr,
    gpuTypeId: row.gpuTypeId,
    datacenterId: row.datacenterId,
    podId: row.podId,
    comfyUiProxyUrl: row.comfyUiProxyUrl,
    createdAt: row.createdAt.toISOString(),
    approvedAt: iso(row.approvedAt),
    startedAt: iso(row.startedAt),
    readyAt: iso(row.readyAt),
    lastActivityAt: iso(row.lastActivityAt),
    stoppedAt: iso(row.stoppedAt),
    secondsUsed: row.secondsUsed ?? liveSeconds(row, now),
    usdCharged: row.usdCharged ?? liveUsd(row, now),
    stopReason: row.stopReason,
    error: row.error,
  };
}

export function createMediaSessionServices(deps: SessionServiceDependencies) {
  const startTimeoutMs = deps.timeouts?.startMs ?? DEFAULT_START_TIMEOUT_MS;
  const pollMs = deps.timeouts?.pollMs ?? DEFAULT_POLL_MS;
  const stopTimeoutMs = deps.timeouts?.stopMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const log = deps.log ?? (() => undefined);

  const notFound = (sessionId: string) => new DomainError({ code: "media_session_not_found", message: "No session with this id", details: { sessionId } });
  const invalidState = (sessionId: string, expected: string, actual: string) =>
    new DomainError({ code: "media_session_invalid_state", message: `Session is ${actual}, expected ${expected}`, details: { sessionId, expected, actual } });

  async function requireRow(sessionId: string): Promise<StoredSessionRow> {
    const row = await deps.store.get(sessionId);
    if (!row) throw notFound(sessionId);
    return row;
  }

  /** Every session billed today: started today, stopped today, or still open (a session across midnight counts in full). */
  async function spentTodayUsd(now: Date): Promise<number> {
    const rows = await deps.store.listBillableSince(startOfLocalDay(now));
    return round2(rows.reduce((sum, row) => sum + (liveUsd(row, now) ?? 0), 0));
  }

  /** Pod creation -> confirmed termination (AC-P14-17); a terminal row keeps the frozen numbers. */
  function finalCost(row: StoredSessionRow, stoppedAt: Date): { secondsUsed: number; usdCharged: number } {
    const secondsUsed = row.startedAt ? Math.max(0, Math.round((stoppedAt.getTime() - row.startedAt.getTime()) / 1000)) : 0;
    const usdCharged = row.costPerHr === null ? 0 : round2((secondsUsed * row.costPerHr) / 3600);
    return { secondsUsed, usdCharged };
  }

  /** Shared with model pulls (`pod-lifecycle.ts`); `alreadyGone` = RunPod had no such pod before our terminate. */
  function terminateAndConfirm(client: RunpodApiClient, podId: string): Promise<TerminateOutcome> {
    return terminateAndConfirmPod(client, podId, { now: () => deps.clock.now(), sleep: deps.sleep }, { timeoutMs: stopTimeoutMs, pollMs });
  }

  /**
   * Where the billable window of a pod found ALREADY gone closes (AC-P14-08: the pod's own timestamps when
   * available -- and a pod RunPod no longer lists has none): the last moment this app saw it alive, never
   * `now()`, so a pod terminated by hand hours before a reboot is not billed up to the reboot. Bounded by
   * `startedAt` below and `now` above.
   */
  function lastKnownAlive(row: StoredSessionRow, now: Date): Date {
    const candidates = [row.lastSeenAliveAt, row.lastActivityAt, row.readyAt, row.startedAt].filter((d): d is Date => d !== null);
    if (candidates.length === 0) return now;
    const latest = new Date(Math.max(...candidates.map((d) => d.getTime())));
    return latest.getTime() > now.getTime() ? now : latest;
  }

  function goneNote(row: StoredSessionRow, at: Date): string {
    return `pod was already gone; billed until it was last seen alive at ${at.toISOString()} (the RunPod invoice is authoritative)`;
  }

  /**
   * Moves a session to a terminal state after its pod is confirmed gone (or was never created).
   * Returns the updated row, or null if the row was no longer in `from`.
   */
  async function finish(
    row: StoredSessionRow,
    from: readonly MediaSessionStatus[],
    status: Extract<MediaSessionStatus, "done" | "failed" | "interrupted">,
    extra: { stopReason?: string | null; error?: string | null; stoppedAt?: Date },
    /** Pod facts to record alongside (a pod that existed but was never written to the row, AC-P14-17). */
    podFacts: { podId?: string; startedAt?: Date; costPerHr?: number | null } = {}
  ): Promise<StoredSessionRow | null> {
    const stoppedAt = extra.stoppedAt ?? deps.clock.now();
    // The facts are built ONCE: the cost is computed from exactly what the row will record (review round 12).
    const facts = {
      ...(podFacts.podId ? { podId: podFacts.podId } : {}),
      ...(podFacts.startedAt ? { startedAt: podFacts.startedAt } : {}),
      ...(podFacts.costPerHr !== undefined ? { costPerHr: podFacts.costPerHr } : {}),
    };
    const cost = finalCost({ ...row, ...facts }, stoppedAt);
    const terminal = await deps.store.transition(row.id, from, {
      status,
      stoppedAt,
      secondsUsed: cost.secondsUsed,
      usdCharged: cost.usdCharged,
      stopReason: extra.stopReason ?? null,
      error: extra.error ?? null,
      ...facts,
    });
    // Terminal = the volume is free again. (A crash between these two writes leaves a lock whose holder is terminal;
    // the next acquire sees that and steals it.)
    if (terminal) await deps.volumeLock.release(`session:${row.id}`);
    return terminal;
  }

  /**
   * stopping/starting/running -> terminate -> confirm -> terminal. Leaves `stopping` when the API cannot
   * confirm. The outcome is persisted on the row (`stoppingOutcome`) so a retry -- the watcher, the boot
   * sweep -- finishes with the status the stop was started for, not a default `done`.
   */
  async function stopRow(row: StoredSessionRow, reason: string, outcome: StoppingOutcome = "done"): Promise<StoredSessionRow> {
    const stopping = await deps.store.transition(row.id, ["starting", "running", "stopping"], { status: "stopping", stopReason: reason, stoppingOutcome: outcome });
    if (!stopping) throw invalidState(row.id, "starting|running|stopping", row.status);
    const terminal = { stopReason: reason, error: outcome === "done" ? null : reason };
    if (!stopping.podId) {
      const finished = await finish(stopping, ["stopping"], outcome, terminal);
      return finished ?? stopping;
    }
    let result: TerminateOutcome;
    try {
      const client = await deps.base.resolveRunpodClient();
      result = await terminateAndConfirm(client, stopping.podId);
    } catch (cause) {
      // The row stays `stopping` (the watcher retries); say why on the row, not only in the one HTTP response (review round 11).
      const detail = cause instanceof Error ? cause.message : String(cause);
      await deps.store.transition(row.id, ["stopping"], { status: "stopping", error: `terminate failed: ${detail}; the watcher retries` });
      throw cause;
    }
    if (!result.confirmed) {
      log(`[media] pod ${stopping.podId} still ${result.lastStatus} after terminate; session ${row.id} stays stopping`);
      const kept = await deps.store.transition(row.id, ["stopping"], { status: "stopping", error: `pod still ${result.lastStatus} after terminate; retrying` });
      return kept ?? stopping;
    }
    if (result.alreadyGone) {
      const gone = lastKnownAlive(stopping, deps.clock.now());
      const finished = await finish(stopping, ["stopping"], outcome, { ...terminal, error: goneNote(stopping, gone), stoppedAt: gone });
      return finished ?? stopping;
    }
    const finished = await finish(stopping, ["stopping"], outcome, terminal);
    return finished ?? stopping;
  }

  /**
   * The ONE rule for "no approve request owns this `approved`/`starting` row any more" (review round 16): either that
   * request already reported its death on the row (`error`), or the row is older than the request's whole budget.
   */
  function isStartAbandoned(row: StoredSessionRow, now: Date): boolean {
    if (row.error !== null) return true;
    const since = row.startedAt ?? row.approvedAt ?? row.createdAt;
    return now.getTime() - since.getTime() >= startTimeoutMs + stopTimeoutMs + ABANDONED_START_GRACE_MS;
  }

  /** A `stopping` row is always resumed with ITS reason and outcome (an operator's "max USD reached" is never relabelled). */
  async function retryStop(row: StoredSessionRow, fallbackReason: string, fallbackOutcome: StoppingOutcome): Promise<StoredSessionRow> {
    return stopRow(row, row.stopReason ?? fallbackReason, row.stoppingOutcome ?? fallbackOutcome);
  }

  /**
   * Reconciles a non-terminal, non-pending row that no request owns any more (boot sweep; an approve
   * request that died mid-start). An `approved` row without podId is the one case where the pod can only
   * be found by its deterministic name -- and that search must never be skipped by moving the row on
   * while RunPod is unreachable (review round 6): the row then stays `approved` (slot taken, error
   * recorded) until a later tick/boot can ask RunPod again.
   */
  async function reconcileAbandoned(open: StoredSessionRow, reason: string, outcome: Extract<StoppingOutcome, "failed" | "interrupted">): Promise<"reconciled" | "retrying" | "deferred"> {
    if (open.status === "stopping") {
      const stopped = await retryStop(open, reason, outcome);
      return stopped.status === "stopping" ? "retrying" : "reconciled";
    }
    let podId = open.podId;
    let orphanFacts: { podId: string; startedAt: Date; costPerHr: number | null } | null = null;
    if (!podId && open.status === "approved") {
      // The process died between createPod and the `starting` write: the pod carries the session's deterministic name.
      try {
        const client = await deps.base.resolveRunpodClient();
        const orphan = await findLivePodByName(client, podNameFor(open.id));
        if (orphan) {
          podId = orphan.id;
          // The pod billed from its creation; record that like abortStart does (AC-P14-17).
          orphanFacts = { podId: orphan.id, startedAt: orphan.createdAt ? new Date(orphan.createdAt) : (open.approvedAt ?? deps.clock.now()), costPerHr: orphan.costPerHr ?? open.costPerHr };
        }
      } catch (cause) {
        await deps.store.transition(open.id, ["approved"], {
          status: "approved",
          error: `could not check RunPod for a pod named ${podNameFor(open.id)} (${cause instanceof Error ? cause.message : String(cause)}); retrying`,
        });
        return "deferred";
      }
      if (orphanFacts) await deps.store.transition(open.id, ["approved"], { status: "approved", ...orphanFacts });
    }
    let alreadyGone = false;
    if (podId) {
      // While the terminate is being confirmed (up to the stop budget) the row must not read `running`/`starting` to the
      // UI, MCP or createJob (review round 17): `stopping` first, like stopRow.
      if (open.status === "starting" || open.status === "running") {
        await deps.store.transition(open.id, ["starting", "running"], { status: "stopping", ...(orphanFacts ?? {}), stopReason: reason, stoppingOutcome: outcome });
      }
      let unconfirmed: string | null = null;
      try {
        const client = await deps.base.resolveRunpodClient();
        const result = await terminateAndConfirm(client, podId);
        if (!result.confirmed) unconfirmed = `pod still ${result.lastStatus} after terminate`;
        alreadyGone = result.alreadyGone;
      } catch (cause) {
        unconfirmed = `pod ${podId} could not be reached (${cause instanceof Error ? cause.message : String(cause)})`;
      }
      if (unconfirmed) {
        // Never free the slot while the pod may still bill: `stopping` keeps podId and the watcher retries (like stopRow).
        await deps.store.transition(open.id, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], {
          status: "stopping",
          ...(orphanFacts ?? {}),
          stopReason: reason,
          stoppingOutcome: outcome,
          error: `${unconfirmed}; the watcher retries`,
        });
        return "retrying";
      }
    }
    const now = deps.clock.now();
    const effective = { ...open, ...(orphanFacts ?? {}) };
    const gone = alreadyGone ? lastKnownAlive(effective, now) : now;
    await finish(open, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], outcome, { stopReason: reason, error: alreadyGone ? `${reason}; ${goneNote(effective, gone)}` : reason, stoppedAt: gone }, orphanFacts ?? {});
    return "reconciled";
  }

  return {
    toPublicSession: (row: StoredSessionRow) => toPublicSession(row, deps.clock.now()),

    async getSession(input: unknown): Promise<MediaSession> {
      const { sessionId } = parseWithSchema(sessionIdInputSchema, input, "session id");
      return toPublicSession(await requireRow(sessionId), deps.clock.now());
    },

    async listSessions(limit = 50, channelId?: string): Promise<MediaSession[]> {
      const now = deps.clock.now();
      return (await deps.store.list(limit, channelId)).map((row) => toPublicSession(row, now));
    },

    async getLimits(): Promise<MediaSessionLimits> {
      const now = deps.clock.now();
      const [settings, overview, open, spent] = await Promise.all([deps.base.getSettings(), deps.base.getOverview(), deps.store.getOpen(), spentTodayUsd(now)]);
      return {
        maxUsdPerDay: settings.maxUsdPerDay,
        spentTodayUsd: spent,
        remainingTodayUsd: round2(Math.max(0, settings.maxUsdPerDay - spent)),
        defaultMaxMinutes: settings.defaultMaxMinutes,
        idleMinutes: settings.idleMinutes,
        watchIntervalSeconds: settings.watchIntervalSeconds,
        openSession: open ? toPublicSession(open, now) : null,
        ready: overview.ready,
        missing: overview.missing,
      };
    },

    /**
     * A pending request with a LOCAL estimate (AC-P14-03): no RunPod call; the GPU price saved with
     * the settings is the input. A request that does not fit today's remaining cap is still created
     * and flagged. Refused when the feature is not ready or a non-terminal session exists (AC-P14-05).
     */
    async requestSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(requestSessionInputSchema, input, "media session request");
      const now = deps.clock.now();
      const [settings, overview] = await Promise.all([deps.base.getSettings(), deps.base.getOverview()]);
      if (!overview.ready) {
        throw new DomainError({ code: "media_generation_not_configured", message: `Media generation is not ready: ${overview.missing.join(", ")}.`, details: { missing: overview.missing } });
      }
      if (settings.gpuOnDemandPricePerHr === null) {
        throw new DomainError({ code: "media_settings_invalid", message: "The GPU's price is unknown -- reload the catalog and save the GPU again in Settings → Media." });
      }
      const maxMinutes = parsed.maxMinutes ?? settings.defaultMaxMinutes;
      // The upper bound is whichever cap bites first: the minutes at the saved price, or the session's own USD cap.
      const byMinutes = (settings.gpuOnDemandPricePerHr * maxMinutes) / 60;
      const estimateUsd = round2(parsed.maxUsd ? Math.min(byMinutes, parsed.maxUsd) : byMinutes);
      const spent = await spentTodayUsd(now);
      const fitsToday = estimateUsd <= Math.max(0, settings.maxUsdPerDay - spent);
      const row = await deps.store.insert({
        id: deps.generateId(),
        channelId: parsed.channelId,
        status: "pending",
        requestedBy: parsed.requestedBy,
        reason: parsed.reason ?? null,
        maxMinutes,
        maxUsd: parsed.maxUsd ?? null,
        estimateUsd,
        fitsToday,
        costPerHr: settings.gpuOnDemandPricePerHr,
        gpuTypeId: settings.gpuTypeId,
        datacenterId: settings.datacenterId,
        podId: null,
        comfyUiProxyUrl: null,
        tokenCiphertext: null,
        tokenIv: null,
        tokenAuthTag: null,
        createdAt: now,
        approvedAt: null,
        approvedByUserId: null,
        startedAt: null,
        readyAt: null,
        lastActivityAt: null,
        stoppedAt: null,
        secondsUsed: null,
        usdCharged: null,
        stopReason: null,
        error: null,
        stoppingOutcome: null,
        lastSeenAliveAt: null,
      });
      if (!row) {
        const open = await deps.store.getOpen();
        throw new DomainError({
          code: "media_session_conflict",
          message: "Another session is already open on this device; stop or resolve it first.",
          details: { openSessionId: open?.id ?? null, openStatus: open?.status ?? null },
        });
      }
      return toPublicSession(row, now);
    },

    async rejectSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(rejectSessionInputSchema, input, "reject session");
      const row = await requireRow(parsed.sessionId);
      const rejected = await deps.store.transition(parsed.sessionId, ["pending"], { status: "rejected", stoppedAt: deps.clock.now(), stopReason: parsed.reason });
      if (!rejected) throw invalidState(parsed.sessionId, "pending", row.status);
      return toPublicSession(rejected, deps.clock.now());
    },

    /**
     * Web-only (fenced). Preconditions run BEFORE any transition (AC-P14-04); then pending ->
     * approved -> starting (pod created, `startedAt` = now, which is when RunPod starts billing)
     * -> running once ComfyUI answers behind the token proxy. A failure after the pod exists
     * terminates it and ends the session `failed` (AC-P14-07).
     */
    async approveAndStartSession(input: { sessionId: unknown; approvedByUserId?: string | null; onStage?: (text: string) => void }): Promise<MediaSession> {
      const { sessionId } = parseWithSchema(sessionIdInputSchema, { sessionId: input.sessionId }, "approve session");
      const onStage = input.onStage ?? (() => undefined);
      const row = await requireRow(sessionId);
      if (row.status !== "pending") throw invalidState(sessionId, "pending", row.status);

      // Preconditions, none of which changes the row.
      const [settings, overview] = await Promise.all([deps.base.getSettings(), deps.base.getOverview()]);
      if (!overview.ready) {
        throw new DomainError({ code: "media_generation_not_configured", message: `Media generation is not ready: ${overview.missing.join(", ")}.`, details: { missing: overview.missing } });
      }
      const now = deps.clock.now();
      const spent = await spentTodayUsd(now);
      // AC-P14-17: the daily total drives the cap -- the session's own upper bound must fit what is left today.
      if (spent >= settings.maxUsdPerDay || round2(spent + row.estimateUsd) > settings.maxUsdPerDay) {
        throw new DomainError({
          code: "media_daily_cap_reached",
          message: `Today's media spend cap ($${settings.maxUsdPerDay}) does not cover this session: $${spent} spent, estimate $${row.estimateUsd}. Lower maxMinutes/maxUsd, raise the cap in Settings → Media, or wait for tomorrow. The request stays pending.`,
          details: { maxUsdPerDay: settings.maxUsdPerDay, spentTodayUsd: spent, estimateUsd: row.estimateUsd },
        });
      }
      const open = await deps.store.getOpen();
      if (open && open.id !== sessionId) {
        throw new DomainError({ code: "media_session_conflict", message: "Another session is already open on this device.", details: { openSessionId: open.id } });
      }
      // The request's estimate, cap check and record describe the GPU/datacenter saved when it was made; the pod is built
      // from the CURRENT settings. If they diverged, the approval would bill something the record never describes
      // (review round 11): refuse, the requester asks again against the new settings.
      if (row.gpuTypeId !== settings.gpuTypeId || row.datacenterId !== settings.datacenterId || row.costPerHr !== settings.gpuOnDemandPricePerHr) {
        throw new DomainError({
          code: "media_settings_invalid",
          message: `Settings → Media changed since this request was made (requested: ${row.gpuTypeId ?? "no GPU"} in ${row.datacenterId ?? "no datacenter"} at $${row.costPerHr ?? "?"}/h; now: ${settings.gpuTypeId ?? "no GPU"} in ${settings.datacenterId ?? "no datacenter"} at $${settings.gpuOnDemandPricePerHr ?? "?"}/h). Reject it and request a new session so the estimate and the record match what will be billed.`,
          details: { sessionId, requested: { gpuTypeId: row.gpuTypeId, datacenterId: row.datacenterId, costPerHr: row.costPerHr }, current: { gpuTypeId: settings.gpuTypeId, datacenterId: settings.datacenterId, costPerHr: settings.gpuOnDemandPricePerHr } },
        });
      }
      const client = await deps.base.resolveRunpodClient(); // credentials must resolve
      const token = deps.generateToken();
      const sealed = await deps.base.sealSecret(token);

      // AC-P14-18 as a constraint: the volume lock is taken BEFORE the `approved` write and held until the session is
      // terminal; a running model pull holds it, so this throws `media_session_conflict` naming it, and the request
      // stays pending with nothing changed.
      const acquisition = await deps.volumeLock.acquire(`session:${sessionId}`);
      const approved = await deps.store.transition(sessionId, ["pending"], {
        status: "approved",
        approvedAt: now,
        approvedByUserId: input.approvedByUserId ?? null,
        tokenCiphertext: sealed.ciphertext,
        tokenIv: sealed.iv,
        tokenAuthTag: sealed.authTag,
      });
      if (!approved) {
        // A concurrent approve of the same session won this transition (a retried POST): the lock is now ITS lock,
        // whichever of the two calls happened to insert the row -- release only when the session is not open under this
        // owner any more (review round 15).
        const latest = await requireRow(sessionId);
        const heldByTheWinner = ["approved", "starting", "running", "stopping"].includes(latest.status);
        if (!heldByTheWinner && acquisition === "acquired") await deps.volumeLock.release(`session:${sessionId}`);
        throw invalidState(sessionId, "pending", latest.status);
      }

      onStage("Creating the pod");
      let pod: RunpodPod;
      const startedAt = deps.clock.now();
      try {
        pod = await client.createPod({
          name: podNameFor(sessionId),
          templateId: settings.templateId ?? undefined,
          gpu: { id: settings.gpuTypeId as string, count: 1 },
          cloud: settings.cloudType,
          dataCenterId: settings.datacenterId ?? undefined,
          mounts: settings.networkVolumeId ? { network: [{ volumeId: settings.networkVolumeId, path: "/workspace" }] } : undefined,
          ports: [`${COMFY_PROXY_PORT}/http`],
          env: { COMFY_TOKEN: token },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The call can fail AFTER RunPod created the pod (timeout, dropped connection): the deterministic name finds it.
        let orphan: RunpodPod | undefined;
        try {
          orphan = await findLivePodByName(client, podNameFor(sessionId));
        } catch (lookupError) {
          // RunPod unreachable for the lookup too: the pod MAY exist and bill. Never free the slot (or the volume lock)
          // on a guess -- the row stays `approved` with the error, and the watcher's abandoned-start reconciliation
          // repeats the name search once RunPod answers (review round 9).
          const detail = lookupError instanceof Error ? lookupError.message : String(lookupError);
          await deps.store.transition(sessionId, ["approved"], { status: "approved", error: `pod creation failed (${message}) and RunPod could not be asked whether the pod exists (${detail}); the watcher re-checks` });
          throw new DomainError({
            code: "media_session_start_failed",
            message: `Pod creation failed (${message}) and RunPod could not confirm whether a pod was created; the session stays approved until the watcher can check.`,
            details: { sessionId, status: "approved" },
          });
        }
        if (!orphan) {
          await finish(approved, ["approved"], "failed", { error: `pod creation failed: ${message}` });
          throw new DomainError({ code: "media_session_start_failed", message: `Pod creation failed: ${message}`, details: { sessionId } });
        }
        log(`[media] createPod failed (${message}) but pod ${orphan.id} exists under ${podNameFor(sessionId)}; continuing with it`);
        pod = orphan;
      }
      // From here on a pod EXISTS and bills: every exit path below either confirms its termination or
      // leaves the session non-terminal (`stopping`, podId recorded) so the watcher/boot sweep retries.
      const abortStart = async (lastDetail: string): Promise<never> => {
        onStage("Terminating the pod");
        let terminated: { confirmed: boolean; lastStatus: string | null };
        try {
          terminated = await terminateAndConfirm(client, pod.id);
        } catch (error) {
          terminated = { confirmed: false, lastStatus: `unknown (${error instanceof Error ? error.message : String(error)})` };
        }
        // An operator Stop (or the watcher/boot sweep) may have taken the row meanwhile: never overwrite its outcome.
        const latest = await requireRow(sessionId);
        if (latest.status === "approved" || latest.status === "starting") {
          // The pod existed and billed from `startedAt`: record it even when the `starting` write never happened.
          const podFacts = { podId: pod.id, startedAt, costPerHr: pod.costPerHr ?? latest.costPerHr };
          if (terminated.confirmed) {
            await finish(latest, ["approved", "starting"], "failed", { error: `start failed: ${lastDetail}` }, podFacts);
          } else {
            await deps.store.transition(sessionId, ["approved", "starting"], {
              status: "stopping",
              ...podFacts,
              stopReason: `start failed: ${lastDetail}`,
              stoppingOutcome: "failed",
              error: `pod still ${terminated.lastStatus} after terminate; the watcher retries`,
            });
          }
        }
        throw new DomainError({
          code: "media_session_start_failed",
          message: `The session could not start: ${lastDetail}.`,
          details: { sessionId, podId: pod.id, podTerminated: terminated.confirmed, status: (await requireRow(sessionId)).status },
        });
      };

      let comfyUiProxyUrl: string;
      let starting: StoredSessionRow | null;
      try {
        comfyUiProxyUrl = deps.comfyUiProxyBaseUrl(pod.id, COMFY_PROXY_PORT);
        starting = await deps.store.transition(sessionId, ["approved"], {
          status: "starting",
          podId: pod.id,
          comfyUiProxyUrl,
          startedAt,
          costPerHr: pod.costPerHr ?? approved.costPerHr,
        });
      } catch (error) {
        return abortStart(`could not record the pod: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!starting) {
        // Swept or stopped meanwhile: never leave the pod behind -- and never DISCARD an unconfirmed terminate either
        // (review round 15): the pod and its cost are written onto whatever row state the other party left, so the
        // operator's listing shows the pod to terminate by hand.
        let outcome: TerminateOutcome | null = null;
        let failure: string | null = null;
        try {
          outcome = await terminateAndConfirm(client, pod.id);
        } catch (cause) {
          failure = cause instanceof Error ? cause.message : String(cause);
        }
        const latest = await requireRow(sessionId);
        if (!outcome?.confirmed) {
          const detail = failure ?? `pod still ${outcome?.lastStatus} after terminate`;
          log(`[media] pod ${pod.id} created after session ${sessionId} was ${latest.status}; terminate not confirmed (${detail})`);
          await deps.store.transition(sessionId, [latest.status], {
            status: latest.status,
            podId: pod.id,
            startedAt,
            costPerHr: pod.costPerHr ?? latest.costPerHr,
            error: `${latest.error ? `${latest.error}; ` : ""}pod ${pod.id} was created after the session ended and its terminate could not be confirmed (${detail}): terminate it by hand (media pod-terminate ${pod.id})`,
          });
        }
        throw invalidState(sessionId, "approved", latest.status);
      }

      onStage("Waiting for the pod to run");
      const deadline = startedAt.getTime() + startTimeoutMs;
      const comfy = deps.createComfyClient({ baseUrl: comfyUiProxyUrl, token });
      let phase: "pod" | "comfy" = "pod";
      let lastDetail = "";
      // One RunPod 502 / 30 s timeout on getPod must not terminate a healthy, almost-ready pod (review round 17): a run of
      // consecutive failures is tolerated like the job poller's; the deadline still bounds the whole wait.
      let pollFailures = 0;
      const getPodTolerant = async (): Promise<{ ok: true; pod: RunpodPod | null } | { ok: false }> => {
        try {
          const current = await client.getPod(pod.id);
          pollFailures = 0;
          return { ok: true, pod: current };
        } catch (error) {
          if (++pollFailures >= MAX_START_POLL_FAILURES) throw error;
          lastDetail = `RunPod unreachable (${pollFailures}×): ${error instanceof Error ? error.message : String(error)}`;
          return { ok: false };
        }
      };
      const seenAlive = () => deps.store.markSeenAlive(sessionId, deps.clock.now()).catch(() => undefined); // a DB hiccup is not a reason to abort
      try {
        for (;;) {
          const polled = await getPodTolerant();
          if (!polled.ok) {
            if (deps.clock.now().getTime() >= deadline) {
              lastDetail = `not ready after ${Math.round(startTimeoutMs / 60000)} min (${lastDetail || phase})`;
              break;
            }
            await deps.sleep(pollMs);
            continue;
          }
          if (phase === "pod") {
            const current = polled.pod;
            if (!current || current.status === "TERMINATED" || current.status === "EXITED" || current.status === "ERROR") {
              lastDetail = `pod ${current?.status ?? "gone"}`;
              break;
            }
            await seenAlive(); // billed at least until here (AC-P14-17)
            if (current.status === "RUNNING") {
              phase = "comfy";
              onStage("Waiting for ComfyUI to answer");
            }
          } else {
            // The pod can still die while ComfyUI boots (pod-start.sh failing, container ERROR): never wait the full budget for that.
            const current = polled.pod;
            if (!current || current.status === "TERMINATED" || current.status === "EXITED" || current.status === "ERROR") {
              lastDetail = `pod ${current?.status ?? "gone"} while waiting for ComfyUI`;
              break;
            }
            await seenAlive();
            try {
              await comfy.getSystemStats();
              const ready = deps.clock.now();
              const running = await deps.store.transition(sessionId, ["starting"], { status: "running", readyAt: ready, lastActivityAt: ready, lastSeenAliveAt: ready, error: null });
              if (!running) {
                lastDetail = `session was ${(await requireRow(sessionId)).status} when ComfyUI answered`;
                break;
              }
              return toPublicSession(running, ready);
            } catch (error) {
              if (error instanceof DomainError && error.code !== "comfyui_unavailable" && error.code !== "comfyui_rejected") throw error;
              lastDetail = error instanceof Error ? error.message : String(error);
            }
          }
          if (deps.clock.now().getTime() >= deadline) {
            lastDetail = `not ready after ${Math.round(startTimeoutMs / 60000)} min (${lastDetail || phase})`;
            break;
          }
          await deps.sleep(pollMs);
        }
      } catch (error) {
        // A gateway/API failure mid-poll (RunPod 5xx, the toggle switched off, ...): the pod still exists.
        return abortStart(`${error instanceof Error ? error.message : String(error)}`);
      }
      return abortStart(lastDetail);
    },

    /** Web-only (fenced): running|starting|stopping -> terminate -> done. */
    async stopSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(stopSessionInputSchema, input, "stop session");
      const row = await requireRow(parsed.sessionId);
      const reason = parsed.reason ?? "stopped by operator";
      // A row already `stopping` is resumed with ITS reason and outcome (an aborted start stays `failed`, review round 14);
      // the operator's press only retries the terminate.
      if (row.status === "stopping") return toPublicSession(await retryStop(row, reason, "done"), deps.clock.now());
      if (row.status === "approved") {
        // The approve request is gone (it threw: createPod failed and RunPod could not say whether a pod exists -- the row
        // carries its error) or is unmistakably abandoned by age -- the operator's Stop is the manual override the
        // watcher's abandoned-start path would otherwise reach only later. While the approve request may still be inside
        // createPod, a Stop would finish the row before the pod exists and orphan it (review round 15): refused.
        if (!isStartAbandoned(row, deps.clock.now())) {
          throw new DomainError({ code: "media_session_invalid_state", message: "The approve request is still creating the pod; wait for it to finish (or fail) before stopping.", details: { sessionId: row.id, status: row.status } });
        }
        const result = await reconcileAbandoned(row, reason, "failed");
        if (result === "deferred") {
          throw new DomainError({ code: "runpod_api_unavailable", message: `RunPod could not be asked whether a pod named ${podNameFor(row.id)} exists; the session stays approved (slot kept) -- try again when RunPod answers.`, details: { sessionId: row.id } });
        }
        return toPublicSession(await requireRow(row.id), deps.clock.now());
      }
      if (!["starting", "running"].includes(row.status)) throw invalidState(parsed.sessionId, "approved|starting|running|stopping", row.status);
      return toPublicSession(await stopRow(row, reason), deps.clock.now());
    },

    /** Jobs (slice 3) call this on every submit/poll so the idle clock restarts. */
    async touchActivity(sessionId: string): Promise<void> {
      await deps.store.touchActivity(sessionId, deps.clock.now());
    },

    /** The ComfyUI client for a running session (slice 3); the token is decrypted for this call only. */
    async comfyClientForSession(sessionId: string): Promise<ComfyUiClient> {
      const row = await requireRow(sessionId);
      if (row.status !== "running" || !row.comfyUiProxyUrl || !row.tokenCiphertext || !row.tokenIv || !row.tokenAuthTag) {
        throw invalidState(sessionId, "running", row.status);
      }
      const token = await deps.base.openSecret({ ciphertext: row.tokenCiphertext, iv: row.tokenIv, authTag: row.tokenAuthTag });
      return deps.createComfyClient({ baseUrl: row.comfyUiProxyUrl, token });
    },

    /**
     * The watcher (AC-P14-06/07): idle ≥ idleMinutes with no activity, minutes ≥ maxMinutes, usd ≥
     * maxUsd -> terminate; a pod found EXITED/gone -> interrupted; a session stuck `stopping` is retried;
     * an `approved`/`starting` row whose approve request died mid-start is reconciled once it is
     * unmistakably abandoned (review round 6 -- before, such a pod billed until a manual restart).
     */
    async watchTick(): Promise<{ action: "none" | "stopped" | "interrupted" | "retried_stop"; sessionId: string | null; reason: string | null }> {
      const open = await deps.store.getOpen();
      if (!open) return { action: "none", sessionId: null, reason: null };
      const now = deps.clock.now();
      if (open.status === "stopping") {
        const stopped = await retryStop(open, "stop retried by watcher", "done");
        return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason: open.stopReason };
      }
      if (open.status === "approved" || open.status === "starting") {
        if (!isStartAbandoned(open, now)) return { action: "none", sessionId: open.id, reason: null };
        const since = open.startedAt ?? open.approvedAt ?? open.createdAt;
        const reason = `start abandoned: still ${open.status} ${Math.round((now.getTime() - since.getTime()) / 60_000)} min after approval (the approving request did not finish)`;
        const result = await reconcileAbandoned(open, reason, "failed");
        return { action: result === "reconciled" ? "stopped" : result === "retrying" ? "retried_stop" : "none", sessionId: open.id, reason };
      }
      if (open.status !== "running") return { action: "none", sessionId: open.id, reason: null };

      const settings = await deps.base.getSettings();
      const client = await deps.base.resolveRunpodClient();
      const pod = open.podId ? await client.getPod(open.podId) : null;
      if (!pod || pod.status === "TERMINATED") {
        const gone = lastKnownAlive(open, now);
        await finish(open, ["running"], "interrupted", { error: `pod disappeared; ${goneNote(open, gone)}`, stoppedAt: gone });
        return { action: "interrupted", sessionId: open.id, reason: "pod disappeared" };
      }
      if (pod.status === "EXITED" || pod.status === "ERROR") {
        // Through stopRow, so an unconfirmed termination keeps the row `stopping` (podId kept) instead of marking it interrupted on trust.
        const stopped = await stopRow(open, `pod was ${pod.status}; terminated`, "interrupted");
        return { action: stopped.status === "stopping" ? "retried_stop" : "interrupted", sessionId: open.id, reason: `pod ${pod.status}` };
      }
      await deps.store.markSeenAlive(open.id, now);

      const minutes = open.startedAt ? (now.getTime() - open.startedAt.getTime()) / 60_000 : 0;
      const idleMinutes = (now.getTime() - (open.lastActivityAt ?? open.readyAt ?? open.startedAt ?? now).getTime()) / 60_000;
      const usd = liveUsd(open, now) ?? 0;
      const spentToday = await spentTodayUsd(now);
      let reason: string | null = null;
      if (minutes >= open.maxMinutes) reason = `max minutes reached (${open.maxMinutes})`;
      else if (open.maxUsd !== null && usd >= open.maxUsd) reason = `max USD reached ($${open.maxUsd})`;
      else if (spentToday >= settings.maxUsdPerDay) reason = `daily cap reached ($${settings.maxUsdPerDay})`;
      else if (idleMinutes >= settings.idleMinutes) reason = `idle for ${Math.floor(idleMinutes)} min (limit ${settings.idleMinutes})`;
      if (!reason) return { action: "none", sessionId: open.id, reason: null };
      const stopped = await stopRow(open, reason);
      return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason };
    },

    /**
     * Boot (AC-P14-08): a session left non-terminal by a process that died is reconciled -- the pod
     * is terminated if it still exists -- and marked `interrupted` (a `pending` request is harmless
     * and stays; a row already `stopping` finishes with its own reason/outcome). Quiet on a RunPod
     * failure: the row keeps a state the watcher/next boot can still act on.
     */
    async bootSweep(): Promise<{ swept: string[] }> {
      const open = await deps.store.getOpen();
      if (!open || open.status === "pending") return { swept: [] };
      try {
        await reconcileAbandoned(open, "interrupted by a server restart", "interrupted");
      } catch (cause) {
        log(`[media] boot sweep of session ${open.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      return { swept: [open.id] };
    },

    /**
     * For the volume lock's staleness check: does this session legitimately hold the volume right now? Only a session
     * past its `approved` write can (a `pending` one never does -- a lock left by an approve whose write threw is stale).
     */
    async holdsVolumeLock(sessionId: string): Promise<boolean> {
      const row = await deps.store.get(sessionId);
      return Boolean(row && ["approved", "starting", "running", "stopping"].includes(row.status));
    },

    /** For the idle auto-shutdown: a pod in flight is work (an MCP-driven session makes no HTTP traffic to this server). */
    async hasOpenPod(): Promise<boolean> {
      const open = await deps.store.getOpen();
      return Boolean(open && ["approved", "starting", "running", "stopping"].includes(open.status));
    },

    /** App exit (AC-P14-09): terminate the running pod first, bounded by the stop timeout; never throws. */
    async stopForShutdown(): Promise<{ stopped: string | null }> {
      try {
        const open = await deps.store.getOpen();
        if (!open || !["starting", "running", "stopping"].includes(open.status)) return { stopped: null };
        const stopped = open.status === "stopping" ? await retryStop(open, "application shutdown", "done") : await stopRow(open, "application shutdown");
        return { stopped: stopped.status === "stopping" ? null : open.id };
      } catch (error) {
        log(`[media] shutdown stop failed: ${error instanceof Error ? error.message : String(error)}`);
        return { stopped: null };
      }
    },
  };
}

export type MediaSessionServices = ReturnType<typeof createMediaSessionServices>;
