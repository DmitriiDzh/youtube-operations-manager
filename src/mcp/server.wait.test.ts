import assert from "node:assert/strict";
import test from "node:test";
import { runInAgentSession } from "@/lib/agent-session";
import { insertPublishingUploads, listWorkerActionLogEntries, rawSqlClient } from "@/lib/db";
import { createRestartWhenIdleCore } from "@/lib/restart-when-idle";
import { createMcpServer, type ProducerSession } from "./server";

// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md AC-WT-06/10/11, §6 "Scoping" / "Restart interplay"): the channel worker's agent_wait
// and the Producer's producer_wait through their REAL session wrappers, on the runner's temporary database (this file only). Expected
// values from the plan: a wait is never counted in mcp_tool_calls (the restart's quiet window never sees it); a worker's wait is its
// own channel's (another channelId is CHANNEL_NOT_ACTIVE, another channel's upload answers exactly like a missing one) and writes no
// worker-log row; the Producer waits on upload / restart only (anything else invalid_request) and every call is in its call log.

type ToolResult = { isError?: boolean; content: Array<{ text: string }>; structuredContent?: Record<string, unknown> };
type Tools = Record<string, { handler: (args: unknown) => Promise<ToolResult> }>;

const mcpCalls = async () => Number((await rawSqlClient.execute("SELECT COUNT(*) AS n FROM gateway_call_events WHERE category = 'mcp_tool_calls'")).rows[0].n);
const payload = (result: ToolResult) => JSON.parse(result.content[0].text) as Record<string, unknown>;

async function inWorker<T>(channelId: string, fn: (tools: Tools) => Promise<T>): Promise<T> {
  const stub = new Proxy({}, { get: () => async () => ({}) }) as Parameters<typeof createMcpServer>[0];
  const server = createMcpServer(stub, { connectionEnabled: true, agentSession: { tokenId: `tok-${channelId}`, channelId, reverify: async () => {} } });
  const tools = (server as unknown as { _registeredTools: Tools })._registeredTools;
  return runInAgentSession({ tokenId: `tok-${channelId}`, channelId, userId: "u-1" }, () => fn(tools));
}

function producerTools(wait: ProducerSession["wait"], logged: string[]): Tools {
  const none = async () => ({});
  const session: ProducerSession = {
    tokenId: "p1",
    reverify: async () => {},
    resolveChannelUser: async () => null,
    recordCall: async (entry) => void logged.push(`${entry.tool}:${entry.channelId}:${entry.outcome}:${entry.errorCode}`),
    listChannels: async () => [],
    portfolioOverview: none,
    uploadMilestones: none,
    liveAnalytics: none,
    proposals: { submit: none, list: none, markDone: none },
    uploadQueue: { list: none, add: none, move: none, cancel: none },
    clipReviews: { submit: none, withdraw: none, list: none, get: none },
    imageReviews: { submit: none, withdraw: none, list: none, get: none },
    thumbnails: { replace: none },
    packageMetadata: { update: none },
    captions: { add: none },
    plans: { templateGet: none, templatePropose: none, get: none, list: none, move: none },
    wait,
  };
  const server = createMcpServer(undefined, { connectionEnabled: true, producerSession: session });
  return (server as unknown as { _registeredTools: Tools })._registeredTools;
}

const uploadRow = (id: string, channelId: string, status: "queued" | "done") => ({
  id,
  channelId,
  video: "V12",
  manifestPath: "04 Videos/11 November/1117 V12/V12_release.json",
  manifestSha256: `sha-${id}`,
  packageJson: "{}",
  settingsJson: "{}",
  publishAt: null,
  approvedBy: "u1",
  approvedAt: new Date("2026-11-17T08:00:00Z"),
  status,
  totalBytes: 1000,
  storedBytes: status === "done" ? 1000 : 0,
  publishAtAtInsert: false,
  stepsJson: "{}",
  attempts: 0,
  createdAt: new Date("2026-11-17T08:00:00Z"),
  updatedAt: new Date("2026-11-17T08:00:00Z"),
});

test("AC-WT-10: agent_wait is the worker's own channel's -- another channelId is CHANNEL_NOT_ACTIVE; another channel's upload is not_found like a missing id", async () => {
  assert.equal(await insertPublishingUploads([uploadRow("up_own", "UC_WT_A", "done"), uploadRow("up_other", "UC_WT_B", "done")]), true);
  await inWorker("UC_WT_A", async (tools) => {
    assert.ok(tools.agent_wait, "registered for a worker");
    const own = await tools.agent_wait.handler({ target: "upload", id: "up_own", timeoutSeconds: 1 });
    assert.equal(own.isError, undefined);
    assert.deepEqual([payload(own).final, payload(own).outcome, payload(own).id], [true, "succeeded", "up_own"]);
    // By video code: channelId put in (the worker's own), the newest row of that channel's V12.
    const byCode = payload(await tools.agent_wait.handler({ target: "upload", id: "V12", timeoutSeconds: 1 }));
    assert.equal(byCode.id, "up_own");

    const wrongChannel = await tools.agent_wait.handler({ target: "upload", id: "up_other", channelId: "UC_WT_B", timeoutSeconds: 1 });
    assert.equal(wrongChannel.isError, true);
    assert.equal((payload(wrongChannel).error as { code: string }).code, "CHANNEL_NOT_ACTIVE");

    const foreign = await tools.agent_wait.handler({ target: "upload", id: "up_other", timeoutSeconds: 1 });
    const missing = await tools.agent_wait.handler({ target: "upload", id: "up_nope", timeoutSeconds: 1 });
    assert.deepEqual(payload(foreign), { ok: false, error: { code: "not_found", message: "No upload with this id on this computer.", details: { target: "upload", id: "up_other" } } });
    assert.deepEqual(payload(missing).error, { code: "not_found", message: "No upload with this id on this computer.", details: { target: "upload", id: "up_nope" } });
  });
  assert.deepEqual(await listWorkerActionLogEntries("UC_WT_A", 10), [], "a wait is a read: no worker-log row");
});

