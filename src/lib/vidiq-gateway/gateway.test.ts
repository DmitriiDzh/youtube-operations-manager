import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createVidiqGateway } from "./index";
import { balanceResult, paidResult, startFakeVidiqServer, type FakeVidiqServer } from "./testing/fake-server";

// BL-278 stage 1 (VIDIQ_INTEGRATION_PLAN.md §5 stage 1 and §6, ADR 0077 decisions 1 and 4): the gateway against a local fake of
// vidIQ's MCP server. No test reaches mcp.vidiq.com or reads a real key.

const KEY = "vq_SENTINEL_7f3a9c";
const UC = "UC" + "x".repeat(22);

async function withFake(run: (fake: FakeVidiqServer, outcomes: string[]) => Promise<void>) {
  const fake = await startFakeVidiqServer({ acceptKey: KEY });
  const outcomes: string[] = [];
  try {
    await run(fake, outcomes);
  } finally {
    await fake.close();
  }
}

function gatewayFor(fake: FakeVidiqServer, outcomes: string[], timeoutMs = 30_000) {
  return createVidiqGateway({ endpoint: fake.url, timeoutMs, connectTimeoutMs: 120_000, recordOutcome: async (outcome) => void outcomes.push(outcome) });
}

async function codeOf(run: () => Promise<unknown>): Promise<{ code: string | null; error: unknown }> {
  try {
    await run();
    return { code: null, error: null };
  } catch (error) {
    return { code: isDomainError(error) ? error.code : `not a DomainError: ${String(error)}`, error };
  }
}

function assertNoSentinel(value: unknown, label: string) {
  const text = value instanceof Error ? `${value.message} ${JSON.stringify((value as { details?: unknown }).details ?? null)} ${value.stack ?? ""}` : JSON.stringify(value);
  assert.equal(String(text).includes(KEY), false, `${label} carries the key`);
}

test("the endpoint override accepts only a loopback URL: the key can go nowhere but vidIQ or a local test server", () => {
  for (const endpoint of ["https://evil.example/mcp", "http://10.0.0.5/mcp", "https://mcp.vidiq.com.evil.example/mcp"]) {
    assert.throws(() => createVidiqGateway({ endpoint }), /loopback/, endpoint);
  }
  assert.doesNotThrow(() => createVidiqGateway({ endpoint: "http://127.0.0.1:9/mcp" }));
  assert.doesNotThrow(() => createVidiqGateway({ endpoint: "http://localhost:9/mcp" }));
});

test("balance: free, parsed from the fixture (150, resets 2026-12-26), the key only as the Bearer header", () =>
  withFake(async (fake, outcomes) => {
    const balance = await gatewayFor(fake, outcomes).balance(KEY);
    assert.equal(balance.totalCredits, 150);
    assert.equal(balance.renewableCredits, 150);
    assert.equal(balance.maxRenewableCredits, 150);
    assert.equal(balance.addOnCredits, 0);
    assert.equal(balance.type, "limited");
    assert.equal(balance.planName, "Free");
    assert.equal(balance.renewableResetsAt.slice(0, 10), "2026-12-26");
    assert.equal(balance.creditsUsed, 0);
    for (const r of fake.requests.filter((x) => x.httpMethod === "POST")) assert.equal(r.authorization, `Bearer ${KEY}`);
    assert.deepEqual(fake.toolCalls().map((c) => c.tool), ["vidiq_balance"]);
    assert.ok(outcomes.includes("allowed"));
    assertNoSentinel(balance, "balance");
  }));

test("AC-VQ-1.2 (gateway half): a key the server refuses (401) is vidiq_key_invalid, with no response text in the error", () =>
  withFake(async (fake, outcomes) => {
    const gateway = createVidiqGateway({ endpoint: fake.url, connectTimeoutMs: 120_000, recordOutcome: async (o) => void outcomes.push(o) });
    const wrong = "vq_WRONG_KEY_123";
    const { code, error } = await codeOf(() => gateway.balance(wrong));
    assert.equal(code, "vidiq_key_invalid");
    assert.equal(String((error as Error).message).includes("received authorization"), false);
    assert.equal(String((error as Error).message).includes(wrong), false);
  }));

test("AC-VQ-1.5: a tool not on the list is refused and the server receives no tools/call", () =>
  withFake(async (fake, outcomes) => {
    const gateway = gatewayFor(fake, outcomes);
    for (const tool of ["vidiq_coach_message_create", "vidiq_update_competitors", "vidiq_generate_titles", "vidiq_made_up"]) {
      assert.equal((await codeOf(() => gateway.callTool(KEY, tool, {}))).code, "vidiq_tool_not_allowed", tool);
    }
    assert.equal(fake.toolCalls().length, 0);
    assert.ok(outcomes.includes("blocked"));
  }));

