import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { balanceResult, paidResult } from "@/lib/vidiq-gateway/testing/fake-server";
import { createVidiqHarness, SENTINEL_KEY, type VidiqHarness } from "./testing/harness";

// BL-278 stage 1 acceptance (VIDIQ_INTEGRATION_PLAN.md §6, ADR 0077 decisions 3, 5 and 7). Expected values are written by hand
// from the plan, the fixture (150 credits, resets 2026-12-26) and vidIQ's stated contract.

const UC = "UC" + "q".repeat(22);
const NOW = new Date("2026-11-26T15:00:00Z");
const MIN = 60_000;

async function withHarness(run: (h: VidiqHarness) => Promise<void>, options: { timeoutMs?: number } = {}) {
  const h = await createVidiqHarness({ now: NOW, timeoutMs: options.timeoutMs });
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

async function failure(run: () => Promise<unknown>): Promise<{ code: string | null; details: Record<string, unknown> | null; error: unknown }> {
  try {
    await run();
    return { code: null, details: null, error: null };
  } catch (error) {
    if (!isDomainError(error)) return { code: `not a DomainError: ${String(error)}`, details: null, error };
    return { code: error.code, details: (error.details ?? null) as Record<string, unknown> | null, error };
  }
}

/** A ledger row as if an earlier call had happened (the store's own insert). */
async function priorRow(h: VidiqHarness, at: Date, creditsUsed: number | null, outcome: "ok" | "unknown" | "failed" = "ok", statedCost = 5, tool = "vidiq_outliers") {
  await h.store.insertLedger({ at, caller: "owner", tool, argsSha256: "0".repeat(64), statedCost, creditsUsed, outcome, errorCode: null, jobId: null, balanceAfter: null });
}

async function saveKey(h: VidiqHarness) {
  return h.services.saveKey({ apiKey: SENTINEL_KEY });
}

/** A fresh snapshot read just now (so the preflight does not re-read). */
async function freshSnapshot(h: VidiqHarness, totalCredits: number) {
  h.fake.script.set("vidiq_balance", () => ({ result: balanceResult(totalCredits) }));
  await h.services.refreshBalance();
}

test("AC-VQ-1.1: with no key the card is 'not configured', the switch cannot go on, and a call is vidiq_key_missing; nothing is sent", () =>
  withHarness(async (h) => {
    const status = await h.services.getStatus();
    assert.equal(status.key.state, "none");
    assert.equal(status.key.hint, null);
    assert.equal(status.enabled, false);
    assert.equal(status.balance, null);
    assert.equal((await failure(() => h.services.updateSettings({ enabled: true }))).code, "vidiq_key_missing");
    assert.equal((await h.services.getStatus()).enabled, false);
    // Even if the switch were on somehow, the key check refuses.
    await h.store.setSetting("vidiq_enabled", "true");
    assert.equal((await failure(() => h.services.callTool({ caller: "owner", tool: "vidiq_trend_categories", args: {} }))).code, "vidiq_key_missing");
    assert.equal(h.fake.requests.length, 0);
  }));

test("AC-VQ-1.2: a key the server refuses (401) stores nothing and is vidiq_key_invalid; the slot stays none", () =>
  withHarness(async (h) => {
    const refused = await failure(() => h.services.saveKey({ apiKey: "vq_some_wrong_key_0000" }));
    assert.equal(refused.code, "vidiq_key_invalid");
    assert.equal(await h.secret.state(), "none");
    assert.equal(h.secretRows.rows.size, 0);
    const status = await h.services.getStatus();
    assert.equal(status.key.state, "none");
    assert.equal(status.enabled, false);
    assert.equal(status.balance, null);
  }));

test("AC-VQ-1.3: a key the server accepts is stored, shows its last 4 characters, turns the switch on, and records the balance", () =>
  withHarness(async (h) => {
    const status = await saveKey(h);
    assert.equal(status.key.state, "set");
    assert.equal(status.key.hint, "3a9c");
    assert.equal(status.key.status, "ok");
    assert.equal(status.enabled, true);
    assert.equal(status.balance?.totalCredits, 150);
    assert.equal(status.balance?.renewableCredits, 150);
    assert.equal(status.balance?.maxRenewableCredits, 150);
    assert.equal(status.balance?.addOnCredits, 0);
    assert.equal(status.balance?.type, "limited");
    assert.equal(status.balance?.renewableResetsAt.slice(0, 10), "2026-12-26");
    assert.equal(status.balance?.readAt, NOW.toISOString());
    // Q5: the period is vidIQ's own cycle, ending at renewableResetsAt and starting one calendar month earlier.
    assert.equal(status.budget.periodEndsAt.slice(0, 10), "2026-12-26");
    assert.equal(status.budget.periodStartsAt.slice(0, 10), "2026-11-26");
    assert.equal(status.budget.monthly, 150);
    assert.equal(status.budget.spentInPeriod, 0);
    assert.equal(status.budget.remaining, 150);
    assert.equal(await h.secret.read(), SENTINEL_KEY);
  }));

test("Q6: replacing the key while the owner has switched the module off keeps it off; clearing turns it off and drops the balance", () =>
  withHarness(async (h) => {
    await saveKey(h);
    assert.equal((await h.services.updateSettings({ enabled: false })).enabled, false);
    const replaced = await saveKey(h);
    assert.equal(replaced.enabled, false, "only the first verified save (slot none -> set) turns it on");
    assert.equal((await h.services.updateSettings({ enabled: true })).enabled, true);
    const cleared = await h.services.clearKey();
    assert.equal(cleared.key.state, "none");
    assert.equal(cleared.enabled, false);
    assert.equal(cleared.balance, null);
    assert.equal((await saveKey(h)).enabled, true, "after a clear the next verified save is a first save again");
  }));

test("a balance snapshot belongs to the key it was read with: a new key discards the old one", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await freshSnapshot(h, 120);
    assert.equal((await h.services.getStatus()).balance?.totalCredits, 120);
    await h.secret.write("vq_other_key_written_elsewhere", { hints: { keyHint: "here" } });
    assert.equal((await h.services.getStatus()).balance, null);
  }));

