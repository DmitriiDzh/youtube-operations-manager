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

// (independent review, review series cycle 5): the write/sync/close sequence had a real bug
// found and re-found across cycles 2-4 with no test able to exercise it, because nothing let a
// test substitute a handle whose close() throws. The injectable `openFn` closes that gap.
function fakeHandle(overrides: { writeFile?: () => Promise<void>; sync?: () => Promise<void>; close?: () => Promise<void> }) {
  return {
    writeFile: overrides.writeFile ?? (async () => {}),
    sync: overrides.sync ?? (async () => {}),
    close: overrides.close ?? (async () => {}),
  };
}

test("writeJsonFileAtomic: a write/sync failure propagates, even if close() also fails, and cleans up the tmp file", () =>
  withTempDir(async (dir) => {
    const target = path.join(dir, "state.json");
    const handle = fakeHandle({
      sync: async () => {
        throw new Error("disk full during sync");
      },
      close: async () => {
        throw new Error("EBADF on close, same underlying fault");
      },
    });

    await assert.rejects(
      () => writeJsonFileAtomic(target, { status: "in_progress" }, async () => handle as never),
      /disk full during sync/
    );

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries, []); // no orphaned tmp file left behind
  }));

test("writeJsonFileAtomic: a close() failure after a successful write/sync propagates (not silently swallowed) and cleans up the tmp file", () =>
  withTempDir(async (dir) => {
    const target = path.join(dir, "state.json");
    const handle = fakeHandle({
      close: async () => {
        throw new Error("late EIO flush error on close");
      },
    });

    await assert.rejects(
      () => writeJsonFileAtomic(target, { status: "completed" }, async () => handle as never),
      /late EIO flush error on close/
    );

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir);
    assert.deepEqual(entries, []); // no orphaned tmp file left behind

    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(target), false); // never renamed into place either
  }));
