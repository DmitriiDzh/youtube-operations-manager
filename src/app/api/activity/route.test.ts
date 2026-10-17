import assert from "node:assert/strict";
import test from "node:test";
import type { ActivitySummary } from "@/lib/activity-summary";
import { createActivityGetHandler } from "./route";

// BL-195 AC-FB-08 (UI_FEEDBACK_CLARITY_PLAN.md §4): a session is required; the summary is asked for the session's user only.

const empty: ActivitySummary = { channelId: null, items: [], sources: { operations: "no_channel", media_jobs: "no_channel", uploads: "no_channel", live_streams: "ok" }, at: "2026-10-17T10:00:00.000Z" };

test("401 without a session; the summary is never read", async () => {
  let asked = 0;
  const get = createActivityGetHandler({ getSession: async () => null, summary: async () => (asked++, empty) });
  assert.equal((await get()).status, 401);
  assert.equal(asked, 0);
});

test("with a session: the session user's summary, not cached", async () => {
  const users: string[] = [];
  const get = createActivityGetHandler({ getSession: async () => ({ user: { id: "u1" } }), summary: async (userId) => (users.push(userId), empty) });
  const response = await get();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), empty);
  assert.deepEqual(users, ["u1"]);
});

test("a failing summary is a 500 without its error text (it could carry a path, AC-FB-08)", async () => {
  const get = createActivityGetHandler({ getSession: async () => ({ user: { id: "u1" } }), summary: async () => Promise.reject(new Error("SQLITE_BUSY /Users/x/db")) });
  const response = await get();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal_error" });
});