test("AC-VQ-1.14: with the switch off every service entry is vidiq_disabled and sends nothing", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await h.services.updateSettings({ enabled: false });
    const sent = h.fake.requests.length;
    for (const run of [
      () => h.services.callTool({ caller: "owner", tool: "vidiq_trend_categories", args: {} }),
      () => h.services.callTool({ caller: "producer", tool: "vidiq_similar_channels", args: { channelId: UC } }),
      () => h.services.pollJob({ caller: "producer", mcpJobId: "job-1" }),
      () => h.services.refreshBalance(),
      () => h.services.checkConnection(),
    ]) {
      assert.equal((await failure(run)).code, "vidiq_disabled");
    }
    assert.equal(h.fake.requests.length, sent);
    // The status read still works (local data only).
    assert.equal((await h.services.getStatus()).enabled, false);
  }));

test("AC-VQ-1.10: budget 150 with 148 spent: a 5-credit call is vidiq_budget_exhausted (5, 2); a 0-credit call still runs", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await priorRow(h, new Date(NOW.getTime() - 30 * MIN), 100);
    await priorRow(h, new Date(NOW.getTime() - 20 * MIN), 48);
    await priorRow(h, new Date("2026-11-20T00:00:00Z"), 100); // before the period (starts 2026-11-26T14:01): not counted
    const refused = await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_similar_channels", args: { channelId: UC } }));
    assert.equal(refused.code, "vidiq_budget_exhausted");
    assert.equal(refused.details?.statedCost, 5);
    assert.equal(refused.details?.remainingBudget, 2);
    assert.equal(String(refused.details?.periodEndsAt).slice(0, 10), "2026-12-26");
    assert.equal(h.callsOf("vidiq_similar_channels"), 0);
    const ledger = (await h.services.getStatus()).ledger;
    assert.equal(ledger[0].outcome, "refused");
    assert.equal(ledger[0].errorCode, "vidiq_budget_exhausted");
    assert.equal(ledger[0].tool, "vidiq_similar_channels");
    h.fake.script.set("vidiq_trend_categories", () => ({ result: paidResult(0, { categories: [] }) }));
    const free = await h.services.callTool({ caller: "producer", tool: "vidiq_trend_categories", args: {} });
    assert.equal(free.creditsSpent, 0);
    assert.equal(h.callsOf("vidiq_trend_categories"), 1);
  }));

