import assert from "node:assert/strict";
import test from "node:test";
import { createChannelConnectionsServices } from "./services";
import { DomainError } from "./contracts";

type FakeChannel = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  connectedUserId: string | null;
  connectedAt: Date;
};

type FakeUser = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

function createFixture(
  opts: {
    channels?: FakeChannel[];
    users?: FakeUser[];
    issuedAt?: Record<string, Date | null>;
    probeResults?: Record<string, "ok" | "invalid_grant" | "error">;
    now?: Date;
  } = {}
) {
  const probeCalls: string[] = [];
  const clock = { current: opts.now ?? new Date("2026-10-10T12:00:00Z") };
  const channels = new Map(opts.channels?.map((c) => [c.channelId, { ...c }]) ?? []);
  const users = new Map(opts.users?.map((u) => [u.userId, { ...u }]) ?? []);
  const revokeCalls: string[] = [];
  let revokeShouldThrow = false;

  const store = {
    async listChannels() {
      return [...channels.values()];
    },
    async getChannel(channelId: string) {
      return channels.get(channelId) ?? null;
    },
    async getUserProfile(userId: string) {
      const u = users.get(userId);
      if (!u) return null;
      return {
        userId: u.userId,
        email: u.email,
        name: u.name,
        image: u.image,
        hasAccessToken: !!u.accessToken,
      };
    },
    async getUserTokens(userId: string) {
      const u = users.get(userId);
      if (!u) return null;
      return { accessToken: u.accessToken, refreshToken: u.refreshToken };
    },
    async clearUserTokens(userId: string) {
      const u = users.get(userId);
      if (u) {
        u.accessToken = null;
        u.refreshToken = null;
      }
    },
    async setChannelConnectedUserId(channelId: string, connectedUserId: string | null) {
      const c = channels.get(channelId);
      if (c) c.connectedUserId = connectedUserId;
    },
    async getRefreshTokenIssuedAt(userId: string) {
      return opts.issuedAt?.[userId] ?? null;
    },
  };

  const revokeToken = async (token: string) => {
    revokeCalls.push(token);
    if (revokeShouldThrow) throw new Error("revoke failed");
  };

  const services = createChannelConnectionsServices({
    store,
    revokeToken,
    probeRefreshToken: async (token: string) => {
      probeCalls.push(token);
      return opts.probeResults?.[token] ?? "ok";
    },
    clock: { now: () => clock.current },
  });

  return {
    services,
    channels,
    users,
    revokeCalls,
    probeCalls,
    clock,
    setRevokeShouldThrow(value: boolean) {
      revokeShouldThrow = value;
    },
  };
}

test("listConnectedChannels returns only channels with a connected identity, with the connected email", async () => {
  const { services } = createFixture({
    channels: [
      {
        channelId: "chan-1",
        title: "Rural Japan Music",
        thumbnailUrl: "https://example.com/1.png",
        connectedUserId: "user-1",
        connectedAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        channelId: "chan-2",
        title: "Never connected",
        thumbnailUrl: null,
        connectedUserId: null,
        connectedAt: new Date("2026-09-02T00:00:00Z"),
      },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: "Owner", image: null, accessToken: "at-1", refreshToken: "rt-1" },
    ],
  });

  const result = await services.listConnectedChannels();

  assert.equal(result.length, 1);
  assert.equal(result[0].channelId, "chan-1");
  assert.equal(result[0].connectedEmail, "owner@example.com");
  assert.equal(result[0].connectedAt, "2026-09-01T00:00:00.000Z");
  assert.equal(result[0].isActive, false);
});

test("listConnectedChannels marks isActive by comparing the internal connectedUserId, not the public email", async () => {
  const { services } = createFixture({
    channels: [
      {
        channelId: "chan-1",
        title: "Channel A",
        thumbnailUrl: null,
        connectedUserId: "user-1",
        connectedAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        channelId: "chan-2",
        title: "Channel B (same Google account, different brand channel)",
        thumbnailUrl: null,
        connectedUserId: "user-2",
        connectedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ],
    users: [
      { userId: "user-1", email: "shared@example.com", name: null, image: null, accessToken: "at-1", refreshToken: "rt-1" },
      { userId: "user-2", email: "shared@example.com", name: null, image: null, accessToken: "at-2", refreshToken: "rt-2" },
    ],
  });

  const result = await services.listConnectedChannels("user-2");

  const chan1 = result.find((c) => c.channelId === "chan-1")!;
  const chan2 = result.find((c) => c.channelId === "chan-2")!;
  assert.equal(chan1.connectedEmail, chan2.connectedEmail, "sanity check: both rows share an email");
  assert.equal(chan1.isActive, false);
  assert.equal(chan2.isActive, true);
});

test("listConnectedChannels omits a channel whose connectedUserId points at a missing user row", async () => {
  const { services } = createFixture({
    channels: [
      {
        channelId: "chan-1",
        title: "Orphaned",
        thumbnailUrl: null,
        connectedUserId: "ghost-user",
        connectedAt: new Date("2026-09-01T00:00:00Z"),
      },
    ],
    users: [],
  });

  const result = await services.listConnectedChannels();
  assert.deepEqual(result, []);
});

test("resolveChannelIdentityForActivation returns the stored identity for a connected channel", async () => {
  const { services } = createFixture({
    channels: [
      {
        channelId: "chan-1",
        title: "Rural Japan Music",
        thumbnailUrl: null,
        connectedUserId: "user-1",
        connectedAt: new Date(),
      },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: "Owner", image: "https://img", accessToken: "at-1", refreshToken: "rt-1" },
    ],
  });

  const identity = await services.resolveChannelIdentityForActivation("chan-1");
  assert.deepEqual(identity, { userId: "user-1", email: "owner@example.com", name: "Owner", image: "https://img" });
});

