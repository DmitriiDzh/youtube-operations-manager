import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withTempDir } from "./temp-dir";
import {
  isStaleTestRunRoot,
  parseTestRunRootName,
  sweepStaleTestRunRoots,
  testRunEnv,
  testRunnerArgs,
  testRunRootName,
  tsxCacheFolderName,
  exitCodeFor,
  refusedRunnerArgs,
} from "../../scripts/test-temp-root.mjs";

// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866). Requirements: every temporary folder of a test run lives under ONE
// per-run folder `ytm-test-run-<pid>-<time>`, removed when the run ends; a new run removes left-behind run folders older
// than 2 h whose process is gone; nothing else in the temp folder is ever touched; it works without a POSIX shell.

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const dead = () => false;
const alive = () => true;

test("the run folder's name carries the process id and start time, and only such names parse", () => {
  assert.equal(testRunRootName(4242, 1_793_000_000_000), "ytm-test-run-4242-1793000000000");
  assert.deepEqual(parseTestRunRootName("ytm-test-run-4242-1793000000000"), { pid: 4242, startedAtMs: 1_793_000_000_000 });
  for (const other of ["ytm-test-run-4242", "ytm-test-run-x-1", "search-terms-abc", "youtube-ops-manager-test-singleton-12", "ytm-test-run-1-2-extra", "ytm-test-run-1-2.txt"]) {
    assert.equal(parseTestRunRootName(other), null, other);
  }
});

test("a left-behind run folder is stale only when older than 2 h AND its process is gone (or older than 48 h)", () => {
  const name = (ageMs: number) => testRunRootName(77, NOW - ageMs);
  assert.equal(isStaleTestRunRoot(name(3 * HOUR), { now: NOW, isAlive: dead }), true);
  assert.equal(isStaleTestRunRoot(name(1 * HOUR), { now: NOW, isAlive: dead }), false, "younger than 2 h: a run may still be going");
  assert.equal(isStaleTestRunRoot(name(3 * HOUR), { now: NOW, isAlive: alive }), false, "its process still runs");
  assert.equal(isStaleTestRunRoot(name(49 * HOUR), { now: NOW, isAlive: alive }), true, "older than 48 h: the id was reused");
  assert.equal(isStaleTestRunRoot(testRunRootName(77, NOW + HOUR), { now: NOW, isAlive: dead }), false, "a start time in the future");
  assert.equal(isStaleTestRunRoot("search-terms-old", { now: NOW, isAlive: dead }), false, "not a run folder");
});

test("the sweep removes only stale run folders, never its own, never anything else", () =>
  withTempDir("ytm-sweep-", async (base) => {
    const staleRoot = testRunRootName(11, NOW - 5 * HOUR);
    const youngRoot = testRunRootName(12, NOW - 10 * 60_000);
    const ownRoot = testRunRootName(13, NOW - 50 * HOUR); // would be stale by age, but it is this run's
    for (const name of [staleRoot, youngRoot, ownRoot, "search-terms-x1", "youtube-ops-manager-test-singleton-9"]) {
      await mkdir(path.join(base, name, "inner"), { recursive: true });
      await writeFile(path.join(base, name, "inner", "f.txt"), "x");
    }
    await writeFile(path.join(base, "ytm-test-run-note.txt"), "a file, not a run folder");
    const removed = await sweepStaleTestRunRoots(base, { now: NOW, isAlive: dead, ownRoot: path.join(base, ownRoot) });
    assert.deepEqual(removed, [staleRoot]);
    assert.deepEqual((await readdir(base)).sort(), [ownRoot, youngRoot, "search-terms-x1", "youtube-ops-manager-test-singleton-9", "ytm-test-run-note.txt"].sort());
  }));

test("tsx's cache folder is named like tsx names it: the effective uid, or the user name where there is none (Windows)", () => {
  assert.equal(tsxCacheFolderName({ geteuid: () => 501 } as unknown as NodeJS.Process), "tsx-501");
  assert.equal(tsxCacheFolderName({} as NodeJS.Process, () => "Dima"), "tsx-Dima");
});

test("a missing temp folder sweeps nothing and does not throw", async () => {
  assert.deepEqual(await sweepStaleTestRunRoots(path.join("/nonexistent-ytm", "nope"), { now: NOW, isAlive: dead }), []);
});

test("the run's environment points TMPDIR, TMP and TEMP at the run folder and keeps the rest", () => {
  const env = testRunEnv({ PATH: "/bin", TMPDIR: "/old", TEMP: "C:\\old", NODE_TEST_CONTEXT: "1" }, "/t/ytm-test-run-1-2");
  assert.deepEqual(env, { PATH: "/bin", TMPDIR: "/t/ytm-test-run-1-2", TMP: "/t/ytm-test-run-1-2", TEMP: "/t/ytm-test-run-1-2", NODE_TEST_CONTEXT: "1" });
});

