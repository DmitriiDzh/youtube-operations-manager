import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createDefaultLogger } from "./index";

// Architecture audit 2026-10-01 (M3): stdout is a protocol channel for the MCP server (JSON-RPC over
// stdio) and the CLI (one JSON envelope). Logging must never write there.

test("createDefaultLogger writes every level to stderr and nothing to stdout", () => {
  const out: string[] = [];
  const err: string[] = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const logger = createDefaultLogger();
    logger.info({ event: "a", context: { x: 1 } });
    logger.error({ event: "b" });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.deepEqual(out, []);
  assert.equal(err.length, 2);
  assert.equal(JSON.parse(err[0]).level, "info");
  assert.equal(JSON.parse(err[1]).event, "b");
});

test("no library or MCP source writes to stdout directly (console.log / process.stdout.write)", async () => {
  const offenders: string[] = [];
  async function scan(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
        const content = await readFile(full, "utf8");
        if (/console\.log\(|process\.stdout\.write\(/.test(content)) offenders.push(path.relative(process.cwd(), full));
      }
    }
  }
  await scan(path.resolve(process.cwd(), "src/lib"));
  await scan(path.resolve(process.cwd(), "src/mcp"));
  assert.deepEqual(offenders, []);
});
