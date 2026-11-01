import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";
import { FACTORY_TOOL_NAMES } from "@/mcp/factory-server";
import { WORKER_FACTORY_TOOLS } from "@/mcp/worker-factory-tools";
import { PRODUCER_UPLOAD_QUEUE_TOOLS } from "@/mcp/producer-tools";

// AC-UP-14 (FO-REQ-0023 §4 B9; ADR 0037 §1: "uploads or scheduling by an agent or the Producer, who get read-only tools" are out of
// scope): no MCP tool uploads, schedules or cancels an upload, and no MCP or agent endpoint code reaches the upload approval, the
// runner or the cancel. Agents read the calendar (`agent_get_publishing_calendar`) only.
//
// BL-239 (owner msgs 3928/3930, ADR 0059 -- the requirement changed for the Producer only): the Producer controls this computer's
// upload queue (list, move, cancel a queued row, add a ready package under the owner's automatic-upload switch). That is the ONE
// exception: its four tools are `producer-only`, and the queue control (`createUploadQueueControlCore`) is reached only from the
// Producer session's wiring. Channel worker agents and the factory still get no upload tool, and no MCP or agent endpoint code
// reaches the approval, the runner, the automatic queue or the owner's cancel -- those checks below are unchanged.

const SRC = path.resolve(process.cwd(), "src");
// BL-209 AC-AU-11 (AUTO_PRIVATE_UPLOAD_PLAN.md §1, ADR 0046): the automatic upload's queue and its switch's setter join the list --
// the owner's switch is set from the Web UI only, and nothing an agent calls can reach the automatic queue.
const UPLOAD_WRITERS = [
  "createUploadApprovalCore",
  "createUploadRunnerCore",
  "cancelUpload",
  "createUploadApproval",
  "createUploadRunner",
  "createAutoPrivateUploadCore",
  "createAutoPrivateUpload",
  "queueAutomatic",
  "setAutoPrivateUploadEnabled",
  // BL-225 stage 3 (ADR 0051 §5/§7): the plan's changes to an uploaded video's date, and the slots' decisions it reads.
  "createPlanScheduleCore",
  "createPlanSchedule",
  "createPublishingPlansUploadCore",
  // BL-239: the Producer's queue goes only through createUploadQueueControlCore (its one allowed caller is checked below); its inner
  // parts are named by no MCP or agent endpoint code.
  "createUploadQueueControl",
  "queueByProducer",
];

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Tools whose names match but only read: the publishing calendar, and the analytics milestones of published uploads (BL-166). */
/** BL-235 (owner msgs 3806/3807, a new requirement): `agent_publishing_coverage` reads which days are covered -- it writes nothing. */
const KNOWN_READS = new Set(["agent_get_publishing_calendar", "producer_upload_milestones", "agent_publishing_coverage"]);
/**
 * BL-225 (FO-REQ-0040, ADR 0051 §6 -- a new requirement, not a relaxation of this one): a channel worker drafts its weekly
 * publishing plan. The draft neither uploads nor schedules anything: only the owner's approval of a slot in the Web UI does, and
 * the plan module's agents' surface has no decision function (`publishing-plans/boundaries.test.ts`). The next test still holds:
 * no MCP code reaches the upload approval, the runner or the automatic queue.
 */
const KNOWN_PLAN_DRAFTS = new Set(["agent_publishing_plan_save", "agent_publishing_plan_get", "agent_publishing_plan_list"]);
/** BL-239 (owner msgs 3928/3930, ADR 0059): the Producer's upload queue tools -- the one exception, on its endpoint only. */
const PRODUCER_QUEUE_TOOLS = new Set<string>(PRODUCER_UPLOAD_QUEUE_TOOLS);

