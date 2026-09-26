import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeJsonFileAtomic } from "./services";
import { withTempDir } from "@/test-support/temp-dir";

test("writeJsonFileAtomic writes readable, correctly-formatted JSON", () =>
  withTempDir("atomic-json-file-test-", async (dir) => {
    const target = path.join(dir, "state.json");
    await writeJsonFileAtomic(target, { status: "in_progress" });

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { status: "in_progress" });
  }));

test("writeJsonFileAtomic overwrites an existing file cleanly, leaving no stray tmp files", () =>
  withTempDir("atomic-json-file-test-", async (dir) => {
    const target = path.join(dir, "state.json");
    await writeJsonFileAtomic(target, { status: "in_progress" });
    await writeJsonFileAtomic(target, { status: "completed" });

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), { status: "completed" });

    const entries = await readdir(dir);
    assert.deepEqual(entries, ["state.json"]);
  }));

// RISK-25's crash-vs-preexisting-data disambiguation (docs/TECHNICAL_DEBT.md) depends on this
// write's content actually reaching disk before rename, not just the OS page cache -- this
// can't simulate a real power loss, but confirms the fsync'd write path doesn't silently
// corrupt or fail to write the file's real content (independent review, review series cycle 2).
test("writeJsonFileAtomic's fsync'd write path still produces the exact written content", () =>
  withTempDir("atomic-json-file-test-", async (dir) => {
    const target = path.join(dir, "state.json");
    const payload = { status: "completed", nested: { count: 3, items: ["a", "b"] } };
    await writeJsonFileAtomic(target, payload);

    const raw = await readFile(target, "utf8");
    assert.deepEqual(JSON.parse(raw), payload);
  }));

// (independent review, review series cycle 6): cycle 5's first version of these two tests used
// a fully in-memory fake handle whose writeFile/sync/close never touched the real filesystem --
// no tmp file was ever created, so the "no orphaned tmp file" assertions passed regardless of
// whether the production cleanup code existed at all (empirically confirmed by the review:
// deleting the cleanup line left both tests green). These open a *real* file via the real
// `open()` and monkey-patch only the specific method under test, so a real tmp file genuinely
// exists on disk for the assertions to meaningfully check.
function openWithSyncFailure(errorMessage: string) {
  return async (filePath: string, flags: string, mode: number) => {
    const real = await open(filePath, flags, mode);
    return {
      writeFile: real.writeFile.bind(real),
      sync: async () => {
        throw new Error(errorMessage);
      },
      close: async () => {
        await real.close().catch(() => {});
        throw new Error("EBADF on close, same underlying fault");
      },
    };
  };
}

function openWithCloseFailure(errorMessage: string) {
  return async (filePath: string, flags: string, mode: number) => {
    const real = await open(filePath, flags, mode);
    return {
      writeFile: real.writeFile.bind(real),
      sync: real.sync.bind(real),
      close: async () => {
        // The real fd is genuinely released (a real close() failure doesn't mean the fd stays
        // open -- it means the *caller* never got confirmation the flush succeeded); only the
        // error we're injecting is fake.
        await real.close().catch(() => {});
        throw new Error(errorMessage);
      },
    };
  };
}

test("writeJsonFileAtomic: a write/sync failure propagates, even if close() also fails, and cleans up the real tmp file", () =>
  withTempDir("atomic-json-file-test-", async (dir) => {
    const target = path.join(dir, "state.json");

    await assert.rejects(
      () => writeJsonFileAtomic(target, { status: "in_progress" }, openWithSyncFailure("disk full during sync") as never),
      /disk full during sync/
    );

    const entries = await readdir(dir);
    assert.deepEqual(entries, []); // the real tmp file this run created is gone
    assert.equal(existsSync(target), false);
  }));

test("writeJsonFileAtomic: a close() failure after a successful write/sync propagates (not silently swallowed) and cleans up the real tmp file", () =>
  withTempDir("atomic-json-file-test-", async (dir) => {
    const target = path.join(dir, "state.json");

    await assert.rejects(
      () => writeJsonFileAtomic(target, { status: "completed" }, openWithCloseFailure("late EIO flush error on close") as never),
      /late EIO flush error on close/
    );

    const entries = await readdir(dir);
    assert.deepEqual(entries, []); // the real tmp file this run created is gone
    assert.equal(existsSync(target), false); // never renamed into place either
  }));
