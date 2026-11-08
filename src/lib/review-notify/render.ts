import { createHash } from "node:crypto";
import { REVIEW_NOTICE_FILE_PREFIX, REVIEW_NOTICE_FORMAT, type PlanReviewEntry, type PlanReviewFeed, type ReviewDecisionNotice, type ReviewNoticeKind } from "./contracts";

// BL-248 (REVIEW_NOTIFY_PLAN.md §4, §7): the pure rules -- file names, a plan pass's id, the Markdown. Nothing here reads the clock or
// names the computer that writes: the same decision gives the same name and the same bytes on any computer (AC-RN-16).

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const SAFE_PART = /^[A-Za-z0-9_-]+$/;
const MAX_PART = 64;
const CUT_PART = 48;

/**
 * One part of a file name (REVIEW_NOTIFY_PLAN.md §4): kept as it is when it is only `A-Z a-z 0-9 _ -` and at most 64 long;
 * otherwise every other character becomes `_`, it is cut to 48 and gets `~` + the first 8 hex of its own SHA-256 -- so two
 * different ids never share a name, and the same id always gives the same part.
 */
export function safeNamePart(raw: string): string {
  if (raw.length > 0 && raw.length <= MAX_PART && SAFE_PART.test(raw)) return raw;
  const replaced = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, CUT_PART);
  return `${replaced}~${sha256Hex(raw).slice(0, 8)}`;
}

/** `REVIEW-DECISION-<kind>-<itemId>-<decisionId>.md`, deterministic from the decision's own ids. */
export function reviewFileName(kind: ReviewNoticeKind, itemId: string, decisionId: string): string {
  return `${REVIEW_NOTICE_FILE_PREFIX}-${kind}-${safeNamePart(itemId)}-${safeNamePart(decisionId)}.md`;
}

/** The ledger key of a single decision (unique across channels and kinds). */
export function singleLedgerKey(notice: Pick<ReviewDecisionNotice, "kind" | "channelId" | "itemId" | "decisionId">): string {
  return `${notice.kind}|${notice.channelId}|${notice.itemId}|${notice.decisionId}`;
}

/** The ledger key of a plan entry. */
export const planLedgerKey = (entryId: string) => `plan|${entryId}`;

/** A plan pass's decision id: the first 16 hex of the SHA-256 of its entry ids, sorted, joined with `\n` (§4). */
export function planPassId(entryIds: readonly string[]): string {
  return sha256Hex([...entryIds].sort().join("\n")).slice(0, 16);
}

/** The stable id of a plan verdict / pick / «ни один не подходит» (§4). */
export const planVerdictEntryId = (planId: string, itemKey: string, attemptRef: string, at: string, result: string) => `v|${planId}|${itemKey}|${attemptRef}|${utcOf(at)}|${result}`;
export const planPickEntryId = (planId: string, itemKey: string, attemptRef: string, at: string) => `p|${planId}|${itemKey}|${attemptRef}|${utcOf(at)}`;
export const planNoneFitsEntryId = (planId: string, itemKey: string, at: string) => `n|${planId}|${itemKey}|${utcOf(at)}`;

/** An ISO time as UTC with milliseconds; a value that is not a time stays as it is. */
export function utcOf(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : at;
}

/** A YAML scalar: JSON's quoting is valid YAML (double-quoted), null stays null. */
const yaml = (value: string | number | null) => (value === null ? "null" : typeof value === "number" ? String(value) : JSON.stringify(value));

/** A fenced block that the text inside can never close (a fence longer than any backtick run in it). */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** Inline code that the value inside can never close. */
function code(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return longest > 0 ? `${ticks} ${value} ${ticks}` : `${ticks}${value}${ticks}`;
}

/** One line of text: a line break inside a value would start a new Markdown line. */
const oneLine = (value: string) => value.replace(/\s*[\r\n]+\s*/g, " ").trim();

const KIND_TITLE: Record<ReviewNoticeKind, string> = {
  clip: "clip",
  storyboard: "storyboard",
  render: "storyboard render («Ролик целиком»)",
  plan: "generation plan review pass",
  slot: "weekly-plan slot",
};

function frontMatter(fields: Array<[string, string | number | null]>): string {
  return ["---", ...fields.map(([key, value]) => `${key}: ${yaml(value)}`), "---"].join("\n");
}

function channelLine(channelName: string | null, channelId: string): string {
  return channelName ? `${oneLine(channelName)} (${code(channelId)})` : code(channelId);
}