test("AC-VQ-1.6: a renamed tool is vidiq_tool_missing after one re-read of the list; the drift report marks that row", () =>
  withFake(async (fake, outcomes) => {
    const gateway = gatewayFor(fake, outcomes);
    // vidIQ's list lacks vidiq_channel_stats but has vidiq_channel_stats_v2.
    fake.tools = fake.tools.map((t) => (t.name === "vidiq_channel_stats" ? { ...t, name: "vidiq_channel_stats_v2" } : t));
    const report = await gateway.listToolsChecked(KEY); // the list read (and kept for an hour)
    assert.equal(report.report.length, 18);
    assert.equal(report.report.find((r) => r.tool === "vidiq_channel_stats")?.state, "vidiq_tool_missing");
    assert.equal(report.report.find((r) => r.tool === "vidiq_similar_channels")?.state, "ok");
    const listsBefore = fake.requests.filter((r) => r.rpcMethod === "tools/list").length;
    assert.equal((await codeOf(() => gateway.callTool(KEY, "vidiq_channel_stats", { channelId: UC }))).code, "vidiq_tool_missing");
    assert.equal(fake.requests.filter((r) => r.rpcMethod === "tools/list").length, listsBefore + 1, "exactly one re-read before the refusal");
    assert.equal(fake.toolCalls().length, 0);
    // The re-read sees the tool back under its pinned name: the call goes.
    fake.tools = fake.tools.map((t) => (t.name === "vidiq_channel_stats_v2" ? { ...t, name: "vidiq_channel_stats" } : t));
    fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5) }));
    assert.equal((await gateway.callTool(KEY, "vidiq_channel_stats", { channelId: UC })).creditsUsed, 5);
  }));

test("AC-VQ-1.7: the live schema newly requiring a property is vidiq_schema_drift; nothing is sent", () =>
  withFake(async (fake, outcomes) => {
    fake.tools = fake.tools.map((t) => {
      if (t.name !== "vidiq_similar_channels") return t;
      const schema = t.inputSchema as { properties: Record<string, unknown> };
      return { ...t, inputSchema: { ...schema, properties: { ...schema.properties, region: { type: "string" } }, required: ["region"] } };
    });
    const gateway = gatewayFor(fake, outcomes);
    assert.equal((await codeOf(() => gateway.callTool(KEY, "vidiq_similar_channels", { niche: "cooking" }))).code, "vidiq_schema_drift");
    assert.equal(fake.toolCalls().length, 0);
    assert.equal((await gateway.listToolsChecked(KEY)).report.find((r) => r.tool === "vidiq_similar_channels")?.state, "vidiq_schema_drift");
  }));

test("AC-VQ-1.7: arguments the live schema rejects (but the pinned one accepts) are vidiq_schema_drift", () =>
  withFake(async (fake, outcomes) => {
    fake.tools = fake.tools.map((t) => {
      if (t.name !== "vidiq_similar_channels") return t;
      const schema = t.inputSchema as { properties: Record<string, Record<string, unknown>> };
      return { ...t, inputSchema: { ...schema, properties: { ...schema.properties, size: { type: "integer", minimum: 1, maximum: 5 } } } };
    });
    const gateway = gatewayFor(fake, outcomes);
    assert.equal((await codeOf(() => gateway.callTool(KEY, "vidiq_similar_channels", { niche: "cooking", size: 10 }))).code, "vidiq_schema_drift");
    assert.equal(fake.toolCalls().length, 0);
  }));

test("AC-VQ-1.8: readOnlyHint false on an allowlisted tool is vidiq_annotation_drift; comment_insights' documented false passes", () =>
  withFake(async (fake, outcomes) => {
    fake.tools = fake.tools.map((t) => (t.name === "vidiq_outliers" ? { ...t, annotations: { ...(t.annotations as object), readOnlyHint: false } } : t));
    fake.script.set("vidiq_comment_insights", () => ({ result: paidResult(5, { mcpJobId: "job-1", status: "inprogress" }) }));
    const gateway = gatewayFor(fake, outcomes);
    assert.equal((await codeOf(() => gateway.callTool(KEY, "vidiq_outliers", { keyword: "x" }))).code, "vidiq_annotation_drift");
    assert.equal(fake.toolCalls().length, 0);
    const insights = await gateway.callTool(KEY, "vidiq_comment_insights", { mode: "discover", niche: "cooking" });
    assert.equal(insights.statedCost, 5);
    assert.equal(insights.creditsUsed, 5);
    assert.deepEqual(fake.toolCalls().map((c) => c.tool), ["vidiq_comment_insights"]);
  }));

test("AC-VQ-1.9: a changed or missing Cost sentence is vidiq_cost_changed; nothing is sent", async () => {
  for (const description of ["Keywords.\n\nCost: 10 credit(s) per call.", "Keywords without a price."]) {
    await withFake(async (fake, outcomes) => {
      fake.tools = fake.tools.map((t) => (t.name === "vidiq_keyword_research" ? { ...t, description } : t));
      const gateway = gatewayFor(fake, outcomes);
      assert.equal((await codeOf(() => gateway.callTool(KEY, "vidiq_keyword_research", { keyword: "x" }))).code, "vidiq_cost_changed", description);
      assert.equal(fake.toolCalls().length, 0);
    });
  }
});