test("resolveChannelIdentityForActivation fails closed for an unknown channel", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.resolveChannelIdentityForActivation("does-not-exist"),
    (err: unknown) => err instanceof DomainError && err.code === "channel_not_connected"
  );
});

test("resolveChannelIdentityForActivation fails closed for a channel that was disconnected", async () => {
  const { services } = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: null, connectedAt: new Date() },
    ],
  });
  await assert.rejects(
    () => services.resolveChannelIdentityForActivation("chan-1"),
    (err: unknown) => err instanceof DomainError && err.code === "channel_not_connected"
  );
});

test("resolveChannelIdentityForActivation fails closed when the stored user has no access token", async () => {
  const { services } = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: "user-1", connectedAt: new Date() },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: null, image: null, accessToken: null, refreshToken: null },
    ],
  });
  await assert.rejects(
    () => services.resolveChannelIdentityForActivation("chan-1"),
    (err: unknown) => err instanceof DomainError && err.code === "channel_not_connected"
  );
});

test("disconnectChannel revokes the refresh token, clears tokens, and unlinks the channel", async () => {
  const fixture = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: "user-1", connectedAt: new Date() },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: null, image: null, accessToken: "at-1", refreshToken: "rt-1" },
    ],
  });

  const result = await fixture.services.disconnectChannel("chan-1");

  assert.deepEqual(result, { disconnected: true, disconnectedUserId: "user-1" });
  assert.deepEqual(fixture.revokeCalls, ["rt-1"]);
  assert.equal(fixture.channels.get("chan-1")?.connectedUserId, null);
  assert.equal(fixture.users.get("user-1")?.accessToken, null);
  assert.equal(fixture.users.get("user-1")?.refreshToken, null);
});

test("disconnectChannel falls back to the access token for revocation when no refresh token is stored", async () => {
  const fixture = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: "user-1", connectedAt: new Date() },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: null, image: null, accessToken: "at-1", refreshToken: null },
    ],
  });

  await fixture.services.disconnectChannel("chan-1");
  assert.deepEqual(fixture.revokeCalls, ["at-1"]);
});

test("disconnectChannel is a safe no-op for a channel that is already disconnected", async () => {
  const fixture = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: null, connectedAt: new Date() },
    ],
  });

  const result = await fixture.services.disconnectChannel("chan-1");
  assert.deepEqual(result, { disconnected: false, disconnectedUserId: null });
  assert.deepEqual(fixture.revokeCalls, []);
});

test("disconnectChannel is a safe no-op for a channel id that does not exist", async () => {
  const fixture = createFixture();
  const result = await fixture.services.disconnectChannel("does-not-exist");
  assert.deepEqual(result, { disconnected: false, disconnectedUserId: null });
});

test("disconnectChannel still clears local state and reports success even when Google's revoke call fails", async () => {
  const fixture = createFixture({
    channels: [
      { channelId: "chan-1", title: "X", thumbnailUrl: null, connectedUserId: "user-1", connectedAt: new Date() },
    ],
    users: [
      { userId: "user-1", email: "owner@example.com", name: null, image: null, accessToken: "at-1", refreshToken: "rt-1" },
    ],
  });
  fixture.setRevokeShouldThrow(true);

  const result = await fixture.services.disconnectChannel("chan-1");

  assert.deepEqual(result, { disconnected: true, disconnectedUserId: "user-1" });
  assert.equal(fixture.channels.get("chan-1")?.connectedUserId, null);
  assert.equal(fixture.users.get("user-1")?.accessToken, null);
});

// ---- connection health (BL-115) ----

const HEALTH_NOW = new Date("2026-10-10T12:00:00Z");
const daysAgo = (d: number) => new Date(HEALTH_NOW.getTime() - d * 86_400_000);

