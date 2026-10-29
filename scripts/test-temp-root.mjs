// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866): one temporary folder per test run, removed when the run ends.
// The pure parts of `scripts/run-tests.mjs`, kept here so `src/test-support/test-temp-root.test.ts` can check them on a
// folder of its own (under the runner, os.tmpdir() IS the run's folder, so nothing here reads os.tmpdir() itself).
import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** The name every run's folder starts with: `ytm-test-run-<pid>-<start ms>`. */
export const TEST_RUN_ROOT_PREFIX = "ytm-test-run-";
/** A left-behind run folder older than this whose process is gone is removed when a new run starts. */
export const STALE_RUN_ROOT_AGE_MS = 2 * 60 * 60 * 1000;
/** Older than this it is removed even when its process id is alive again (the system reuses process ids). */
export const ABANDONED_RUN_ROOT_AGE_MS = 48 * 60 * 60 * 1000;

const NAME = /^ytm-test-run-(\d+)-(\d+)$/;

/** The run folder's name for a process and its start time. */
export function testRunRootName(pid, startedAtMs) {
  return `${TEST_RUN_ROOT_PREFIX}${pid}-${startedAtMs}`;
}

/** `{ pid, startedAtMs }` for a run folder's name, or null for any other name. */
export function parseTestRunRootName(name) {
  const match = NAME.exec(name);
  if (!match) return null;
  return { pid: Number(match[1]), startedAtMs: Number(match[2]) };
}

/** Whether a process with this id runs now (EPERM: it runs, under another user). */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Whether a left-behind run folder may be removed: older than 2 h and its process gone, or older than 48 h whatever its
 * process id says. A folder whose name is not a run folder's, or that started in the future, is never removed.
 * @param {string} name
 * @param {{ now: number; isAlive?: (pid: number) => boolean; maxAgeMs?: number; abandonedAgeMs?: number }} options
 */
export function isStaleTestRunRoot(name, { now, isAlive = isPidAlive, maxAgeMs = STALE_RUN_ROOT_AGE_MS, abandonedAgeMs = ABANDONED_RUN_ROOT_AGE_MS }) {
  const parsed = parseTestRunRootName(name);
  if (!parsed) return false;
  const age = now - parsed.startedAtMs;
  if (age < 0) return false;
  if (age > abandonedAgeMs) return true;
  return age > maxAgeMs && !isAlive(parsed.pid);
}

/** Removes a folder, retrying a few times (Windows can hold a just-closed database file briefly: EBUSY). */
export async function removeWithRetry(dir, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return false;
}

/**
 * Removes the stale run folders directly inside `baseDir` (crash safety: a run killed before its own cleanup). Never the
 * folder named `ownRoot`, never anything whose name is not a run folder's. Returns the names removed.
 * @param {string} baseDir
 * @param {{ now?: number; isAlive?: (pid: number) => boolean; ownRoot?: string | null; maxAgeMs?: number; abandonedAgeMs?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function sweepStaleTestRunRoots(baseDir, { now, isAlive = isPidAlive, ownRoot = null, maxAgeMs, abandonedAgeMs } = {}) {
  let names;
  try {
    names = await readdir(baseDir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (ownRoot && path.join(baseDir, name) === ownRoot) continue;
    if (!isStaleTestRunRoot(name, { now: now ?? Date.now(), isAlive, maxAgeMs, abandonedAgeMs })) continue;
    if (await removeWithRetry(path.join(baseDir, name))) removed.push(name);
  }
  return removed;
}

/** The environment a test run gets: every name the system reads its temporary folder from points at the run's folder. */
export function testRunEnv(baseEnv, root) {
  return { ...baseEnv, TMPDIR: root, TMP: root, TEMP: root };
}

/** The test runner's arguments: the default pattern unless files or patterns were given; options always first. */
export function testRunnerArgs(extra, defaultPattern = "src/**/*.test.ts") {
  const options = extra.filter((arg) => arg.startsWith("-"));
  const targets = extra.filter((arg) => !arg.startsWith("-"));
  return ["--import", "tsx", "--test", ...options, ...(targets.length > 0 ? targets : [defaultPattern])];
}

/**
 * The folder tsx keeps its compile cache in, under the temp folder: `tsx-<effective uid>` (`tsx-<user name>` on Windows),
 * as tsx's own `temporary-directory` module names it. The run links it to the one in the system temp folder, so the
 * cache survives the run (a cache, not a leftover: without the link every run would compile all files again).
 */
export function tsxCacheFolderName(proc = process, userName = () => os.userInfo().username) {
  return `tsx-${proc.geteuid ? proc.geteuid() : userName()}`;
}
