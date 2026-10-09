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
  assert.deepEqual(reconcileAgentTokens(local, forged), { revoke: [], insert: [], ignored: [] });

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
  assert.deepEqual(reconcileAgentTokens([older], [newer]), { revoke: [{ role: "channel", hash: older.hash, revokedAt: at("10:05") }], insert: [newer], ignored: [] });
  // On the device that holds the newer one: add the older one, already revoked as of 10:05.
  assert.deepEqual(reconcileAgentTokens([newer], [older]), { revoke: [], insert: [{ ...older, revokedAt: at("10:05") }], ignored: [] });
  // Equal times: "c…" > "a…", so the "c…" token wins whichever device computes it.
  const tie: AgentTokenRecord = { ...older, hash: "c".repeat(64) };
  assert.deepEqual(reconcileAgentTokens([older], [tie]).revoke, [{ role: "channel", hash: older.hash, revokedAt: at("10:00") }]);
  assert.deepEqual(reconcileAgentTokens([tie], [older]).revoke, []);
  // Different channels are different slots: both stay active.
  const otherChannel: AgentTokenRecord = { ...newer, channelId: "UC_B" };
  assert.deepEqual(reconcileAgentTokens([older], [otherChannel]).revoke, []);
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
    assert.deepEqual(reconcileAgentTokens([own], [peer]), { revoke: [], insert: [], ignored: [{ hash: own.hash, reason: "conflicts_with_local" }] });
  }
  // Two peers describing an unknown hash differently: neither is trusted.
  const p1: AgentTokenRecord = { ...own, hash: "e".repeat(64) };
  const p2: AgentTokenRecord = { ...p1, channelId: "UC_B" };
  assert.deepEqual(reconcileAgentTokens([], [p1, p2]), { revoke: [], insert: [], ignored: [{ hash: p1.hash, reason: "peers_disagree" }] });
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
