// ---------------------------------------------------------------------------
// BL-163 AC-PR-05 (docs/roadmap/plans/WATCHLIST_HYGIENE_PROPOSALS_PLAN.md §2.C, spec §26: "AI may propose. Human approves. System
// applies."). Mirrors PHASE9-INV-03 / PHASE10-INV-02's structural inventory: nothing an agent can reach -- the MCP server, the
// Producer's own endpoint route, the CLI, agent-operations -- may name the owner's side of the proposal store, nor the store's own
// decision writes underneath it. Scans directories, not filenames. The symbols are assembled from parts so this file never matches
// a scan of its own.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(THIS_DIR, "../..");

const AGENT_REACHABLE_ROOTS = ["mcp", "cli", path.join("lib", "agent-operations"), path.join("app", "api", "mcp")].map((dir) => path.join(SRC_ROOT, dir));

const OWNER_SIDE = ["approve", "reject", "apply", "decide", "fail"].map((verb) => `${verb}AgentProposal`);
const REVIEW_CORE = ["createAgentProposal", "ReviewCore"].join("");

async function sourceFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...(await sourceFiles(full)));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

test("AC-PR-05: no file an agent can reach names the owner's approve / reject / apply side of the proposal store", async () => {
  const offenders: string[] = [];
  for (const root of AGENT_REACHABLE_ROOTS) {
    for (const file of await sourceFiles(root)) {
      const content = await readFile(file, "utf8");
      for (const symbol of [...OWNER_SIDE, REVIEW_CORE]) if (content.includes(symbol)) offenders.push(`${path.relative(SRC_ROOT, file)}: ${symbol}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("AC-PR-05: the owner's review core is built only by the Web UI's own routes", async () => {
  const allowed = [path.join("app", "api", "agent-proposals"), path.join("app", "api", "market-intelligence", "summary"), path.join("lib", "agent-proposals")];
  const callers: string[] = [];
  for (const file of await sourceFiles(SRC_ROOT)) {
    if (!(await readFile(file, "utf8")).includes(REVIEW_CORE)) continue;
    const relative = path.relative(SRC_ROOT, file);
    if (!allowed.some((dir) => relative.startsWith(dir + path.sep))) callers.push(relative);
  }
  assert.deepEqual(callers, []);
});
