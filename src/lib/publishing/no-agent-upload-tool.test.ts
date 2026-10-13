import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MCP_TOOL_CLASSIFICATION } from "@/mcp/tool-classification";

// AC-UP-14 (FO-REQ-0023 §4 B9; ADR 0037 §1: "uploads or scheduling by an agent or the Producer, who get read-only tools" are out of
// scope): no MCP tool uploads, schedules or cancels an upload, and no MCP or agent endpoint code reaches the upload approval, the
// runner or the cancel. Agents read the calendar (`agent_get_publishing_calendar`) only.

const SRC = path.resolve(process.cwd(), "src");
const UPLOAD_WRITERS = ["createUploadApprovalCore", "createUploadRunnerCore", "cancelUpload", "createUploadApproval", "createUploadRunner"];

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
const KNOWN_READS = new Set(["agent_get_publishing_calendar", "producer_upload_milestones"]);

test("AC-UP-14: no MCP tool name uploads, schedules or publishes a video; the matching names are known reads", () => {
  const publishingTools = Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => /upload|schedul|publish|insert_video|thumbnail/i.test(name));
  assert.deepEqual(publishingTools.filter((name) => !KNOWN_READS.has(name)), []);
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