test("AC-UP-14: no MCP tool name uploads, schedules or publishes a video; the matching names are known reads, plan drafts or the Producer's queue", () => {
  const publishingTools = Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => /upload|schedul|publish|insert_video|thumbnail/i.test(name));
  assert.deepEqual(publishingTools.filter((name) => !KNOWN_READS.has(name) && !KNOWN_PLAN_DRAFTS.has(name) && !PRODUCER_QUEUE_TOOLS.has(name)), []);
});

// BL-239 AC-UQ-11: the exception is exactly four tools, all `producer-only` (never registered for a channel worker), none on the
// factory endpoint or among the worker's factory-style tools.
test("BL-239 AC-UQ-11: the Producer's queue tools are exactly four, producer-only; the factory and workers have no queue tool", () => {
  assert.deepEqual([...PRODUCER_QUEUE_TOOLS].sort(), ["producer_upload_queue_add", "producer_upload_queue_cancel", "producer_upload_queue_list", "producer_upload_queue_move"]);
  for (const name of PRODUCER_QUEUE_TOOLS) assert.equal(MCP_TOOL_CLASSIFICATION[name], "producer-only", name);
  const queueLike = (name: string) => /upload_queue|queue_upload|upload_(add|move|cancel)/i.test(name);
  assert.deepEqual((FACTORY_TOOL_NAMES as readonly string[]).filter(queueLike), []);
  assert.deepEqual(Object.keys(WORKER_FACTORY_TOOLS).filter(queueLike), []);
  assert.deepEqual(Object.values(WORKER_FACTORY_TOOLS).map((tool) => tool.agentName).filter(queueLike), []);
});

// BL-239 AC-UQ-11: the queue control is reached only by the Producer session's wiring and the owner's move route (and defined in
// the publishing module); no channel-agent, factory or agent-operations code names it.
test("BL-239 AC-UQ-11: createUploadQueueControlCore is used only by the Producer session wiring and the owner's move route", async () => {
  const callers: string[] = [];
  for (const file of await files(SRC)) {
    if (/\bcreateUploadQueueControlCore\b/.test(await readFile(file, "utf8"))) callers.push(path.relative(SRC, file));
  }
  assert.deepEqual(callers.sort(), ["app/api/channels/[channelId]/publishing/uploads/[uploadId]/move/route.ts", "lib/producer-mcp-endpoint/session-deps.ts", "lib/publishing/index.ts"]);
  const others: string[] = [];
  for (const root of ["mcp", "lib/agent-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations", "app/api/mcp/route.ts", "app/api/mcp/factory"]) {
    const target = path.join(SRC, root);
    const list = target.endsWith(".ts") ? [target] : await files(target);
    for (const file of list) {
      const content = await readFile(file, "utf8").catch(() => "");
      if (/\b(createUploadQueueControlCore|createUploadQueueControl|queueByProducer)\b/.test(content)) others.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(others, []);
});

test("AC-UP-14: no MCP server or agent endpoint code reaches the upload approval, the runner or the cancel", async () => {
  const roots = ["mcp", "lib/agent-mcp-endpoint", "lib/producer-mcp-endpoint", "lib/factory-mcp-endpoint", "lib/agent-operations"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of await files(path.join(SRC, root))) {
      const content = await readFile(file, "utf8");
      if (UPLOAD_WRITERS.some((name) => new RegExp(`\\b${name}\\b`).test(content))) offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

// BL-209 AC-AU-11: the switch's only setter is the Web UI's Settings route; no MCP tool name mentions it.
test("AC-AU-11: setAutoPrivateUploadEnabled is called only by the Settings route; no MCP tool names the automatic upload", async () => {
  const callers: string[] = [];
  for (const file of await files(SRC)) {
    const content = await readFile(file, "utf8");
    if (/\bsetAutoPrivateUploadEnabled\b/.test(content)) callers.push(path.relative(SRC, file));
  }
  assert.deepEqual(callers.sort(), ["app/api/settings/route.ts", "lib/db.ts"]);
  assert.deepEqual(Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => /auto.*upload|auto_private/i.test(name)), []);
});
