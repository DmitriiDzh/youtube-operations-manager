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
};

export type SessionPatch = Partial<Omit<StoredSessionRow, "id" | "status">> & { status: MediaSessionStatus };

export type MediaSessionStore = {
  /** `null` = the device's single open slot is taken (AC-P14-05). */
  insert(row: Omit<StoredSessionRow, "createdAt"> & { createdAt?: Date }): Promise<StoredSessionRow | null>;
  get(id: string): Promise<StoredSessionRow | null>;
  getOpen(): Promise<StoredSessionRow | null>;
  list(limit: number): Promise<StoredSessionRow[]>;
  listStartedSince(since: Date): Promise<StoredSessionRow[]>;
  /** Atomic `from -> set.status`; `null` = not in `from`. */
  transition(id: string, from: readonly MediaSessionStatus[], set: SessionPatch): Promise<StoredSessionRow | null>;
  touchActivity(id: string, at: Date): Promise<void>;
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
  log?: (line: string) => void;
};

const DEFAULT_START_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 90_000;

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

  async function spentTodayUsd(now: Date): Promise<number> {
    const rows = await deps.store.listStartedSince(startOfUtcDay(now));
    return round2(rows.reduce((sum, row) => sum + (liveUsd(row, now) ?? 0), 0));
  }

  /** Pod creation -> confirmed termination (AC-P14-17); a terminal row keeps the frozen numbers. */
  function finalCost(row: StoredSessionRow, stoppedAt: Date): { secondsUsed: number; usdCharged: number } {
    const secondsUsed = row.startedAt ? Math.max(0, Math.round((stoppedAt.getTime() - row.startedAt.getTime()) / 1000)) : 0;
    const usdCharged = row.costPerHr === null ? 0 : round2((secondsUsed * row.costPerHr) / 3600);
    return { secondsUsed, usdCharged };
  }

  async function terminateAndConfirm(client: RunpodApiClient, podId: string): Promise<{ confirmed: boolean; lastStatus: string | null }> {
    await client.terminatePod(podId);
    const deadline = deps.clock.now().getTime() + stopTimeoutMs;
    let lastStatus: string | null = null;
    for (;;) {
      const pod = await client.getPod(podId);
      if (!pod || pod.status === "TERMINATED") return { confirmed: true, lastStatus: pod?.status ?? null };
      lastStatus = pod.status;
      if (deps.clock.now().getTime() >= deadline) return { confirmed: false, lastStatus };
      await deps.sleep(pollMs);
    }
  }

  /**
   * Moves a session to a terminal state after its pod is confirmed gone (or was never created).
   * Returns the updated row, or null if the row was no longer in `from`.
   */
  async function finish(
    row: StoredSessionRow,
    from: readonly MediaSessionStatus[],
    status: Extract<MediaSessionStatus, "done" | "failed" | "interrupted">,
    extra: { stopReason?: string | null; error?: string | null }
  ): Promise<StoredSessionRow | null> {
    const stoppedAt = deps.clock.now();
    const cost = finalCost(row, stoppedAt);
    return deps.store.transition(row.id, from, {
      status,
      stoppedAt,
      secondsUsed: cost.secondsUsed,
      usdCharged: cost.usdCharged,
      stopReason: extra.stopReason ?? null,
      error: extra.error ?? null,
    });
  }

  /** stopping/starting/running -> terminate -> confirm -> terminal. Leaves `stopping` when the API cannot confirm. */
  async function stopRow(row: StoredSessionRow, reason: string, terminalStatus: "done" | "interrupted" | "failed" = "done"): Promise<StoredSessionRow> {
    const stopping = await deps.store.transition(row.id, ["starting", "running", "stopping"], { status: "stopping", stopReason: reason });
    if (!stopping) throw invalidState(row.id, "starting|running|stopping", row.status);
    if (!stopping.podId) {
      const finished = await finish(stopping, ["stopping"], terminalStatus, { stopReason: reason });
      return finished ?? stopping;
    }
    const client = await deps.base.resolveRunpodClient();
    const result = await terminateAndConfirm(client, stopping.podId);
    if (!result.confirmed) {
      log(`[media] pod ${stopping.podId} still ${result.lastStatus} after terminate; session ${row.id} stays stopping`);
      const kept = await deps.store.transition(row.id, ["stopping"], { status: "stopping", error: `pod still ${result.lastStatus} after terminate; retrying` });
      return kept ?? stopping;
    }
    const finished = await finish(stopping, ["stopping"], terminalStatus, { stopReason: reason });
    return finished ?? stopping;
  }

  return {
    toPublicSession: (row: StoredSessionRow) => toPublicSession(row, deps.clock.now()),

    async getSession(input: unknown): Promise<MediaSession> {
      const { sessionId } = parseWithSchema(sessionIdInputSchema, input, "session id");
      return toPublicSession(await requireRow(sessionId), deps.clock.now());
    },

    async listSessions(limit = 50): Promise<MediaSession[]> {
      const now = deps.clock.now();
      return (await deps.store.list(limit)).map((row) => toPublicSession(row, now));
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
      const estimateUsd = round2((settings.gpuOnDemandPricePerHr * maxMinutes) / 60);
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
      if (spent >= settings.maxUsdPerDay) {
        throw new DomainError({
          code: "media_daily_cap_reached",
          message: `Today's media spend cap ($${settings.maxUsdPerDay}) is used up ($${spent} spent). The request stays pending.`,
          details: { maxUsdPerDay: settings.maxUsdPerDay, spentTodayUsd: spent },
        });
      }
      const open = await deps.store.getOpen();
      if (open && open.id !== sessionId) {
        throw new DomainError({ code: "media_session_conflict", message: "Another session is already open on this device.", details: { openSessionId: open.id } });
      }
      const client = await deps.base.resolveRunpodClient(); // credentials must resolve
      const token = deps.generateToken();
      const sealed = await deps.base.sealSecret(token);

      const approved = await deps.store.transition(sessionId, ["pending"], {
        status: "approved",
        approvedAt: now,
        approvedByUserId: input.approvedByUserId ?? null,
        tokenCiphertext: sealed.ciphertext,
        tokenIv: sealed.iv,
        tokenAuthTag: sealed.authTag,
      });
      if (!approved) throw invalidState(sessionId, "pending", (await requireRow(sessionId)).status);

      onStage("Creating the pod");
      let pod: RunpodPod;
      const startedAt = deps.clock.now();
      try {
        pod = await client.createPod({
          name: `ytm-media-${sessionId.slice(0, 8)}`,
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
        await finish(approved, ["approved"], "failed", { error: `pod creation failed: ${message}` });
        throw new DomainError({ code: "media_session_start_failed", message: `Pod creation failed: ${message}`, details: { sessionId } });
      }
      const comfyUiProxyUrl = deps.comfyUiProxyBaseUrl(pod.id, COMFY_PROXY_PORT);
      const starting = await deps.store.transition(sessionId, ["approved"], {
        status: "starting",
        podId: pod.id,
        comfyUiProxyUrl,
        startedAt,
        costPerHr: pod.costPerHr ?? approved.costPerHr,
      });
      if (!starting) {
        // Swept or stopped meanwhile: never leave the pod behind.
        await terminateAndConfirm(client, pod.id);
        throw invalidState(sessionId, "approved", (await requireRow(sessionId)).status);
      }

      onStage("Waiting for the pod to run");
      const deadline = startedAt.getTime() + startTimeoutMs;
      const comfy = deps.createComfyClient({ baseUrl: comfyUiProxyUrl, token });
      let phase: "pod" | "comfy" = "pod";
      let lastDetail = "";
      for (;;) {
        if (phase === "pod") {
          const current = await client.getPod(pod.id);
          if (!current || current.status === "TERMINATED" || current.status === "EXITED" || current.status === "ERROR") {
            lastDetail = `pod ${current?.status ?? "gone"}`;
            break;
          }
          if (current.status === "RUNNING") {
            phase = "comfy";
            onStage("Waiting for ComfyUI to answer");
          }
        } else {
          try {
            await comfy.getSystemStats();
            const ready = deps.clock.now();
            const running = await deps.store.transition(sessionId, ["starting"], { status: "running", readyAt: ready, lastActivityAt: ready, error: null });
            if (!running) {
              await terminateAndConfirm(client, pod.id);
              throw invalidState(sessionId, "starting", (await requireRow(sessionId)).status);
            }
            return toPublicSession(running, ready);
          } catch (error) {
            if (error instanceof DomainError && error.code !== "comfyui_unavailable") throw error;
            lastDetail = error instanceof Error ? error.message : String(error);
          }
        }
        if (deps.clock.now().getTime() >= deadline) {
          lastDetail = `not ready after ${Math.round(startTimeoutMs / 60000)} min (${lastDetail || phase})`;
          break;
        }
        await deps.sleep(pollMs);
      }
      onStage("Terminating the pod");
      const result = await terminateAndConfirm(client, pod.id);
      const failed = await finish(starting, ["starting", "stopping"], "failed", {
        error: result.confirmed ? `start failed: ${lastDetail}` : `start failed: ${lastDetail}; pod still ${result.lastStatus} after terminate`,
      });
      throw new DomainError({ code: "media_session_start_failed", message: `The session could not start: ${lastDetail}.`, details: { sessionId, podId: pod.id, podTerminated: result.confirmed, status: failed?.status ?? null } });
    },

    /** Web-only (fenced): running|starting|stopping -> terminate -> done. */
    async stopSession(input: unknown): Promise<MediaSession> {
      const parsed = parseWithSchema(stopSessionInputSchema, input, "stop session");
      const row = await requireRow(parsed.sessionId);
      if (!["starting", "running", "stopping"].includes(row.status)) throw invalidState(parsed.sessionId, "starting|running|stopping", row.status);
      return toPublicSession(await stopRow(row, parsed.reason ?? "stopped by operator"), deps.clock.now());
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
     * maxUsd -> terminate; a pod found EXITED/gone -> interrupted; a session stuck `stopping` is retried.
     */
    async watchTick(): Promise<{ action: "none" | "stopped" | "interrupted" | "retried_stop"; sessionId: string | null; reason: string | null }> {
      const open = await deps.store.getOpen();
      if (!open) return { action: "none", sessionId: null, reason: null };
      const now = deps.clock.now();
      if (open.status === "stopping") {
        const stopped = await stopRow(open, open.stopReason ?? "stop retried by watcher");
        return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason: open.stopReason };
      }
      if (open.status !== "running") return { action: "none", sessionId: open.id, reason: null };

      const settings = await deps.base.getSettings();
      const client = await deps.base.resolveRunpodClient();
      const pod = open.podId ? await client.getPod(open.podId) : null;
      if (!pod || pod.status === "TERMINATED") {
        await finish(open, ["running"], "interrupted", { error: "pod disappeared" });
        return { action: "interrupted", sessionId: open.id, reason: "pod disappeared" };
      }
      if (pod.status === "EXITED" || pod.status === "ERROR") {
        await terminateAndConfirm(client, pod.id);
        await finish(open, ["running"], "interrupted", { error: `pod was ${pod.status}; terminated` });
        return { action: "interrupted", sessionId: open.id, reason: `pod ${pod.status}` };
      }

      const minutes = open.startedAt ? (now.getTime() - open.startedAt.getTime()) / 60_000 : 0;
      const idleMinutes = (now.getTime() - (open.lastActivityAt ?? open.readyAt ?? open.startedAt ?? now).getTime()) / 60_000;
      const usd = liveUsd(open, now) ?? 0;
      let reason: string | null = null;
      if (minutes >= open.maxMinutes) reason = `max minutes reached (${open.maxMinutes})`;
      else if (open.maxUsd !== null && usd >= open.maxUsd) reason = `max USD reached ($${open.maxUsd})`;
      else if (idleMinutes >= settings.idleMinutes) reason = `idle for ${Math.floor(idleMinutes)} min (limit ${settings.idleMinutes})`;
      if (!reason) return { action: "none", sessionId: open.id, reason: null };
      const stopped = await stopRow(open, reason);
      return { action: stopped.status === "stopping" ? "retried_stop" : "stopped", sessionId: open.id, reason };
    },

    /**
     * Boot (AC-P14-08): a session left non-terminal by a process that died is reconciled -- the pod
     * is terminated if it still exists -- and marked `interrupted` (a `pending` request is harmless
     * and stays). Quiet on a RunPod failure: the next tick/boot retries.
     */
    async bootSweep(): Promise<{ swept: string[] }> {
      const open = await deps.store.getOpen();
      if (!open || open.status === "pending") return { swept: [] };
      let error = "interrupted by a server restart";
      if (open.podId) {
        try {
          const client = await deps.base.resolveRunpodClient();
          const result = await terminateAndConfirm(client, open.podId);
          if (!result.confirmed) error += `; pod still ${result.lastStatus} after terminate`;
        } catch (cause) {
          error += `; pod ${open.podId} could not be reached (${cause instanceof Error ? cause.message : String(cause)})`;
        }
      }
      await finish(open, [...MEDIA_SESSION_NON_TERMINAL_STATUSES], "interrupted", { error });
      return { swept: [open.id] };
    },

    /** App exit (AC-P14-09): terminate the running pod first, bounded by the stop timeout; never throws. */
    async stopForShutdown(): Promise<{ stopped: string | null }> {
      try {
        const open = await deps.store.getOpen();
        if (!open || !["starting", "running", "stopping"].includes(open.status)) return { stopped: null };
        const stopped = await stopRow(open, "application shutdown");
        return { stopped: stopped.status === "stopping" ? null : open.id };
      } catch (error) {
        log(`[media] shutdown stop failed: ${error instanceof Error ? error.message : String(error)}`);
        return { stopped: null };
      }
    },
  };
}

export type MediaSessionServices = ReturnType<typeof createMediaSessionServices>;
