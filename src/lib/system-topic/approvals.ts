import { z } from "zod";
import { DomainError } from "@/lib/shared-domain";
import type { SystemApprovalCommands, SystemCommandStatus, SystemTopicState } from "./contracts";
import { SYSTEM_REQUEST_ID_PATTERN } from "./parser";
import { sha256Hex } from "./services";

// BL-228 (SYSTEM_TOPIC_PLAN.md §5 as amended, ADR 0053 Amendment 1; FO-RESP-0043 H4/Q5/Q6, owner msg 3607): one-time paid-call
// approvals. An agent writes `<requests>/<id>.json`; the scan posts it once (through the outbox) with the Manager's OWN estimate and
// the request hash; the owner's `approve <id>` in the topic makes it `approved_in_topic`; only the owner's Confirm in the Web UI
// runs it -- after every check again, marked used before the call. The result goes to `<id>.result.json`. All state is in the DB.

/** A request is honoured for this long after its `createdAt` (and never when `createdAt` is in the future). */
export const SYSTEM_REQUEST_TTL_MS = 2 * 60 * 60 * 1000;
/** Who the paid call is recorded as. */
export const SYSTEM_APPROVAL_ACTOR = "owner (System)";
/** Where the owner confirms (the reply to `approve`). */
export const SYSTEM_CONFIRM_PLACE = "Settings → AI agent → System (Telegram)";

export type SystemRequestState = "posted" | "approved_in_topic" | "confirmed" | "done" | "failed" | "denied" | "expired" | "refused";
export type SystemResultStatus = "done" | "refused" | "failed" | "expired" | "denied";

export type SystemRequestRow = {
  id: string;
  action: string | null;
  argsJson: string | null;
  hash: string | null;
  createdAt: number | null;
  requestedBy: string | null;
  reason: string | null;
  agentEstimateUsd: number | null;
  estimateUsd: number | null;
  state: SystemRequestState;
  refusal: string | null;
  seenAt: number;
  approvedAt: number | null;
  confirmedAt: number | null;
  finishedAt: number | null;
  resultJson: string | null;
};

export type SystemRequestPatch = Partial<Pick<SystemRequestRow, "state" | "refusal" | "approvedAt" | "confirmedAt" | "finishedAt" | "resultJson">>;

export type SystemRequestStore = {
  get(id: string): Promise<SystemRequestRow | null>;
  /** False when a row with this id exists already. */
  insert(row: SystemRequestRow): Promise<boolean>;
  /** Compare-and-set: changes the row only while it is in one of `from`; true when it changed. */
  transition(id: string, from: readonly SystemRequestState[], patch: SystemRequestPatch): Promise<boolean>;
  listByStates(states: readonly SystemRequestState[]): Promise<SystemRequestRow[]>;
  recent(limit: number): Promise<SystemRequestRow[]>;
};

/** The factory's requests folder. Names only (no path is built from a name that failed the id pattern). */
export type SystemRequestFiles = {
  /** The file names in the folder; null when the folder does not exist. */
  list(dir: string): Promise<string[] | null>;
  /** A file's text; null when it does not exist. */
  read(dir: string, name: string): Promise<string | null>;
  /** Writes `<id>.result.json` atomically (a temporary file in the same folder, then a rename). */
  writeResult(dir: string, id: string, text: string): Promise<void>;
};