test("the runner's arguments: the whole suite by default, only the given files otherwise, options first", () => {
  assert.deepEqual(testRunnerArgs([]), ["--import", "tsx", "--test", "src/**/*.test.ts"]);
  assert.deepEqual(testRunnerArgs(["src/a.test.ts", "--test-name-pattern=x"]), ["--import", "tsx", "--test", "--test-name-pattern=x", "src/a.test.ts"]);
  // The space form keeps the value with its option (it is not a file); a flag without a value stays alone.
  assert.deepEqual(testRunnerArgs(["--test-name-pattern", "backup retention", "src/a.test.ts"]), ["--import", "tsx", "--test", "--test-name-pattern", "backup retention", "src/a.test.ts"]);
  assert.deepEqual(testRunnerArgs(["--test-only", "--test-concurrency", "2"]), ["--import", "tsx", "--test", "--test-only", "--test-concurrency", "2", "src/**/*.test.ts"]);
});

test("the run's exit code: the runner's own, or 128 + the signal's number when a signal ended it", () => {
  const signals = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as unknown as typeof import("node:os").constants.signals;
  assert.equal(exitCodeFor(0, null, signals), 0);
  assert.equal(exitCodeFor(1, null, signals), 1);
  assert.equal(exitCodeFor(null, "SIGINT", signals), 130);
  assert.equal(exitCodeFor(null, "SIGTERM", signals), 143);
  assert.equal(exitCodeFor(null, "SIGHUP", signals), 129);
  assert.equal(exitCodeFor(null, "SIGNOPE" as NodeJS.Signals, signals), 1);
});

test("end to end: a test's mkdtemp lands in the run folder, and nothing of the run is left afterwards", () =>
  withTempDir("ytm-runner-", async (base) => {
    // A stale run folder from a killed run, and a young one from a run that may still be going.
    const staleRoot = testRunRootName(2_147_483_000, Date.now() - 5 * HOUR);
    const youngRoot = testRunRootName(2_147_483_001, Date.now() - 60_000);
    await mkdir(path.join(base, staleRoot));
    await mkdir(path.join(base, youngRoot));
    await mkdir(path.join(base, "unrelated-folder"));
    const probe = path.join(base, "probe.test.mjs");
    await writeFile(
      probe,
      [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { mkdtempSync, writeFileSync } from "node:fs";',
        'import os from "node:os";',
        'import path from "node:path";',
        "test('probe', () => {",
        `  assert.match(path.basename(os.tmpdir()), /^ytm-test-run-\\d+-\\d+$/);`,
        `  assert.equal(path.dirname(os.tmpdir()), ${JSON.stringify(base)});`,
        "  const dir = mkdtempSync(path.join(os.tmpdir(), 'leaky-'));",
        "  writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(1024));",
        "});",
      ].join("\n")
    );
    const runner = path.resolve(process.cwd(), "scripts", "run-tests.mjs");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, TMP: base, TEMP: base };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, [runner, probe], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /pass 1/);
    // tsx's compile cache is the one thing kept outside the run folder (linked into it during the run).
    assert.deepEqual((await readdir(base)).sort(), [youngRoot, "probe.test.mjs", tsxCacheFolderName(), "unrelated-folder"].sort());
  }));

test("end to end: a failing test still removes the run folder and the run fails", () =>
  withTempDir("ytm-runner-", async (base) => {
    const probe = path.join(base, "fail.test.mjs");
    await writeFile(probe, 'import test from "node:test";\ntest("fails", () => { throw new Error("expected"); });\n');
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, TMP: base, TEMP: base };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "scripts", "run-tests.mjs"), probe], { env, encoding: "utf8", timeout: 60_000 });
    assert.notEqual(result.status, 0);
    assert.deepEqual((await readdir(base)).sort(), ["fail.test.mjs", tsxCacheFolderName()].sort());
  }));

test("--test-isolation other than \"process\" is refused (tests in one process could reach the real app-data)", () => {
  for (const args of [["--test-isolation=none"], ["--test-isolation", "none", "src/a.test.ts"], ["--test-isolation"]]) {
    assert.match(refusedRunnerArgs(args) ?? "", /refused/, JSON.stringify(args));
  }
  assert.equal(refusedRunnerArgs(["--test-isolation=process"]), null);
  assert.equal(refusedRunnerArgs(["--test-isolation", "process"]), null);
  assert.equal(refusedRunnerArgs(["--test-name-pattern", "none"]), null);
});

test("end to end: the runner refuses --test-isolation none before running anything, and leaves no run folder", () =>
  withTempDir("ytm-runner-", async (base) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: base, TMP: base, TEMP: base };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "scripts", "run-tests.mjs"), "--test-isolation", "none"], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /refused/);
    assert.deepEqual(await readdir(base), []);
  }));