test("AC-WT-11: producer_wait accepts upload and restart only (anything else invalid_request, logged); each call is in the Producer's call log", async () => {
  const logged: string[] = [];
  const reached: string[] = [];
  const tools = producerTools(
    {
      waitFor: async (input, scope) => {
        reached.push(`${JSON.stringify(input)}:${JSON.stringify(scope)}`);
        return { target: "upload", id: "up1", final: true, outcome: "succeeded", status: "done", snapshot: {}, waitedSeconds: 0 };
      },
    },
    logged
  );
  for (const target of ["media_job", "storyboard_review", "translation_request", "weekly_build"]) {
    const refused = await tools.producer_wait.handler({ target, id: "x" });
    assert.equal(refused.isError, true, target);
    assert.equal((payload(refused).error as { code: string }).code, "invalid_request", target);
  }
  assert.equal((await tools.producer_wait.handler({ target: "upload", id: "up1" })).isError, undefined);
  assert.equal((await tools.producer_wait.handler({ target: "restart", id: "current", timeoutSeconds: 30 })).isError, undefined);
  assert.deepEqual(reached, ['{"target":"upload","id":"up1"}:{"channelId":null}', '{"target":"restart","id":"current","timeoutSeconds":30}:{"channelId":null}']);
  assert.deepEqual(logged, [
    "producer_wait:null:error:invalid_request",
    "producer_wait:null:error:invalid_request",
    "producer_wait:null:error:invalid_request",
    "producer_wait:null:error:invalid_request",
    "producer_wait:null:ok:null",
    "producer_wait:null:ok:null",
  ]);
  // A wait for a channel's upload by code is logged under that channel and answers forChannelId.
  const byCode = await tools.producer_wait.handler({ target: "upload", id: "V12", channelId: "UC_WT_A" });
  assert.equal(payload(byCode).forChannelId, "UC_WT_A");
  assert.equal(logged.at(-1), "producer_wait:UC_WT_A:ok:null");
});

test("AC-WT-06: back-to-back agent_wait / producer_wait calls are never counted -- an open restart request's waitingFor shows no mcp_quiet from them", async () => {
  const before = await mcpCalls();
  const logged: string[] = [];
  const producer = producerTools({ waitFor: async () => ({ target: "restart", id: "r", final: false, outcome: "still_running", status: "open", snapshot: {}, waitedSeconds: 1 }) }, logged);
  await inWorker("UC_WT_C", async (tools) => {
    for (let i = 0; i < 3; i++) {
      // Real path on this database: no restart request here.
      const none = await tools.agent_wait.handler({ target: "restart", id: "current", timeoutSeconds: 1 });
      assert.equal((payload(none).error as { code: string }).code, "no_restart_request");
      await producer.producer_wait.handler({ target: "restart", id: "current", timeoutSeconds: 1 });
    }
  });
  assert.equal(await mcpCalls(), before, "no wait reached mcp_tool_calls");
  const status = await createRestartWhenIdleCore().status();
  assert.equal(status.waitingFor.some((reason) => reason.kind === "mcp_quiet"), false, JSON.stringify(status.waitingFor));
  // Control: a counted channel call does open the quiet window.
  await inWorker("UC_WT_C", (tools) => tools.agent_hold_restart.handler({ minutes: 1, reason: "control" }));
  assert.equal(await mcpCalls(), before + 1);
});

test("agent_wait input: until on a target that takes none is invalid_request; a storyboard missing in the worker's own channel is not_found", async () => {
  await inWorker("UC_WT_D", async (tools) => {
    const bad = await tools.agent_wait.handler({ target: "media_job", id: "j_missing", until: "ready", timeoutSeconds: 1 });
    assert.equal((payload(bad).error as { code: string }).code, "invalid_request");
    const unknownJob = await tools.agent_wait.handler({ target: "storyboard_review", id: "sb_x", timeoutSeconds: 1 });
    // The worker's channel is put in; a storyboard that does not exist there is not_found -- never another channel's data.
    assert.deepEqual(payload(unknownJob).error, { code: "not_found", message: "No storyboard_review with this id on this computer.", details: { target: "storyboard_review", id: "sb_x" } });
  });
});