/** One allowlisted action, wired to the same service code and schema as its MCP tool (src/composition). */
export type SystemApprovalAction = {
  /** The Manager's per-approval cap (USD). */
  capUsd: number;
  /** The tool's own schema plus the System requirements; the args to run with, or why not. */
  parse(args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
  /** The Manager's own estimate and the existing limits (a refusal names the limit). */
  check(args: Record<string, unknown>): Promise<{ estimateUsd: number | null; refusal: string | null }>;
  /** Runs the call in process. A refusal or failure is `ok: false` with its text. */
  run(args: Record<string, unknown>, actor: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
  /** The arguments in short, for the post. */
  summary(args: Record<string, unknown>): string;
};

export type SystemApprovalsDeps = {
  store: SystemRequestStore;
  files: SystemRequestFiles;
  actions: Readonly<Record<string, SystemApprovalAction>>;
  readState(): Promise<SystemTopicState>;
  serviceMode(): boolean;
  enqueue(text: string): Promise<void>;
  clock(): number;
  log?(event: string, context: Record<string, unknown>): void;
};

/** `00 YT Operator/System/requests/<id>.json` (DEV-RESP-0043 Part 1, FO-RESP-0043 Q5). */
export const systemRequestFileSchema = z.looseObject({
  format: z.literal(1),
  id: z.string().regex(SYSTEM_REQUEST_ID_PATTERN),
  createdAt: z.iso.datetime({ offset: true }),
  requestedBy: z.string().min(1).max(120),
  action: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()),
  costEstimateUsd: z.number().nonnegative().optional(),
  reason: z.string().max(2000).optional(),
});

/** JSON with every object's keys sorted, no whitespace: the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The request hash the owner sees: the first 8 hex of SHA-256 of the canonical JSON of `{ action, args }`. */
export function requestHash(action: string, args: unknown): string {
  return sha256Hex(canonicalJson({ action, args })).slice(0, 8);
}

const money = (usd: number | null) => (usd === null ? "unknown" : `$${usd.toFixed(2)}`);

function expiredAt(createdAt: number | null, now: number): boolean {
  return createdAt === null || now - createdAt > SYSTEM_REQUEST_TTL_MS || createdAt > now;
}

export type SystemRequestView = Omit<SystemRequestRow, "argsJson" | "resultJson" | "createdAt" | "seenAt" | "approvedAt" | "confirmedAt" | "finishedAt"> & {
  args: unknown;
  result: unknown;
  createdAt: string | null;
  seenAt: string;
  approvedAt: string | null;
  confirmedAt: string | null;
  finishedAt: string | null;
};

export function createSystemApprovals(deps: SystemApprovalsDeps) {
  const log = deps.log ?? (() => undefined);
  const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
  const parseJson = (text: string | null): unknown => {
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  function toView(row: SystemRequestRow): SystemRequestView {
    const { argsJson, resultJson, ...rest } = row;
    return {
      ...rest,
      args: parseJson(argsJson),
      result: parseJson(resultJson),
      createdAt: iso(row.createdAt),
      seenAt: new Date(row.seenAt).toISOString(),
      approvedAt: iso(row.approvedAt),
      confirmedAt: iso(row.confirmedAt),
      finishedAt: iso(row.finishedAt),
    };
  }

  async function writeResult(dir: string | null, id: string, status: SystemResultStatus, body: { result?: unknown; error?: string }) {
    if (!dir) return;
    const text = `${JSON.stringify({ format: 1, id, status, at: new Date(deps.clock()).toISOString(), ...body }, null, 2)}\n`;
    try {
      await deps.files.writeResult(dir, id, text);
    } catch (error) {
      log("system_topic.result_write_failed", { id, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Ends a request (only from one of `from`): the row, the result file and a line in the topic. False when it moved meanwhile. */
  async function finish(
    dir: string | null,
    row: Pick<SystemRequestRow, "id">,
    from: readonly SystemRequestState[],
    state: Exclude<SystemRequestState, "posted" | "approved_in_topic" | "confirmed">,
    detail: { refusal?: string; result?: unknown; error?: string }
  ): Promise<boolean> {
    const now = deps.clock();
    const resultJson = JSON.stringify(detail.result !== undefined ? { result: detail.result } : { error: detail.error ?? detail.refusal ?? state });
    const changed = await deps.store.transition(row.id, from, { state, refusal: detail.refusal ?? null, finishedAt: now, resultJson });
    if (!changed) return false;
    await writeResult(dir, row.id, state, detail.result !== undefined ? { result: detail.result } : { error: detail.error ?? detail.refusal ?? state });
    const line =
      state === "done"
        ? `Request ${row.id}: done.`
        : state === "denied"
          ? `Request ${row.id}: denied.`
          : state === "expired"
            ? `Request ${row.id}: expired (older than 2 h, or created in the future).`
            : `Request ${row.id}: ${state} -- ${detail.error ?? detail.refusal ?? ""}`.trim();
    await deps.enqueue(line);
    log("system_topic.request_finished", { id: row.id, state });
    return true;
  }

  /** The file read again and checked as at posting; the args to run with, or a refusal text. */
  async function recheckFile(dir: string, row: SystemRequestRow): Promise<{ ok: true; args: Record<string, unknown>; action: SystemApprovalAction } | { ok: false; refusal: string }> {
    const text = await deps.files.read(dir, `${row.id}.json`);
    if (text === null) return { ok: false, refusal: "the request file is gone" };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, refusal: "the request file is not valid JSON any more" };
    }
    const parsed = systemRequestFileSchema.safeParse(json);
    if (!parsed.success || parsed.data.id !== row.id) return { ok: false, refusal: "the request file no longer matches format 1" };
    const hash = requestHash(parsed.data.action, parsed.data.args);
    if (hash !== row.hash) return { ok: false, refusal: `the request changed after it was posted (hash ${hash}, posted ${row.hash})` };
    const action = deps.actions[parsed.data.action];
    if (!action) return { ok: false, refusal: `action ${parsed.data.action} is not allowed here` };
    const args = action.parse(parsed.data.args);
    if (!args.ok) return { ok: false, refusal: `the arguments fail the tool's schema: ${args.error}` };
    return { ok: true, args: args.args, action };
  }

  /** The Manager's own estimate and the limits; a refusal text, or the estimate. */
  async function estimate(action: SystemApprovalAction, args: Record<string, unknown>): Promise<{ estimateUsd: number | null; refusal: string | null }> {
    let checked: { estimateUsd: number | null; refusal: string | null };
    try {
      checked = await action.check(args);
    } catch (error) {
      return { estimateUsd: null, refusal: `the estimate could not be made: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (checked.refusal) return checked;
    if (checked.estimateUsd === null) return { estimateUsd: null, refusal: "the cost could not be estimated" };
    if (checked.estimateUsd > action.capUsd) return { estimateUsd: checked.estimateUsd, refusal: `the estimate ${money(checked.estimateUsd)} is over the ${money(action.capUsd)} cap` };
    return checked;
  }

  async function scanOne(dir: string, name: string): Promise<void> {
    const id = name.slice(0, -".json".length);
    if (!SYSTEM_REQUEST_ID_PATTERN.test(id)) return;
    if (await deps.store.get(id)) return;
    const text = await deps.files.read(dir, name);
    if (text === null) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return; // possibly still being written: the next scan reads it again
    }
    const now = deps.clock();
    const parsed = systemRequestFileSchema.safeParse(json);
    const base: SystemRequestRow = {
      id,
      action: null,
      argsJson: null,
      hash: null,
      createdAt: null,
      requestedBy: null,
      reason: null,
      agentEstimateUsd: null,
      estimateUsd: null,
      state: "posted",
      refusal: null,
      seenAt: now,
      approvedAt: null,
      confirmedAt: null,
      finishedAt: null,
      resultJson: null,
    };
    const refuse = async (row: SystemRequestRow, refusal: string, state: "refused" | "expired" = "refused") => {
      const resultJson = JSON.stringify({ error: refusal });
      if (!(await deps.store.insert({ ...row, state, refusal, finishedAt: now, resultJson }))) return;
      await writeResult(dir, id, state, { error: refusal });
      const what = row.action ? ` (${row.action}${row.requestedBy ? ` from ${row.requestedBy}` : ""})` : "";
      await deps.enqueue(`Request ${id}${what}: ${state} -- ${refusal}`);
      log("system_topic.request_refused", { id, state });
    };
    if (!parsed.success || parsed.data.id !== id) {
      await refuse(base, parsed.success ? "its id is not its file name" : "the request file does not match format 1");
      return;
    }
    const request = parsed.data;
    const row: SystemRequestRow = {
      ...base,
      action: request.action,
      argsJson: JSON.stringify(request.args),
      hash: requestHash(request.action, request.args),
      createdAt: Date.parse(request.createdAt),
      requestedBy: request.requestedBy,
      reason: request.reason ?? null,
      agentEstimateUsd: request.costEstimateUsd ?? null,
    };
    if (expiredAt(row.createdAt, now)) return refuse(row, "older than 2 h, or created in the future", "expired");
    const action = deps.actions[request.action];
    if (!action) return refuse(row, `action ${request.action} is not allowed here (allowed: ${Object.keys(deps.actions).join(", ")})`);
    const args = action.parse(request.args);
    if (!args.ok) return refuse(row, `the arguments fail the tool's schema: ${args.error}`);
    const checked = await estimate(action, args.args);
    if (checked.refusal) return refuse({ ...row, estimateUsd: checked.estimateUsd }, checked.refusal);
    if (!(await deps.store.insert({ ...row, estimateUsd: checked.estimateUsd }))) return;
    await deps.enqueue(
      [
        `Paid-call request ${id} from ${request.requestedBy}`,
        `${request.action} ${action.summary(args.args)}`.trim(),
        `Estimate (YT Manager): ${money(checked.estimateUsd)}${request.costEstimateUsd !== undefined ? ` (the request says ${money(request.costEstimateUsd)})` : ""}`,
        `Hash: ${row.hash}`,
        ...(request.reason ? [`Reason: ${request.reason.slice(0, 300)}`] : []),
        `Reply "approve ${id}" or "deny ${id}" here, then confirm in YT Manager (${SYSTEM_CONFIRM_PLACE}).`,
      ].join("\n")
    );
    log("system_topic.request_posted", { id, action: request.action, estimateUsd: checked.estimateUsd });
  }

  async function requireOn(): Promise<SystemTopicState> {
    const state = await deps.readState();
    if (!state.enabled || !deps.serviceMode()) {
      throw new DomainError({ code: "system_topic_disabled", message: "The System topic is off on this computer (Settings → AI agent → System)" });
    }
    return state;
  }

  async function requireRow(id: string): Promise<SystemRequestRow> {
    const row = SYSTEM_REQUEST_ID_PATTERN.test(id) ? await deps.store.get(id) : null;
    if (!row) throw new DomainError({ code: "system_topic_request_not_found", message: "No request with this id", details: { id } });
    return row;
  }

  /** Why a request in this state cannot be approved / confirmed / denied. */
  function stateText(row: SystemRequestRow): string {
    switch (row.state) {
      case "posted":
        return `request ${row.id} is not approved in the topic yet`;
      case "approved_in_topic":
        return `request ${row.id} is approved -- confirm it in YT Manager (${SYSTEM_CONFIRM_PLACE})`;
      case "confirmed":
      case "done":
      case "failed":
        return `used: request ${row.id} was already confirmed`;
      case "denied":
        return `request ${row.id} was denied`;
      case "expired":
        return `request ${row.id} expired`;
      case "refused":
        return `request ${row.id} was refused: ${row.refusal ?? ""}`.trim();
    }
  }

  const commands: SystemApprovalCommands = {
    async approveInTopic(id): Promise<{ status: SystemCommandStatus; text: string }> {
      const state = await deps.readState();
      const row = await deps.store.get(id);
      if (!row) return { status: "refused", text: `unknown request ${id}` };
      if (row.state !== "posted") return { status: "refused", text: stateText(row) };
      if (expiredAt(row.createdAt, deps.clock())) {
        await finish(state.requestsPath, row, ["posted"], "expired", { refusal: "older than 2 h" });
        return { status: "refused", text: `request ${id} expired` };
      }
      if (!(await deps.store.transition(id, ["posted"], { state: "approved_in_topic", approvedAt: deps.clock() }))) {
        return { status: "refused", text: stateText((await deps.store.get(id)) ?? row) };
      }
      log("system_topic.request_approved_in_topic", { id });
      return { status: "done", text: `approved -- confirm in YT Manager (${SYSTEM_CONFIRM_PLACE})` };
    },

    async denyInTopic(id): Promise<{ status: SystemCommandStatus; text: string }> {
      const state = await deps.readState();
      const row = await deps.store.get(id);
      if (!row) return { status: "refused", text: `unknown request ${id}` };
      if (row.state !== "posted" && row.state !== "approved_in_topic") return { status: "refused", text: stateText(row) };
      const done = await finish(state.requestsPath, row, ["posted", "approved_in_topic"], "denied", { refusal: "denied by the owner" });
      return done ? { status: "done", text: "denied" } : { status: "refused", text: stateText((await deps.store.get(id)) ?? row) };
    },
  };

  return {
    commands,

    /**
     * One pass over the requests folder (every ~10 s while the feature is on): each new `<id>.json` is posted once (or refused /
     * expired once); open requests past 2 h expire.
     */
    async scan(): Promise<{ scanned: boolean }> {
      const state = await deps.readState();
      if (!state.enabled || !deps.serviceMode() || !state.requestsPath) return { scanned: false };
      const dir = state.requestsPath;
      const names = await deps.files.list(dir);
      if (names === null) throw new Error(`the requests folder ${dir} does not exist`);
      for (const name of [...names].sort()) {
        if (!name.endsWith(".json") || name.endsWith(".result.json")) continue;
        await scanOne(dir, name);
      }
      const now = deps.clock();
      for (const row of await deps.store.listByStates(["posted", "approved_in_topic"])) {
        if (expiredAt(row.createdAt, now)) await finish(dir, row, ["posted", "approved_in_topic"], "expired", { refusal: "older than 2 h" });
      }
      return { scanned: true };
    },

    async list(): Promise<{ waiting: SystemRequestView[]; recent: SystemRequestView[] }> {
      const [waiting, recent] = await Promise.all([deps.store.listByStates(["approved_in_topic"]), deps.store.recent(20)]);
      return { waiting: waiting.map(toView), recent: recent.map(toView) };
    },

    /**
     * The owner's Confirm in the Web UI -- the only way a request runs. Only after the owner's `approve` in the topic. Every check
     * again (2 h, the file's hash, the schema, the caps and limits); the request is marked used (`confirmed`) BEFORE the call, so a
     * second confirm can never run it again.
     */
    async confirm(id: string): Promise<SystemRequestView> {
      const state = await requireOn();
      const row = await requireRow(id);
      if (row.state !== "approved_in_topic") {
        throw new DomainError({ code: "system_topic_request_state", message: stateText(row), details: { id, state: row.state } });
      }
      const dir = state.requestsPath;
      const settle = async () => toView((await deps.store.get(id)) ?? row);
      if (expiredAt(row.createdAt, deps.clock())) {
        await finish(dir, row, ["approved_in_topic"], "expired", { refusal: "older than 2 h" });
        return settle();
      }
      if (!dir) {
        await finish(dir, row, ["approved_in_topic"], "refused", { refusal: "no requests folder is set" });
        return settle();
      }
      const file = await recheckFile(dir, row);
      if (!file.ok) {
        await finish(dir, row, ["approved_in_topic"], "refused", { refusal: file.refusal });
        return settle();
      }
      const checked = await estimate(file.action, file.args);
      if (checked.refusal) {
        await finish(dir, row, ["approved_in_topic"], "refused", { refusal: checked.refusal });
        return settle();
      }
      // Used BEFORE the call: only one confirm can win this.
      if (!(await deps.store.transition(id, ["approved_in_topic"], { state: "confirmed", confirmedAt: deps.clock() }))) {
        const latest = (await deps.store.get(id)) ?? row;
        throw new DomainError({ code: "system_topic_request_state", message: stateText(latest), details: { id, state: latest.state } });
      }
      log("system_topic.request_confirmed", { id, action: row.action, estimateUsd: checked.estimateUsd });
      let outcome: { ok: true; result: unknown } | { ok: false; error: string };
      try {
        outcome = await file.action.run(file.args, SYSTEM_APPROVAL_ACTOR);
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.ok) await finish(dir, row, ["confirmed"], "done", { result: outcome.result });
      else await finish(dir, row, ["confirmed"], "failed", { error: outcome.error });
      return settle();
    },

    /** The owner's Deny in the Web UI (a request not yet confirmed). */
    async deny(id: string): Promise<SystemRequestView> {
      const state = await deps.readState();
      const row = await requireRow(id);
      if (row.state !== "posted" && row.state !== "approved_in_topic") {
        throw new DomainError({ code: "system_topic_request_state", message: stateText(row), details: { id, state: row.state } });
      }
      if (!(await finish(state.requestsPath, row, ["posted", "approved_in_topic"], "denied", { refusal: "denied by the owner" }))) {
        const latest = (await deps.store.get(id)) ?? row;
        throw new DomainError({ code: "system_topic_request_state", message: stateText(latest), details: { id, state: latest.state } });
      }
      return toView((await deps.store.get(id)) ?? row);
    },
  };
}

export type SystemApprovals = ReturnType<typeof createSystemApprovals>;
