import assert from "node:assert/strict";
import test from "node:test";
import type { LiveChannelInfo } from "@/lib/channel-access";
import { createChannelInfoHandler } from "./route";

// BL-197 acceptance (owner, Telegram 2026-10-18, msgs 2984/2988): the header reads its channel from YouTube once per signed-in identity,
// then answers without YouTube; every answer still records the channel as the session's active one (ADR 0004).

const CHANNEL: LiveChannelInfo = { id: "UC_own", title: "Own channel", thumbnail: "https://t/1.jpg", videoCount: "42", subscriberCount: "1000" };

function harness(options: { live?: () => Promise<LiveChannelInfo | null>; userId?: () => string } = {}) {
  const liveReads: string[] = [];
  const activations: Array<{ userId: string; channelId: string }> = [];
  const memo = new Map<string, LiveChannelInfo>();
  const handler = createChannelInfoHandler({
    getSession: async () => ({ user: { id: options.userId ? options.userId() : "user-1" } }),
    readLiveChannel: async (userId) => {
      liveReads.push(userId);
      return options.live ? options.live() : CHANNEL;
    },
    activateChannel: async (args) => {
      activations.push(args);
    },
    memo: { recall: (userId) => memo.get(userId) ?? null, epoch: () => 0, remember: (userId, channel) => void memo.set(userId, channel) },
  });
  return { handler, liveReads, activations, memo };
}

test("channel-info: the first call reads YouTube, the next ones answer from the memo with no live read", async () => {
  const h = harness();
  const first = await (await h.handler()).json();
  const second = await (await h.handler()).json();
  const third = await (await h.handler()).json();

  assert.deepEqual(h.liveReads, ["user-1"]);
  assert.deepEqual(first, { channel: CHANNEL });
  assert.deepEqual(second, { channel: CHANNEL });
  assert.deepEqual(third, { channel: CHANNEL });
});

test("channel-info: every answer, remembered or live, records the channel as the session's active one", async () => {
  const h = harness();
  await h.handler();
  await h.handler();
  assert.deepEqual(h.activations, [
    { userId: "user-1", channelId: "UC_own" },
    { userId: "user-1", channelId: "UC_own" },
  ]);
});

test("channel-info: another signed-in identity gets its own live read, never the first identity's channel", async () => {
  let current = "user-1";
  const other: LiveChannelInfo = { ...CHANNEL, id: "UC_other", title: "Other" };
  const h = harness({ userId: () => current, live: async () => (current === "user-1" ? CHANNEL : other) });
  await h.handler();
  current = "user-2";
  const body = await (await h.handler()).json();

  assert.deepEqual(h.liveReads, ["user-1", "user-2"]);
  assert.equal(body.channel.id, "UC_other");
  assert.deepEqual(h.activations.at(-1), { userId: "user-2", channelId: "UC_other" });
});

test("channel-info: a failed live read answers 502, remembers nothing and activates nothing; the next call reads live again", async () => {
  let fail = true;
  const h = harness({
    live: async () => {
      if (fail) throw new Error("invalid_grant");
      return CHANNEL;
    },
  });
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const failed = await h.handler();
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, "channel_info_unavailable");
  } finally {
    console.error = originalError;
  }
  assert.equal(h.memo.size, 0);
  assert.deepEqual(h.activations, []);

  fail = false;
  const ok = await h.handler();
  assert.equal(ok.status, 200);
  assert.deepEqual(h.liveReads, ["user-1", "user-1"]);
});

test("channel-info: a grant with no channel answers channel null and is not remembered", async () => {
  const h = harness({ live: async () => null });
  assert.deepEqual(await (await h.handler()).json(), { channel: null });
  assert.deepEqual(await (await h.handler()).json(), { channel: null });
  assert.deepEqual(h.liveReads, ["user-1", "user-1"]);
  assert.deepEqual(h.activations, []);
});

test("channel-info: no session answers 401 without any read", async () => {
  const liveReads: string[] = [];
  const handler = createChannelInfoHandler({
    getSession: async () => null,
    readLiveChannel: async (userId) => {
      liveReads.push(userId);
      return CHANNEL;
    },
    activateChannel: async () => undefined,
    memo: { recall: () => null, epoch: () => 0, remember: () => undefined },
  });
  assert.equal((await handler()).status, 401);
  assert.deepEqual(liveReads, []);
});
