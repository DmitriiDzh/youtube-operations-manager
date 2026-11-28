import { createHash } from "node:crypto";
import { recordGatewayCallOutcome } from "@/lib/db";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { mcpCallTool, mcpListTools, VIDIQ_MCP_URL, VIDIQ_TIMEOUT_MS, type FetchLike, type McpCallResult, type McpToolListEntry } from "./client";
import {
  checkStaticCall,
  newSchemaValidator,
  parseStatedCost,
  pinnedStatedCost,
  pinnedTool,
  requiredOf,
  stripSchemaId,
  VIDIQ_ALLOWED_TOOLS,
  VIDIQ_READ_ONLY_EXCEPTIONS,
  type JsonSchemaObject,
  type VidiqToolName,
} from "./contract";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077, VIDIQ_INTEGRATION_PLAN.md §5 stage 1): the single gateway to vidIQ, the same single-gateway-per-API-category
// rule the YouTube gateways follow (AGENTS.md §G). It holds the pinned contract, checks every call against it and against the live
// `tools/list` (fail closed), and counts every attempt (`vidiq_api`). Only `src/lib/vidiq-research/` may use it (inventory test),
// so the switch, the budget and the ledger sit in front of every call. It writes nothing anywhere: vidIQ under an API key has no
// YouTube writer, and none of the allowlisted tools writes to the vidIQ account.
// ---------------------------------------------------------------------------

export {
  checkStaticCall,
  isAllowedTool,
  parseStatedCost,
  pinnedCostFor,
  pinnedCostsOf,
  pinnedInputSchemaWithoutUserGoal,
  VIDIQ_ALLOWED_TOOLS,
  VIDIQ_CONTRACT_DATE,
  VIDIQ_TOOL_TTL_SECONDS,
  type CheckedCall,
  type VidiqToolName,
} from "./contract";

/** The drift codes of ADR 0077 decision 4, as the report shows them. */
export type VidiqDriftCode = "vidiq_tool_missing" | "vidiq_schema_drift" | "vidiq_cost_changed" | "vidiq_annotation_drift";
export type VidiqDriftRow = { tool: VidiqToolName; state: "ok" | VidiqDriftCode };
export type VidiqDriftReport = { readAt: string; report: VidiqDriftRow[] };

export type VidiqBalance = {
  type: string | null;
  planName: string | null;
  totalCredits: number;
  renewableCredits: number | null;
  maxRenewableCredits: number | null;
  renewableResetsAt: string;
  addOnCredits: number | null;
  maxAddOnCredits: number | null;
  creditsUsed: number | null;
};

/** What `checkLive` passed: the call exactly as it would be sent, with its stated cost. */
export type LiveCheckedCall = Readonly<{ tool: VidiqToolName; args: Record<string, unknown>; statedCost: number }>;

export type VidiqCallOutcome = { tool: VidiqToolName; statedCost: number; result: McpCallResult; creditsUsed: number | null; isError: boolean };

export type VidiqGatewayDeps = {
  /** Tests only: a loopback MCP server. Production passes nothing and the key can go only to vidIQ. */
  endpoint?: string;
  /** One `tools/call`, from the moment it is sent (60 s). */
  timeoutMs?: number;
  /** The handshake and `tools/list` (60 s). */
  connectTimeoutMs?: number;
  fetch?: FetchLike;
  recordOutcome?: (outcome: "allowed" | "blocked") => Promise<void>;
  now?: () => number;
  maxResultBytes?: number;
};

/** The live list is kept this long per process, and read again once before any drift refusal. */
export const VIDIQ_TOOLS_LIST_TTL_MS = 60 * 60_000;
/** A result above this is refused (`vidiq_result_too_large`); its credits still count. */
export const VIDIQ_MAX_RESULT_BYTES = 256 * 1024;

function endpointUrl(endpoint: string | undefined): URL {
  if (endpoint === undefined) return new URL(VIDIQ_MCP_URL);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("vidIQ gateway: the endpoint override must be a loopback URL (tests only).");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !(host === "127.0.0.1" || host === "localhost" || host === "::1")) {
    throw new Error("vidIQ gateway: the endpoint override must be a loopback URL (tests only).");
  }
  return url;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** `_credits.used` from the structured content, or from the JSON text when there is none. */
export function creditsUsedOf(result: McpCallResult): number | null {
  const fromStructured = (result.structuredContent as { _credits?: { used?: unknown } } | undefined)?._credits?.used;
  if (isCount(fromStructured)) return fromStructured;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const text = (item as { type?: unknown; text?: unknown }).type === "text" ? (item as { text?: unknown }).text : null;
    if (typeof text !== "string" || !text.trimStart().startsWith("{")) continue;
    try {
      const used = (JSON.parse(text) as { _credits?: { used?: unknown } })._credits?.used;
      if (isCount(used)) return used;
    } catch {
      // not JSON
    }
  }
  return null;
}

