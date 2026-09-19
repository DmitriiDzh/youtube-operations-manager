import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "./services";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-json-file-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("writeJsonFileAtomic writes readable, correctly-formatted JSON", () =>
  withTempDir(async (dir) => {
    const target = path.join(dir, "state.json");
    await writeJsonFileAtomic(target, { status: "in_progress" });

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { status: "in_progress" });
  }));

test("writeJsonFileAtomic overwrites an existing file cleanly, leaving no stray tmp files", () =>
  withTempDir(async (dir) => {
    const target = path.join(dir, "state.json");
    await writeJsonFileAtomic(target, { status: "in_progress" });
    await writeJsonFileAtomic(target, { status: "completed" });

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { status: "completed" });

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries, ["state.json"]);
  }));

// RISK-25's crash-vs-preexisting-data disambiguation (docs/TECHNICAL_DEBT.md) depends on this
// write's content actually reaching disk before rename, not just the OS page cache -- this
// can't simulate a real power loss, but confirms the fsync'd write path doesn't silently
// corrupt or fail to write the file's real content (independent review, review series cycle 2).
test("writeJsonFileAtomic's fsync'd write path still produces the exact written content", () =>
  withTempDir(async (dir) => {
    const target = path.join(dir, "state.json");
    const payload = { status: "completed", nested: { count: 3, items: ["a", "b"] } };
    await writeJsonFileAtomic(target, payload);

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), payload);
  }));
