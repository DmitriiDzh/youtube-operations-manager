import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { DomainError } from "@/lib/shared-domain";
import toolsFixture from "./fixtures/tools-list.2026-11-26.json";

// ---------------------------------------------------------------------------
// BL-278 (ADR 0077 decision 4, VIDIQ_INTEGRATION_PLAN.md §4): the pinned vidIQ contract. The allowlist, the costs, the TTLs and
// the input schemas come from the dated fixture `fixtures/tools-list.2026-11-26.json` (the live `tools/list` of 2026-11-26), never
// from memory. A newer contract is a new dated fixture and a reviewed change here, never an edit of the old fixture.
//
// The static checks below run with no network: the tool on the list, the arguments a JSON object with only the pinned properties,
// channel and video arguments canonical ids, `userGoal` stripped, the pinned schema satisfied.
// ---------------------------------------------------------------------------

export const VIDIQ_CONTRACT_DATE = "2026-11-26";

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Plan §4: the 18 tools, each with its pinned cost (comment_insights: per mode) and its cache TTL (stage 2; null = never cached). */
const PINS = {
  vidiq_keyword_research: { cost: 5, ttlSeconds: DAY },
  vidiq_channel_search: { cost: 5, ttlSeconds: DAY },
  vidiq_outliers: { cost: 5, ttlSeconds: DAY },
  vidiq_trend_categories: { cost: 0, ttlSeconds: 7 * DAY },
  vidiq_trending_videos: { cost: 5, ttlSeconds: DAY },
  vidiq_similar_channels: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_channel_stats: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_channel_performance_trends: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_channel_videos: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_get_channels_by_ids: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_get_videos_by_ids: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_video_stats: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_video_change_history: { cost: 5, ttlSeconds: 7 * DAY },
  vidiq_title_thumbnail_wins: { cost: 5, ttlSeconds: DAY },
  // Owner TG 4961 (Q1): earnings estimates are shown, labelled a vidIQ estimate.
  vidiq_video_earnings_estimate: { cost: 5, ttlSeconds: 7 * DAY },
  // Asynchronous (creates a job on vidIQ's side): readOnlyHint false is its documented exception (ADR 0077 decision 4).
  vidiq_comment_insights: { cost: "comment_insights", ttlSeconds: DAY },
  vidiq_balance: { cost: 0, ttlSeconds: null },
  vidiq_job_poll: { cost: 0, ttlSeconds: null },
} as const;

export type VidiqToolName = keyof typeof PINS;

export const VIDIQ_ALLOWED_TOOLS = Object.freeze(Object.keys(PINS) as VidiqToolName[]);

export const VIDIQ_TOOL_TTL_SECONDS: Readonly<Record<VidiqToolName, number | null>> = Object.freeze(
  Object.fromEntries(Object.entries(PINS).map(([name, pin]) => [name, pin.ttlSeconds])) as Record<VidiqToolName, number | null>
);

/** The one allowlisted tool that reports readOnlyHint false (asynchronous job, writes nothing to YouTube). */
export const VIDIQ_READ_ONLY_EXCEPTIONS: ReadonlySet<VidiqToolName> = new Set(["vidiq_comment_insights"]);

/** comment_insights: 5 per discover, validate or new raw search; a raw page with `cursor` is free. */
const COMMENT_INSIGHTS_PAID = 5;

export function isAllowedTool(name: unknown): name is VidiqToolName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(PINS, name);
}

/** The pinned cost of one call with these (already checked) arguments. */
export function pinnedCostFor(tool: string, args: Record<string, unknown>): number {
  if (!isAllowedTool(tool)) throw notAllowed();
  const cost = PINS[tool].cost;
  if (cost === "comment_insights") return args.mode === "raw" && typeof args.cursor === "string" && args.cursor.length > 0 ? 0 : COMMENT_INSIGHTS_PAID;
  return cost;
}

/** Every cost the pin allows for a tool (for the overcharge check over ledger rows). */
export function pinnedCostsOf(tool: string): number[] {
  if (!isAllowedTool(tool)) return [];
  const cost = PINS[tool].cost;
  return cost === "comment_insights" ? [COMMENT_INSIGHTS_PAID, 0] : [cost];
}

/**
 * The number a live description states as the cost, or null when its Cost sentence is missing or not in the pinned form:
 * fixed-cost tools `Cost: N credit(s) per call.`; comment_insights `Cost: N credits per discover, validate, or new raw search. Raw
 * cursor pages are free.`
 */
export function parseStatedCost(tool: string, description: unknown): number | null {
  if (typeof description !== "string") return null;
  const pattern =
    tool === "vidiq_comment_insights"
      ? /(?:^|\n)Cost: (\d{1,6}) credits per discover, validate, or new raw search\. Raw cursor pages are free\.\s*$/
      : /(?:^|\n)Cost: (\d{1,6}) credit\(s\) per call\.\s*$/;
  const match = pattern.exec(description);
  return match ? Number(match[1]) : null;
}

/** The pinned (fixture) cost a description must state: comment_insights' paid figure; every other tool's one figure. */
export function pinnedStatedCost(tool: VidiqToolName): number {
  const cost = PINS[tool].cost;
  return cost === "comment_insights" ? COMMENT_INSIGHTS_PAID : cost;
}

export type JsonSchemaObject = { type?: unknown; properties?: Record<string, unknown>; required?: unknown; [key: string]: unknown };