test("AC-VQ-1.11: a fresh snapshot of 3 credits with the budget untouched refuses a 5-credit call (vidiq_insufficient_credits)", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await freshSnapshot(h, 3);
    const refused = await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }));
    assert.equal(refused.code, "vidiq_insufficient_credits");
    assert.equal(h.callsOf("vidiq_channel_stats"), 0);
  }));

test("a snapshot older than 10 minutes is re-read (free) before a paid call: 3 then, 150 now, the call goes", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await freshSnapshot(h, 3);
    h.clock.at = new Date(NOW.getTime() + 11 * MIN);
    h.fake.script.set("vidiq_balance", () => ({ result: balanceResult(150) }));
    h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5) }));
    const out = await h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } });
    assert.equal(out.creditsSpent, 5);
    assert.equal(h.callsOf("vidiq_channel_stats"), 1);
  }));

test("AC-VQ-1.12: a paid call writes one row (stated 5, used 5, ok, the balance after); no retry", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5, { channel: { id: UC } }) }));
    h.fake.script.set("vidiq_balance", () => ({ result: balanceResult(145) }));
    const out = await h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC, userGoal: "x" } });
    assert.equal(out.creditsSpent, 5);
    assert.equal(out.statedCost, 5);
    assert.equal(out.isError, false);
    assert.equal(out.balance?.totalCredits, 145);
    assert.equal(h.callsOf("vidiq_channel_stats"), 1);
    const rows = (await h.services.getStatus()).ledger.filter((r) => r.tool === "vidiq_channel_stats");
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { caller: rows[0].caller, statedCost: rows[0].statedCost, creditsUsed: rows[0].creditsUsed, outcome: rows[0].outcome, errorCode: rows[0].errorCode, balanceAfter: rows[0].balanceAfter },
      { caller: "producer", statedCost: 5, creditsUsed: 5, outcome: "ok", errorCode: null, balanceAfter: 145 }
    );
    assert.match(rows[0].argsSha256, /^[0-9a-f]{64}$/);
    assert.equal((await h.services.getStatus()).budget.spentInPeriod, 5);
  }));

test("AC-VQ-1.12: an isError answer with _credits.used 0 counts 0", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(0, { error: "unknown channel" }, true) }));
    const out = await h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } });
    assert.equal(out.isError, true);
    assert.equal(out.creditsSpent, 0);
    const row = (await h.services.getStatus()).ledger.find((r) => r.tool === "vidiq_channel_stats");
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.creditsUsed, 0);
    assert.equal((await h.services.getStatus()).budget.spentInPeriod, 0);
  }));

test("AC-VQ-1.12: a timeout after sending is recorded unknown and counts the stated 5; the server saw exactly one tools/call", () =>
  withHarness(
    async (h) => {
      await saveKey(h);
      h.fake.script.set("vidiq_channel_stats", () => ({ delayMs: 10_000, hang: true }));
      assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }))).code, "vidiq_outcome_unknown");
      assert.equal(h.callsOf("vidiq_channel_stats"), 1);
      const status = await h.services.getStatus();
      const row = status.ledger.find((r) => r.tool === "vidiq_channel_stats");
      assert.equal(row?.outcome, "unknown");
      assert.equal(row?.creditsUsed, null);
      assert.equal(status.budget.spentInPeriod, 5);
    },
    { timeoutMs: 500 }
  ));

test("a failed call vidIQ charged (result too large) counts its real _credits.used", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5, { blob: "z".repeat(300 * 1024) }) }));
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }))).code, "vidiq_result_too_large");
    const status = await h.services.getStatus();
    const row = status.ledger.find((r) => r.tool === "vidiq_channel_stats");
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.creditsUsed, 5);
    assert.equal(row?.errorCode, "vidiq_result_too_large");
    assert.equal(status.budget.spentInPeriod, 5);
  }));

