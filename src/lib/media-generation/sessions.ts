import type { EncryptedPayload } from "@/lib/shared-crypto";
import type { ComfyUiClient, RunpodApiClient, RunpodPod } from "@/lib/media-gateway";
import {
  COMFY_PROXY_PORT,
  DomainError,
  MEDIA_SESSION_ACTIVE_STATUSES,
  MEDIA_SESSION_NON_TERMINAL_STATUSES,
  type MediaSession,
  type MediaSessionLimits,
  type MediaGpuPlan,
  type MediaSessionRequester,
  type MediaSessionStatus,
  type MediaSettings,
} from "./contracts";
import { classifyCreatePodFailure, resolveGpuCandidates, type GpuCandidate } from "./gpu-plan";
import { findLivePodByName, terminateAndConfirm as terminateAndConfirmPod, type TerminateOutcome } from "./pod-lifecycle";
import { describeVolumeLockHolder, type VolumeLock } from "./volume-lock";
import { round2 } from "@/lib/shared-money";
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
  requestedBy: MediaSessionRequester;
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
  /** Schema v63 (BL-135); absent = false. */
  releaseWhenDone?: boolean;
  // Schema v64 (BL-133); absent on rows written before it.
  approvedBy?: "owner" | "factory" | null;
  gpuPlanJson?: string | null;
  capacityAttempts?: number | null;
  capacityNextAttemptAt?: Date | null;
  capacityWaitUntil?: Date | null;
  /** When this app last saw the pod alive (schema v54): the billable window of a pod found already gone closes here. */
  lastSeenAliveAt: Date | null;
  /** When this app's terminate DELETE went through (schema v57): a retried stop that finds the pod gone bills to here. */
  terminateSentAt: Date | null;
};

export type StoppingOutcome = "done" | "failed" | "interrupted";

export type SessionPatch = Partial<Omit<StoredSessionRow, "id" | "status">> & { status: MediaSessionStatus };

