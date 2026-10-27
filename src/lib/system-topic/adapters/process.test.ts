import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { childEnvironment, runFactoryProcess } from "./process";

// BL-228 (SYSTEM_TOPIC_PLAN.md §3, ADR 0053 §4): the argv runs without a shell (shell syntax stays literal text), in the given
// directory, with stdout and stderr together, the exit code, a timeout that ends it, and none of the Manager's own variables.
// Local child processes of this machine's `node` only -- no network.

const NODE = process.execPath;

test("no shell: a ; or $(...) in an argument is passed as text", async () => {
  const result = await runFactoryProcess([NODE, "-e", "console.log(process.argv[1])", "a; echo injected $(whoami)"], { cwd: undefined, timeoutMs: 10_000 });
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "a; echo injected $(whoami)\n");
});

test("stdout and stderr are both kept; the exit code is returned; the cwd is the given directory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "system-topic-run-"));
  try {
    const result = await runFactoryProcess([NODE, "-e", "console.log(process.cwd()); console.error('warn'); process.exit(3)"], { cwd: dir, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 3);
    assert.match(result.output, new RegExp(`^${(await realpath(dir)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(result.output, /warn\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run longer than the timeout is ended and reported as timed out", async () => {
  const started = Date.now();
  const result = await runFactoryProcess([NODE, "-e", "setTimeout(() => {}, 60000)"], { cwd: undefined, timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 10_000);
});

test("a program that does not exist is an error, not a crash", async () => {
  const result = await runFactoryProcess(["/nonexistent/program-bl228"], { cwd: undefined, timeoutMs: 5_000 });
  assert.notEqual(result.error, null);
});

test("the child's environment holds only the listed variables, never the Manager's secrets", () => {
  const env = childEnvironment({ PATH: "/usr/bin", HOME: "/Users/x", NEXTAUTH_SECRET: "s", GOOGLE_CLIENT_SECRET: "g", YTOM_SERVICE_MODE: "1" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/Users/x", PYTHONUNBUFFERED: "1" });
});
