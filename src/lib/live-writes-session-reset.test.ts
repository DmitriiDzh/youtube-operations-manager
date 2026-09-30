import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  LIVE_WRITES_SESSION_LEASE_TTL_MS,
  getLiveWritesEnabled,
  renewLiveWritesSessionLease,
  resetLiveWritesForNewServerSession,
  setLiveWritesEnabled,
} from "@/lib/db";
import { assertLiveWritesAuthorized } from "@/lib/youtube-write-gateway";

// Architecture audit 2026-10-01 (H1, docs/roadmap/plans/HARDENING_AUDIT_2026-10_PLAN.md AC-H1-1/2):
// the shared Live-writes flag is reset ONLY at web-server boot. Database initialization (which runs
// in every MCP/CLI process too) must never touch it, or any agent call switches the operator's
// toggle off.

const SRC = path.resolve(process.cwd(), "src");

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

test("AC-H1-1: this process's database initialization left an enabled flag enabled", async () => {
  await setLiveWritesEnabled(true);
  assert.equal(await getLiveWritesEnabled(), true);
});

test("AC-H1-2: the server-session reset switches it off", async () => {
  await setLiveWritesEnabled(true);
  await resetLiveWritesForNewServerSession();
  assert.equal(await getLiveWritesEnabled(), false);
});

test("AC-H1-1: only the web boot hook resets the flag; no initialization code writes live_writes_enabled directly", async () => {
  const callers: string[] = [];
  for (const file of await listSourceFiles(SRC)) {
    const content = await readFile(file, "utf8");
    if (content.includes("resetLiveWritesForNewServerSession(")) callers.push(path.relative(SRC, file));
    if (path.relative(SRC, file) !== path.join("lib", "db.ts") && content.includes('"live_writes_enabled"')) {
      assert.fail(`${path.relative(SRC, file)} writes the live_writes_enabled key directly`);
    }
  }
  assert.deepEqual(callers.sort(), [path.join("instrumentation.ts"), path.join("lib", "db.ts")].sort());
  const db = await readFile(path.join(SRC, "lib", "db.ts"), "utf8");
  assert.equal(db.split('"live_writes_enabled"').length - 1, 1, "db.ts names the key once (its setting constant), never in a raw reset");
});

// Architecture-audit review, rounds 3-4: Live writes are honored only while a web-server session lease
// is fresh -- so a force-killed/crashed web server (Windows `taskkill /F`, a closed console window,
// a crash: no signal handler runs) cannot leave them on for a later MCP/CLI-only period. A lapse is a
// persisted OFF (never silently back on), and a future-dated lease is not "fresh".
test("lease: fresh -> enabled; inside/outside the TTL boundary; the gateway refuses once lapsed", async () => {
  await setLiveWritesEnabled(true); // stamps a fresh lease
  assert.equal(await getLiveWritesEnabled(), true);
  const now = Date.now();
  assert.equal(await getLiveWritesEnabled(new Date(now + LIVE_WRITES_SESSION_LEASE_TTL_MS - 5000)), true);
  assert.equal(await getLiveWritesEnabled(new Date(now + LIVE_WRITES_SESSION_LEASE_TTL_MS + 5000)), false);
  await assert.rejects(assertLiveWritesAuthorized(), (e: unknown) => (e as { code?: string }).code === "live_writes_disabled");
});

test("lease: a lapse is a persisted OFF -- a later renewal (e.g. after sleep) does not bring writes back", async () => {
  await setLiveWritesEnabled(true);
  await renewLiveWritesSessionLease(new Date(Date.now() - LIVE_WRITES_SESSION_LEASE_TTL_MS - 1000));
  assert.equal(await getLiveWritesEnabled(), false);
  await renewLiveWritesSessionLease(new Date());
  assert.equal(await getLiveWritesEnabled(), false, "only an explicit operator action may re-enable");
  await setLiveWritesEnabled(true);
  assert.equal(await getLiveWritesEnabled(), true);
});

test("lease: a lease stamped far in the future (clock ran ahead, then corrected) is not fresh", async () => {
  await setLiveWritesEnabled(true);
  await renewLiveWritesSessionLease(new Date(Date.now() + 2 * 60 * 60 * 1000));
  assert.equal(await getLiveWritesEnabled(), false);
});

test("lease: only the web boot hook and the settings route can renew it -- never MCP/CLI code", async () => {
  const renewers: string[] = [];
  const enablers: string[] = [];
  for (const file of await listSourceFiles(SRC)) {
    const content = await readFile(file, "utf8");
    if (content.includes("renewLiveWritesSessionLease(")) renewers.push(path.relative(SRC, file));
    // Components are skipped: `batch-manager.tsx` has an unrelated React state setter of the same name;
    // client components cannot import db.ts anyway.
    if (content.includes("setLiveWritesEnabled(") && !file.includes(`${path.sep}components${path.sep}`)) {
      enablers.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(renewers.sort(), [path.join("instrumentation.ts"), path.join("lib", "db.ts")].sort());
  // setLiveWritesEnabled(true) also renews the lease -- so it, too, is web-settings-route-only.
  assert.deepEqual(enablers.sort(), [path.join("app", "api", "settings", "route.ts"), path.join("lib", "db.ts")].sort());
});