test("an overcharge (used above the pin) marks the tool drifted: its next call is vidiq_cost_changed and is not sent", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(7) }));
    const out = await h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } });
    assert.equal(out.creditsSpent, 7);
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }))).code, "vidiq_cost_changed");
    assert.equal(h.callsOf("vidiq_channel_stats"), 1);
    assert.equal((await h.services.checkConnection()).report.find((r) => r.tool === "vidiq_channel_stats")?.state, "vidiq_cost_changed");
  }));

test("AC-VQ-1.13: two paid calls started together with 5 credits of budget left: exactly one is sent", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await priorRow(h, new Date(NOW.getTime() - 5 * MIN), 145);
    h.fake.script.set("vidiq_similar_channels", () => ({ result: paidResult(5), delayMs: 50 }));
    const results = await Promise.allSettled([
      h.services.callTool({ caller: "producer", tool: "vidiq_similar_channels", args: { channelId: UC } }),
      h.services.callTool({ caller: "owner", tool: "vidiq_similar_channels", args: { channelId: "UC" + "r".repeat(22) } }),
    ]);
    assert.equal(h.callsOf("vidiq_similar_channels"), 1);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal(isDomainError(rejected.reason) ? rejected.reason.code : null, "vidiq_budget_exhausted");
  }));

test("AC-VQ-1.15: a handle as channelId is refused before sending and recorded as a refused row", () =>
  withHarness(async (h) => {
    await saveKey(h);
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: "@somebody" } }))).code, "vidiq_canonical_id_required");
    assert.equal(h.callsOf("vidiq_channel_stats"), 0);
    const row = (await h.services.getStatus()).ledger[0];
    assert.equal(row.outcome, "refused");
    assert.equal(row.creditsUsed, 0);
    assert.equal(row.errorCode, "vidiq_canonical_id_required");
  }));

test("comment_insights starts a job (row job_pending, counted at 5); job_poll accepts only a job id this ledger recorded", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_comment_insights", () => ({ result: paidResult(5, { mcpJobId: "job-abc", status: "inprogress" }) }));
    const started = await h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: { mode: "discover", niche: "home cooking" } });
    assert.deepEqual(started.job, { mcpJobId: "job-abc", status: "inprogress" });
    const status = await h.services.getStatus();
    const row = status.ledger.find((r) => r.tool === "vidiq_comment_insights");
    assert.equal(row?.outcome, "job_pending");
    assert.equal(row?.jobId, "job-abc");
    assert.equal(status.budget.spentInPeriod, 5);
    const sent = h.fake.toolCalls().length;
    assert.equal((await failure(() => h.services.pollJob({ caller: "producer", mcpJobId: "job-not-ours" }))).code, "vidiq_job_unknown");
    assert.equal(h.fake.toolCalls().length, sent);
    h.fake.script.set("vidiq_job_poll", () => ({ result: paidResult(0, { status: "inprogress" }) }));
    const polled = await h.services.pollJob({ caller: "producer", mcpJobId: "job-abc" });
    assert.equal(polled.creditsSpent, 0);
    assert.equal(h.callsOf("vidiq_job_poll"), 1);
  }));

test("the budget is an integer 0-100000; the status shows what is spent and what is left", () =>
  withHarness(async (h) => {
    await saveKey(h);
    for (const bad of [-1, 100_001, 1.5, "150", null]) assert.equal((await failure(() => h.services.updateSettings({ monthlyBudgetCredits: bad }))).code, "validation_failed", String(bad));
    await priorRow(h, new Date(NOW.getTime() - MIN), 40);
    const status = await h.services.updateSettings({ monthlyBudgetCredits: 2000 });
    assert.equal(status.budget.monthly, 2000);
    assert.equal(status.budget.spentInPeriod, 40);
    assert.equal(status.budget.remaining, 1960);
  }));

test("without a balance snapshot the period is the UTC calendar month", () =>
  withHarness(async (h) => {
    const status = await h.services.getStatus();
    assert.equal(status.budget.periodStartsAt, "2026-11-01T00:00:00.000Z");
    assert.equal(status.budget.periodEndsAt, "2026-12-01T00:00:00.000Z");
  }));

