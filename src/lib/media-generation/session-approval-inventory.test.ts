import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// AC-P14-16 (docs/roadmap/plans/PHASE_14_PLAN.md): approving, starting, stopping or rejecting a
// generation session is a Web-UI action only. The same mechanical fence as
// `market-research-request-approval-inventory.test.ts`: none of these symbols may appear in the
// agent-facing MCP server, the operator CLI, or the agent-operations module.
// BL-135 (ADR 0023 amendment 2, owner 2026-10-06): `releaseSession` -- the requesting channel ending its OWN session -- is
// deliberately NOT fenced: it can only withdraw a request or stop a pod (stop spending), never approve, start or resume.

// BL-133: the Factory Operator's self-approving start/stop are fenced the same way -- reachable only through the factory
// endpoint's route (src/app/api/mcp/factory), never from the channel MCP server, the CLI or agent-operations.
const FENCED_SYMBOLS = ["approveSession", "approveAndStartSession", "stopSession", "rejectSession", "stopForShutdown", "bootSweep", "watchTick", "factoryStartSession", "factoryStopSession"];
const FENCED_DIRS = [path.join("src", "mcp"), path.join("src", "cli"), path.join("src", "lib", "agent-operations")];

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("session approval/stop/reject and the watcher are unreachable from src/mcp, src/cli and src/lib/agent-operations", async () => {
  const root = process.cwd();
  const offenders: string[] = [];
  for (const dir of FENCED_DIRS) {
    for (const file of await listFiles(path.join(root, dir))) {
      const text = await readFile(file, "utf8");
      for (const symbol of FENCED_SYMBOLS) {
        if (text.includes(symbol)) offenders.push(`${path.relative(root, file)}: ${symbol}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
