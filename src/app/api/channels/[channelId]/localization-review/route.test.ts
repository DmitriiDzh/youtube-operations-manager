import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createReviewQueueHandler } from "./route";
import { createVideoReviewHandler } from "./[videoId]/route";

// BL-227 (LANGUAGES_REVIEW_PLAN.md §6): the review routes check the session and the active channel before reading anything.

const get = () => new Request("http://localhost/x");
const allow = { assertActiveChannel: async () => "UC_A" };
const deny = {
  assertActiveChannel: async () => {
    throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
  },
};

test("queue: 401 without a session, the channel check before the read, the queue answered", async () => {
  const reads: string[] = [];
  const listQueue = async (channelId: string) => (reads.push(channelId), []);
  assert.equal((await createReviewQueueHandler({ getSession: async () => null, channelAccess: allow, listQueue })(get(), { params: Promise.resolve({ channelId: "UC_A" }) })).status, 401);
  const refused = await createReviewQueueHandler({ getSession: async () => ({ user: { id: "u" } }), channelAccess: deny, listQueue })(get(), { params: Promise.resolve({ channelId: "UC_B" }) });
  assert.notEqual(refused.status, 200);
  assert.deepEqual(reads, []);
  const ok = await createReviewQueueHandler({ getSession: async () => ({ user: { id: "u" } }), channelAccess: allow, listQueue })(get(), { params: Promise.resolve({ channelId: "UC_A" }) });
  assert.deepEqual([ok.status, await ok.json(), reads], [200, { videos: [] }, ["UC_A"]]);
});

test("one video: the channel check before the read; null when nothing waits", async () => {
  const reads: string[] = [];
  const getReview = async (channelId: string, videoId: string) => (reads.push(`${channelId}/${videoId}`), null);
  const refused = await createVideoReviewHandler({ getSession: async () => ({ user: { id: "u" } }), channelAccess: deny, getReview })(get(), { params: Promise.resolve({ channelId: "UC_B", videoId: "v1" }) });
  assert.notEqual(refused.status, 200);
  const ok = await createVideoReviewHandler({ getSession: async () => ({ user: { id: "u" } }), channelAccess: allow, getReview })(get(), { params: Promise.resolve({ channelId: "UC_A", videoId: "v1" }) });
  assert.deepEqual([ok.status, await ok.json(), reads], [200, { review: null }, ["UC_A/v1"]]);
});