test("a snapshot whose reset date has passed rolls the period forward by whole months", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.clock.at = new Date("2026-12-27T10:00:00Z");
    const status = await h.services.getStatus();
    assert.equal(status.budget.periodStartsAt.slice(0, 10), "2026-12-26");
    assert.equal(status.budget.periodEndsAt.slice(0, 10), "2027-01-26");
  }));

test("checkConnection is the free drift report: 18 rows, all ok against the fixture, no tools/call", () =>
  withHarness(async (h) => {
    await saveKey(h);
    const calls = h.fake.toolCalls().length;
    const report = await h.services.checkConnection();
    assert.equal(report.report.length, 18);
    assert.ok(report.report.every((r) => r.state === "ok"), JSON.stringify(report.report.filter((r) => r.state !== "ok")));
    assert.equal(h.fake.toolCalls().length, calls);
  }));

test("AC-VQ-1.4: the sentinel key appears nowhere but the Bearer header the fake server receives", async () => {
  const captured: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of ["log", "warn", "error", "info"] as const) console[name] = (...args: unknown[]) => void captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  const outputs: unknown[] = [];
  const errors: unknown[] = [];
  const keep = async (run: () => Promise<unknown>) => {
    try {
      outputs.push(await run());
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await withHarness(
      async (h) => {
        await keep(() => saveKey(h)); // save
        await keep(() => h.services.getStatus()); // status read
        await keep(() => h.services.refreshBalance()); // balance read
        await keep(() => h.services.checkConnection()); // drift check
        h.fake.script.set("vidiq_channel_stats", () => ({ result: paidResult(5) }));
        await keep(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } })); // paid call
        await keep(() => h.services.callTool({ caller: "producer", tool: "vidiq_coach_message_create", args: {} })); // refused call
        h.fake.script.set("vidiq_channel_videos", () => ({ result: paidResult(0, { error: "boom" }, true) }));
        await keep(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_videos", args: { channelId: UC, videoFormat: "long" } })); // tool error (echoes the header)
        h.fake.script.set("vidiq_video_stats", () => ({ http: 500 }));
        await keep(() => h.services.callTool({ caller: "producer", tool: "vidiq_video_stats", args: { videoId: "abcdefghijk", granularity: "day" } })); // transport error, body echoes the header
        h.fake.script.set("vidiq_video_change_history", () => ({ http: 429, headers: { "retry-after": "5" } }));
        await keep(() => h.services.callTool({ caller: "producer", tool: "vidiq_video_change_history", args: { videoId: "abcdefghijk" } }));
        h.fake.listFailure = { http: 401 };
        await keep(() => h.services.checkConnection({ refresh: true }));
        h.fake.listFailure = null;
        await keep(() => h.services.getStatus());

        assert.ok(errors.length >= 4, `expected the refusals and failures to throw, got ${errors.length}`);
        const surfaces: Array<[string, string]> = [
          ["log lines", captured.join("\n") + h.logs.join("\n")],
          ["service outputs", JSON.stringify(outputs)],
          ["error messages and details", errors.map((e) => `${(e as Error).message} ${JSON.stringify((e as { details?: unknown }).details ?? null)}`).join("\n")],
          ["ledger rows", JSON.stringify(await h.store.listLedger({ limit: 1000 }))],
          ["app_settings values", JSON.stringify([...h.store.settings.entries()])],
          ["secret hints", JSON.stringify([...h.secretRows.rows.values()].map((r) => r.hints))],
        ];
        for (const [label, text] of surfaces) assert.equal(text.includes(SENTINEL_KEY), false, `${label} carry the key`);
        const posts = h.fake.requests.filter((r) => r.httpMethod === "POST");
        assert.ok(posts.length > 0);
        for (const r of posts) {
          assert.equal(r.authorization, `Bearer ${SENTINEL_KEY}`);
          assert.equal(JSON.stringify(r.args ?? null).includes(SENTINEL_KEY), false, "the key is never in a request body");
        }
      },
      { timeoutMs: 1_000 }
    );
  } finally {
    Object.assign(console, originals);
  }
});