/** The Markdown of one single decision (REVIEW_NOTIFY_PLAN.md §7). */
export function renderDecisionNotice(notice: ReviewDecisionNotice): string {
  const decidedAt = utcOf(notice.decidedAt);
  const lines: string[] = [
    frontMatter([
      ["format", REVIEW_NOTICE_FORMAT],
      ["kind", notice.kind],
      ["channelId", notice.channelId],
      ["itemId", notice.itemId],
      ["decisionId", notice.decisionId],
      ["status", notice.status],
      ["decidedAt", decidedAt],
      ["decidedOn", notice.decidedOn],
    ]),
    "",
    `# Owner review decision: ${KIND_TITLE[notice.kind]} ${notice.status}`,
    "",
    `- Channel: ${channelLine(notice.channelName, notice.channelId)}`,
    `- Item: ${code(notice.itemId)}`,
    ...notice.context.map((line) => `- ${line.label}: ${oneLine(line.value)}`),
    `- Status: **${notice.status}**`,
    `- Decided at: ${decidedAt} (UTC)`,
    `- Decided on: ${notice.decidedOn ? oneLine(notice.decidedOn) : "unknown"}`,
    `- Decision id: ${code(notice.decisionId)}`,
    "",
    "## Owner's comment",
    "",
    notice.comment !== null && notice.comment.length > 0 ? fenced(notice.comment) : "(none)",
    "",
    "## Attachments (relative to the channel folder)",
    "",
    ...(notice.attachments.length > 0 ? notice.attachments.map((p) => `- ${code(p)}`) : ["(none)"]),
    "",
    "## Where to find it",
    "",
    `- YT Manager: ${notice.ytmPlace}`,
    `- Read: ${code(notice.readTool)}`,
    "",
  ];
  return lines.join("\n");
}

function markLine(mark: PlanReviewEntry["marks"][number]): string {
  const span = mark.end === null ? `${mark.start}s` : `${mark.start}s-${mark.end}s`;
  const region = mark.region ? ` region x=${mark.region.x} y=${mark.region.y} r=${mark.region.r}` : "";
  return `${span}${region}${mark.note ? `: ${oneLine(mark.note)}` : ""}`;
}

function entryHeading(entry: PlanReviewEntry): string {
  const attempt = entry.attemptRef ? ` / ${code(entry.attemptRef)}` : "";
  const what = entry.type === "verdict" ? (entry.result ?? "verdict") : entry.type === "pick" ? "picked" : "none fits («ни один не подходит»)";
  return `### ${code(entry.itemKey)}${attempt}: ${what}`;
}

function entryBlock(entry: PlanReviewEntry): string[] {
  const lines = [entryHeading(entry), ""];
  if (entry.groupId) lines.push(`- Wave: ${code(entry.groupId)}`);
  if (entry.rating !== null) lines.push(`- Rating: ${entry.rating}/10`);
  if (entry.reasons.length > 0) lines.push(`- Reasons: ${entry.reasons.map(oneLine).join(", ")}`);
  if (entry.marks.length > 0) lines.push("- Marks:", ...entry.marks.map((m) => `  - ${markLine(m)}`));
  lines.push(`- At: ${utcOf(entry.at)} (UTC), on ${entry.device ? oneLine(entry.device) : "unknown"}`);
  lines.push("");
  lines.push(entry.note !== null && entry.note.length > 0 ? fenced(entry.note) : "(no note)");
  lines.push("");
  return lines;
}

/** Entries in the file's order: oldest first, then by id. */
export function sortPlanEntries(entries: readonly PlanReviewEntry[]): PlanReviewEntry[] {
  return [...entries].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0) || a.entryId.localeCompare(b.entryId));
}

/** The Markdown of one plan review pass (REVIEW_NOTIFY_PLAN.md §3, §7). */
export function renderPlanPass(feed: Omit<PlanReviewFeed, "entries" | "waveFinishedAt">, entries: readonly PlanReviewEntry[], passId: string): string {
  const sorted = sortPlanEntries(entries);
  const newest = sorted[sorted.length - 1];
  const decidedAt = newest ? utcOf(newest.at) : null;
  const devices = [...new Set(sorted.map((e) => e.device).filter((d): d is string => !!d))].sort();
  const count = (type: PlanReviewEntry["type"], result?: "accepted" | "rejected") => sorted.filter((e) => e.type === type && (result === undefined || e.result === result)).length;
  const lines: string[] = [
    frontMatter([
      ["format", REVIEW_NOTICE_FORMAT],
      ["kind", "plan"],
      ["channelId", feed.channelId],
      ["itemId", feed.planId],
      ["decisionId", passId],
      ["status", "reviewed"],
      ["decidedAt", decidedAt],
      ["decidedOn", devices.length > 0 ? devices.join(", ") : null],
      ["entries", sorted.length],
    ]),
    "",
    `# Owner review pass: generation plan ${feed.title ? oneLine(feed.title) : feed.planId}`,
    "",
    `- Channel: ${channelLine(feed.channelName, feed.channelId)}`,
    `- Plan: ${code(feed.planId)}${feed.title ? ` (${oneLine(feed.title)})` : ""}`,
    ...(feed.video ? [`- Video: ${oneLine(feed.video)}`] : []),
    `- Status: **reviewed** — accepted ${count("verdict", "accepted")}, rejected ${count("verdict", "rejected")}, picked ${count("pick")}, none fits ${count("none_fits")}`,
    `- Last decision at: ${decidedAt ?? "unknown"} (UTC)`,
    `- Decided on: ${devices.length > 0 ? devices.map(oneLine).join(", ") : "unknown"}`,
    `- Pass id: ${code(passId)}`,
    "",
    "## Decisions",
    "",
    ...sorted.flatMap(entryBlock),
    "## Where to find it",
    "",
    `- YT Manager: ${feed.ytmPlace}`,
    `- Read: ${code(feed.readTool)}`,
    "",
  ];
  return lines.join("\n");
}