export type PinnedTool = { name: VidiqToolName; description: string; inputSchema: JsonSchemaObject; annotations: Record<string, unknown> };

const PINNED_TOOLS: ReadonlyMap<VidiqToolName, PinnedTool> = (() => {
  const map = new Map<VidiqToolName, PinnedTool>();
  for (const entry of toolsFixture as Array<{ name: string; description: string; inputSchema: JsonSchemaObject; annotations?: Record<string, unknown> }>) {
    if (isAllowedTool(entry.name)) map.set(entry.name, { name: entry.name, description: entry.description, inputSchema: entry.inputSchema, annotations: entry.annotations ?? {} });
  }
  for (const name of VIDIQ_ALLOWED_TOOLS) if (!map.has(name)) throw new Error(`vidIQ contract: ${name} is missing from the ${VIDIQ_CONTRACT_DATE} fixture`);
  return map;
})();

export function pinnedTool(name: VidiqToolName): PinnedTool {
  return PINNED_TOOLS.get(name)!;
}

/** The pinned input schema without `userGoal` (stage 2 publishes it to the Producer). */
export function pinnedInputSchemaWithoutUserGoal(name: VidiqToolName): JsonSchemaObject {
  const schema = pinnedTool(name).inputSchema;
  const properties = { ...(schema.properties ?? {}) };
  delete properties.userGoal;
  return { ...schema, properties };
}

export function requiredOf(schema: JsonSchemaObject): string[] {
  return Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : [];
}

// ---- argument rules (plan §4) ----------------------------------------------------------------------------------------------

const CHANNEL_ID = /^UC[0-9A-Za-z_-]{22}$/;
const VIDEO_ID = /^[0-9A-Za-z_-]{11}$/;
const CHANNEL_ARGS = new Set(["channelId", "channelIds", "excludeChannelIds"]);
const VIDEO_ARGS = new Set(["videoId", "videoIds", "seedVideoId"]);

/** One validator instance per schema origin, so a live schema never gets a pinned schema's compiled validator back. */
export function newSchemaValidator() {
  return new AjvJsonSchemaValidator();
}

const pinnedValidator = newSchemaValidator();
const pinnedCompiled = new Map<VidiqToolName, (input: unknown) => { valid: boolean }>();

function compiledPinned(tool: VidiqToolName) {
  let compiled = pinnedCompiled.get(tool);
  if (!compiled) {
    compiled = pinnedValidator.getValidator(stripSchemaId(pinnedTool(tool).inputSchema) as never);
    pinnedCompiled.set(tool, compiled);
  }
  return compiled;
}

/** `$id`/`$schema` are dropped before compiling, so ajv never caches one schema under another's id. */
export function stripSchemaId(schema: JsonSchemaObject): JsonSchemaObject {
  const copy = { ...schema };
  delete copy.$id;
  delete copy.$schema;
  return copy;
}

function notAllowed(): DomainError {
  return new DomainError({ code: "vidiq_tool_not_allowed", message: "This vidIQ tool is not on YTM's allowlist." });
}

function argsInvalid(reason: string): DomainError {
  return new DomainError({ code: "vidiq_args_invalid", message: `The arguments do not fit the tool's pinned schema: ${reason}.` });
}

function canonicalRequired(property: string): DomainError {
  return new DomainError({
    code: "vidiq_canonical_id_required",
    message: `${property} must be a canonical YouTube id (a channel: UC plus 22 characters; a video: 11 characters), never a handle or URL.`,
    details: { property },
  });
}

export type CheckedCall = { tool: VidiqToolName; args: Record<string, unknown>; pinnedCost: number };

/**
 * The checks that need no network (ADR 0077 decision 4, plan §4 argument rules), in this order: the tool on the list; the
 * arguments a JSON object; `userGoal` stripped; only pinned properties; canonical channel and video ids; the pinned schema.
 * Returns the arguments that would be sent.
 */
export function checkStaticCall(tool: unknown, args: unknown): CheckedCall {
  if (!isAllowedTool(tool)) throw notAllowed();
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== "object" || Array.isArray(input)) throw argsInvalid("not a JSON object");
  const sent: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  delete sent.userGoal;
  const schema = pinnedTool(tool).inputSchema;
  const known = new Set(Object.keys(schema.properties ?? {}));
  const unknown = Object.keys(sent).filter((key) => !known.has(key));
  if (unknown.length > 0) throw argsInvalid(`unknown propert${unknown.length === 1 ? "y" : "ies"} ${unknown.slice(0, 5).map((k) => JSON.stringify(k.slice(0, 40))).join(", ")}`);
  for (const [key, value] of Object.entries(sent)) {
    const pattern = CHANNEL_ARGS.has(key) ? CHANNEL_ID : VIDEO_ARGS.has(key) ? VIDEO_ID : null;
    if (!pattern) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.some((v) => typeof v === "string" && !pattern.test(v))) throw canonicalRequired(key);
  }
  if (tool === "vidiq_job_poll" && !(typeof sent.mcpJobId === "string" && sent.mcpJobId.length > 0)) throw argsInvalid("mcpJobId must be a non-empty string");
  if (!compiledPinned(tool)(sent).valid) throw argsInvalid("the pinned input schema rejects them");
  return { tool, args: sent, pinnedCost: pinnedCostFor(tool, sent) };
}
