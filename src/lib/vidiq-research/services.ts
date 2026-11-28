import { createHash } from "node:crypto";
import type { DeviceSecretSlot } from "@/lib/device-secrets";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { pinnedCostsOf, type LiveCheckedCall, type VidiqBalance, type VidiqDriftReport, type VidiqGateway } from "@/lib/vidiq-gateway";
import {
  VIDIQ_BALANCE_MAX_AGE_MS,
  VIDIQ_DEFAULT_MONTHLY_BUDGET,
  VIDIQ_MAX_MONTHLY_BUDGET,
  VIDIQ_PENDING_STALE_MS,
  VIDIQ_RECENT_LEDGER_ROWS,
  type VidiqBalanceSnapshot,
  type VidiqBudgetView,
  type VidiqCaller,
  type VidiqCallResult,
  type VidiqKeyView,
  type VidiqLedgerRow,
  type VidiqStatusView,
  type VidiqStore,
} from "./contracts";
import { callInputSchema, parseInput, pollInputSchema, saveKeyInputSchema, updateSettingsInputSchema } from "./schemas";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077 decisions 3, 5 and 7, VIDIQ_INTEGRATION_PLAN.md §5 stage 1): the services. The call order of a vidIQ call, under
// one lock per process (the caller passes the lock; production keeps it on `globalThis`):
//   1 switch, 2 key, 3 allowlist and argument checks (no network; a job id must be one this ledger recorded), 4 cache (stage 2),
//   5 live drift check (and an earlier overcharge), 6 stated cost, 7 preflight (budget left in the period, then the account balance,
//   re-read free when older than 10 minutes), 8 a `pending` row at the stated cost, 9 the gateway call (the call step 5 passed,
//   never listed again), 10 the row updated with vidIQ's `_credits.used` and the outcome, 11 a free balance read recorded as
//   `balance_after` (it also settles an error vidIQ answered: an unchanged balance means it charged nothing).
// ADR 0077 amendment 1: `pending` rows older than 15 minutes (a process that ended mid-call) become `unknown` before the status or
// a call reads the ledger; an overcharge blocks its tool only until the owner acknowledges it (`vidiq_overcharge_ack_at`).
// A paid call is never retried. Logs carry fixed text and error codes only, never a key, an argument or a vidIQ answer.
// ---------------------------------------------------------------------------

export type VidiqSecretSlot = Pick<DeviceSecretSlot, "state" | "info" | "readWithVersion" | "write" | "clear" | "setStatus">;
export type VidiqGatewayPort = Pick<VidiqGateway, "checkStaticCall" | "checkLive" | "callChecked" | "balance" | "listToolsChecked">;

export type VidiqResearchDeps = {
  store: VidiqStore;
  secret: VidiqSecretSlot;
  gateway: VidiqGatewayPort;
  clock: { now(): Date };
  withLock: <T>(run: () => Promise<T>) => Promise<T>;
  log?: (line: string) => void;
};

/** A FIFO lock: one holder at a time. */
export function serialLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return function withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
}

const DRIFT_CODES = new Set(["vidiq_tool_not_allowed", "vidiq_tool_missing", "vidiq_schema_drift", "vidiq_args_invalid", "vidiq_cost_changed", "vidiq_annotation_drift", "vidiq_canonical_id_required", "vidiq_job_unknown"]);

/** Canonical JSON for the argument hash: sorted keys, null/undefined/empty strings and `userGoal` dropped. */
export function canonicalArgs(value: unknown, top = true): unknown {
  if (Array.isArray(value)) return value.map((v) => canonicalArgs(v, false));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === null || v === undefined || v === "" || (top && key === "userGoal")) continue;
      out[key] = canonicalArgs(v, false);
    }
    return out;
  }
  return value;
}

export function argsSha256(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(canonicalArgs(args ?? {})) ?? "null";
  } catch {
    text = "unserializable";
  }
  return createHash("sha256").update(text).digest("hex");
}