export type MediaSessionStore = {
  /** Slice 6: never refused -- concurrent sessions are bounded at approve (`approve`), not at request. */
  insert(row: Omit<StoredSessionRow, "createdAt"> & { createdAt?: Date }): Promise<StoredSessionRow>;
  get(id: string): Promise<StoredSessionRow | null>;
  /** Every non-terminal session (pending included), oldest first. */
  listOpen(): Promise<StoredSessionRow[]>;
  /**
   * `pending -> approved` as ONE atomic step guarded by "fewer than `maxActive` sessions hold a pod" and "no exclusive
   * volume-lock row" (AC-P14-22/23). `null` = a guard or the row's status refused; nothing changed.
   */
  approve(id: string, set: Omit<SessionPatch, "status">, maxActive: number): Promise<StoredSessionRow | null>;
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
   * AC-P14-18 as a constraint (review round 9; shared/exclusive since slice 6, `volume-lock.ts`): an active session
   * holds the volume SHARED by being an active row; a model pull's or operator pod's EXCLUSIVE row blocks the approve
   * (store.approve's guard), and a crash-stale row is cleared first (`activeHolder`).
   */
  volumeLock: VolumeLock;
  log?: (line: string) => void;
  /** BL-133 audit (`media_control_events`): factory session starts/stops and limit holds. */
  events?: { record(event: { actor: "owner" | "factory"; action: string; subject: string; details?: Record<string, unknown> }): Promise<void> };
  /** Tests only: let a watcher tick wait for the capacity retry it fires (production fires it in the background). */
  awaitCapacityRetries?: boolean;
  /** BL-133: the capacity log -- one call per createPod attempt (best effort: a failed record never fails a start). */
  capacityLog?: { record(attempt: { at: Date; sessionId: string; datacenterId: string | null; gpuTypeId: string; pricePerHr: number | null; result: "placed" | "no_capacity" | "error"; detail: string | null }): Promise<void> };
  /** BL-135: the session's jobs, for "release when done" (late-bound to the job services in `index.ts`). */
  jobSummary?(sessionId: string): Promise<{ total: number; open: number; lastFinishedAt: Date | null }>;
};

/** BL-135: how long a `releaseWhenDone` session may sit with every job finished before its pod is stopped. */
export const RELEASE_WHEN_DONE_GRACE_MS = 60_000;

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

const isActive = (row: StoredSessionRow) => (MEDIA_SESSION_ACTIVE_STATUSES as readonly MediaSessionStatus[]).includes(row.status);

export type WatchTickResult = { action: "none" | "stopped" | "interrupted" | "retried_stop" | "retried_start"; sessionId: string | null; reason: string | null };

/** The pod's name is deterministic so a pod created before the `starting` write can still be found at boot. */
export function podNameFor(sessionId: string): string {
  return `ytm-media-${sessionId.slice(0, 8)}`;
}

/** The cap's day is the operator's machine's local day (this app runs on that machine), not UTC. */
function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** BL-133: the factory's month is the machine's local calendar month, like its day. */
function startOfLocalMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
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
    releaseWhenDone: row.releaseWhenDone ?? false,
    approvedBy: row.approvedBy ?? (row.approvedAt ? "owner" : null),
    gpuPlan: row.gpuPlanJson ? (JSON.parse(row.gpuPlanJson) as MediaGpuPlan) : null,
    capacity:
      row.status === "waiting_capacity" || (row.capacityAttempts ?? 0) > 0
        ? { attempts: row.capacityAttempts ?? 0, nextAttemptAt: iso(row.capacityNextAttemptAt ?? null), waitUntil: iso(row.capacityWaitUntil ?? null) }
        : null,
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
    // The ONE billing arithmetic (`liveSeconds`/`liveUsd`), frozen at `stoppedAt` (review round 19).
    const frozen = { ...row, stoppedAt, usdCharged: null };
    return { secondsUsed: liveSeconds(frozen, stoppedAt) ?? 0, usdCharged: liveUsd(frozen, stoppedAt) ?? 0 };
  }

  /** Shared with model pulls (`pod-lifecycle.ts`); `alreadyGone` = RunPod had no such pod before our terminate. */
  function terminateAndConfirm(client: RunpodApiClient, podId: string, onTerminateSent?: (at: Date, alreadyGone: boolean) => Promise<void>): Promise<TerminateOutcome> {
    return terminateAndConfirmPod(client, podId, { now: () => deps.clock.now(), sleep: deps.sleep }, { timeoutMs: stopTimeoutMs, pollMs }, onTerminateSent);
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
    // Since slice 6 a session holds the volume by being active, so becoming terminal frees its share. A `session:` lock
    // row can exist only as a leftover of a pre-slice-6 build; release it if it is this session's.
    if (terminal) await deps.volumeLock.release(`session:${row.id}`);
    return terminal;
  }

  /**
   * stopping/starting/running -> terminate -> confirm -> terminal. Leaves `stopping` when the API cannot
   * confirm. The outcome is persisted on the row (`stoppingOutcome`) so a retry -- the watcher, the boot
   * sweep -- finishes with the status the stop was started for, not a default `done`.
   */
  async function stopRow(row: StoredSessionRow, requestedReason: string, requestedOutcome: StoppingOutcome = "done"): Promise<StoredSessionRow> {
    // A row ALREADY `stopping` keeps its own reason and outcome (an operator's deliberate `done` stop is never relabelled
    // `interrupted` by a watcher tick that raced it, review round 20); only starting/running take the caller's.
    const stopping =
      (await deps.store.transition(row.id, ["starting", "running"], { status: "stopping", stopReason: requestedReason, stoppingOutcome: requestedOutcome })) ??
      (await deps.store.transition(row.id, ["stopping"], { status: "stopping" }));
    if (!stopping) throw invalidState(row.id, "starting|running|stopping", row.status);
    const reason = stopping.stopReason ?? requestedReason;
    const outcome = stopping.stoppingOutcome ?? requestedOutcome;
    const terminal = { stopReason: reason, error: outcome === "done" ? null : reason };
    if (!stopping.podId) {
      const finished = await finish(stopping, ["stopping"], outcome, terminal);
      return finished ?? stopping;
    }
    let result: TerminateOutcome;
    try {
      const client = await deps.base.resolveRunpodClient();
      result = await terminateAndConfirm(client, stopping.podId, async (at, alreadyGone) => {
        // Our DELETE went through: from here the pod dies by our hand, so a retry must bill to THIS moment, not to the
        // last sighting (review round 19).
        if (!alreadyGone && !stopping.terminateSentAt) await deps.store.transition(row.id, ["stopping"], { status: "stopping", terminateSentAt: at });
      });
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
      if (stopping.terminateSentAt) {
        // Gone because an earlier attempt's DELETE went through (its confirm failed): billed to that DELETE, the honest
        // "creation -> confirmed termination" window (AC-P14-17), and no "vanished on its own" note.
        const finished = await finish(stopping, ["stopping"], outcome, { ...terminal, stoppedAt: stopping.terminateSentAt });
        return finished ?? stopping;
      }
      const gone = lastKnownAlive(stopping, deps.clock.now());
      // A `done` stop of a pod that was already gone is not an error: the note goes with the reason (review round 18).
      const finished = await finish(
        stopping,
        ["stopping"],
        outcome,
        outcome === "done" ? { stopReason: `${reason} (${goneNote(stopping, gone)})`, error: null, stoppedAt: gone } : { ...terminal, error: `${reason}; ${goneNote(stopping, gone)}`, stoppedAt: gone }
      );
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
          // RunPod's createdAt is untrusted input: an unparsable value must never become an Invalid Date that turns the cost
          // (and the daily cap check) into NaN (review round 18).
          const createdMs = orphan.createdAt ? Date.parse(orphan.createdAt) : NaN;
          orphanFacts = { podId: orphan.id, startedAt: Number.isFinite(createdMs) ? new Date(createdMs) : (open.approvedAt ?? deps.clock.now()), costPerHr: orphan.costPerHr ?? open.costPerHr };
        }
      } catch (cause) {
        await deps.store.transition(open.id, ["approved"], {
          status: "approved",
          error: `could not check RunPod for a pod named ${podNameFor(open.id)} (${cause instanceof Error ? cause.message : String(cause)}); retrying`,
        });
        return "deferred";
      }
    }
    let alreadyGone = false;
    if (podId) {
      // While the terminate is being confirmed (up to the stop budget) the row must not read `running`/`starting`/
      // `approved` to the UI, MCP, createJob or a concurrent Stop (review rounds 17/18): `stopping` first, with the pod
      // facts, like stopRow -- a second reconcile then resumes the same stop instead of racing it.
      if (open.status === "approved" || open.status === "starting" || open.status === "running") {
        await deps.store.transition(open.id, ["approved", "starting", "running"], { status: "stopping", ...(orphanFacts ?? {}), stopReason: reason, stoppingOutcome: outcome });
      }
      let unconfirmed: string | null = null;
      try {
        const client = await deps.base.resolveRunpodClient();
        const result = await terminateAndConfirm(client, podId, async (at, alreadyGone) => {
          // Our DELETE went through: a retry that finds the pod gone bills to THIS moment (review round 20) -- the pod ran
          // from the crash until now, and that is real RunPod spend the daily cap must see.
          if (!alreadyGone) await deps.store.transition(open.id, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], { status: "stopping", terminateSentAt: at });
        });
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
    // The same billing rule as stopRow (review round 21): gone because an earlier DELETE of ours went through -> billed
    // to that DELETE, no "vanished on its own" note; gone on its own -> billed to the last sighting.
    const latest = (await deps.store.get(open.id)) ?? open;
    if (alreadyGone && latest.terminateSentAt) {
      await finish(open, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], outcome, { stopReason: reason, error: reason, stoppedAt: latest.terminateSentAt }, orphanFacts ?? {});
      return "reconciled";
    }
    const gone = alreadyGone ? lastKnownAlive(effective, now) : now;
    await finish(open, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], outcome, { stopReason: reason, error: alreadyGone ? `${reason}; ${goneNote(effective, gone)}` : reason, stoppedAt: gone }, orphanFacts ?? {});
    return "reconciled";
  }

  /**
   * The approve itself (owner: Web route; factory: within its limits, BL-133). Preconditions first, none of which changes
   * the row; then the guarded `pending -> approved`; the start continues in the background.
   */
  async function approveInner(input: { sessionId: unknown; approvedByUserId?: string | null; approvedBy: "owner" | "factory"; onStage?: (text: string) => void }): Promise<{ session: MediaSession; started: Promise<MediaSession> }> {
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
    const [spent, open] = await Promise.all([spentTodayUsd(now), deps.store.listOpen()]);
    // AC-P14-17 with concurrent sessions (§5.2): what is spent today, plus what the OTHER active sessions may still spend
    // up to their own estimate, plus this session's estimate must fit the daily cap. (Not atomic between two approves --
    // the watcher stops every session once the day's total reaches the cap; only the concurrency count is atomic.)
    const reservedUsd = round2(open.filter((r) => r.id !== sessionId && isActive(r)).reduce((sum, r) => sum + Math.max(0, r.estimateUsd - (liveUsd(r, now) ?? 0)), 0));
    if (spent >= settings.maxUsdPerDay || round2(spent + reservedUsd + row.estimateUsd) > settings.maxUsdPerDay) {
      throw new DomainError({
        code: "media_daily_cap_reached",
        message: `Today's media spend cap ($${settings.maxUsdPerDay}) does not cover this session: $${spent} spent, $${reservedUsd} reserved by the other active sessions, estimate $${row.estimateUsd}. Lower maxMinutes/maxUsd, raise the cap in Production → Setup, or wait. The request stays pending.`,
        details: { maxUsdPerDay: settings.maxUsdPerDay, spentTodayUsd: spent, reservedUsd, estimateUsd: row.estimateUsd },
      });
    }
    // The request's estimate, cap check and record describe the GPU/datacenter saved when it was made; the pod is built
    // from the CURRENT settings. If they diverged, the approval would bill something the record never describes
    // (review round 11): refuse, the requester asks again against the new settings.
    if (row.gpuTypeId !== settings.gpuTypeId || row.datacenterId !== settings.datacenterId || row.costPerHr !== settings.gpuOnDemandPricePerHr) {
      throw new DomainError({
        code: "media_settings_invalid",
        message: `Production → Setup changed since this request was made (requested: ${row.gpuTypeId ?? "no GPU"} in ${row.datacenterId ?? "no datacenter"} at $${row.costPerHr ?? "?"}/h; now: ${settings.gpuTypeId ?? "no GPU"} in ${settings.datacenterId ?? "no datacenter"} at $${settings.gpuOnDemandPricePerHr ?? "?"}/h). Reject it and request a new session so the estimate and the record match what will be billed.`,
        details: { sessionId, requested: { gpuTypeId: row.gpuTypeId, datacenterId: row.datacenterId, costPerHr: row.costPerHr }, current: { gpuTypeId: settings.gpuTypeId, datacenterId: settings.datacenterId, costPerHr: settings.gpuOnDemandPricePerHr } },
      });
    }
    const client = await deps.base.resolveRunpodClient(); // credentials must resolve
    const token = deps.generateToken();
    const sealed = await deps.base.sealSecret(token);

    // AC-P14-18: a model pull / operator pod holding the volume exclusively refuses the approve (a crash-stale lock row
    // is cleared here first, so a dead pull never blocks sessions); the guarded UPDATE re-checks it atomically.
    const exclusive = await deps.volumeLock.activeHolder();
    if (exclusive) {
      throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(exclusive.owner), details: { sessionId, holder: exclusive.owner } });
    }
    const approved = await deps.store.approve(
      sessionId,
      { approvedAt: now, approvedByUserId: input.approvedByUserId ?? null, approvedBy: input.approvedBy, tokenCiphertext: sealed.ciphertext, tokenIv: sealed.iv, tokenAuthTag: sealed.authTag },
      settings.maxConcurrentSessions
    );
    if (!approved) {
      // Say which guard refused: the row moved on (a retried POST / a reject), a lock row appeared, or the limit is full.
      const latest = await requireRow(sessionId);
      if (latest.status !== "pending") throw invalidState(sessionId, "pending", latest.status);
      const holder = await deps.volumeLock.holder();
      if (holder) throw new DomainError({ code: "media_session_conflict", message: describeVolumeLockHolder(holder.owner), details: { sessionId, holder: holder.owner } });
      const active = (await deps.store.listOpen()).filter(isActive);
      throw new DomainError({
        code: "media_session_conflict",
        message: `${active.length} of ${settings.maxConcurrentSessions} concurrent sessions are already active (the limit in Production → Setup); stop one or wait for one to finish. The request stays pending.`,
        details: { sessionId, activeSessions: active.map((r) => r.id), maxConcurrentSessions: settings.maxConcurrentSessions },
      });
    }
    const started = startApproved(approved, settings, client, token, onStage);
    started.catch(() => undefined); // the outcome is on the row; a caller that ignores `started` must not crash the process
    return { session: toPublicSession(approved, now), started };
  
  }

  /** The one stop path (owner Stop; the Factory Operator's own sessions, BL-133). */
  async function stopInner(row: StoredSessionRow, reason: string): Promise<MediaSession> {
    // A row already `stopping` is resumed with ITS reason and outcome (an aborted start stays `failed`, review round 14);
    // the operator's press only retries the terminate.
    if (row.status === "stopping") return toPublicSession(await retryStop(row, reason, "done"), deps.clock.now());
    if (row.status === "waiting_capacity") {
      // BL-133: no pod exists while waiting -- ending it costs nothing and frees the slot.
      const ended = await finish(row, ["waiting_capacity"], "done", { stopReason: reason });
      if (!ended) throw invalidState(row.id, "waiting_capacity", (await requireRow(row.id)).status);
      return toPublicSession(ended, deps.clock.now());
    }
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
    if (!["starting", "running"].includes(row.status)) throw invalidState(row.id, "approved|starting|running|stopping", row.status);
    return toPublicSession(await stopRow(row, reason), deps.clock.now());
  
  }

  /** BL-133: what the factory's sessions spent (or still may, up to their USD cap) since `from`; `exclude` = the one being decided. */
  async function factorySpendUsd(from: Date, now: Date, exclude: string): Promise<number> {
    // Billed rows AND every open one (independent review): a factory session still being created or waiting for capacity has
    // no `startedAt` yet, so the billing query misses it -- but it may still spend up to its cap and must be reserved.
    const [billed, open] = await Promise.all([deps.store.listBillableSince(from), deps.store.listOpen()]);
    const byId = new Map<string, StoredSessionRow>();
    for (const r of [...billed, ...open]) byId.set(r.id, r);
    const rows = [...byId.values()].filter((r) => r.requestedBy === "factory" && r.id !== exclude);
    return round2(
      rows.reduce((sum, r) => {
        const spent = liveUsd(r, now) ?? 0;
        // An active session may still spend up to its own cap: reserved, so two quick starts cannot both slip under a limit.
        const reserved = isActive(r) ? Math.max(0, (r.maxUsd ?? r.estimateUsd) - spent) : 0;
        return sum + spent + reserved;
      }, 0)
    );
  }

  async function recordSessionEvent(event: { actor: "owner" | "factory"; action: string; subject: string; details?: Record<string, unknown> }): Promise<void> {
    try {
      await deps.events?.record(event);
    } catch (error) {
      log(`[media] could not record the ${event.action} event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** BL-133: one capacity-log row (best effort). */
  async function recordAttempt(sessionId: string, settings: MediaSettings, candidate: GpuCandidate, result: "placed" | "no_capacity" | "error", detail: string | null): Promise<void> {
    try {
      await deps.capacityLog?.record({ at: deps.clock.now(), sessionId, datacenterId: settings.datacenterId, gpuTypeId: candidate.gpuTypeId, pricePerHr: candidate.pricePerHr, result, detail: detail ? detail.slice(0, 500) : null });
    } catch (error) {
      log(`[media] could not record a capacity attempt: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * BL-133 (plan §2.4): nobody could be placed -- `approved -> waiting_capacity` with no pod (nothing billed). The watcher
   * retries every `capacityRetrySeconds`; once `capacityWaitMinutes` have passed since the FIRST wait, the session fails with
   * `media_no_capacity`. A row that moved on meanwhile (stopped, swept) keeps its own outcome.
   */
  async function waitForCapacity(row: StoredSessionRow, settings: MediaSettings, failures: string[]): Promise<MediaSession> {
    const now = deps.clock.now();
    const waitUntil = row.capacityWaitUntil ?? new Date(now.getTime() + settings.capacityWaitMinutes * 60_000);
    const attempts = (row.capacityAttempts ?? 0) + 1;
    const lastFailures = failures.join("; ");
    if (now.getTime() >= waitUntil.getTime()) {
      const message = `no capacity: no GPU candidate could be placed in ${settings.datacenterId ?? "the datacenter"} within ${settings.capacityWaitMinutes} min (${attempts} rounds; last: ${lastFailures})`;
      await finish(row, ["approved"], "failed", { error: `media_no_capacity: ${message}` });
      throw new DomainError({ code: "media_no_capacity", message: `${message}.`, details: { sessionId: row.id, attempts } });
    }
    const waiting = await deps.store.transition(row.id, ["approved"], {
      status: "waiting_capacity",
      capacityAttempts: attempts,
      capacityWaitUntil: waitUntil,
      capacityNextAttemptAt: new Date(now.getTime() + settings.capacityRetrySeconds * 1000),
      error: `waiting for capacity: ${lastFailures}`,
    });
    return toPublicSession(waiting ?? (await requireRow(row.id)), now);
  }

  /**
   * The background half of an approve: pending -> approved happened; from here approved -> starting (pod created,
   * `startedAt` = now, which is when RunPod starts billing) -> running once ComfyUI answers behind the token proxy. A
   * failure after the pod exists terminates it and ends the session `failed` (AC-P14-07).
   */
  async function startApproved(approved: StoredSessionRow, settings: MediaSettings, client: RunpodApiClient, token: string, onStage: (text: string) => void): Promise<MediaSession> {
    const sessionId = approved.id;
    onStage("Creating the pod");
    // BL-133 (FACTORY_GPU_SESSIONS_PLAN.md §2.3): the candidates are tried in order -- the session's own plan, else the
    // device GPU and its fallback list -- filtered by VRAM, price cap and the volume's datacenter. "No capacity" moves on;
    // a fatal answer ends the start as before; when nobody can be placed the session WAITS (no pod, nothing billed).
    const plan = approved.gpuPlanJson ? (JSON.parse(approved.gpuPlanJson) as MediaGpuPlan) : null;
    // An unreadable catalog is not a reason to refuse a start: the listed candidates are then tried as they are.
    const catalog = await Promise.resolve()
      .then(() => client.listGpuTypes({ cloud: settings.cloudType }))
      .catch(() => null);
    const { candidates, skipped } = resolveGpuCandidates({ plan, settings, catalog });
    if (candidates.length === 0) {
      const detail = skipped.map((s) => `${s.gpuTypeId}: ${s.reason}`).join("; ") || "no GPU is configured";
      await finish(approved, ["approved"], "failed", { error: `no GPU candidate qualifies: ${detail}` });
      throw new DomainError({ code: "media_session_start_failed", message: `No GPU candidate qualifies: ${detail}.`, details: { sessionId, skipped } });
    }
    let pod: RunpodPod | null = null;
    let used: GpuCandidate | null = null;
    let startedAt = deps.clock.now();
    const failures: string[] = [];
    // A pod an EARLIER attempt created behind a failed answer (a timeout) carries this session's name (independent review):
    // before every createPod after the first -- and before the first of a capacity-retry round -- look for it, so a second pod
    // is never created next to a first one nobody would ever terminate.
    const adoptExisting = async (): Promise<RunpodPod | undefined> => {
      try {
        return await findLivePodByName(client, podNameFor(sessionId));
      } catch (lookupError) {
        const detail = lookupError instanceof Error ? lookupError.message : String(lookupError);
        await deps.store.transition(sessionId, ["approved"], { status: "approved", error: `RunPod could not be asked whether a pod of this session already exists (${detail}); the watcher re-checks` });
        throw new DomainError({ code: "media_session_start_failed", message: `RunPod could not confirm whether a pod already exists for this session; it stays approved until the watcher can check.`, details: { sessionId, status: "approved" } });
      }
    };
    const candidateOf = (existing: RunpodPod, fallback: GpuCandidate): GpuCandidate => candidates.find((c) => c.gpuTypeId === existing.gpuTypeId) ?? fallback;
    for (const [index, candidate] of candidates.entries()) {
      startedAt = deps.clock.now();
      if (index > 0 || (approved.capacityAttempts ?? 0) > 0) {
        const existing = await adoptExisting();
        if (existing) {
          log(`[media] pod ${existing.id} of session ${sessionId} already exists (an earlier attempt); continuing with it`);
          pod = existing;
          used = candidateOf(existing, candidate);
          await recordAttempt(sessionId, settings, used, "placed", "adopted: created by an earlier attempt");
          break;
        }
      }
      try {
        pod = await client.createPod({
          name: podNameFor(sessionId),
          templateId: settings.templateId ?? undefined,
          gpu: { id: candidate.gpuTypeId, count: 1 },
          cloud: settings.cloudType,
          dataCenterId: settings.datacenterId ?? undefined,
          mounts: settings.networkVolumeId ? { network: [{ volumeId: settings.networkVolumeId, path: "/workspace" }] } : undefined,
          ports: [`${COMFY_PROXY_PORT}/http`],
          env: { COMFY_TOKEN: token },
        });
        used = candidate;
        await recordAttempt(sessionId, settings, candidate, "placed", null);
        break;
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
          await recordAttempt(sessionId, settings, candidate, "error", message);
          await deps.store.transition(sessionId, ["approved"], { status: "approved", error: `pod creation failed (${message}) and RunPod could not be asked whether the pod exists (${detail}); the watcher re-checks` });
          throw new DomainError({
            code: "media_session_start_failed",
            message: `Pod creation failed (${message}) and RunPod could not confirm whether a pod was created; the session stays approved until the watcher can check.`,
            details: { sessionId, status: "approved" },
          });
        }
        if (orphan) {
          log(`[media] createPod failed (${message}) but pod ${orphan.id} exists under ${podNameFor(sessionId)}; continuing with it`);
          pod = orphan;
          used = candidateOf(orphan, candidate);
          await recordAttempt(sessionId, settings, used, "placed", `adopted after: ${message}`);
          break;
        }
        const kind = classifyCreatePodFailure(error);
        await recordAttempt(sessionId, settings, candidate, kind === "no_capacity" ? "no_capacity" : "error", message);
        if (kind === "fatal") {
          await finish(approved, ["approved"], "failed", { error: `pod creation failed: ${message}` });
          throw new DomainError({ code: "media_session_start_failed", message: `Pod creation failed: ${message}`, details: { sessionId } });
        }
        failures.push(`${candidate.gpuTypeId}: ${message}`);
      }
    }
    if (!pod || !used) return waitForCapacity(approved, settings, failures);
    // From here on a pod EXISTS and bills: every exit path below either confirms its termination or
    // leaves the session non-terminal (`stopping`, podId recorded) so the watcher/boot sweep retries.
    const abortStart = async (lastDetail: string): Promise<MediaSession> => {
      onStage("Terminating the pod");
      let terminated: { confirmed: boolean; lastStatus: string | null };
      try {
        terminated = await terminateAndConfirm(client, pod.id, async (at, alreadyGone) => {
          if (!alreadyGone) await deps.store.transition(sessionId, ["approved", "starting"], { status: (await requireRow(sessionId)).status as "approved" | "starting", podId: pod.id, startedAt, terminateSentAt: at });
        });
      } catch (error) {
        terminated = { confirmed: false, lastStatus: `unknown (${error instanceof Error ? error.message : String(error)})` };
      }
      // An operator Stop (or the watcher/boot sweep) may have taken the row meanwhile: never overwrite its outcome.
      const latest = await requireRow(sessionId);
      if (latest.status === "approved" || latest.status === "starting") {
        // The pod existed and billed from `startedAt`: record it even when the `starting` write never happened.
        const podFacts = { podId: pod.id, startedAt, costPerHr: pod.costPerHr ?? used.pricePerHr ?? latest.costPerHr };
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
      // An operator Stop (or the watcher/boot sweep) ended the session on purpose while it was starting: that is the
      // session's outcome, not a start failure to report as an error (review round 19).
      const final = await requireRow(sessionId);
      if (latest.status !== "approved" && latest.status !== "starting") return toPublicSession(final, deps.clock.now());
      throw new DomainError({
        code: "media_session_start_failed",
        message: `The session could not start: ${lastDetail}.`,
        details: { sessionId, podId: pod.id, podTerminated: terminated.confirmed, status: final.status },
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
        // BL-133: what it actually got -- the candidate (its catalog price when the pod does not report one).
        gpuTypeId: used.gpuTypeId,
        costPerHr: pod.costPerHr ?? used.pricePerHr ?? approved.costPerHr,
        capacityNextAttemptAt: null,
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
      const facts = { podId: pod.id, startedAt, costPerHr: pod.costPerHr ?? used.pricePerHr ?? latest.costPerHr };
      if (!outcome?.confirmed) {
        const detail = failure ?? `pod still ${outcome?.lastStatus} after terminate`;
        log(`[media] pod ${pod.id} created after session ${sessionId} was ${latest.status}; terminate not confirmed (${detail})`);
        await deps.store.transition(sessionId, [latest.status], {
          status: latest.status,
          ...facts,
          error: `${latest.error ? `${latest.error}; ` : ""}pod ${pod.id} was created after the session ended and its terminate could not be confirmed (${detail}): terminate it by hand (media pod-terminate ${pod.id})`,
        });
      } else {
        // Confirmed gone -- but it billed from `startedAt` until now, on no row so far: record the pod and its cost on
        // whatever row the other party left, so the daily cap sees the spend (AC-P14-17, review round 19).
        const stoppedAt = deps.clock.now();
        const cost = finalCost({ ...latest, ...facts }, stoppedAt);
        await deps.store.transition(sessionId, [latest.status], {
          status: latest.status,
          ...facts,
          ...(MEDIA_SESSION_NON_TERMINAL_STATUSES.includes(latest.status) ? {} : { stoppedAt, secondsUsed: cost.secondsUsed, usdCharged: cost.usdCharged }),
          error: `${latest.error ? `${latest.error}; ` : ""}pod ${pod.id} was created after the session ended and was terminated (${cost.secondsUsed} s billed)`,
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
          // RunPod says RUNNING while the image still downloads; the container is up only once `runtime` appears
          // (slice 0). Until then the honest stage is "downloading the image", and a timeout says the container never started.
          if (current.status === "RUNNING" && current.containerUptimeSec !== null) {
            phase = "comfy";
            onStage("Waiting for ComfyUI to answer");
          } else if (current.status === "RUNNING") {
            lastDetail = "the container never started on the host (image download or host problem)";
            onStage("Downloading the image and starting the container");
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
  }

  /** One session's watcher step (see `watchTick`). */
  async function watchOne(open: StoredSessionRow): Promise<WatchTickResult> {
    const now = deps.clock.now();
    if (open.status === "waiting_capacity") {
      // BL-133: no pod exists. Past the wait -> failed (media_no_capacity); when the next attempt is due -> back to
      // `approved` (approvedAt restarted, so the abandoned-start clock measures THIS attempt) and the start runs again in the
      // background -- a start can take minutes and must not hold up the other sessions' tick.
      const settings = await deps.base.getSettings();
      if (open.capacityWaitUntil && now.getTime() >= open.capacityWaitUntil.getTime()) {
        const reason = `no capacity within ${settings.capacityWaitMinutes} min (${open.capacityAttempts ?? 0} rounds)`;
        await finish(open, ["waiting_capacity"], "failed", { error: `media_no_capacity: ${reason}${open.error ? `; ${open.error}` : ""}` });
        return { action: "stopped", sessionId: open.id, reason };
      }
      if (open.capacityNextAttemptAt && now.getTime() < open.capacityNextAttemptAt.getTime()) return { action: "none", sessionId: open.id, reason: null };
      // What the approval was made against must still hold (independent review): the factory switch for a factory session,
      // and the datacenter (the volume) -- otherwise the wait ends here, at no cost.
      const voided =
        open.requestedBy === "factory" && open.approvedBy === "factory" && !settings.factorySessionsEnabled
          ? "factory sessions were switched off while it waited"
          : open.datacenterId !== settings.datacenterId
            ? `the datacenter changed (${open.datacenterId ?? "none"} → ${settings.datacenterId ?? "none"}) while it waited`
            : null;
      if (voided) {
        await finish(open, ["waiting_capacity"], "failed", { error: `capacity wait ended: ${voided}` });
        return { action: "stopped", sessionId: open.id, reason: voided };
      }
      let client: RunpodApiClient;
      let token: string;
      try {
        if (!open.tokenCiphertext || !open.tokenIv || !open.tokenAuthTag) throw new Error("the session's proxy token is missing");
        client = await deps.base.resolveRunpodClient();
        token = await deps.base.openSecret({ ciphertext: open.tokenCiphertext, iv: open.tokenIv, authTag: open.tokenAuthTag });
      } catch (cause) {
        // Nothing changed yet: the session keeps waiting and the next round tries again (never an `approved` row with no start).
        const detail = cause instanceof Error ? cause.message : String(cause);
        await deps.store.transition(open.id, ["waiting_capacity"], { status: "waiting_capacity", capacityNextAttemptAt: new Date(now.getTime() + settings.capacityRetrySeconds * 1000), error: `capacity retry could not start: ${detail}` });
        return { action: "none", sessionId: open.id, reason: detail };
      }
      const retry = await deps.store.transition(open.id, ["waiting_capacity"], { status: "approved", approvedAt: now, error: null });
      if (!retry) return { action: "none", sessionId: open.id, reason: null };
      const started = startApproved(retry, settings, client, token, () => undefined);
      started.catch(() => undefined); // every outcome lands on the row
      if (deps.awaitCapacityRetries) await started.catch(() => undefined);
      return { action: "retried_start", sessionId: open.id, reason: "capacity retry" };
    }
    if (open.status === "stopping") {
      const stopped = await retryStop(open, "stop retried by watcher", "done");
      return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason: open.stopReason };
    }
    if (open.status === "starting" && !isStartAbandoned(open, now)) {
      // The pod exists and bills while ComfyUI boots: the day's cap stops it too (§5.2 "every active session", independent
      // review before the dev merge). An `approved` row has no pod yet and cannot be stopped without orphaning one.
      const settings = await deps.base.getSettings();
      // The session's own USD cap bites while ComfyUI boots too (independent review: a dear fallback GPU could pass it
      // during an 8-minute start before the running-state check).
      if (open.maxUsd !== null && (liveUsd(open, now) ?? 0) >= open.maxUsd) {
        const reason = `max USD reached ($${open.maxUsd}) while starting`;
        const stopped = await stopRow(open, reason);
        return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason };
      }
      if ((await spentTodayUsd(now)) >= settings.maxUsdPerDay) {
        const reason = `daily cap reached ($${settings.maxUsdPerDay})`;
        const stopped = await stopRow(open, reason);
        return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason };
      }
      return { action: "none", sessionId: open.id, reason: null };
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
      // Through stopRow (DELETE first, then confirm), never on the strength of one GET: a transient 404 on a live pod would
      // otherwise free the slot and the lock while the pod keeps billing (review round 18). An already-gone pod is billed
      // to its last sighting by stopRow's alreadyGone path.
      const stopped = await stopRow(open, "pod disappeared", "interrupted");
      return { action: stopped.status === "stopping" ? "retried_stop" : "interrupted", sessionId: open.id, reason: "pod disappeared" };
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
    else if (open.releaseWhenDone && open.status === "running" && deps.jobSummary) {
      // BL-135: every job finished and none followed for a minute (counted from the last finish AND the last activity, so a
      // job being submitted right now is never cut off).
      const jobs = await deps.jobSummary(open.id);
      const quietSince = Math.max(jobs.lastFinishedAt?.getTime() ?? 0, open.lastActivityAt?.getTime() ?? 0);
      if (jobs.total > 0 && jobs.open === 0 && now.getTime() - quietSince >= RELEASE_WHEN_DONE_GRACE_MS) reason = "all jobs done (release when done)";
    }
    if (!reason) return { action: "none", sessionId: open.id, reason: null };
    const stopped = await stopRow(open, reason);
    return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason };
  }

  const services = {
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
      const [settings, overview, open, spent] = await Promise.all([deps.base.getSettings(), deps.base.getOverview(), deps.store.listOpen(), spentTodayUsd(now)]);
      const openSessions = open.map((row) => toPublicSession(row, now));
      return {
        maxUsdPerDay: settings.maxUsdPerDay,
        spentTodayUsd: spent,
        remainingTodayUsd: round2(Math.max(0, settings.maxUsdPerDay - spent)),
        defaultMaxMinutes: settings.defaultMaxMinutes,
        idleMinutes: settings.idleMinutes,
        watchIntervalSeconds: settings.watchIntervalSeconds,
        openSessions,
        openSession: openSessions[0] ?? null,
        maxConcurrentSessions: settings.maxConcurrentSessions,
        activeSessionCount: open.filter(isActive).length,
        ready: overview.ready,
        missing: overview.missing,
      };
    },

    /**
     * A pending request with a LOCAL estimate (AC-P14-03): no RunPod call; the GPU price saved with
     * the settings is the input. A request that does not fit today's remaining cap is still created
     * and flagged. Refused when the feature is not ready. Since slice 6 (owner, 2026-10-05) any number of requests may
     * be pending; how many may hold a pod at once is bounded at approve (`maxConcurrentSessions`).
     */
    async requestSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(requestSessionInputSchema, input, "media session request");
      const now = deps.clock.now();
      const [settings, overview] = await Promise.all([deps.base.getSettings(), deps.base.getOverview()]);
      if (!overview.ready) {
        throw new DomainError({ code: "media_generation_not_configured", message: `Media generation is not ready: ${overview.missing.join(", ")}.`, details: { missing: overview.missing } });
      }
      if (settings.gpuOnDemandPricePerHr === null) {
        throw new DomainError({ code: "media_settings_invalid", message: "The GPU's price is unknown -- reload the catalog and save the GPU again in Production → Setup." });
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
        terminateSentAt: null,
        releaseWhenDone: parsed.releaseWhenDone ?? false,
        gpuPlanJson: parsed.gpu ? JSON.stringify({ candidates: parsed.gpu.candidates, minVramGb: parsed.gpu.minVramGb ?? null, maxPricePerHr: parsed.gpu.maxPricePerHr ?? null }) : null,
      });
      return toPublicSession(row, now);
    },

    /**
     * BL-135 (ADR 0023 amendment 2, owner 2026-10-06): the channel that requested a session may END it -- the one session
     * action an agent gets, because it only ever stops spending. Its own channel's session only (another channel's is
     * not found). `pending` → withdrawn (rejected), `starting`/`running` → the same stop as the owner's, `stopping` →
     * nothing to do, `approved` (pod still being created) → refused until it is running, terminal → refused.
     */
    async releaseSession(input: { sessionId: string; channelId: string }): Promise<MediaSession> {
      const row = await deps.store.get(input.sessionId);
      if (!row || row.channelId !== input.channelId) throw notFound(input.sessionId);
      const reason = "released by the channel agent";
      if (row.status === "pending") {
        const withdrawn = await deps.store.transition(row.id, ["pending"], { status: "rejected", stoppedAt: deps.clock.now(), stopReason: "withdrawn by the channel agent" });
        if (!withdrawn) throw invalidState(row.id, "pending", (await requireRow(row.id)).status);
        return toPublicSession(withdrawn, deps.clock.now());
      }
      if (row.status === "stopping") return toPublicSession(row, deps.clock.now());
      if (row.status === "waiting_capacity") {
        const ended = await finish(row, ["waiting_capacity"], "done", { stopReason: reason });
        if (!ended) throw invalidState(row.id, "waiting_capacity", (await requireRow(row.id)).status);
        return toPublicSession(ended, deps.clock.now());
      }
      if (row.status === "starting" || row.status === "running") return toPublicSession(await stopRow(row, reason), deps.clock.now());
      throw invalidState(row.id, row.status === "approved" ? "running (the pod is still being created -- try again shortly)" : "pending|starting|running", row.status);
    },

    async rejectSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(rejectSessionInputSchema, input, "reject session");
      const row = await requireRow(parsed.sessionId);
      const rejected = await deps.store.transition(parsed.sessionId, ["pending"], { status: "rejected", stoppedAt: deps.clock.now(), stopReason: parsed.reason });
      if (!rejected) throw invalidState(parsed.sessionId, "pending", row.status);
      return toPublicSession(rejected, deps.clock.now());
    },

    /**
     * Web-only (fenced). Slice 6 (AC-P14-24, owner 2026-10-05: no blocking pop-up): the preconditions run BEFORE any
     * transition (AC-P14-04), then `pending -> approved` happens synchronously and this returns at once with the
     * `approved` session; `started` is the start running on in the background (pod created -> ComfyUI answering behind
     * the token proxy). Every start failure lands on the row (`failed`/`stopping` + error), so a caller that does not
     * wait for `started` still sees the outcome in the sessions table.
     */
    async approveSession(input: { sessionId: unknown; approvedByUserId?: string | null; onStage?: (text: string) => void }): Promise<{ session: MediaSession; started: Promise<MediaSession> }> {
      return approveInner({ ...input, approvedBy: "owner" });
    },

    /**
     * BL-133 (FACTORY_GPU_SESSIONS_PLAN.md §2.2, AC-FG-01/02): the Factory Operator's own start. The session is requested
     * (`requestedBy: factory`, the per-session caps defaulting to the owner's factory limits) and approved BY THE FACTORY only
     * when it fits every factory limit -- the switch, per-session USD/minutes, the factory's day and month -- and then every
     * device limit the owner's approve also checks. Otherwise it stays `pending` for the owner, with the limit named.
     */
    async factoryStartSession(input: {
      channelId: string;
      maxMinutes?: number;
      maxUsd?: number;
      gpu?: { candidates: string[]; minVramGb?: number | null; maxPricePerHr?: number | null };
      releaseWhenDone?: boolean;
    }): Promise<{ session: MediaSession; approved: boolean; heldBy: string | null }> {
      const settings = await deps.base.getSettings();
      const pending = await services.requestSession({
        channelId: input.channelId,
        maxMinutes: input.maxMinutes ?? settings.factoryMaxMinutesPerSession,
        maxUsd: input.maxUsd ?? settings.factoryMaxUsdPerSession,
        reason: "started by the Factory Operator",
        ...(input.releaseWhenDone !== undefined ? { releaseWhenDone: input.releaseWhenDone } : {}),
        ...(input.gpu ? { gpu: input.gpu } : {}),
        requestedBy: "factory",
      });
      const row = await requireRow(pending.sessionId);
      const now = deps.clock.now();
      // The worst case a factory session can spend is its own USD cap (the watcher stops it there whatever GPU it gets).
      const worst = row.maxUsd ?? row.estimateUsd;
      const [today, month] = await Promise.all([factorySpendUsd(startOfLocalDay(now), now, row.id), factorySpendUsd(startOfLocalMonth(now), now, row.id)]);
      const held = !settings.factorySessionsEnabled
        ? "Factory sessions are switched off (Production → Setup)"
        : row.maxMinutes > settings.factoryMaxMinutesPerSession
          ? `${row.maxMinutes} min is over the factory's ${settings.factoryMaxMinutesPerSession} min per session`
          : worst > settings.factoryMaxUsdPerSession
            ? `$${worst} is over the factory's $${settings.factoryMaxUsdPerSession} per session`
            : round2(today + worst) > settings.factoryMaxUsdPerDay
              ? `the factory's day would reach $${round2(today + worst)} (limit $${settings.factoryMaxUsdPerDay}; spent or reserved $${today})`
              : round2(month + worst) > settings.factoryMaxUsdPerMonth
                ? `the factory's month would reach $${round2(month + worst)} (limit $${settings.factoryMaxUsdPerMonth}; spent or reserved $${month})`
                : null;
      if (held) {
        await recordSessionEvent({ actor: "factory", action: "session_held_for_owner", subject: row.id, details: { reason: held } });
        const kept = await deps.store.transition(row.id, ["pending"], { status: "pending", reason: `started by the Factory Operator; waits for the owner: ${held}` });
        return { session: toPublicSession(kept ?? row, now), approved: false, heldBy: held };
      }
      try {
        const { session } = await approveInner({ sessionId: row.id, approvedBy: "factory" });
        await recordSessionEvent({ actor: "factory", action: "session_started", subject: row.id, details: { maxMinutes: row.maxMinutes, maxUsd: row.maxUsd } });
        return { session, approved: true, heldBy: null };
      } catch (error) {
        // A DEVICE limit (daily cap, concurrency, a pull on the volume, settings changed): the request stays pending.
        const reason = error instanceof Error ? error.message : String(error);
        await recordSessionEvent({ actor: "factory", action: "session_held_for_owner", subject: row.id, details: { reason } });
        const latest = await requireRow(row.id);
        if (latest.status !== "pending") throw error;
        return { session: toPublicSession(latest, deps.clock.now()), approved: false, heldBy: reason };
      }
    },

    /** BL-133: a session the Factory Operator started -- any other one is reported as not found (AC-FG-03/07). */
    async getFactorySession(input: { sessionId: string }): Promise<MediaSession> {
      const row = await deps.store.get(input.sessionId);
      if (!row || row.requestedBy !== "factory") throw notFound(input.sessionId);
      return toPublicSession(row, deps.clock.now());
    },

    /** BL-133: the factory ends a session IT started (AC-FG-03); another session behaves like one that does not exist. */
    async factoryStopSession(input: { sessionId: string }): Promise<MediaSession> {
      const row = await deps.store.get(input.sessionId);
      if (!row || row.requestedBy !== "factory") throw notFound(input.sessionId);
      if (row.status === "pending") {
        const withdrawn = await deps.store.transition(row.id, ["pending"], { status: "rejected", stoppedAt: deps.clock.now(), stopReason: "withdrawn by the Factory Operator" });
        if (!withdrawn) throw invalidState(row.id, "pending", (await requireRow(row.id)).status);
        await recordSessionEvent({ actor: "factory", action: "session_stopped", subject: row.id, details: { from: "pending" } });
        return toPublicSession(withdrawn, deps.clock.now());
      }
      const stopped = await stopInner(row, "stopped by the Factory Operator");
      await recordSessionEvent({ actor: "factory", action: "session_stopped", subject: row.id, details: { from: row.status } });
      return stopped;
    },

    /** Approve and wait for the start to finish (the operator CLI and tests); the Web route uses `approveSession`. */
    async approveAndStartSession(input: { sessionId: unknown; approvedByUserId?: string | null; onStage?: (text: string) => void }): Promise<MediaSession> {
      const { started } = await services.approveSession(input);
      return started;
    },

    /** Web-only (fenced): running|starting|stopping -> terminate -> done. */
    async stopSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(stopSessionInputSchema, input, "stop session");
      return stopInner(await requireRow(parsed.sessionId), parsed.reason ?? "stopped by operator");
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
     *
     * Slice 6: every open session, one result each (oldest first; a pending row answers "none"). One session's RunPod
     * failure never skips the others -- it is reported as that session's error and the next tick retries.
     */
    async watchTick(): Promise<WatchTickResult[]> {
      // In parallel (independent review): each stop may wait up to the stop budget, and a fourth session must not bill on
      // while the first three are confirmed one after another. Results keep the sessions' order.
      return Promise.all(
        (await deps.store.listOpen()).map(async (open): Promise<WatchTickResult> => {
          try {
            return await watchOne(open);
          } catch (cause) {
            log(`[media] watcher: session ${open.id} failed this tick: ${cause instanceof Error ? cause.message : String(cause)}`);
            return { action: "none", sessionId: open.id, reason: `watch failed: ${cause instanceof Error ? cause.message : String(cause)}` };
          }
        })
      );
    },

    /**
     * Boot (AC-P14-08): a session left non-terminal by a process that died is reconciled -- the pod
     * is terminated if it still exists -- and marked `interrupted` (a `pending` request is harmless
     * and stays; a row already `stopping` finishes with its own reason/outcome). Quiet on a RunPod
     * failure: the row keeps a state the watcher/next boot can still act on.
     */
    async bootSweep(): Promise<{ swept: string[] }> {
      const swept: string[] = [];
      for (const open of await deps.store.listOpen()) {
        // A pending request has no pod; neither has a session waiting for capacity (BL-133) -- the watcher resumes it.
        if (open.status === "pending" || open.status === "waiting_capacity") continue;
        try {
          await reconcileAbandoned(open, "interrupted by a server restart", "interrupted");
        } catch (cause) {
          log(`[media] boot sweep of session ${open.id} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        swept.push(open.id);
      }
      return { swept };
    },

    /**
     * For the volume lock's staleness check: does this session legitimately hold the volume right now? Only a session
     * past its `approved` write can (a `pending` one never does -- a lock left by an approve whose write threw is stale).
     */
    async holdsVolumeLock(sessionId: string): Promise<boolean> {
      const row = await deps.store.get(sessionId);
      return Boolean(row && isActive(row));
    },

    /** For the idle auto-shutdown: a pod in flight is work (an MCP-driven session makes no HTTP traffic to this server). */
    /** Sessions holding a pod right now (slice 6: the shared side of the volume lock). */
    async activeSessionIds(): Promise<string[]> {
      return (await deps.store.listOpen()).filter(isActive).map((row) => row.id);
    },

    async hasOpenPod(): Promise<boolean> {
      return (await deps.store.listOpen()).some(isActive);
    },

    /**
     * App exit (AC-P14-09): terminate every running pod first, in parallel, each bounded by the stop timeout; never
     * throws. `stopped` lists the sessions whose termination was confirmed.
     */
    async stopForShutdown(): Promise<{ stopped: string[] }> {
      let open: StoredSessionRow[];
      try {
        open = (await deps.store.listOpen()).filter((row) => ["starting", "running", "stopping"].includes(row.status));
      } catch (error) {
        log(`[media] shutdown stop failed: ${error instanceof Error ? error.message : String(error)}`);
        return { stopped: [] };
      }
      const outcomes = await Promise.allSettled(
        open.map((row) => (row.status === "stopping" ? retryStop(row, "application shutdown", "done") : stopRow(row, "application shutdown")))
      );
      const stopped: string[] = [];
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled" && outcome.value.status !== "stopping") stopped.push(open[index].id);
        if (outcome.status === "rejected") log(`[media] shutdown stop of session ${open[index].id} failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      });
      return { stopped };
    },
  };
  return services;
}

export type MediaSessionServices = ReturnType<typeof createMediaSessionServices>;
