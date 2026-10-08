import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

function mutatingRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "POST" }));
}

function patchRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "PATCH" }));
}

function putRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "PUT" }));
}

function readRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "GET" }));
}

// AC-LOCK-01
test("proxy rejects a mutating /api/** request while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/channels/sync"));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.error, "operation_lock_held");
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy allows a GET request through even while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(readRequest("/api/channels"));
    // NextResponse.next() has no meaningful status of its own to assert beyond "not blocked" --
    // it is not a 409/423 rejection.
    assert.notEqual(response.status, 409);
    assert.notEqual(response.status, 423);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy never gates the device-handoff routes themselves (they manage the lock internally)", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const response = await proxy(mutatingRequest("/api/device-handoff/export"));
    assert.notEqual(response.status, 409);
    assert.notEqual(response.status, 423);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// BL-152: the interface-language route only sets a cookie on this browser; it must work whatever state the device is in.
test("proxy never gates the interface-language route, even while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "import");
  try {
    const response = await proxy(putRequest("/api/ui-language"));
    assert.notEqual(response.status, 409);
    assert.notEqual(response.status, 423);
    assert.notEqual(response.status, 503);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy allows a mutating request through when the device is available", async () => {
  const response = await proxy(mutatingRequest("/api/channels/sync"));
  assert.notEqual(response.status, 409);
  assert.notEqual(response.status, 423);
});