/** `date` plus `months` calendar months in UTC, the day clamped to the target month's length. */
function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const target = new Date(Date.UTC(y, m, 1, date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

export function createVidiqResearchServices(deps: VidiqResearchDeps) {
  const now = () => deps.clock.now();
  const log = (line: string) => deps.log?.(line);

  // ---- settings and the snapshot ------------------------------------------------------------------------------------------

  async function isEnabled(): Promise<boolean> {
    return (await deps.store.getSetting("vidiq_enabled")) === "true";
  }

  async function monthlyBudget(): Promise<number> {
    const stored = await deps.store.getSetting("vidiq_monthly_budget_credits");
    const value = stored === null ? NaN : Number(stored);
    return Number.isInteger(value) && value >= 0 && value <= VIDIQ_MAX_MONTHLY_BUDGET ? value : VIDIQ_DEFAULT_MONTHLY_BUDGET;
  }

  /** The stored snapshot when it was read with the key stored now; null otherwise. */
  async function snapshot(): Promise<VidiqBalanceSnapshot | null> {
    const raw = await deps.store.getSetting("vidiq_balance_snapshot");
    if (!raw) return null;
    let parsed: VidiqBalanceSnapshot;
    try {
      parsed = JSON.parse(raw) as VidiqBalanceSnapshot;
    } catch {
      return null;
    }
    if (typeof parsed?.totalCredits !== "number" || typeof parsed.renewableResetsAt !== "string" || typeof parsed.readAt !== "string") return null;
    const info = await deps.secret.info();
    return info && info.version === parsed.keyVersion ? parsed : null;
  }

  async function storeSnapshot(balance: VidiqBalance, keyVersion: string, readAt: Date): Promise<VidiqBalanceSnapshot> {
    const value: VidiqBalanceSnapshot = {
      type: balance.type,
      planName: balance.planName,
      totalCredits: balance.totalCredits,
      renewableCredits: balance.renewableCredits,
      maxRenewableCredits: balance.maxRenewableCredits,
      renewableResetsAt: balance.renewableResetsAt,
      addOnCredits: balance.addOnCredits,
      maxAddOnCredits: balance.maxAddOnCredits,
      readAt: readAt.toISOString(),
      keyVersion,
    };
    await deps.store.setSetting("vidiq_balance_snapshot", JSON.stringify(value));
    return value;
  }

  // ---- the period and the budget (Q5: vidIQ's own renewal cycle) ---------------------------------------------------------

  function periodOf(at: Date, snap: VidiqBalanceSnapshot | null): { start: Date; end: Date } {
    if (!snap) {
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
      return { start, end: new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)) };
    }
    let end = new Date(snap.renewableResetsAt);
    for (let i = 0; i < 120 && end.getTime() <= at.getTime(); i++) end = addMonthsUtc(end, 1);
    let start = addMonthsUtc(end, -1);
    for (let i = 0; i < 120 && start.getTime() > at.getTime(); i++) {
      end = start;
      start = addMonthsUtc(end, -1);
    }
    return { start, end };
  }

  /** Every row of the period counts vidIQ's `_credits.used` where known, its stated cost where not yet known. */
  async function budgetView(at: Date = now()): Promise<VidiqBudgetView> {
    const { start, end } = periodOf(at, await snapshot());
    const rows = await deps.store.listLedger({ limit: 1_000_000, since: start, now: at });
    const spent = rows.filter((r) => r.at.getTime() < end.getTime()).reduce((sum, r) => sum + (r.creditsUsed ?? r.statedCost), 0);
    const monthly = await monthlyBudget();
    return { monthly, spentInPeriod: spent, remaining: monthly - spent, periodStartsAt: start.toISOString(), periodEndsAt: end.toISOString() };
  }

  /** When the owner last acknowledged the recorded overcharges (ms), or null. */
  async function overchargeAckAt(): Promise<number | null> {
    const raw = await deps.store.getSetting("vidiq_overcharge_ack_at");
    const at = raw === null ? NaN : Date.parse(raw);
    return Number.isNaN(at) ? null : at;
  }

  /**
   * Tools whose recorded charge exceeded the current pin after the owner's last acknowledgement (ADR 0077 decision 5 "until the
   * pin is reviewed", amendment 1: the owner's review clears it; a later overcharge blocks again).
   */
  async function overchargedTools(at: Date): Promise<Set<string>> {
    const [rows, ackAt] = await Promise.all([deps.store.listLedger({ limit: 1_000_000, now: at }), overchargeAckAt()]);
    return new Set(
      rows
        .filter((r) => (ackAt === null || r.at.getTime() > ackAt) && r.creditsUsed !== null && r.creditsUsed > r.statedCost && pinnedCostsOf(r.tool).includes(r.statedCost))
        .map((r) => r.tool)
    );
  }

  /** A process that ended mid-call leaves a `pending` row: after 15 minutes it is `unknown` (still counted at its stated cost). */
  async function expireStalePending(at: Date): Promise<void> {
    await deps.store.expireStalePending(new Date(at.getTime() - VIDIQ_PENDING_STALE_MS));
  }

  // ---- the key ------------------------------------------------------------------------------------------------------------

  async function keyView(): Promise<VidiqKeyView> {
    const [state, info] = await Promise.all([deps.secret.state(), deps.secret.info()]);
    if (!info) return { state, hint: null, status: null, verifiedAt: null };
    const status = info.status === "ok" || info.status === "invalid" ? info.status : null;
    return { state, hint: info.hints.keyHint ?? null, status, verifiedAt: info.verifiedAt ? new Date(info.verifiedAt).toISOString() : null };
  }

  async function readKey(): Promise<{ value: string; version: string } | null> {
    try {
      return await deps.secret.readWithVersion();
    } catch (error) {
      if (isDomainError(error) && (error.code === "device_secret_unreadable" || error.code === "encryption_key_not_configured")) {
        throw new DomainError({ code: "encryption_key_not_configured", message: "The stored vidIQ API key cannot be read on this computer; enter it again (Settings → Cloud APIs)." });
      }
      throw error;
    }
  }

  /** Steps 1 and 2: the switch, then the key. */
  async function requireOnAndKey(): Promise<{ value: string; version: string }> {
    if (!(await isEnabled())) throw new DomainError({ code: "vidiq_disabled", message: "vidIQ is turned off on this computer (Settings → Cloud APIs)." });
    const key = await readKey();
    if (!key) throw new DomainError({ code: "vidiq_key_missing", message: "No vidIQ API key is stored on this computer (Settings → Cloud APIs)." });
    return key;
  }

  async function markKeyRefused(version: string): Promise<void> {
    await deps.secret.setStatus(version, { status: "invalid", verifiedAt: now().getTime() }).catch(() => false);
  }

  // ---- the ledger ---------------------------------------------------------------------------------------------------------

  async function record(row: Omit<VidiqLedgerRow, "id">): Promise<number> {
    return deps.store.insertLedger(row);
  }

  const toolName = (tool: unknown) => (typeof tool === "string" && tool.length > 0 ? tool.slice(0, 100) : "(invalid)");

  async function refused(caller: VidiqCaller, tool: unknown, args: unknown, statedCost: number, error: DomainError): Promise<never> {
    await record({ at: now(), caller, tool: toolName(tool), argsSha256: argsSha256(args), statedCost, creditsUsed: 0, outcome: "refused", errorCode: error.code, jobId: null, balanceAfter: null });
    throw error;
  }

  /** A free balance read for the key, stored as the snapshot. */
  async function readBalance(key: { value: string; version: string }): Promise<VidiqBalanceSnapshot> {
    const started = now();
    try {
      return await storeSnapshot(await deps.gateway.balance(key.value), key.version, started);
    } catch (error) {
      if (isDomainError(error) && error.code === "vidiq_key_invalid") await markKeyRefused(key.version);
      throw error;
    }
  }

  async function status(): Promise<VidiqStatusView> {
    const at = now();
    await expireStalePending(at);
    const snap = await snapshot();
    const rows = await deps.store.listLedger({ limit: VIDIQ_RECENT_LEDGER_ROWS, now: at });
    let balance: VidiqStatusView["balance"] = null;
    if (snap) {
      const { keyVersion: _omit, ...rest } = snap;
      void _omit;
      balance = rest;
    }
    return {
      key: await keyView(),
      enabled: await isEnabled(),
      balance,
      budget: await budgetView(at),
      ledger: rows.map((r) => ({ ...r, at: r.at.toISOString() })),
      overchargedTools: [...(await overchargedTools(at))].sort(),
    };
  }

  /**
   * After vidIQ ANSWERED a paid call with an error: one free balance read. The same total and the same renewal date as the snapshot
   * read just before the call means vidIQ charged nothing, so the row counts 0; anything else keeps the stated cost (another client
   * may have spent meanwhile). A timeout is never settled this way: its charge can land after the read.
   */
  async function settleAnsweredError(key: { value: string; version: string }, rowId: number, before: VidiqBalanceSnapshot): Promise<void> {
    try {
      const after = await readBalance(key);
      const unchanged = after.totalCredits === before.totalCredits && after.renewableResetsAt === before.renewableResetsAt;
      await deps.store.updateLedger(rowId, { balanceAfter: after.totalCredits, ...(unchanged ? { creditsUsed: 0 } : {}) });
    } catch (error) {
      log(`[vidiq-research] the balance after an answered error could not be read (${isDomainError(error) ? error.code : "unexpected error"})`);
    }
  }

  /** Steps 1-11 for one call (inside the lock). */
  async function runCall(caller: VidiqCaller, tool: string, args: unknown): Promise<VidiqCallResult> {
    const key = await requireOnAndKey();
    // 3: allowlist and arguments (no network).
    let checked;
    try {
      checked = deps.gateway.checkStaticCall(tool, args);
    } catch (error) {
      if (isDomainError(error)) return refused(caller, tool, args, 0, error);
      throw error;
    }
    if (checked.tool === "vidiq_job_poll" && !(await deps.store.hasPendingJob(String(checked.args.mcpJobId)))) {
      return refused(caller, tool, args, 0, new DomainError({ code: "vidiq_job_unknown", message: "This job id was not started by a call recorded on this computer." }));
    }
    // 4: the cache arrives in stage 2.
    const at = now();
    await expireStalePending(at);
    if ((await overchargedTools(at)).has(checked.tool)) {
      return refused(caller, tool, args, checked.pinnedCost, new DomainError({ code: "vidiq_cost_changed", message: "vidIQ charged more than the pinned cost for this tool; YTM refuses it until the contract is reviewed.", details: { tool: checked.tool } }));
    }
    // 5 + 6: live drift check; the stated cost.
    let live: LiveCheckedCall;
    try {
      live = await deps.gateway.checkLive(key.value, tool, args);
    } catch (error) {
      if (!isDomainError(error)) throw error;
      if (error.code === "vidiq_key_invalid") await markKeyRefused(key.version);
      if (DRIFT_CODES.has(error.code)) return refused(caller, tool, args, checked.pinnedCost, error);
      await record({ at, caller, tool: checked.tool, argsSha256: argsSha256(args), statedCost: checked.pinnedCost, creditsUsed: 0, outcome: "failed", errorCode: error.code, jobId: null, balanceAfter: null });
      throw error;
    }
    const statedCost = live.statedCost;
    // 7: preflight.
    const budget = await budgetView(at);
    if (statedCost > budget.remaining) {
      return refused(caller, tool, args, statedCost, new DomainError({
        code: "vidiq_budget_exhausted",
        message: "This call would exceed the vidIQ credits budget left in this period (Settings → Cloud APIs).",
        details: { statedCost, remainingBudget: Math.max(0, budget.remaining), periodEndsAt: budget.periodEndsAt },
      }));
    }
    let before: VidiqBalanceSnapshot | null = null;
    if (statedCost > 0) {
      let snap = await snapshot();
      if (!snap || at.getTime() - Date.parse(snap.readAt) > VIDIQ_BALANCE_MAX_AGE_MS) snap = await readBalance(key);
      before = snap;
      if (statedCost > snap.totalCredits) {
        return refused(caller, tool, args, statedCost, new DomainError({
          code: "vidiq_insufficient_credits",
          message: "The vidIQ account has fewer credits left than this call costs.",
          details: { statedCost, totalCredits: snap.totalCredits },
        }));
      }
    }
    // 8: the reservation.
    const rowId = await record({ at, caller, tool: checked.tool, argsSha256: argsSha256(args), statedCost, creditsUsed: null, outcome: "pending", errorCode: null, jobId: null, balanceAfter: null });
    // 9 + 10: the call and its outcome.
    let outcome;
    try {
      outcome = await deps.gateway.callChecked(key.value, live);
    } catch (error) {
      if (!isDomainError(error)) {
        await deps.store.updateLedger(rowId, { outcome: "unknown", errorCode: "vidiq_unavailable" });
        throw error;
      }
      const details = (error.details ?? {}) as { requestSent?: boolean; creditsUsed?: number | null };
      if (error.code === "vidiq_key_invalid") await markKeyRefused(key.version);
      if (error.code === "vidiq_result_too_large") {
        await deps.store.updateLedger(rowId, { outcome: "failed", errorCode: error.code, creditsUsed: typeof details.creditsUsed === "number" ? details.creditsUsed : null });
      } else if (DRIFT_CODES.has(error.code)) {
        await deps.store.updateLedger(rowId, { outcome: "refused", errorCode: error.code, creditsUsed: 0 });
      } else if (error.code === "vidiq_answered_error") {
        // vidIQ answered with an error: counted at the stated cost unless its own balance shows it charged nothing.
        await deps.store.updateLedger(rowId, { outcome: "failed", errorCode: error.code, creditsUsed: null });
        if (before) await settleAnsweredError(key, rowId, before);
      } else if (details.requestSent === true && error.code !== "vidiq_key_invalid" && error.code !== "vidiq_rate_limited") {
        // The call left and no usable answer came back: counted at the stated cost until vidIQ's own numbers say otherwise.
        await deps.store.updateLedger(rowId, { outcome: "unknown", errorCode: error.code, creditsUsed: null });
      } else {
        await deps.store.updateLedger(rowId, { outcome: "failed", errorCode: error.code, creditsUsed: 0 });
      }
      throw error;
    }
    const body = (outcome.result.structuredContent ?? null) as Record<string, unknown> | null;
    const job =
      checked.tool === "vidiq_comment_insights" && !outcome.isError && body && typeof body.mcpJobId === "string" && body.mcpJobId.length > 0
        ? { mcpJobId: body.mcpJobId.slice(0, 128), status: typeof body.status === "string" ? body.status.slice(0, 40) : "inprogress" }
        : null;
    await deps.store.updateLedger(rowId, {
      outcome: outcome.isError ? "failed" : job ? "job_pending" : "ok",
      errorCode: outcome.isError ? "vidiq_tool_error" : null,
      creditsUsed: outcome.creditsUsed,
      jobId: job?.mcpJobId ?? null,
    });
    // 11: the balance afterwards (free; a failure is logged and the call's answer still returned).
    let balance: VidiqCallResult["balance"] = null;
    if (statedCost > 0 || (outcome.creditsUsed ?? 0) > 0) {
      try {
        const snap = await readBalance(key);
        balance = { totalCredits: snap.totalCredits, renewableResetsAt: snap.renewableResetsAt };
        await deps.store.updateLedger(rowId, { balanceAfter: snap.totalCredits });
      } catch (error) {
        log(`[vidiq-research] the balance after a call could not be read (${isDomainError(error) ? error.code : "unexpected error"})`);
      }
    }
    return {
      tool: checked.tool,
      statedCost,
      creditsSpent: outcome.creditsUsed ?? statedCost,
      isError: outcome.isError,
      result: outcome.result,
      job,
      balance,
      budget: await budgetView(now()),
    };
  }

  return {
    getStatus: () => status(),

    /**
     * Verifies the key with the free balance read, then stores it (a refused key is never stored). The first verified save (the slot
     * going from none to set) turns the module on (plan Q6); replacing a key keeps the switch as the owner left it.
     */
    saveKey: (raw: unknown) =>
      deps.withLock(async () => {
        const { apiKey } = parseInput(saveKeyInputSchema, raw, "vidIQ API key");
        const first = (await deps.secret.info()) === null;
        const started = now();
        let balance: VidiqBalance;
        try {
          balance = await deps.gateway.balance(apiKey);
        } catch (error) {
          if (isDomainError(error)) {
            await record({ at: started, caller: "owner", tool: "vidiq_balance", argsSha256: argsSha256({}), statedCost: 0, creditsUsed: 0, outcome: "failed", errorCode: error.code, jobId: null, balanceAfter: null });
          }
          throw error;
        }
        const info = await deps.secret.write(apiKey, { hints: { keyHint: apiKey.slice(-4) }, status: "ok", verifiedAt: started.getTime() });
        await storeSnapshot(balance, info.version, started);
        await record({ at: started, caller: "owner", tool: "vidiq_balance", argsSha256: argsSha256({}), statedCost: 0, creditsUsed: balance.creditsUsed, outcome: "ok", errorCode: null, jobId: null, balanceAfter: balance.totalCredits });
        if (first) await deps.store.setSetting("vidiq_enabled", "true");
        return status();
      }),

    /** Removes the key; the switch goes off and the balance snapshot (it belonged to that key) is dropped. */
    clearKey: () =>
      deps.withLock(async () => {
        await deps.secret.clear();
        await deps.store.setSetting("vidiq_enabled", null);
        await deps.store.setSetting("vidiq_balance_snapshot", null);
        return status();
      }),

    /** The switch (on only with a saved key) and the monthly budget (integer 0-100 000). */
    updateSettings: (raw: unknown) =>
      deps.withLock(async () => {
        const input = parseInput(updateSettingsInputSchema, raw, "vidIQ settings");
        if (input.enabled === true && (await deps.secret.state()) !== "set") {
          throw new DomainError({ code: "vidiq_key_missing", message: "Save a vidIQ API key first; the module can be on only with a key." });
        }
        if (input.enabled !== undefined) await deps.store.setSetting("vidiq_enabled", input.enabled ? "true" : null);
        if (input.monthlyBudgetCredits !== undefined) await deps.store.setSetting("vidiq_monthly_budget_credits", String(input.monthlyBudgetCredits));
        return status();
      }),

    /** The owner's «Обновить»: a free balance read. */
    refreshBalance: () =>
      deps.withLock(async () => {
        const key = await requireOnAndKey();
        const started = now();
        try {
          const snap = await readBalance(key);
          await deps.secret.setStatus(key.version, { status: "ok", verifiedAt: started.getTime() }).catch(() => false);
          await record({ at: started, caller: "owner", tool: "vidiq_balance", argsSha256: argsSha256({}), statedCost: 0, creditsUsed: 0, outcome: "ok", errorCode: null, jobId: null, balanceAfter: snap.totalCredits });
        } catch (error) {
          if (isDomainError(error)) await record({ at: started, caller: "owner", tool: "vidiq_balance", argsSha256: argsSha256({}), statedCost: 0, creditsUsed: 0, outcome: "failed", errorCode: error.code, jobId: null, balanceAfter: null });
          throw error;
        }
        return status();
      }),

    /**
     * The owner's acknowledgement of the recorded overcharges (ADR 0077 amendment 1): from now on they no longer block their tools;
     * the ledger rows stay and still count. A later overcharge blocks its tool again. Local only, nothing is sent.
     */
    acknowledgeOvercharges: () =>
      deps.withLock(async () => {
        await deps.store.setSetting("vidiq_overcharge_ack_at", now().toISOString());
        return status();
      }),

    /** «Проверить подключение»: the free `tools/list` drift report, 18 rows (an overcharged tool shows as cost changed). */
    checkConnection: (input: { refresh?: boolean } = { refresh: true }): Promise<VidiqDriftReport> =>
      deps.withLock(async () => {
        const key = await requireOnAndKey();
        let report: VidiqDriftReport;
        try {
          report = await deps.gateway.listToolsChecked(key.value, { refresh: input.refresh !== false });
        } catch (error) {
          if (isDomainError(error) && error.code === "vidiq_key_invalid") await markKeyRefused(key.version);
          throw error;
        }
        const overcharged = await overchargedTools(now());
        return { readAt: report.readAt, report: report.report.map((row) => (row.state === "ok" && overcharged.has(row.tool) ? { ...row, state: "vidiq_cost_changed" as const } : row)) };
      }),

    /** One vidIQ call by the owner or the Producer, through the whole call order. */
    callTool: (raw: { caller: VidiqCaller; tool: string; args?: unknown }) =>
      deps.withLock(async () => {
        const input = parseInput(callInputSchema, raw, "vidIQ call");
        return runCall(input.caller, input.tool, input.args);
      }),

    /** `vidiq_job_poll` for a job this computer's ledger started (free). */
    pollJob: (raw: { caller: VidiqCaller; mcpJobId: string }) =>
      deps.withLock(async () => {
        const input = parseInput(pollInputSchema, raw, "vidIQ job poll");
        return runCall(input.caller, "vidiq_job_poll", { mcpJobId: input.mcpJobId });
      }),
  };
}

export type VidiqResearchServices = ReturnType<typeof createVidiqResearchServices>;