test("AC-VQ-1.15: userGoal never reaches the server; the arguments are sent otherwise unchanged", () =>
  withFake(async (fake, outcomes) => {
    fake.script.set("vidiq_similar_channels", () => ({ result: paidResult(5) }));
    const out = await gatewayFor(fake, outcomes).callTool(KEY, "vidiq_similar_channels", { channelId: UC, size: 10, userGoal: "context the agent should never forward" });
    assert.deepEqual(fake.toolCalls()[0].args, { channelId: UC, size: 10 });
    assert.equal(out.creditsUsed, 5);
    assert.equal(out.isError, false);
  }));

test("a tool answering isError is returned as such with vidIQ's own _credits.used (0)", () =>
  withFake(async (fake, outcomes) => {
    fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(0, { error: "not found" }, true) }));
    const out = await gatewayFor(fake, outcomes).callTool(KEY, "vidiq_channel_stats", { channelId: UC });
    assert.equal(out.isError, true);
    assert.equal(out.creditsUsed, 0);
  }));

test("429 is vidiq_rate_limited with retryAfterSeconds; 5xx is vidiq_unavailable; neither carries the response text", () =>
  withFake(async (fake, outcomes) => {
    const gateway = gatewayFor(fake, outcomes);
    fake.script.set("vidiq_channel_stats", () => ({ http: 429, headers: { "retry-after": "30" } }));
    const limited = await codeOf(() => gateway.callTool(KEY, "vidiq_channel_stats", { channelId: UC }));
    assert.equal(limited.code, "vidiq_rate_limited");
    assert.equal((limited.error as { details?: { retryAfterSeconds?: number } }).details?.retryAfterSeconds, 30);
    assertNoSentinel(limited.error, "429 error");
    fake.script.set("vidiq_channel_stats", () => ({ http: 503 }));
    const down = await codeOf(() => gateway.callTool(KEY, "vidiq_channel_stats", { channelId: UC }));
    assert.equal(down.code, "vidiq_unavailable");
    assert.equal((down.error as { details?: { requestSent?: boolean } }).details?.requestSent, true);
    assertNoSentinel(down.error, "503 error");
    assert.equal(fake.toolCalls().length, 2, "no retry");
  }));

test("a server that cannot be reached is vidiq_unavailable before anything was sent", async () => {
  const fake = await startFakeVidiqServer({ acceptKey: KEY });
  const url = fake.url;
  await fake.close();
  const gateway = createVidiqGateway({ endpoint: url, timeoutMs: 1_000, recordOutcome: async () => undefined });
  const { code, error } = await codeOf(() => gateway.balance(KEY));
  assert.equal(code, "vidiq_unavailable");
  assert.notEqual((error as { details?: { requestSent?: boolean } }).details?.requestSent, true);
});

test("a timeout after the call was sent is vidiq_outcome_unknown, never retried", () =>
  withFake(async (fake, outcomes) => {
    fake.script.set("vidiq_channel_stats", () => ({ delayMs: 10_000, hang: true }));
    const gateway = gatewayFor(fake, outcomes, 400);
    await gateway.listToolsChecked(KEY);
    const { code, error } = await codeOf(() => gateway.callTool(KEY, "vidiq_channel_stats", { channelId: UC }));
    assert.equal(code, "vidiq_outcome_unknown");
    assert.equal((error as { details?: { requestSent?: boolean } }).details?.requestSent, true);
    assert.equal(fake.toolCalls().length, 1);
  }));

test("a result over 256 KB is vidiq_result_too_large and still reports vidIQ's _credits.used", () =>
  withFake(async (fake, outcomes) => {
    fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5, { blob: "z".repeat(300 * 1024) }) }));
    const { code, error } = await codeOf(() => gatewayFor(fake, outcomes).callTool(KEY, "vidiq_channel_stats", { channelId: UC }));
    assert.equal(code, "vidiq_result_too_large");
    assert.equal((error as { details?: { creditsUsed?: number } }).details?.creditsUsed, 5);
  }));

test("pollJob is a free job_poll call; a balance result with other numbers parses those numbers", () =>
  withFake(async (fake, outcomes) => {
    fake.script.set("vidiq_job_poll", (args) => ({ result: paidResult(0, { mcpJobId: args.mcpJobId, status: "inprogress" }) }));
    fake.script.set("vidiq_balance", () => ({ result: balanceResult(42, "2027-01-26T00:00:00Z") }));
    const gateway = gatewayFor(fake, outcomes);
    const polled = await gateway.pollJob(KEY, "job-77");
    assert.equal(polled.creditsUsed, 0);
    assert.deepEqual(fake.toolCalls()[0].args, { mcpJobId: "job-77" });
    const balance = await gateway.balance(KEY);
    assert.equal(balance.totalCredits, 42);
    assert.equal(balance.renewableResetsAt, "2027-01-26T00:00:00Z");
  }));