// Independent review 2026-11-28. Expected values by hand from ADR 0077 decision 5 and its amendment 1.

const RAW_PAGE = { mode: "raw", cursor: "c".repeat(64) }; // a raw continuation page (cursor: 64 hex): pinned at 0 credits
const listReads = (h: VidiqHarness) => h.fake.requests.filter((r) => r.rpcMethod === "tools/list").length;

test("review 1: a free comment_insights page charged 5 blocks the tool until the owner acknowledges; then it is sent; a new overcharge blocks again", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.script.set("vidiq_comment_insights", () => ({ result: paidResult(5, { items: [] }) }));
    const first = await h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: RAW_PAGE });
    assert.equal(first.statedCost, 0);
    assert.equal(first.creditsSpent, 5);
    assert.deepEqual((await h.services.getStatus()).overchargedTools, ["vidiq_comment_insights"]);
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: RAW_PAGE }))).code, "vidiq_cost_changed");
    assert.equal(h.callsOf("vidiq_comment_insights"), 1);

    h.clock.at = new Date(NOW.getTime() + 1 * MIN);
    const acked = await h.services.acknowledgeOvercharges();
    assert.deepEqual(acked.overchargedTools, []);
    // The charge stays in the ledger and in the budget.
    const charged = acked.ledger.find((r) => r.tool === "vidiq_comment_insights" && r.outcome === "ok");
    assert.equal(charged?.creditsUsed, 5);
    assert.equal(acked.budget.spentInPeriod, 5);
    assert.equal((await h.services.checkConnection()).report.find((r) => r.tool === "vidiq_comment_insights")?.state, "ok");

    h.clock.at = new Date(NOW.getTime() + 2 * MIN);
    h.fake.script.set("vidiq_comment_insights", () => ({ result: paidResult(0, { items: [] }) }));
    assert.equal((await h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: RAW_PAGE })).creditsSpent, 0);
    assert.equal(h.callsOf("vidiq_comment_insights"), 2);

    h.clock.at = new Date(NOW.getTime() + 3 * MIN);
    h.fake.script.set("vidiq_comment_insights", () => ({ result: paidResult(5, { items: [] }) }));
    await h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: RAW_PAGE });
    assert.deepEqual((await h.services.getStatus()).overchargedTools, ["vidiq_comment_insights"]);
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_comment_insights", args: RAW_PAGE }))).code, "vidiq_cost_changed");
    assert.equal(h.callsOf("vidiq_comment_insights"), 3);
    assert.equal((await h.services.getStatus()).budget.spentInPeriod, 10);
  }));

test("review 1: acknowledging sends nothing to vidIQ and works with the module off", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await priorRow(h, new Date(NOW.getTime() - 5 * MIN), 9, "ok", 5, "vidiq_outliers");
    await h.services.updateSettings({ enabled: false });
    assert.deepEqual((await h.services.getStatus()).overchargedTools, ["vidiq_outliers"]);
    const sent = h.fake.requests.length;
    assert.deepEqual((await h.services.acknowledgeOvercharges()).overchargedTools, []);
    assert.equal(h.fake.requests.length, sent);
  }));

test("review 2: a call whose tool list cannot be read is recorded failed at 0 credits (not unknown); no tools/call goes out", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.gatewayClock.offsetMs = 61 * MIN; // the list read at key save has expired
    h.fake.listFailure = { http: 503 };
    const sent = h.fake.toolCalls().length;
    const refused = await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }));
    assert.equal(refused.code, "vidiq_unavailable");
    assert.equal(refused.details?.requestSent, false);
    assert.equal(h.fake.toolCalls().length, sent);
    const status = await h.services.getStatus();
    const row = status.ledger.find((r) => r.tool === "vidiq_channel_stats");
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.creditsUsed, 0);
    assert.equal(status.budget.spentInPeriod, 0);
  }));

test("review 2: a paid call reads the tool list at most once; the call sent is the one the drift check passed", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.gatewayClock.offsetMs = 61 * MIN;
    const lists = listReads(h);
    await h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } });
    assert.equal(listReads(h) - lists, 1);
    assert.equal(h.callsOf("vidiq_channel_stats"), 1);
  }));