/** The structured body of a result, or its first JSON text block. */
export function structuredBodyOf(result: McpCallResult): Record<string, unknown> | null {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of Array.isArray(result.content) ? result.content : []) {
    const text = (item as { text?: unknown }).text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
  }
  return null;
}

function parseBalance(result: McpCallResult): VidiqBalance {
  const body = structuredBodyOf(result);
  const widget = ((result._meta as { widgetData?: Record<string, unknown> } | undefined)?.widgetData ?? {}) as Record<string, unknown>;
  const num = (value: unknown) => (isCount(value) ? value : null);
  if (result.isError || !body || !isCount(body.totalCredits) || typeof body.renewableResetsAt !== "string" || Number.isNaN(Date.parse(body.renewableResetsAt))) {
    throw new DomainError({ code: "vidiq_unavailable", message: "vidIQ's balance answer could not be read.", details: { requestSent: true } });
  }
  return {
    type: typeof body.type === "string" ? body.type.slice(0, 40) : null,
    planName: typeof widget.planName === "string" ? widget.planName.slice(0, 40) : null,
    totalCredits: body.totalCredits,
    renewableCredits: num(body.renewableCredits),
    maxRenewableCredits: num(body.maxRenewableCredits),
    renewableResetsAt: body.renewableResetsAt,
    addOnCredits: num(body.addOnCredits),
    maxAddOnCredits: num(body.maxAddOnCredits),
    creditsUsed: creditsUsedOf(result),
  };
}

/** Defence in depth (AGENTS.md §F): should an answer ever quote the key, it never travels further than this gateway. */
function redactKey(result: McpCallResult, key: string): McpCallResult {
  if (key.length < 8) return result;
  const text = JSON.stringify(result);
  if (!text.includes(key)) return result;
  return JSON.parse(text.split(key).join("[redacted]")) as McpCallResult;
}

/** One read of the live list, with its own validator instance and the live schemas it compiled (lazily, once per tool). */
type LiveList = { readAt: number; tools: Map<string, McpToolListEntry>; validator: ReturnType<typeof newSchemaValidator>; compiled: Map<string, ((input: unknown) => { valid: boolean }) | null> };