// Regression: an earlier version of src/proxy.ts gated every POST regardless of what it
// actually did, diverging from the CLI's/MCP's own read-only classification of these exact
// operations (video-metadata preview/transcript, localizations import preview, AI localization
// generate) -- found by independent review.
test("proxy never gates genuinely read-only POST preview/generate routes, even while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const readOnlyPaths = [
      "/api/video-metadata/preview",
      "/api/video-metadata/transcript",
      "/api/channels/chan-1/localizations/import/preview",
      "/api/channels/chan-1/ai-localization/generate",
      "/api/channels/chan-1/videos/v1/details/preview",
      // Phase 10 slice 4 -- generates a draft only, persists nothing.
      "/api/decision-engine/hypotheses/generate",
    ];
    for (const p of readOnlyPaths) {
      const response = await proxy(mutatingRequest(p));
      assert.notEqual(response.status, 409, `${p} must not be gated by the operation lock`);
      assert.notEqual(response.status, 423, `${p} must not be gated by recovery mode`);
    }
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// video-details/details/apply is a REAL, non-dry-run YouTube write (2026-09-20) -- unlike its
// own preview sibling above, it must NOT be exempt, so it stays behind the ordinary
// operation-lock gate exactly like every other real mutation.
test("proxy gates the video-details apply route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/channels/chan-1/videos/v1/details/apply"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 8 (BL-058): analytics/collect is a real local-state mutation (writes video_metrics_daily
// rows) -- unlike ai-localization's own `generate` (exempted because it persists nothing), this
// must stay behind the ordinary gate, not be added to EXEMPT_READ_ONLY_PATH_SUFFIXES.
test("proxy gates the analytics collect route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/channels/chan-1/analytics/collect"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 8 (BL-059): the auto-collect trigger is a POST that MAY perform the same real mutation --
// gated the same way, never exempted, even though it often no-ops.
test("proxy gates the analytics auto-collect route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/channels/chan-1/analytics/auto-collect"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 8 follow-up, slice 4 (weekly reports): the generate-if-due trigger is a POST that MAY
// perform a real local-persistence mutation (a new/replacement snapshot row) -- gated the same
// way, never exempted, even though it often no-ops (same reasoning as auto-collect above).
test("proxy gates the analytics weekly-reports generate-if-due route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/channels/chan-1/analytics/weekly-reports/generate-if-due"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 9 slice 9B: the market-intelligence auto-refresh trigger is a POST that MAY perform a real
// mutation (a new market_channel_snapshots/market_video_snapshots/collection-run row) -- gated the
// same way, never exempted, even though it often no-ops (same reasoning as auto-collect above).
test("proxy gates the market-intelligence collect-if-stale route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/collect-if-stale"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 9 slice 9C: discovery/candidate-lifecycle routes are real mutations (write candidate rows,
// a run-log row, or a new watchlist entry) -- gated the same way, never exempted.
test("proxy gates the market-intelligence discover route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/discover"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence discovery-candidates status-update route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(patchRequest("/api/market-intelligence/discovery-candidates/UC_TEST0000000000000"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence discovery-candidates promote route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/discovery-candidates/UC_TEST0000000000000/promote"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 9 slice 9E, part A: topic/assignment routes are real mutations (write topic/assignment
// rows) -- gated the same way, never exempted.
test("proxy gates the market-intelligence topics route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/topics"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence topic-assignments route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/topics/topic-1/assignments"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 9 slice 9E, part B: trend-candidate/evidence routes are real mutations (write trend
// candidate/evidence rows) -- gated the same way, never exempted.
test("proxy gates the market-intelligence trend-candidates route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/trend-candidates"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence trend-candidate status-update route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(patchRequest("/api/market-intelligence/trend-candidates/trend-1"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence trend-candidate evidence route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/trend-candidates/trend-1/evidence"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// AC-9G-B-12 (docs/roadmap/plans/PHASE_9_SLICE_9G_PART_B_PLAN.md §8) -- the Web-UI-only
// approve/reject routes are real mutations (the approve route also triggers a real search.list
// call), gated the same way, never exempted.
test("proxy gates the market-intelligence research-request approve route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/research-requests/req-1/approve"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the market-intelligence research-request reject route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/market-intelligence/research-requests/req-1/reject"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- decision-engine's mutating
// routes are real local-DB writes, gated the same way as every other mutation, never exempted.
test("proxy gates the decision-engine create-hypothesis route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/hypotheses"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the decision-engine create-experiment route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/hypotheses/hyp-1/experiments"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the decision-engine experiment-transition route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/experiments/exp-1/transition"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the decision-engine create-outcome route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/experiments/exp-1/outcomes"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md) -- adding a structured evidence
// reference is a real local-DB write (a new hypothesis_evidence row), gated the same way.
test("proxy gates the decision-engine add-hypothesis-evidence route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/hypotheses/hyp-1/evidence"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 10 slice 4 -- unlike its own sibling `.../hypotheses/generate` (exempt, draft-only), this
// route DOES persist a real hypothesis/evidence/provenance and must stay behind the normal gate.
test("proxy gates the decision-engine generate/save route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/hypotheses/generate/save"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 10 slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md) -- attaching/detaching a Change
// Set is a real local-DB write, and executing creates a real Batch -- both stay behind the normal
// gate exactly like every other mutating decision-engine route.
test("proxy gates the decision-engine set-change-set route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(putRequest("/api/decision-engine/experiments/exp-1/change-set"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("proxy gates the decision-engine execute-experiment route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(mutatingRequest("/api/decision-engine/experiments/exp-1/execute"));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 11 (docs/roadmap/plans/PHASE_11_PLAN.md) -- the operator-only set path for a channel
// workspace is a real local mutation, gated like every other one.
test("proxy gates the channel-workspaces PUT route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(new NextRequest(new Request("http://localhost/api/channel-workspaces", { method: "PUT" })));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md 12.1) -- issuing/revoking agent tokens are real local
// mutations, gated like every other one.
test("proxy gates issuing an agent token (POST) like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(new NextRequest(new Request("http://localhost/api/agent-tokens", { method: "POST" })));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// Architecture audit 2026-10-01 (H4, AC-H4-1/2, refined after review): the operator's stop switches
// pass the gate in RECOVERY MODE, but (like everything else) not while the operation lock is held;
// neighbouring routes stay fully gated.
test("AC-H4: stop switches are exempt from recovery mode only; the operation lock still blocks them", async () => {
  const stopSwitches: Array<[string, string]> = [
    ["POST", "/api/settings"],
    ["DELETE", "/api/agent-tokens"],
    ["DELETE", "/api/factory-agent-token"],
    ["POST", "/api/channel-connections/disconnect"],
  ];
  const neighbours: Array<[string, string]> = [
    ["PUT", "/api/settings"],
    ["POST", "/api/agent-tokens"],
    ["POST", "/api/factory-agent-token"],
    // BL-130 AC-TI-12: importing a token is a registration, not a stop switch.
    ["POST", "/api/agent-tokens/import"],
    ["POST", "/api/factory-agent-token/import"],
    ["PUT", "/api/logical-paths/value"],
    ["DELETE", "/api/logical-paths"],
    ["POST", "/api/channel-connections/disconnect/extra"],
    ["PUT", "/api/channel-workspaces"],
  ];
  const call = (method: string, pathname: string) => proxy(new NextRequest(new Request(`http://localhost${pathname}`, { method })));

  await acquireOperationLock(rawSqlClient, "import");
  try {
    for (const [method, pathname] of [...stopSwitches, ...neighbours]) {
      assert.equal((await call(method, pathname)).status, 409, `${method} ${pathname} under the lock`);
    }
  } finally {
    await releaseOperationLock(rawSqlClient);
  }

  const channelId = `chan-h4-${Date.now()}`;
  await rawSqlClient.execute({ sql: "INSERT INTO channels (id, title, uploads_playlist_id) VALUES (?, ?, ?)", args: [channelId, "H4", "UU_H4"] });
  await rawSqlClient.execute({ sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)", args: [`${channelId}-b`, channelId, "RUNNING"] });
  await rawSqlClient.execute({
    sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
    args: [`${channelId}-r`, `${channelId}-b`, "v1", "[]", "UNKNOWN"],
  });
  try {
    for (const [method, pathname] of stopSwitches) {
      assert.notEqual((await call(method, pathname)).status, 423, `${method} ${pathname} in recovery mode`);
    }
    for (const [method, pathname] of neighbours) {
      assert.equal((await call(method, pathname)).status, 423, `${method} ${pathname} in recovery mode`);
    }
  } finally {
    await rawSqlClient.execute({ sql: "DELETE FROM batch_ledger_rows WHERE id = ?", args: [`${channelId}-r`] });
    await rawSqlClient.execute({ sql: "DELETE FROM batches WHERE id = ?", args: [`${channelId}-b`] });
    await rawSqlClient.execute({ sql: "DELETE FROM channels WHERE id = ?", args: [channelId] });
  }
});



// Phase 12 slice 12.4 -- assigning market records to channels is a real local mutation.
test("proxy gates the market-assignments PUT route like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const response = await proxy(new NextRequest(new Request("http://localhost/api/market-assignments", { method: "PUT" })));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// docs/roadmap/plans/HTTP_MCP_SERVER_PLAN.md AC-HM-11: every MCP call is a POST (reads included), so the
// in-app agent endpoint must not be blocked by the device gate; other mutating routes still are.
test("AC-HM-11: only /api/mcp itself is exempt -- a sibling like /api/mcp-x or /api/mcpx stays gated", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    assert.equal((await proxy(mutatingRequest("/api/mcp/"))).status, 200);
    for (const path of ["/api/mcp-x", "/api/mcpx", "/api/mcp2/foo"]) {
      assert.equal((await proxy(mutatingRequest(path))).status, 409, path);
    }
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

test("AC-HM-11: /api/mcp is not blocked by the operation lock, while another mutating route still is", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const mcp = await proxy(mutatingRequest("/api/mcp"));
    assert.equal(mcp.status, 200);
    assert.equal(mcp.headers.get("x-middleware-next"), "1");
    const other = await proxy(mutatingRequest("/api/channels/sync"));
    assert.equal(other.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});
