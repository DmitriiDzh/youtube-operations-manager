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

function createFixture(opts: { channels?: FakeChannel[]; users?: FakeUser[] } = {}) {
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
  };

  const revokeToken = async (token: string) => {
    revokeCalls.push(token);
    if (revokeShouldThrow) throw new Error("revoke failed");
  };

  const services = createChannelConnectionsServices({ store, revokeToken });

  return {
    services,
    channels,
    users,
    revokeCalls,
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
