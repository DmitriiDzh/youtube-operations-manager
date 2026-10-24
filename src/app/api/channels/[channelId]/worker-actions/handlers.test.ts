import assert from "node:assert/strict";
import test from "node:test";
import type { WorkerActionLogEntry } from "@/lib/db";
import { createWorkerActionsGetHandler, WORKER_ACTIONS_SHOWN } from "./handlers";

// WORKER_CAPABILITIES_PLAN.md AC-WK-08: signed-in owner only; at most 100 rows of the channel in the address, newest first.

const context = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const entry = (channelId: string, target: string): WorkerActionLogEntry => ({
  id: 1,
  at: new Date("2026-10-24T10:00:00Z"),
  channelId,
  tokenId: "secret-token-id",
  tool: "playlist_update",
  target,
  detail: '{"privacyStatus":"private"}',
  outcome: "ok",
  errorCode: null,
});

test("AC-WK-08: 401 without a signed-in session, and the log is not read", async () => {
  let read = false;
  const GET = createWorkerActionsGetHandler({ getSession: async () => null, list: async () => ((read = true), []) });
  const response = await GET(new Request("http://localhost/x"), context("UC_T"));
  assert.equal(response.status, 401);
  assert.equal(read, false);
});

test("AC-WK-08: reads the address's channel with the 100-row limit and returns its rows", async () => {
  const asked: Array<[string, number]> = [];
  const GET = createWorkerActionsGetHandler({
    getSession: async () => ({ user: { id: "owner" } }),
    list: async (channelId, limit) => {
      asked.push([channelId, limit]);
      return [entry(channelId, "p1")];
    },
  });
  const response = await GET(new Request("http://localhost/x"), context("UC_T"));
  assert.equal(response.status, 200);
  assert.deepEqual(asked, [["UC_T", 100]]);
  assert.equal(WORKER_ACTIONS_SHOWN, 100);
  const body = (await response.json()) as { actions: Array<Record<string, unknown>> };
  assert.deepEqual(body.actions, [
    { at: "2026-10-24T10:00:00.000Z", tool: "playlist_update", target: "p1", detail: '{"privacyStatus":"private"}', outcome: "ok", errorCode: null },
  ]);
});
