import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  LIVE_WRITES_SESSION_LEASE_TTL_MS,
  getLiveWritesEnabled,
  getLiveWritesToggle,
  migrateLiveWritesToDefaultOn,
  rawSqlClient,
  renewLiveWritesSessionLease,
  setLiveWritesEnabled,
} from "@/lib/db";
import { assertLiveWritesAuthorized } from "@/lib/youtube-write-gateway";

// Architecture audit 2026-10-01 (H1): database initialization (which runs in every MCP/CLI process too) must never touch the
// shared Live-writes flag. ADR 0044 (2026-10-19): nothing resets it at all any more.

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

// ADR 0044 (owner, Telegram msg 3157, 2026-10-19): Live writes are ON unless the owner switched them off, and nothing resets
// them -- not a server boot, not a shutdown, not the idle window. The web server's session lease stays a liveness check: with
// the app down an MCP/CLI process cannot write, but a lapse no longer persists "off". (Replaces the 2026-09-21 Gate B
// "off at the start of every session" tests, which the owner's decision withdrew.)

test("ADR 0044: a toggle never set counts as on (while the web server's lease is fresh)", async () => {
  await rawSqlClient.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: ["live_writes_enabled"] });
  await renewLiveWritesSessionLease();
  assert.equal(await getLiveWritesToggle(), true);
  assert.equal(await getLiveWritesEnabled(), true);
});

test("ADR 0044: the owner's off persists, and only his on brings writes back", async () => {
  await setLiveWritesEnabled(false);
  await renewLiveWritesSessionLease();
  assert.equal(await getLiveWritesEnabled(), false);
  await assert.rejects(assertLiveWritesAuthorized(), (e: unknown) => (e as { code?: string }).code === "live_writes_disabled");
  await setLiveWritesEnabled(true);
  assert.equal(await getLiveWritesEnabled(), true);
});

test("ADR 0044: no code resets the toggle -- nothing outside db.ts writes the key, and db.ts writes it only in setLiveWritesEnabled", async () => {
  const offenders: string[] = [];
  for (const file of await listSourceFiles(SRC)) {
    const content = await readFile(file, "utf8");
    if (content.includes("resetLiveWritesForNewServerSession")) offenders.push(`${path.relative(SRC, file)} (reset)`);
    if (path.relative(SRC, file) !== path.join("lib", "db.ts") && content.includes('"live_writes_enabled"')) offenders.push(path.relative(SRC, file));
  }
  assert.deepEqual(offenders, []);
  const db = await readFile(path.join(SRC, "lib", "db.ts"), "utf8");
  assert.equal(db.split("setAppSetting(LIVE_WRITES_ENABLED_SETTING_KEY").length - 1, 1, "the only write of the toggle is the owner's setter");
});

test("lease: fresh -> enabled; past the TTL refused (the app is down), and the gateway refuses too", async () => {
  await setLiveWritesEnabled(true); // stamps a fresh lease
  const now = Date.now();
  assert.equal(await getLiveWritesEnabled(new Date(now + LIVE_WRITES_SESSION_LEASE_TTL_MS - 5000)), true);
  assert.equal(await getLiveWritesEnabled(new Date(now + LIVE_WRITES_SESSION_LEASE_TTL_MS + 5000)), false);
  await renewLiveWritesSessionLease(new Date(now - LIVE_WRITES_SESSION_LEASE_TTL_MS - 5000));
  await assert.rejects(assertLiveWritesAuthorized(), (e: unknown) => (e as { code?: string }).code === "live_writes_disabled");
});

test("ADR 0044: a lapsed lease is NOT a persisted off -- once the web server renews it, writes work again by themselves", async () => {
  await setLiveWritesEnabled(true);
  await renewLiveWritesSessionLease(new Date(Date.now() - LIVE_WRITES_SESSION_LEASE_TTL_MS - 1000));
  assert.equal(await getLiveWritesEnabled(), false);
  assert.equal(await getLiveWritesToggle(), true, "the owner's choice is untouched");
  await renewLiveWritesSessionLease(new Date());
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

test("ADR 0044 migration: once per database the old automatic off is forgotten; the owner's later off is kept", async () => {
  await rawSqlClient.execute({ sql: "DELETE FROM app_settings WHERE key = ?", args: ["live_writes_default_on_migrated"] });
  await setLiveWritesEnabled(false); // what the old boot reset left behind
  assert.equal(await migrateLiveWritesToDefaultOn(), true);
  assert.equal(await getLiveWritesToggle(), true);
  await setLiveWritesEnabled(false); // the owner's own off, after the migration
  assert.equal(await migrateLiveWritesToDefaultOn(), false, "it runs once");
  assert.equal(await getLiveWritesToggle(), false, "the owner's choice survives every later boot");
  await setLiveWritesEnabled(true);
});