test("review 2: checkConnection with the tool list failing is vidiq_unavailable, not sent; the ledger gets no possibly-charged row", () =>
  withHarness(async (h) => {
    await saveKey(h);
    h.fake.listFailure = { http: 502 };
    const refused = await failure(() => h.services.checkConnection());
    assert.equal(refused.code, "vidiq_unavailable");
    assert.equal(refused.details?.requestSent, false);
    assert.equal((await h.services.getStatus()).ledger.some((r) => r.outcome === "unknown"), false);
  }));

test("review 3: an HTTP 400 answer to a paid call is vidiq_answered_error; an unchanged balance afterwards settles the row to 0", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await freshSnapshot(h, 150);
    h.fake.script.set("vidiq_channel_stats", () => ({ http: 400 }));
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }))).code, "vidiq_answered_error");
    assert.equal(h.callsOf("vidiq_channel_stats"), 1);
    const status = await h.services.getStatus();
    const row = status.ledger.find((r) => r.tool === "vidiq_channel_stats");
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.errorCode, "vidiq_answered_error");
    assert.equal(row?.creditsUsed, 0);
    assert.equal(row?.balanceAfter, 150);
    assert.equal(status.budget.spentInPeriod, 0);
  }));

test("review 3: a JSON-RPC error answer with the balance lower afterwards keeps the stated 5 (another client may have spent)", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await freshSnapshot(h, 150);
    h.fake.script.set("vidiq_balance", () => ({ result: balanceResult(145) }));
    h.fake.script.set("vidiq_channel_stats", () => ({ rpcError: -32603 }));
    assert.equal((await failure(() => h.services.callTool({ caller: "producer", tool: "vidiq_channel_stats", args: { channelId: UC } }))).code, "vidiq_answered_error");
    const status = await h.services.getStatus();
    const row = status.ledger.find((r) => r.tool === "vidiq_channel_stats");
    assert.equal(row?.outcome, "failed");
    assert.equal(row?.creditsUsed, null);
    assert.equal(row?.balanceAfter, 145);
    assert.equal(status.budget.spentInPeriod, 5);
  }));

test("review 5: a pending row older than 15 minutes becomes unknown at the next status read (still counted); a 14-minute one stays", () =>
  withHarness(async (h) => {
    await h.store.insertLedger({ at: new Date(NOW.getTime() - 16 * MIN), caller: "producer", tool: "vidiq_outliers", argsSha256: "1".repeat(64), statedCost: 5, creditsUsed: null, outcome: "pending", errorCode: null, jobId: null, balanceAfter: null });
    await h.store.insertLedger({ at: new Date(NOW.getTime() - 14 * MIN), caller: "producer", tool: "vidiq_trending_videos", argsSha256: "2".repeat(64), statedCost: 5, creditsUsed: null, outcome: "pending", errorCode: null, jobId: null, balanceAfter: null });
    const status = await h.services.getStatus();
    const old = status.ledger.find((r) => r.tool === "vidiq_outliers");
    const recent = status.ledger.find((r) => r.tool === "vidiq_trending_videos");
    assert.equal(old?.outcome, "unknown");
    assert.equal(old?.errorCode, "vidiq_outcome_unknown");
    assert.equal(old?.creditsUsed, null);
    assert.equal(recent?.outcome, "pending");
    assert.equal(status.budget.spentInPeriod, 10);
  }));

test("review 5: a call also turns a stale pending row unknown before it reads the ledger", () =>
  withHarness(async (h) => {
    await saveKey(h);
    await h.store.insertLedger({ at: new Date(NOW.getTime() - 20 * MIN), caller: "owner", tool: "vidiq_outliers", argsSha256: "1".repeat(64), statedCost: 5, creditsUsed: null, outcome: "pending", errorCode: null, jobId: null, balanceAfter: null });
    await h.services.callTool({ caller: "producer", tool: "vidiq_trend_categories", args: {} });
    assert.equal(h.store.rows.find((r) => r.tool === "vidiq_outliers")?.outcome, "unknown");
  }));
