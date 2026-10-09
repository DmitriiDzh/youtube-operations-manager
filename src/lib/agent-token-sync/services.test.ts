import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { applyAgentTokenSyncPlan, initializeDatabaseSchema, listAgentTokenRowsForSync, type AppDb } from "@/lib/db";
import { createAgentTokenServices, type AgentTokenStore } from "@/lib/agent-tokens/services";
import { createFactoryTokenServices } from "@/lib/factory-agent-tokens/services";
import type { RoleTokenStore } from "@/lib/role-agent-tokens";
import { AGENT_TOKENS_REPORT_FORMAT, AGENT_TOKENS_REPORT_VERSION, createAgentTokensShareCore, type AgentTokensReportStore } from "@/lib/sync-gateway";
import type { AgentTokenRecord } from "./contracts";
import { createAgentTokenSyncServices, reconcileAgentTokens } from "./services";

// Expected behavior from docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §2 (AC-ST-01..11), written before this module, from the owner's
// decisions (Telegram 2026-10-09, msgs 2200, 2205, 2207): every agent token works on every device without an import, a revocation
// reaches every device and is never undone, one active token per slot (the newest wins, equal times: the larger hash), and only
// hashes travel. Each "device" below is its own in-memory token table plus a REAL agent-tokens report core; `exchange` plays
// Syncthing by handing each device the other's published report.

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const at = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00Z`);
const SECRET = (c: string) => c.repeat(43);

type Row = AgentTokenRecord & { id: string };

function memoryReportStore(): AgentTokensReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => {
      local = json;
    },
    readPeers: async () => ({ ...peers }),
    writePeer: async (deviceId, json) => {
      peers[deviceId] = json;
    },
  };
}

function createDevice(deviceId: string, clock: { now: Date }, options: { connected?: Record<string, string | null>; secrets?: string[] } = {}) {
  const rows: Row[] = [];
  const connected: Record<string, string | null> = { ...(options.connected ?? { UC_A: "user-a" }) };
  const secrets = [...(options.secrets ?? [])];
  const nextSecret = () => {
    const secret = secrets.shift();
    assert.ok(secret, "test ran out of secrets");
    return secret;
  };
  let ids = 0;
  const newId = () => `${deviceId}-${++ids}`;

  const channelStore: AgentTokenStore = {
    async replace(input) {
      for (const row of rows) if (row.role === "channel" && row.channelId === input.channelId && row.revokedAt === null) row.revokedAt = clock.now;
      rows.push({ id: input.id, role: "channel", hash: input.tokenHash, channelId: input.channelId, userId: input.userId, label: input.label, createdAt: clock.now, revokedAt: null });
    },
    async revokeForChannel(channelId) {
      let n = 0;
      for (const row of rows) if (row.role === "channel" && row.channelId === channelId && row.revokedAt === null) { row.revokedAt = clock.now; n++; }
      return n;
    },
    async findActiveByHash(hash) {
      const row = rows.find((r) => r.role === "channel" && r.hash === hash && r.revokedAt === null);
      return row ? { id: row.id, channelId: row.channelId!, userId: row.userId!, label: row.label, createdAt: row.createdAt } : null;
    },
    async findByHash(hash) {
      const row = rows.find((r) => r.role === "channel" && r.hash === hash);
      return row ? { id: row.id, channelId: row.channelId!, userId: row.userId!, label: row.label, createdAt: row.createdAt, revokedAt: row.revokedAt } : null;
    },
    async listActive() {
      return rows.filter((r) => r.role === "channel" && r.revokedAt === null).map((r) => ({ id: r.id, channelId: r.channelId!, userId: r.userId!, label: r.label, createdAt: r.createdAt }));
    },
  };
  const factoryStore: RoleTokenStore = {
    async replace(input) {
      for (const row of rows) if (row.role === "factory" && row.revokedAt === null) row.revokedAt = clock.now;
      rows.push({ id: input.id, role: "factory", hash: input.tokenHash, channelId: null, userId: null, label: input.label, createdAt: clock.now, revokedAt: null });
    },
    async revoke() {
      let n = 0;
      for (const row of rows) if (row.role === "factory" && row.revokedAt === null) { row.revokedAt = clock.now; n++; }
      return n;
    },
    async findActiveByHash(hash) {
      return rows.find((r) => r.role === "factory" && r.hash === hash && r.revokedAt === null) ?? null;
    },
    async findByHash(hash) {
      return rows.find((r) => r.role === "factory" && r.hash === hash) ?? null;
    },
    async listActive() {
      return rows.filter((r) => r.role === "factory" && r.revokedAt === null);
    },
  };

  const channel = createAgentTokenServices({
    store: channelStore,
    getChannelConnectedUserId: async (channelId) => connected[channelId] ?? null,
    getLiveChannelIdForUser: async (userId) => Object.entries(connected).find(([, user]) => user === userId)?.[0] ?? null,
    generateSecret: nextSecret,
  });
  const factory = createFactoryTokenServices({ store: factoryStore, generateSecret: nextSecret });
  const share = createAgentTokensShareCore({ store: memoryReportStore(), ownDeviceId: async () => deviceId, clock: { now: () => clock.now } });
  let publishFails = false;
  const sync = createAgentTokenSyncServices({
    store: {
      listAll: async () => rows.map((row) => ({ ...row })),
      async apply(plan) {
        for (const item of plan.redate) {
          const row = rows.find((r) => r.hash === item.hash);
          if (row && row.createdAt.getTime() > item.createdAt.getTime()) row.createdAt = item.createdAt;
        }
        for (const item of plan.revoke) {
          const row = rows.find((r) => r.hash === item.hash && r.revokedAt === null);
          if (row) row.revokedAt = item.revokedAt;
        }
        for (const record of plan.insert) if (!rows.some((r) => r.hash === record.hash)) rows.push({ ...record });
      },
    },
    share: {
      listPeerTokens: async () => (await share.listPeerReports()).flatMap((report) => report.tokens),
      async publish(tokens) {
        if (publishFails) throw new Error("shared folder unavailable");
        await share.publishLocalReport({ format: AGENT_TOKENS_REPORT_FORMAT, version: AGENT_TOKENS_REPORT_VERSION, deviceId, updatedAt: clock.now.toISOString(), tokens });
      },
    },
    newId,
    clock: { now: () => clock.now },
  });
  return {
    deviceId,
    rows,
    connected,
    channel,
    factory,
    share,
    sync,
    failPublishing(value: boolean) {
      publishFails = value;
    },
  };
}

type Device = ReturnType<typeof createDevice>;

/** One Syncthing round: both publish, each receives the other's latest report, both apply. */
async function exchange(clock: { now: Date }, ...devices: Device[]) {
  // A device that cannot publish (its shared folder is unavailable) still applies what it received.
  for (const device of devices) await device.sync.tick().catch(() => undefined);
  clock.now = new Date(clock.now.getTime() + 1000);
  for (const from of devices) {
    let bytes: Uint8Array;
    try {
      bytes = await from.share.exportBytes();
    } catch {
      continue; // nothing published yet
    }
    for (const to of devices) if (to !== from) await to.share.mergeIncoming(bytes, from.deviceId);
  }
  for (const device of devices) await device.sync.tick().catch(() => undefined);
}

const isInvalid = (error: unknown) => (error as { code?: string }).code === "AGENT_TOKEN_INVALID";

test("AC-ST-01: a channel token and a factory token issued on A are accepted on B after one exchange, with no import", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a"), SECRET("f")] });
  const b = createDevice("dev-b", clock);
  const channelToken = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  const factoryToken = (await a.factory.issueToken({})).token;
  await assert.rejects(b.channel.verifyToken(channelToken), isInvalid);
  await exchange(clock, a, b);
  const binding = await b.channel.verifyToken(channelToken);
  assert.deepEqual([binding.channelId, binding.userId], ["UC_A", "user-a"]);
  assert.ok(await b.factory.verifyToken(factoryToken));
});

test("AC-ST-02: revoking on A stops the token on B; rotating on A swaps old for new on B", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a"), SECRET("b"), SECRET("c")] });
  const b = createDevice("dev-b", clock);
  const first = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  await exchange(clock, a, b);
  clock.now = at("10:05");
  const second = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  await exchange(clock, a, b);
  await assert.rejects(b.channel.verifyToken(first), isInvalid);
  assert.ok(await b.channel.verifyToken(second));
  clock.now = at("10:10");
  await a.channel.revokeToken({ channelId: "UC_A" });
  await exchange(clock, a, b);
  await assert.rejects(b.channel.verifyToken(second), isInvalid);
  // Revoked on B too, so B now publishes it as revoked as well.
  assert.equal(b.rows.find((row) => row.hash === sha256(second))?.revokedAt?.toISOString(), at("10:10").toISOString());
});

test("AC-ST-03: a revocation is never undone, even by a report that lists the token as active", async () => {
  const local: AgentTokenRecord[] = [{ hash: "1".repeat(64), role: "factory", channelId: null, userId: null, label: null, createdAt: at("10:00"), revokedAt: at("10:30") }];
  const forged: AgentTokenRecord[] = [{ ...local[0], revokedAt: null, createdAt: at("09:00") }];
  // Still revoked; the only change is the issue time, which takes the earliest any device reports (rule from review round 1).
  assert.deepEqual(reconcileAgentTokens(local, forged, { now: at("12:00") }), { revoke: [], insert: [], redate: [{ role: "factory", hash: local[0].hash, createdAt: at("09:00") }], ignored: [] });

  // End to end: B revoked a factory token; a third device keeps publishing it as active; B still refuses it.
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("f")] });
  const b = createDevice("dev-b", clock);
  const c = createDevice("dev-c", clock);
  const token = (await a.factory.issueToken({})).token;
  await exchange(clock, a, b, c);
  c.failPublishing(true); // C stays on its old report, which still says "active"
  clock.now = at("10:30");
  await b.factory.revokeToken();
  await exchange(clock, a, b, c);
  await assert.rejects(b.factory.verifyToken(token), isInvalid);
  await assert.rejects(a.factory.verifyToken(token), isInvalid);
});

test("AC-ST-04: two different active tokens for one slot -- the newer wins on every device, equal times go to the larger hash", () => {
  const older: AgentTokenRecord = { hash: "a".repeat(64), role: "channel", channelId: "UC_A", userId: "user-a", label: null, createdAt: at("10:00"), revokedAt: null };
  const newer: AgentTokenRecord = { ...older, hash: "b".repeat(64), createdAt: at("10:05") };
  // On the device that holds the older one: revoke it as of 10:05, add the newer one.
  assert.deepEqual(reconcileAgentTokens([older], [newer], { now: at("12:00") }), { revoke: [{ role: "channel", hash: older.hash, revokedAt: at("10:05") }], insert: [newer], redate: [], ignored: [] });
  // On the device that holds the newer one: add the older one, already revoked as of 10:05.
  assert.deepEqual(reconcileAgentTokens([newer], [older], { now: at("12:00") }), { revoke: [], insert: [{ ...older, revokedAt: at("10:05") }], redate: [], ignored: [] });
  // Equal times: "c…" > "a…", so the "c…" token wins whichever device computes it.
  const tie: AgentTokenRecord = { ...older, hash: "c".repeat(64) };
  assert.deepEqual(reconcileAgentTokens([older], [tie], { now: at("12:00") }).revoke, [{ role: "channel", hash: older.hash, revokedAt: at("10:00") }]);
  assert.deepEqual(reconcileAgentTokens([tie], [older], { now: at("12:00") }).revoke, []);
  // Different channels are different slots: both stay active.
  const otherChannel: AgentTokenRecord = { ...newer, channelId: "UC_B" };
  assert.deepEqual(reconcileAgentTokens([older], [otherChannel], { now: at("12:00") }).revoke, []);
});

test("AC-ST-04: factory tokens issued independently on A (10:00) and B (10:05) end as B's on both devices", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("x")] });
  const b = createDevice("dev-b", clock, { secrets: [SECRET("y")] });
  const fromA = (await a.factory.issueToken({})).token;
  clock.now = at("10:05");
  const fromB = (await b.factory.issueToken({})).token;
  await exchange(clock, a, b);
  for (const device of [a, b]) {
    await assert.rejects(device.factory.verifyToken(fromA), isInvalid);
    assert.ok(await device.factory.verifyToken(fromB));
  }
});

test("AC-ST-05: a peer record whose hash this device knows under another channel, account or role changes nothing", () => {
  const own: AgentTokenRecord = { hash: "d".repeat(64), role: "channel", channelId: "UC_A", userId: "user-a", label: null, createdAt: at("10:00"), revokedAt: null };
  for (const peer of [
    { ...own, channelId: "UC_B", revokedAt: at("10:01") },
    { ...own, userId: "user-x", revokedAt: at("10:01") },
    { ...own, role: "producer" as const, channelId: null, userId: null, revokedAt: at("10:01") },
  ]) {
    assert.deepEqual(reconcileAgentTokens([own], [peer], { now: at("12:00") }), { revoke: [], insert: [], redate: [], ignored: [{ hash: own.hash, reason: "conflicts_with_local" }] });
  }
  // Two peers describing an unknown hash differently: neither is trusted.
  const p1: AgentTokenRecord = { ...own, hash: "e".repeat(64) };
  const p2: AgentTokenRecord = { ...p1, channelId: "UC_B" };
  assert.deepEqual(reconcileAgentTokens([], [p1, p2], { now: at("12:00") }), { revoke: [], insert: [], redate: [], ignored: [{ hash: p1.hash, reason: "peers_disagree" }] });
});

test("AC-ST-06 / AC-ST-08: a learned channel token needs the channel connected here under its account; disconnecting only stops it here", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a")] });
  const b = createDevice("dev-b", clock, { connected: { UC_A: null } });
  const token = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  await exchange(clock, a, b);
  await assert.rejects(b.channel.verifyToken(token), isInvalid); // not connected on B
  b.connected.UC_A = "user-x";
  await assert.rejects(b.channel.verifyToken(token), isInvalid); // connected under another account
  b.connected.UC_A = "user-a";
  assert.ok(await b.channel.verifyToken(token));
  // Disconnecting on B (the route no longer revokes): refused on B, still accepted on A, and accepted again after reconnecting.
  b.connected.UC_A = null;
  await exchange(clock, a, b);
  await assert.rejects(b.channel.verifyToken(token), isInvalid);
  assert.ok(await a.channel.verifyToken(token));
  b.connected.UC_A = "user-a";
  assert.ok(await b.channel.verifyToken(token));
});

test("AC-ST-07: the published report carries the hash, never the token", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("s"), SECRET("t")] });
  const channelToken = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  const factoryToken = (await a.factory.issueToken({})).token;
  await a.sync.tick();
  const published = new TextDecoder().decode(await a.share.exportBytes());
  assert.equal(published.includes(SECRET("s")), false);
  assert.equal(published.includes(SECRET("t")), false);
  assert.equal(published.includes(channelToken), false);
  assert.equal(published.includes(factoryToken), false);
  assert.equal(published.includes(sha256(channelToken)), true);
});

test("AC-ST-08: the disconnect route no longer revokes the channel's token", async () => {
  const source = await readFile(path.resolve(process.cwd(), "src/app/api/channel-connections/disconnect/route.ts"), "utf8");
  assert.equal(/revokeToken|agent-tokens/.test(source.replace(/\/\/.*$/gm, "")), false);
});

test("AC-ST-09: a local change publishes without applying the peers; a failed publish is retried by the next step", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a")] });
  const b = createDevice("dev-b", clock, { secrets: [SECRET("f")] });
  await b.factory.issueToken({});
  await b.sync.tick();
  await a.share.mergeIncoming(await b.share.exportBytes(), "dev-b"); // A has B's report but has not applied it
  await a.channel.issueToken({ channelId: "UC_A" });
  assert.deepEqual(await a.sync.tick({ applyPeers: false }), { applied: false, published: true });
  assert.equal(a.rows.some((row) => row.role === "factory"), false, "a publish-only step adds nothing from the peers");
  // A failed publish is not remembered as published: the next step publishes again.
  await a.channel.revokeToken({ channelId: "UC_A" });
  a.failPublishing(true);
  await assert.rejects(a.sync.tick({ applyPeers: false }));
  a.failPublishing(false);
  assert.deepEqual(await a.sync.tick({ applyPeers: false }), { applied: false, published: true });
});

test("AC-ST-11: with no peer reports nothing changes, and an unchanged report is not published again", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a")] });
  await a.channel.issueToken({ channelId: "UC_A" });
  assert.deepEqual(await a.sync.tick(), { applied: false, published: true });
  assert.deepEqual(await a.sync.tick(), { applied: false, published: false });
  assert.equal(a.rows.length, 1);
});

test("AC-ST-10 (real database): adopting a winning factory or producer token never trips the one-active index; the loser ends revoked", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-token-sync-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    await client.execute("INSERT INTO factory_agent_tokens (id, token_hash, created_at) VALUES ('f-local', 'old-factory', 1760004000)");
    await client.execute("INSERT INTO producer_agent_tokens (id, token_hash, created_at) VALUES ('p-local', 'old-producer', 1760004000)");
    const winnerAt = new Date(1760004300 * 1000);
    await applyAgentTokenSyncPlan(
      {
        revoke: [
          { role: "factory", tokenHash: "old-factory", revokedAt: winnerAt },
          { role: "producer", tokenHash: "old-producer", revokedAt: winnerAt },
        ],
        insert: [
          { id: "f-new", role: "factory", tokenHash: "new-factory", channelId: null, userId: null, label: null, createdAt: winnerAt, revokedAt: null },
          { id: "p-new", role: "producer", tokenHash: "new-producer", channelId: null, userId: null, label: "P", createdAt: winnerAt, revokedAt: null },
          { id: "c-new", role: "channel", tokenHash: "new-channel", channelId: "UC_A", userId: "user-a", label: null, createdAt: winnerAt, revokedAt: null },
        ],
      },
      database
    );
    const rows = await listAgentTokenRowsForSync(database);
    const state = Object.fromEntries(rows.map((row) => [row.tokenHash, row.revokedAt === null ? "active" : row.revokedAt.toISOString()]));
    assert.deepEqual(state, {
      "old-factory": winnerAt.toISOString(),
      "new-factory": "active",
      "old-producer": winnerAt.toISOString(),
      "new-producer": "active",
      "new-channel": "active",
    });
    // Applying the same plan again changes nothing (a revoked row is never touched, a known hash is not inserted twice).
    await applyAgentTokenSyncPlan({ revoke: [{ role: "factory", tokenHash: "old-factory", revokedAt: new Date(0) }], insert: [] }, database);
    assert.equal((await listAgentTokenRowsForSync(database)).find((row) => row.tokenHash === "old-factory")?.revokedAt?.toISOString(), winnerAt.toISOString());
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Independent review, round 1 (expected values from the same plan rules: a revocation reaches every device, the newest token wins
// everywhere, a token's createdAt is the earliest any device knows).
// ---------------------------------------------------------------------------------------------------------------------------------

test("review: a revocation still reaches a device that was off for more than a week (reports never go stale)", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("f")] });
  const c = createDevice("dev-c", clock);
  const token = (await a.factory.issueToken({})).token;
  await exchange(clock, a, c);
  assert.ok(await c.factory.verifyToken(token));
  // C is switched off; A revokes and publishes, then runs on for 8 days with no token change.
  await a.factory.revokeToken();
  await a.sync.tick();
  clock.now = new Date(clock.now.getTime() + 8 * 24 * 60 * 60_000);
  // C comes back and receives A's (8-day-old) report.
  await c.share.mergeIncoming(await a.share.exportBytes(), "dev-a");
  await c.sync.tick();
  await assert.rejects(c.factory.verifyToken(token), isInvalid);
});

test("review: an unchanged report is republished after a day, so its date stays fresh", async () => {
  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("f")] });
  await a.factory.issueToken({});
  assert.deepEqual(await a.sync.tick(), { applied: false, published: true });
  clock.now = new Date(clock.now.getTime() + 23 * 60 * 60_000);
  assert.deepEqual(await a.sync.tick(), { applied: false, published: false });
  clock.now = new Date(clock.now.getTime() + 2 * 60 * 60_000);
  assert.deepEqual(await a.sync.tick(), { applied: false, published: true });
});

test("review: a peer record created more than 5 minutes ahead is ignored and cannot win its slot", () => {
  const now = at("10:00");
  const own: AgentTokenRecord = { hash: "a".repeat(64), role: "producer", channelId: null, userId: null, label: null, createdAt: at("09:00"), revokedAt: null };
  const fromTheFuture: AgentTokenRecord = { ...own, hash: "b".repeat(64), createdAt: at("10:06") };
  assert.deepEqual(reconcileAgentTokens([own], [fromTheFuture], { now }), {
    revoke: [],
    insert: [],
    redate: [],
    ignored: [{ hash: fromTheFuture.hash, reason: "dated_in_future" }],
  });
  // Within 5 minutes it counts (and wins: it is newer).
  const slightlyAhead: AgentTokenRecord = { ...fromTheFuture, createdAt: at("10:04") };
  assert.deepEqual(reconcileAgentTokens([own], [slightlyAhead], { now }).revoke, [{ role: "producer", hash: own.hash, revokedAt: at("10:04") }]);
  // A revocation dated in the future still stops the token, as of now (review round 2: it can never win a slot).
  const futureRevocation: AgentTokenRecord = { ...own, revokedAt: at("11:00") };
  assert.deepEqual(reconcileAgentTokens([own], [futureRevocation], { now }).revoke, [{ role: "producer", hash: own.hash, revokedAt: now }]);
});

test("review: a token imported later on B takes the issue time from A, so every device publishes the same createdAt", async () => {
  const issued: AgentTokenRecord = { hash: "c".repeat(64), role: "channel", channelId: "UC_A", userId: "user-a", label: null, createdAt: at("10:00"), revokedAt: null };
  const importedOnB: AgentTokenRecord = { ...issued, createdAt: at("11:00") };
  assert.deepEqual(reconcileAgentTokens([importedOnB], [issued], { now: at("12:00") }).redate, [{ role: "channel", hash: issued.hash, createdAt: at("10:00") }]);
  // Never moved later.
  assert.deepEqual(reconcileAgentTokens([issued], [importedOnB], { now: at("12:00") }).redate, []);

  const clock = { now: at("10:00") };
  const a = createDevice("dev-a", clock, { secrets: [SECRET("a")] });
  const b = createDevice("dev-b", clock);
  const token = (await a.channel.issueToken({ channelId: "UC_A" })).token;
  clock.now = at("11:00");
  await b.channel.importToken({ channelId: "UC_A", token });
  assert.equal(b.rows[0].createdAt.toISOString(), at("11:00").toISOString());
  await exchange(clock, a, b);
  assert.equal(b.rows[0].createdAt.toISOString(), at("10:00").toISOString());
  const published = JSON.parse(new TextDecoder().decode(await b.share.exportBytes())) as { tokens: Array<{ createdAt: string }> };
  assert.deepEqual(published.tokens.map((t) => t.createdAt), [at("10:00").toISOString()]);
});

test("review round 2 (real database): a token issued here between planning and applying never leaves two active in a slot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-token-sync-race-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const t = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00Z`);
    // Issued here at 10:10 after the plan was computed; the plan still adds a peer's active factory token from 10:05.
    await client.execute(`INSERT INTO factory_agent_tokens (id, token_hash, created_at) VALUES ('f-here', 'here-1010', ${t("10:10").getTime() / 1000})`);
    await applyAgentTokenSyncPlan(
      { revoke: [], insert: [{ id: "f-peer", role: "factory", tokenHash: "peer-1005", channelId: null, userId: null, label: null, createdAt: t("10:05"), revokedAt: null }] },
      database
    );
    // A peer's NEWER channel token arrives while an older one is active here: the newer one wins, the older is revoked as of it.
    await client.execute(`INSERT INTO agent_channel_tokens (id, channel_id, user_id, token_hash, created_at) VALUES ('c-here', 'UC_A', 'user-a', 'here-1000', ${t("10:00").getTime() / 1000})`);
    await applyAgentTokenSyncPlan(
      { revoke: [], insert: [{ id: "c-peer", role: "channel", tokenHash: "peer-1015", channelId: "UC_A", userId: "user-a", label: null, createdAt: t("10:15"), revokedAt: null }] },
      database
    );
    const state = Object.fromEntries((await listAgentTokenRowsForSync(database)).map((row) => [row.tokenHash, row.revokedAt === null ? "active" : row.revokedAt.toISOString()]));
    assert.deepEqual(state, {
      "here-1010": "active",
      "peer-1005": t("10:10").toISOString(),
      "here-1000": t("10:15").toISOString(),
      "peer-1015": "active",
    });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("review round 3 (real database): a learned token already registered here meanwhile is left as it is -- never revokes itself", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-token-sync-self-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "test.db")}` });
  try {
    await initializeDatabaseSchema(client);
    const database = drizzle(client) as unknown as AppDb;
    const t = (hhmm: string) => new Date(`2026-10-09T${hhmm}:00Z`);
    // The same channel token imported here at 10:00 after the plan (which learned it from a peer at 10:02) was computed.
    await client.execute(`INSERT INTO agent_channel_tokens (id, channel_id, user_id, token_hash, created_at) VALUES ('c-here', 'UC_A', 'user-a', 'same-channel', ${t("10:00").getTime() / 1000})`);
    // The same producer token, equal times.
    await client.execute(`INSERT INTO producer_agent_tokens (id, token_hash, created_at) VALUES ('p-here', 'same-producer', ${t("10:00").getTime() / 1000})`);
    await applyAgentTokenSyncPlan(
      {
        revoke: [],
        insert: [
          { id: "c-peer", role: "channel", tokenHash: "same-channel", channelId: "UC_A", userId: "user-a", label: null, createdAt: t("10:02"), revokedAt: null },
          { id: "p-peer", role: "producer", tokenHash: "same-producer", channelId: null, userId: null, label: null, createdAt: t("10:00"), revokedAt: null },
        ],
      },
      database
    );
    const state = Object.fromEntries((await listAgentTokenRowsForSync(database)).map((row) => [row.tokenHash, row.revokedAt === null ? "active" : row.revokedAt.toISOString()]));
    assert.deepEqual(state, { "same-channel": "active", "same-producer": "active" });
  } finally {
    client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