export function createVidiqGateway(deps: VidiqGatewayDeps = {}) {
  const url = endpointUrl(deps.endpoint);
  const timeoutMs = deps.timeoutMs ?? VIDIQ_TIMEOUT_MS;
  const connectTimeoutMs = deps.connectTimeoutMs ?? VIDIQ_TIMEOUT_MS;
  const fetchImpl: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const record = deps.recordOutcome ?? ((outcome) => recordGatewayCallOutcome("vidiq_api", outcome));
  const now = deps.now ?? (() => Date.now());
  const maxResultBytes = deps.maxResultBytes ?? VIDIQ_MAX_RESULT_BYTES;
  const lists = new Map<string, LiveList>();
  /** Calls `checkLive` passed, each usable once by `callChecked` with the same key (it cannot be forged by a caller). */
  const issued = new WeakMap<object, string>();

  const options = (key: string) => ({ url, key, timeoutMs, connectTimeoutMs, fetchImpl });
  const keyId = (key: string) => createHash("sha256").update(key).digest("hex");
  const count = (outcome: "allowed" | "blocked") => record(outcome).catch(() => undefined);

  async function refuse(error: DomainError): Promise<never> {
    await count("blocked");
    throw error;
  }

  async function readList(key: string): Promise<LiveList> {
    await count("allowed");
    const tools = await mcpListTools(options(key));
    const list: LiveList = { readAt: now(), tools: new Map(tools.map((t) => [t.name, t])), validator: newSchemaValidator(), compiled: new Map() };
    lists.set(keyId(key), list);
    return list;
  }

  async function cachedList(key: string): Promise<{ list: LiveList; fresh: boolean }> {
    const cached = lists.get(keyId(key));
    if (cached && now() - cached.readAt < VIDIQ_TOOLS_LIST_TTL_MS) return { list: cached, fresh: false };
    return { list: await readList(key), fresh: true };
  }

  /** The drift of one tool in a live list; with `args`, also whether the live schema accepts them. */
  function driftOf(list: LiveList, tool: VidiqToolName, args?: Record<string, unknown>): VidiqDriftCode | null {
    const live = list.tools.get(tool);
    if (!live) return "vidiq_tool_missing";
    const readOnly = live.annotations?.readOnlyHint;
    if (readOnly !== true && !(VIDIQ_READ_ONLY_EXCEPTIONS.has(tool) && readOnly === false)) return "vidiq_annotation_drift";
    if (parseStatedCost(tool, live.description) !== pinnedStatedCost(tool)) return "vidiq_cost_changed";
    const schema = live.inputSchema as JsonSchemaObject | undefined;
    if (!schema || typeof schema !== "object") return "vidiq_schema_drift";
    const pinnedRequired = new Set(requiredOf(pinnedTool(tool).inputSchema));
    if (requiredOf(schema).some((name) => !pinnedRequired.has(name))) return "vidiq_schema_drift";
    if (!list.compiled.has(tool)) {
      try {
        list.compiled.set(tool, list.validator.getValidator(stripSchemaId(schema) as never));
      } catch {
        list.compiled.set(tool, null);
      }
    }
    const validate = list.compiled.get(tool);
    if (!validate) return "vidiq_schema_drift";
    if (args && !validate(args).valid) return "vidiq_schema_drift";
    return null;
  }

  const DRIFT_MESSAGES: Record<VidiqDriftCode, string> = {
    vidiq_tool_missing: "vidIQ no longer offers this tool under its pinned name; YTM refuses it until the contract is reviewed.",
    vidiq_schema_drift: "vidIQ changed this tool's arguments; YTM refuses it until the contract is reviewed.",
    vidiq_cost_changed: "vidIQ's stated cost for this tool differs from the pinned cost; YTM refuses it until the contract is reviewed.",
    vidiq_annotation_drift: "vidIQ no longer marks this tool read-only; YTM refuses it until the contract is reviewed.",
  };

  /** Static checks, then the live drift check (re-reading the list once before refusing). Returns what would be sent. */
  async function checkLive(key: string, tool: unknown, args: unknown): Promise<LiveCheckedCall> {
    let checked;
    try {
      checked = checkStaticCall(tool, args);
    } catch (error) {
      if (isDomainError(error)) return refuse(error as DomainError);
      throw error;
    }
    const cached = await cachedList(key);
    let list = cached.list;
    const fresh = cached.fresh;
    let drift = driftOf(list, checked.tool, checked.args);
    if (drift && !fresh) {
      list = await readList(key);
      drift = driftOf(list, checked.tool, checked.args);
    }
    if (drift) return refuse(new DomainError({ code: drift, message: DRIFT_MESSAGES[drift], details: { tool: checked.tool } }));
    const passed: LiveCheckedCall = Object.freeze({ tool: checked.tool, args: Object.freeze(structuredClone(checked.args)), statedCost: checked.pinnedCost });
    issued.set(passed, keyId(key));
    return passed;
  }

  /** Sends a call `checkLive` has just passed, without listing again (a list failure there could not be told from a sent call). */
  async function send(key: string, checked: LiveCheckedCall): Promise<VidiqCallOutcome> {
    await count("allowed");
    const result = redactKey(await mcpCallTool(options(key), checked.tool, checked.args), key);
    const creditsUsed = creditsUsedOf(result);
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > maxResultBytes) {
      throw new DomainError({ code: "vidiq_result_too_large", message: "vidIQ's answer is larger than YTM accepts (256 KB).", details: { creditsUsed, requestSent: true } });
    }
    return { tool: checked.tool, statedCost: checked.statedCost, result, creditsUsed, isError: result.isError === true };
  }

  async function callTool(key: string, tool: unknown, args: unknown): Promise<VidiqCallOutcome> {
    return send(key, await checkLive(key, tool, args));
  }

  /** The checked result of `checkLive` for the same key, once; anything else is refused before sending. */
  async function callChecked(key: string, checked: LiveCheckedCall): Promise<VidiqCallOutcome> {
    if (issued.get(checked) !== keyId(key)) throw new Error("vidIQ gateway: callChecked takes only a call checkLive passed for this key, once.");
    issued.delete(checked);
    return send(key, checked);
  }

  return {
    checkStaticCall,
    checkLive,
    callTool,
    callChecked,

    /** The free `tools/list` and a drift row per allowlisted tool (argument-independent checks). */
    async listToolsChecked(key: string, input: { refresh?: boolean } = {}): Promise<VidiqDriftReport> {
      const list = input.refresh ? await readList(key) : (await cachedList(key)).list;
      return { readAt: new Date(list.readAt).toISOString(), report: VIDIQ_ALLOWED_TOOLS.map((tool) => ({ tool, state: driftOf(list, tool) ?? "ok" })) };
    },

    /** The free `vidiq_balance`, parsed. */
    async balance(key: string): Promise<VidiqBalance> {
      return parseBalance((await callTool(key, "vidiq_balance", {})).result);
    },

    /** The free `vidiq_job_poll` (the ledger check that the job is ours runs in vidiq-research first). */
    async pollJob(key: string, mcpJobId: string): Promise<VidiqCallOutcome> {
      return callTool(key, "vidiq_job_poll", { mcpJobId });
    },
  };
}

export type VidiqGateway = ReturnType<typeof createVidiqGateway>;

const GATEWAY_KEY = Symbol.for("youtube-operations-manager.vidiq-gateway");

/** The production gateway, one per process (the live list cache is shared by every bundle). Never takes an endpoint. */
export function getVidiqGateway(): VidiqGateway {
  const holder = globalThis as unknown as Record<symbol, VidiqGateway | undefined>;
  return (holder[GATEWAY_KEY] ??= createVidiqGateway());
}
