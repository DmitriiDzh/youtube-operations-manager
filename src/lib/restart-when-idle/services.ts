import { DomainError } from "@/lib/shared-domain";
import {
  RESTART_HOLD_MINUTES_MAX,
  RESTART_HOLD_MINUTES_MIN,
  RESTART_HOLD_REASON_MAX,
  RESTART_QUIET_MINUTES_DEFAULT,
  RESTART_QUIET_MINUTES_MAX,
  RESTART_QUIET_MINUTES_MIN,
  RESTART_REQUEST_MAX_AGE_MS,
  type RestartBusyReaders,
  type RestartHoldOwner,
  type RestartHoldRow,
  type RestartHoldView,
  type RestartRequester,
  type RestartRequestRow,
  type RestartRequestView,
  type RestartStatus,
  type RestartWaitingKind,
  type RestartWaitingReason,
  type RestartWhenIdleDependencies,
} from "./contracts";

// BL-220 (docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md, ADR 0049): the pure services. Everything outside -- the database, the
// busy readers, the request file, the clock, the stop signal -- is injected (src/lib/restart-when-idle/index.ts wires it).

const MAX_IDS = 5;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Review (BL-220): active holds one holder may keep at once. */
export const RESTART_HOLDS_PER_HOLDER = 3;

/** A `restarting` request this old whose process still answers did not restart; the owner may cancel it. */
export const RESTART_STUCK_MS = 5 * 60_000;

export function requestView(row: RestartRequestRow): RestartRequestView {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: new Date(row.requestedAt).toISOString(),
    restartingAt: iso(row.restartingAt),
    finishedAt: iso(row.finishedAt),
    waitedMinutes: row.waitedMinutes,
    fromVersion: row.fromVersion,
    fromSchema: row.fromSchema,
    toVersion: row.toVersion,
    toSchema: row.toSchema,
  };
}

export function holdView(row: RestartHoldRow, now: number): RestartHoldView {
  return {
    holdId: row.id,
    heldBy: row.heldBy,
    reason: row.reason,
    createdAt: new Date(row.createdAt).toISOString(),
    until: new Date(row.until).toISOString(),
    releasedAt: iso(row.releasedAt),
    releasedBy: row.releasedBy,
    active: row.releasedAt === null && row.until > now,
  };
}

/** A hold's owner as given by a caller: `factory`, `owner` or `worker:<channelId>`; anything else is refused. */
export function isRestartHoldOwner(value: unknown): value is RestartHoldOwner {
  return value === "factory" || value === "owner" || (typeof value === "string" && /^worker:[A-Za-z0-9_-]{1,64}$/.test(value));
}

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ code: "validation_failed", message, details });
}

/** The developer script's file: `{ requestedBy: "developer", at: <ISO time> }`; anything else is malformed (AC-RI-09). */
export function parseRequestFile(text: string): { ok: true; at: number } | { ok: false; problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, problem: "not an object" };
  const fields = parsed as Record<string, unknown>;
  if (fields.requestedBy !== "developer") return { ok: false, problem: "requestedBy is not \"developer\"" };
  const at = typeof fields.at === "string" ? Date.parse(fields.at) : Number.NaN;
  if (!Number.isFinite(at)) return { ok: false, problem: "at is not a time" };
  return { ok: true, at };
}

