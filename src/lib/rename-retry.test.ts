import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renameWithRetry } from "./rename-retry";

function fakeErrnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

// RISK-22 (docs/TECHNICAL_DEBT.md): a transiently-held handle (antivirus, indexer, a
// just-closed handle) can make a bare rename() fail with EBUSY/EPERM on Windows even when
// nothing is genuinely holding a competing lock -- this must retry instead of throwing
// unhandled on the first attempt.
test("renameWithRetry retries on EBUSY/EPERM and eventually succeeds", async () => {
  let calls = 0;
  await renameWithRetry("/from", "/to", async () => {
    calls++;
    if (calls < 3) throw fakeErrnoError("EBUSY");
  });
  assert.equal(calls, 3);
});

test("renameWithRetry does not retry an unrelated error -- rethrows immediately", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      renameWithRetry("/from", "/to", async () => {
        calls++;
        throw fakeErrnoError("ENOENT");
      }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT"
  );
  assert.equal(calls, 1);
});

test("renameWithRetry gives up and rethrows the last error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      renameWithRetry("/from", "/to", async () => {
        calls++;
        throw fakeErrnoError("EPERM");
      }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EPERM"
  );
  assert.equal(calls, 10);
});

test("renameWithRetry actually renames a real file when no error occurs (default rename, no injection)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rename-retry-test-"));
  try {
    const from = path.join(dir, "source.txt");
    const to = path.join(dir, "dest.txt");
    await writeFile(from, "hello");
    await renameWithRetry(from, to);
    assert.equal(await readFile(to, "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