function twoConnections(extra: Parameters<typeof createFixture>[0] = {}) {
  return createFixture({
    now: HEALTH_NOW,
    channels: [
      { channelId: "UC_A", title: "Alpha", thumbnailUrl: null, connectedUserId: "u-a", connectedAt: new Date(0) },
      { channelId: "UC_B", title: "Beta", thumbnailUrl: null, connectedUserId: "u-b", connectedAt: new Date(0) },
      { channelId: "UC_C", title: "Disconnected", thumbnailUrl: null, connectedUserId: null, connectedAt: new Date(0) },
    ],
    users: [
      { userId: "u-a", email: "a@example.com", name: null, image: null, accessToken: "ACCESS-A", refreshToken: "REFRESH-A" },
      { userId: "u-b", email: "b@example.com", name: null, image: null, accessToken: "ACCESS-B", refreshToken: "REFRESH-B" },
    ],
    ...extra,
  });
}

test("getConnectionHealth: only the non-active, dead connection is reauth_required; the active one stays ok; disconnected channels are omitted", async () => {
  const { services } = twoConnections({
    issuedAt: { "u-a": daysAgo(1), "u-b": daysAgo(8) },
    probeResults: { "REFRESH-B": "invalid_grant" },
  });
  const health = await services.getConnectionHealth("u-a");
  assert.deepEqual(
    health.map((h) => ({ channelId: h.channelId, state: h.state, isActive: h.isActive, ageDays: h.ageDays })),
    [
      { channelId: "UC_A", state: "ok", isActive: true, ageDays: 1 },
      { channelId: "UC_B", state: "reauth_required", isActive: false, ageDays: 8 },
    ]
  );
});

test("getConnectionHealth never exposes a token or the internal user id", async () => {
  const { services } = twoConnections({ issuedAt: { "u-a": daysAgo(1), "u-b": daysAgo(1) } });
  const serialized = JSON.stringify(await services.getConnectionHealth("u-a"));
  for (const secret of ["ACCESS-A", "REFRESH-A", "ACCESS-B", "REFRESH-B", "u-a", "u-b"]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
});

test("getConnectionHealth: a connection with no stored refresh token is reauth_required and is not probed", async () => {
  const { services, probeCalls, users } = twoConnections({ issuedAt: { "u-a": daysAgo(1), "u-b": daysAgo(1) } });
  users.get("u-b")!.refreshToken = null;
  const health = await services.getConnectionHealth("u-a");
  assert.equal(health.find((h) => h.channelId === "UC_B")?.state, "reauth_required");
  assert.deepEqual(probeCalls, ["REFRESH-A"]);
});

test("getConnectionHealth reuses a real check for 10 minutes, re-checks after, and forceRefresh bypasses the cache", async () => {
  const { services, probeCalls, clock } = twoConnections({ issuedAt: { "u-a": daysAgo(1), "u-b": daysAgo(1) } });
  await services.getConnectionHealth("u-a");
  assert.equal(probeCalls.length, 2);

  clock.current = new Date(HEALTH_NOW.getTime() + 9 * 60_000 + 59_000);
  await services.getConnectionHealth("u-a");
  assert.equal(probeCalls.length, 2, "within 10 minutes: cached");

  await services.getConnectionHealth("u-a", { forceRefresh: true });
  assert.equal(probeCalls.length, 4, "forceRefresh checks again");

  clock.current = new Date(clock.current.getTime() + 10 * 60_000);
  await services.getConnectionHealth("u-a");
  assert.equal(probeCalls.length, 6, "after 10 minutes: checked again");
});

test("getConnectionHealth: a failed real check (network) is never cached and never blocks: unknown age stays unknown, then recovers", async () => {
  const { services, probeCalls } = twoConnections({ probeResults: { "REFRESH-A": "error", "REFRESH-B": "error" } });
  const first = await services.getConnectionHealth("u-a");
  assert.deepEqual(first.map((h) => h.state), ["unknown", "unknown"]);
  assert.equal(first[0].checkedAt, null);
  await services.getConnectionHealth("u-a");
  assert.equal(probeCalls.length, 4, "an error result is retried on the next call");
});

test("getConnectionHealth: after a fresh sign-in stores a NEW refresh token, a cached invalid_grant for the old one is not reused", async () => {
  const { services, probeCalls, users } = twoConnections({
    issuedAt: { "u-a": daysAgo(1), "u-b": daysAgo(8) },
    probeResults: { "REFRESH-B": "invalid_grant" },
  });
  const before = await services.getConnectionHealth("u-a");
  assert.equal(before.find((h) => h.channelId === "UC_B")?.state, "reauth_required");

  users.get("u-b")!.refreshToken = "REFRESH-B-NEW"; // re-login completed within the 10-minute cache window
  const after = await services.getConnectionHealth("u-a");
  assert.equal(after.find((h) => h.channelId === "UC_B")?.state, "ok");
  assert.ok(probeCalls.includes("REFRESH-B-NEW"), "the new token was really checked");
});