export function createRestartWhenIdle(deps: RestartWhenIdleDependencies) {
  // The DB state `restarting` is the real guard (the next check finds no open request); this is the second one, per process.
  let stopSent = false;
  let ticking: Promise<void> | null = null;
  let lastLoggedWaiting: string | null = null;

  async function quietMinutes(): Promise<number> {
    const stored = await deps.store.getQuietMinutes();
    return stored !== null && Number.isInteger(stored) && stored >= RESTART_QUIET_MINUTES_MIN && stored <= RESTART_QUIET_MINUTES_MAX
      ? stored
      : RESTART_QUIET_MINUTES_DEFAULT;
  }

  /** A request open for 24 h becomes `expired` (AC-RI-05); returns the requests still open. */
  async function expireDue(now: number): Promise<RestartRequestRow[]> {
    const open = await deps.store.listRequests(["open"]);
    const still: RestartRequestRow[] = [];
    for (const row of open) {
      if (now - row.requestedAt >= RESTART_REQUEST_MAX_AGE_MS) {
        if (await deps.store.updateRequest(row.id, "open", { status: "expired", finishedAt: now })) {
          deps.log("restart_when_idle.expired", { requestId: row.id, requestedBy: row.requestedBy });
        }
      } else still.push(row);
    }
    return still;
  }

  /** Every reason the restart must wait now (AC-RI-01). A reader that fails keeps it waiting (`check_failed`). */
  async function waitingFor(now: number): Promise<RestartWaitingReason[]> {
    const reasons: RestartWaitingReason[] = [];
    const failed: string[] = [];
    const add = (kind: RestartWaitingKind, ids: string[], until: string | null = null) => {
      if (ids.length > 0) reasons.push({ kind, count: ids.length, ids: ids.slice(0, MAX_IDS), until });
    };
    const read = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn();
      } catch {
        failed.push(name);
        return undefined;
      }
    };
    const lists: Array<[RestartWaitingKind, keyof RestartBusyReaders]> = [
      ["media_session", "mediaSessions"],
      ["media_job", "mediaJobs"],
      ["gemini_job", "geminiJobs"],
      ["elevenlabs_job", "elevenlabsJobs"],
      ["upload", "uploads"],
      ["live_stream", "liveStreams"],
      ["operation", "operations"],
      ["batch", "batches"],
    ];
    for (const [kind, reader] of lists) {
      const ids = await read(reader, () => deps.readers[reader]() as Promise<string[]>);
      if (ids) add(kind, ids);
    }
    const lock = await read("operationLock", () => deps.readers.operationLock());
    if (lock) add("operation_lock", [lock]);
    const holds = await read("holds", () => deps.store.listActiveHolds(now));
    if (holds && holds.length > 0) add("hold", holds.map((hold) => hold.id), new Date(Math.max(...holds.map((hold) => hold.until))).toISOString());
    const quiet = await read("quietMinutes", () => quietMinutes());
    const last = await read("lastMcpCallAt", () => deps.readers.lastMcpCallAt());
    if (quiet !== undefined && last !== undefined && last !== null && now - last < quiet * 60_000) {
      add("mcp_quiet", ["mcp"], new Date(last + quiet * 60_000).toISOString());
    }
    add("check_failed", [...new Set(failed)]);
    return reasons;
  }

  async function activeHolds(now: number): Promise<RestartHoldView[]> {
    return (await deps.store.listActiveHolds(now)).map((row) => holdView(row, now));
  }

  async function createRequest(by: RestartRequester, now: number): Promise<{ request: RestartRequestView; joined: boolean }> {
    if (!deps.serviceMode()) {
      throw new DomainError({ code: "restart_needs_service", message: "Only the macOS system service (YTOM_SERVICE_MODE=1) can restart itself", details: { requestedBy: by } });
    }
    const open = await expireDue(now);
    const existing = open[0] ?? (await deps.store.listRequests(["restarting"]))[0];
    // One request at a time: a second one joins the first.
    if (existing) return { request: requestView(existing), joined: true };
    const row: RestartRequestRow = {
      id: deps.newId(),
      status: "open",
      requestedBy: by,
      requestedAt: now,
      restartingAt: null,
      finishedAt: null,
      fromVersion: null,
      fromSchema: null,
      toVersion: null,
      toSchema: null,
      waitedMinutes: null,
    };
    try {
      await deps.store.insertRequest(row);
    } catch (error) {
      // Another request was opened at the same moment (the one-open index refused this one): join it.
      const raced = (await deps.store.listRequests(["open"]))[0];
      if (raced) return { request: requestView(raced), joined: true };
      throw error;
    }
    deps.log("restart_when_idle.requested", { requestId: row.id, requestedBy: by });
    return { request: requestView(row), joined: false };
  }

  /** The developer's file: taken once and removed (the adapter removes it before answering); a malformed one is only logged. */
  async function pickUpRequestFile(now: number): Promise<void> {
    let text: string | null;
    try {
      text = await deps.takeRequestFile();
    } catch (error) {
      deps.log("restart_when_idle.request_file_unreadable", { message: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (text === null) return;
    const parsed = parseRequestFile(text);
    if (!parsed.ok) {
      deps.log("restart_when_idle.request_file_malformed", { problem: parsed.problem });
      return;
    }
    try {
      await createRequest("developer", now);
    } catch (error) {
      deps.log("restart_when_idle.request_file_refused", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function tickOnce(): Promise<void> {
    const now = deps.clock();
    await pickUpRequestFile(now);
    const open = await expireDue(now);
    const request = open[0];
    if (!request || !deps.serviceMode() || stopSent) return;
    const reasons = await waitingFor(now);
    if (reasons.length > 0) {
      const summary = JSON.stringify(reasons.map((reason) => [reason.kind, reason.count]));
      if (summary !== lastLoggedWaiting) {
        lastLoggedWaiting = summary;
        deps.log("restart_when_idle.waiting", { requestId: request.id, waitingFor: reasons.map((reason) => ({ kind: reason.kind, count: reason.count, ids: reason.ids })) });
      }
      return;
    }
    const build = deps.build();
    const waitedMinutes = Math.floor((now - request.requestedAt) / 60_000);
    const moved = await deps.store.updateRequest(request.id, "open", {
      status: "restarting",
      restartingAt: now,
      fromVersion: build.version,
      fromSchema: build.schema,
      waitedMinutes,
    });
    if (!moved || stopSent) return;
    stopSent = true;
    deps.log("restart_when_idle.restarting", { requestId: request.id, requestedBy: request.requestedBy, version: build.version, schema: build.schema, waitedMinutes });
    deps.stop();
  }

  return {
    /** `{ request, waitingFor, holds, lastRestart, quietMinutes, serviceMode }` -- works on every computer (AC-RI-07). */
    async status(): Promise<RestartStatus> {
      const now = deps.clock();
      // Read-only (a GET passes no mutation gate): a request past 24 h is not shown; the next check or request marks it expired.
      const open = (await deps.store.listRequests(["open"])).filter((row) => now - row.requestedAt < RESTART_REQUEST_MAX_AGE_MS);
      const current = open[0] ?? (await deps.store.listRequests(["restarting"]))[0] ?? null;
      const last = await deps.store.lastDone();
      return {
        request: current ? requestView(current) : null,
        waitingFor: await waitingFor(now),
        holds: await activeHolds(now),
        lastRestart: last ? requestView(last) : null,
        quietMinutes: await quietMinutes(),
        serviceMode: deps.serviceMode(),
      };
    },

    /** Opens a request, or joins the open one. Refused outside the system service (AC-RI-07). */
    async request(by: RestartRequester): Promise<{ request: RestartRequestView; joined: boolean }> {
      return createRequest(by, deps.clock());
    },

    /**
     * The owner cancels the open request (AC-RI-05); `not_found` when there is none. Also a request stuck in `restarting`: the stop
     * was sent at least {@link RESTART_STUCK_MS} ago and this process is still answering, so the restart did not happen (a stop can
     * hang, e.g. on a connection the browser keeps open) -- cancelling it lets a new request be made.
     */
    async cancel(): Promise<{ request: RestartRequestView }> {
      const now = deps.clock();
      const open = await expireDue(now);
      const stuck = open.length === 0 ? (await deps.store.listRequests(["restarting"])).find((r) => r.restartingAt !== null && now - r.restartingAt >= RESTART_STUCK_MS) : undefined;
      const row = open[0] ?? stuck;
      if (!row || !(await deps.store.updateRequest(row.id, row.status, { status: "cancelled", finishedAt: now }))) {
        throw new DomainError({ code: "not_found", message: "No restart request is open" });
      }
      if (row === stuck) stopSent = false; // this process did not stop: a later request may send the stop again
      deps.log("restart_when_idle.cancelled", { requestId: row.id, stuck: row === stuck });
      return { request: requestView({ ...row, status: "cancelled", finishedAt: now }) };
    },

    /** A hold of 1-60 minutes with a reason (AC-RI-03). */
    async hold(input: { heldBy: RestartHoldOwner; minutes: unknown; reason: unknown }): Promise<{ hold: RestartHoldView }> {
      const { minutes } = input;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < RESTART_HOLD_MINUTES_MIN || minutes > RESTART_HOLD_MINUTES_MAX) {
        throw invalid(`minutes must be a whole number from ${RESTART_HOLD_MINUTES_MIN} to ${RESTART_HOLD_MINUTES_MAX}`, { field: "minutes" });
      }
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (reason.length === 0 || reason.length > RESTART_HOLD_REASON_MAX) {
        throw invalid(`reason is required (1-${RESTART_HOLD_REASON_MAX} characters)`, { field: "reason" });
      }
      if (!isRestartHoldOwner(input.heldBy)) throw invalid("unknown hold owner", { field: "heldBy" });
      const now = deps.clock();
      // Review (BL-220): a holder keeps at most RESTART_HOLDS_PER_HOLDER active holds, so a loop cannot stack them.
      const mine = (await deps.store.listActiveHolds(now)).filter((hold) => hold.heldBy === input.heldBy);
      if (mine.length >= RESTART_HOLDS_PER_HOLDER) {
        throw invalid(`at most ${RESTART_HOLDS_PER_HOLDER} active holds per holder: release one first`, { field: "holds", active: mine.length });
      }
      const row: RestartHoldRow = { id: deps.newId(), heldBy: input.heldBy, reason, createdAt: now, until: now + minutes * 60_000, releasedAt: null, releasedBy: null };
      await deps.store.insertHold(row);
      deps.log("restart_when_idle.hold_set", { holdId: row.id, heldBy: row.heldBy, minutes });
      return { hold: holdView(row, now) };
    },

    /** Ends a hold early (AC-RI-04): a worker or the Operator only its own (`not_found` otherwise), the owner any. */
    async releaseHold(input: { holdId: unknown; by: RestartHoldOwner }): Promise<{ hold: RestartHoldView; released: boolean }> {
      const holdId = typeof input.holdId === "string" ? input.holdId : "";
      if (holdId.length === 0 || holdId.length > 64) throw invalid("holdId is required", { field: "holdId" });
      const row = await deps.store.getHold(holdId);
      if (!row || (input.by !== "owner" && row.heldBy !== input.by)) {
        throw new DomainError({ code: "not_found", message: "No such hold", details: { holdId } });
      }
      const now = deps.clock();
      const released = row.releasedAt === null && row.until > now && (await deps.store.releaseHold(row.id, input.by, now));
      if (released) deps.log("restart_when_idle.hold_released", { holdId: row.id, heldBy: row.heldBy, by: input.by });
      return { hold: holdView(released ? { ...row, releasedAt: now, releasedBy: input.by } : row, now), released };
    },

    async getQuietMinutes(): Promise<number> {
      return quietMinutes();
    },

    /** 1-30 minutes (AC-RI-08); applies at the next check. */
    async setQuietMinutes(minutes: unknown): Promise<{ quietMinutes: number }> {
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < RESTART_QUIET_MINUTES_MIN || minutes > RESTART_QUIET_MINUTES_MAX) {
        throw invalid(`quietMinutes must be a whole number from ${RESTART_QUIET_MINUTES_MIN} to ${RESTART_QUIET_MINUTES_MAX}`, { field: "quietMinutes" });
      }
      await deps.store.setQuietMinutes(minutes);
      return { quietMinutes: minutes };
    },

    /** One check (every 15 s under the system service): the request file, the 24 h expiry, then the restart when nothing waits. */
    async tick(): Promise<void> {
      if (!ticking) {
        ticking = tickOnce().finally(() => {
          ticking = null;
        });
      }
      return ticking;
    },

    /**
     * On boot (AC-RI-06): a request left `restarting` becomes `done` with the running version and schema. An `open` one becomes `done`
     * too -- the server has just started again, which is what it asked for -- and so does a request file written before this start.
     */
    async finalizeBoot(): Promise<{ finished: string[] }> {
      const now = deps.clock();
      const build = deps.build();
      const finished: string[] = [];
      for (const row of await deps.store.listRequests(["restarting", "open"])) {
        const waitedMinutes = row.waitedMinutes ?? Math.floor((now - row.requestedAt) / 60_000);
        if (await deps.store.updateRequest(row.id, row.status, { status: "done", finishedAt: now, toVersion: build.version, toSchema: build.schema, waitedMinutes })) {
          finished.push(row.id);
          deps.log("restart_when_idle.done", { requestId: row.id, from: row.status, version: build.version, schema: build.schema });
        }
      }
      let text: string | null = null;
      try {
        text = await deps.takeRequestFile();
      } catch {
        // Unreadable now: the first check tries again.
      }
      if (text !== null) {
        const parsed = parseRequestFile(text);
        if (!parsed.ok) deps.log("restart_when_idle.request_file_malformed", { problem: parsed.problem });
        else if (parsed.at <= now) deps.log("restart_when_idle.request_file_satisfied_by_boot", { at: new Date(parsed.at).toISOString() });
        else await createRequest("developer", now).catch((error: unknown) => deps.log("restart_when_idle.request_file_refused", { message: error instanceof Error ? error.message : String(error) }));
      }
      return { finished };
    },
  };
}

export type RestartWhenIdle = ReturnType<typeof createRestartWhenIdle>;
