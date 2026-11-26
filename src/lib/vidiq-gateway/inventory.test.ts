import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// BL-278 (ADR 0077 decision 1, AC-VQ-1.16) -- AGENTS.md §G single gateway per API category: only `src/lib/vidiq-gateway/` may
// reach vidIQ's MCP server or build an MCP client, callers use its barrel, and only `src/lib/vidiq-research/` may use the barrel
// (so the budget, the ledger and later the cache sit in front of every call). Test files are skipped like the other inventory
// tests, so each matcher is first proved over sample strings.

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules") continue;
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (/\.(ts|tsx|mjs|js|sh)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const HOST = /mcp\.vidiq\.com/;
const MCP_CLIENT = /from\s+["']@modelcontextprotocol\/sdk\/client(\/[^"']*)?["']|import\(\s*["']@modelcontextprotocol\/sdk\/client/;
const GATEWAY_CHILD = /from\s+["']@\/lib\/vidiq-gateway\/[^"']+["']|import\(\s*["']@\/lib\/vidiq-gateway\/[^"']+["']/;
const GATEWAY_BARREL = /from\s+["']@\/lib\/vidiq-gateway["']|import\(\s*["']@\/lib\/vidiq-gateway["']/;

test("the matchers catch what they must and nothing else", () => {
  assert.ok(HOST.test('const url = "https://mcp.vidiq.com/mcp";'));
  assert.ok(!HOST.test('const url = "https://vidiq.com/terms";'));
  assert.ok(MCP_CLIENT.test('import { Client } from "@modelcontextprotocol/sdk/client/index.js";'));
  assert.ok(MCP_CLIENT.test('import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";'));
  assert.ok(MCP_CLIENT.test("const m = await import('@modelcontextprotocol/sdk/client/index.js');"));
  assert.ok(!MCP_CLIENT.test('import { Server } from "@modelcontextprotocol/sdk/server/index.js";'));
  assert.ok(GATEWAY_CHILD.test('import { x } from "@/lib/vidiq-gateway/client";'));
  assert.ok(GATEWAY_CHILD.test('import { x } from "@/lib/vidiq-gateway/contract";'));
  assert.ok(!GATEWAY_CHILD.test('import { x } from "@/lib/vidiq-gateway";'));
  assert.ok(GATEWAY_BARREL.test('import { getVidiqGateway } from "@/lib/vidiq-gateway";'));
  assert.ok(!GATEWAY_BARREL.test('import { x } from "@/lib/vidiq-gateway-other";'));
});

test("vidiq-gateway inventory: no production file outside the gateway names vidIQ's MCP host or imports an MCP client", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "vidiq-gateway");
  const offenders: string[] = [];
  for (const dir of ["src", "scripts"]) {
    let files: string[] = [];
    try {
      files = await listFiles(path.join(root, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.startsWith(gateway + path.sep)) continue;
      const text = await readFile(file, "utf8");
      if (HOST.test(text)) offenders.push(`${path.relative(root, file)} (host)`);
      if (MCP_CLIENT.test(text)) offenders.push(`${path.relative(root, file)} (MCP client)`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Test-support code (the fake vidIQ server, the module's harness) lives in a `testing/` folder: it may import the fake server, and no
// production file may import anything from such a folder.
const TESTING_IMPORT = /from\s+["']@\/lib\/vidiq-(gateway|research)\/testing\/[^"']+["']|from\s+["']\.{1,2}\/(\.\.\/)*testing\/[^"']+["']/;
const isTestingFile = (file: string) => file.split(path.sep).includes("testing");

test("the testing-folder matcher catches test-support imports", () => {
  assert.ok(TESTING_IMPORT.test('import { startFakeVidiqServer } from "@/lib/vidiq-gateway/testing/fake-server";'));
  assert.ok(TESTING_IMPORT.test('import { createVidiqHarness } from "./testing/harness";'));
  assert.ok(TESTING_IMPORT.test('import { createVidiqHarness } from "../testing/harness";'));
  assert.ok(!TESTING_IMPORT.test('import { x } from "./contract";'));
});

test("vidiq-gateway inventory: no file outside the gateway imports a child; only vidiq-research imports the barrel", async () => {
  const root = process.cwd();
  const gateway = path.join(root, "src", "lib", "vidiq-gateway");
  const research = path.join(root, "src", "lib", "vidiq-research");
  const offenders: string[] = [];
  for (const file of await listFiles(path.join(root, "src"))) {
    const text = await readFile(file, "utf8");
    if (!isTestingFile(file) && TESTING_IMPORT.test(text)) offenders.push(`${path.relative(root, file)} (imports test support)`);
    if (file.startsWith(gateway + path.sep)) continue;
    if (GATEWAY_CHILD.test(text) && !(isTestingFile(file) && /vidiq-gateway\/testing\//.test(text))) offenders.push(`${path.relative(root, file)} (child)`);
    if (GATEWAY_BARREL.test(text) && !file.startsWith(research + path.sep)) offenders.push(`${path.relative(root, file)} (barrel)`);
  }
  assert.deepEqual(offenders, []);
});

test("AC-VQ-1.16: the gateway and vidiq-research import nothing from the YouTube write path or the YouTube read gateway", async () => {
  const root = process.cwd();
  const offenders: string[] = [];
  for (const dir of [path.join(root, "src", "lib", "vidiq-gateway"), path.join(root, "src", "lib", "vidiq-research")]) {
    for (const file of await listFiles(dir)) {
      const text = await readFile(file, "utf8");
      if (/@\/lib\/(write-context|youtube-write-gateway|youtube-read-gateway)\b|assertLiveWritesAuthorized|assertWriteChannel/.test(text)) offenders.push(path.relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
