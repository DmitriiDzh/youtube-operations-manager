import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/batches/contracts";
import { createSendHandler } from "./route";

// BL-124 acceptance AC-SEND-02 / AC-SEND-04 at the route level: status mapping, session and active-channel checks, the 201 body.
const params = Promise.resolve({ channelId: "UC_A", changeSetId: "CS1" });
const request = () => new Request("http://localhost/api/channels/UC_A/change-sets/CS1/send", { method: "POST" });
const session = async () => ({ user: { id: "user-1" } });
const passAccess = { async assertActiveChannel() { return "UC_A"; } };
const batch = { id: "b1", channelId: "UC_A", status: "PENDING", concurrency: 1, dryRun: false, runId: null, createdAt: "t", startedAt: null, completedAt: null };

test("send route: success answers 201 with the batch id and counts", async () => {
  const handler = createSendHandler({
    getSession: session,
    channelAccess: passAccess,
    core: { createLiveBatchForChangeSet: async () => ({ batch: batch as never, changeCount: 3, videoCount: 2 }) },
  });

  const response = await handler(request(), { params });
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.batchId, "b1");
  assert.equal(body.changeCount, 3);
  assert.equal(body.videoCount, 2);
});

test("send route: Live writes off (live_writes_disabled) answers 503 and carries the code", async () => {
  const handler = createSendHandler({
    getSession: session,
    channelAccess: passAccess,
    core: {
      createLiveBatchForChangeSet: async () => {
        throw new DomainError({ code: "live_writes_disabled", message: "off" });
      },
    },
  });

  const response = await handler(request(), { params });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "live_writes_disabled");
});

test("send route: already in progress answers 409 with the batch id", async () => {
  const handler = createSendHandler({
    getSession: session,
    channelAccess: passAccess,
    core: {
      createLiveBatchForChangeSet: async () => {
        throw new DomainError({ code: "send_already_in_progress", message: "busy", details: { batchId: "b1" } });
      },
    },
  });

  const response = await handler(request(), { params });

  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).details, { batchId: "b1" });
});

test("send route: no session answers 401 and never reaches the core; a channel that is not the active one is refused before the core", async () => {
  let coreCalls = 0;
  const core = {
    createLiveBatchForChangeSet: async () => {
      coreCalls++;
      return { batch: batch as never, changeCount: 1, videoCount: 1 };
    },
  };

  const noSession = await createSendHandler({ getSession: async () => null, channelAccess: passAccess, core })(request(), { params });
  assert.equal(noSession.status, 401);

  const wrongChannel = await createSendHandler({
    getSession: session,
    channelAccess: {
      async assertActiveChannel(): Promise<string> {
        throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
      },
    },
    core,
  })(request(), { params });
  assert.equal(wrongChannel.status, 403);
  assert.equal(coreCalls, 0);
});
