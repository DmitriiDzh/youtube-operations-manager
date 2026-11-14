import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

// A real HTTP request always carries Host (BL-251: a request without one is treated as remote and gated).
const LOCAL = { host: "localhost:3000" };

function mutatingRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "POST", headers: LOCAL }));
}

function patchRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "PATCH", headers: LOCAL }));
}

function putRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "PUT", headers: LOCAL }));
}

function readRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "GET", headers: LOCAL }));
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
    const response = await proxy(new NextRequest(new Request("http://localhost/api/channel-workspaces", { method: "PUT", headers: LOCAL })));
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
    const response = await proxy(new NextRequest(new Request("http://localhost/api/agent-tokens", { method: "POST", headers: LOCAL })));
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
    // BL-161: revoking the Producer's token is the same kind of stop switch.
    ["DELETE", "/api/producer-agent-token"],
    ["POST", "/api/channel-connections/disconnect"],
    // BL-231: STOP of the factory's weekly build.
    ["POST", "/api/channels/UC1/weekly-build/stop"],
  ];
  const neighbours: Array<[string, string]> = [
    ["PUT", "/api/settings"],
    ["POST", "/api/agent-tokens"],
    ["POST", "/api/factory-agent-token"],
    // BL-130 AC-TI-12: importing a token is a registration, not a stop switch.
    ["POST", "/api/agent-tokens/import"],
    ["POST", "/api/factory-agent-token/import"],
    ["POST", "/api/producer-agent-token"],
    ["POST", "/api/producer-agent-token/import"],
    ["PUT", "/api/logical-paths/value"],
    ["DELETE", "/api/logical-paths"],
    ["POST", "/api/channel-connections/disconnect/extra"],
    ["PUT", "/api/channel-workspaces"],
    ["POST", "/api/channels/UC1/weekly-build/start"],
    ["POST", "/api/channels/UC1/weekly-build/stop/extra"],
  ];
  const call = (method: string, pathname: string) => proxy(new NextRequest(new Request(`http://localhost${pathname}`, { method, headers: LOCAL })));

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
    const response = await proxy(new NextRequest(new Request("http://localhost/api/market-assignments", { method: "PUT", headers: LOCAL })));
    assert.equal(response.status, 409);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});

// BL-163: the owner's proposal decisions and the watchlist pause / inactivity settings are real mutations, gated like the rest.
test("proxy gates the agent-proposal approve/reject and the watchlist pause/inactivity routes like any other real mutation", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    for (const path of [
      "/api/agent-proposals/p-1/approve",
      "/api/agent-proposals/p-1/reject",
      "/api/market-intelligence/channels/UCaaaaaaaaaaaaaaaaaaaaaa/pause",
      "/api/market-intelligence/inactivity",
    ]) {
      assert.equal((await proxy(mutatingRequest(path))).status, 409, path);
    }
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

// ---- BL-251 (docs/roadmap/plans/REMOTE_ACCESS_PLAN.md AC-RA-3/6): requests from the owner's other devices (tailscale serve).
// What a real `tailscale serve` delivered (measured 2026-11-14); and what Next.js adds to the Mac's own requests.
const TS = { host: "mac.tail1234.ts.net", "x-forwarded-for": "100.64.0.7", "x-forwarded-host": "mac.tail1234.ts.net", "tailscale-user-login": "owner@example.com", "tailscale-user-name": "Owner" };
const NEXT_LOCAL = { host: "127.0.0.1:3000", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "http", "x-forwarded-port": "3000" };
const remoteReq = (method: string, pathname: string, extra: Record<string, string> = {}) =>
  new NextRequest(new Request(`http://127.0.0.1:3000${pathname}`, { method, headers: { ...TS, ...extra } }));

async function remoteOn(on: boolean) {
  const { getRemoteAccess } = await import("@/lib/remote-access");
  const ra = getRemoteAccess();
  await ra.setPassword("correct horse");
  await ra.setEnabled(on);
  return ra;
}

test("AC-RA-3: switch off -- every remote request is refused, a page and an API; local requests untouched", async () => {
  await remoteOn(false);
  assert.equal((await proxy(remoteReq("GET", "/home"))).status, 403);
  const api = await proxy(remoteReq("GET", "/api/channels"));
  assert.equal(api.status, 403);
  assert.equal((await api.json()).error, "remote_access_disabled");
  assert.equal((await proxy(remoteReq("POST", "/api/device-handoff/export", { origin: "https://mac.tail1234.ts.net" }))).status, 403); // before its exemption
  assert.equal((await proxy(readRequest("/api/channels"))).status, 200);
  // security review C1: the Mac's own request carries Next's loopback x-forwarded-* -- it must still pass with the switch off
  assert.equal((await proxy(new NextRequest(new Request("http://127.0.0.1:3000/api/channels", { headers: NEXT_LOCAL })))).status, 200);
  assert.equal((await proxy(new NextRequest(new Request("http://127.0.0.1:3000/home", { headers: NEXT_LOCAL })))).status, 200);
});

test("AC-RA-3: switch on -- MCP and Mac-only routes 403, CSRF origin enforced, the password callback passes", async () => {
  await remoteOn(true);
  const origin = { origin: "https://mac.tail1234.ts.net" };
  for (const p of ["/api/mcp", "/api/mcp/factory", "/api/agent-tokens", "/api/cloud-credentials/export", "/api/auth/signin/google",
    "/api/gemini-media/key", "/api/elevenlabs-speech/key", "/api/media-generation/credentials", "/api/logical-paths/value",
    "/api/channel-connections/disconnect"]) {
    const r = await proxy(remoteReq("POST", p, origin));
    assert.equal(r.status, 403, p);
    assert.equal((await r.json()).error, "remote_access_mac_only", p);
  }
  assert.equal((await proxy(remoteReq("PUT", "/api/remote-access", origin))).status, 403);
  assert.equal((await proxy(remoteReq("GET", "/api/remote-access"))).status, 200);
  assert.equal((await proxy(remoteReq("POST", "/api/channels/sync"))).status, 403); // no Origin
  assert.equal((await proxy(remoteReq("POST", "/api/channels/sync", { origin: "https://evil.example" }))).status, 403);
  assert.equal((await proxy(remoteReq("POST", "/api/auth/callback/remote-password", origin))).status, 200);
  assert.equal((await proxy(remoteReq("GET", "/home"))).status, 200);
});

test("AC-RA-6: a phone session works only with the current epoch; a stale one is signed out", async () => {
  const ra = await remoteOn(true);
  const { encode } = await import("next-auth/jwt");
  const previous = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = "test-secret-remote-access";
  try {
    const { epoch } = await ra.verifyPassword("correct horse", "owner@example.com");
    const cookie = async (claims: Record<string, unknown>) =>
      `next-auth.session-token=${await encode({ token: { sub: "u1", ...claims }, secret: "test-secret-remote-access" })}`;
    const good = await cookie({ remote: true, remoteEpoch: epoch });
    assert.equal((await proxy(remoteReq("GET", "/api/channels", { cookie: good }))).status, 200);
    const notRemote = await cookie({});
    assert.equal((await proxy(remoteReq("GET", "/api/channels", { cookie: notRemote }))).status, 401);
    await ra.setPassword("another horse"); // bumps the epoch
    assert.equal((await proxy(remoteReq("GET", "/api/channels", { cookie: good }))).status, 401);
    const session = await proxy(remoteReq("GET", "/api/auth/session", { cookie: good }));
    assert.deepEqual(await session.json(), {});
  } finally {
    if (previous === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previous;
  }
});

test("BL-251 (msg 4236): the shell's status reads work from a phone session; their actions stay Mac-only", async () => {
  const ra = await remoteOn(true);
  const { encode } = await import("next-auth/jwt");
  const previous = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = "test-secret-remote-access";
  try {
    const { epoch } = await ra.verifyPassword("correct horse", "owner@example.com");
    const good = `next-auth.session-token=${await encode({ token: { sub: "u1", remote: true, remoteEpoch: epoch }, secret: "test-secret-remote-access" })}`;
    const origin = { origin: "https://mac.tail1234.ts.net", cookie: good };
    for (const p of ["/api/operation-lock", "/api/device-sync/status", "/api/device-sync/divergence", "/api/cloud-connection/status"]) {
      assert.equal((await proxy(remoteReq("GET", p, { cookie: good }))).status, 200, p);
      assert.equal((await proxy(remoteReq("GET", p))).status, 401, `${p} without a session`);
    }
    for (const [m, p] of [["POST", "/api/operation-lock"], ["DELETE", "/api/operation-lock"], ["POST", "/api/device-sync/sync-now"],
      ["POST", "/api/device-sync/resolve"], ["GET", "/api/cloud-connection/start"], ["POST", "/api/cloud-connection/disconnect"],
      ["GET", "/api/agent-tokens"]]) {
      const r = await proxy(remoteReq(m, p, origin));
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((await r.json()).error, "remote_access_mac_only", `${m} ${p}`);
    }
  } finally {
    if (previous === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previous;
  }
});

test("BL-251 hardening (review 14.11): a remote API call without a session stops at the proxy; sign-in, presence and the status read pass; an encoded Mac-only path is still Mac-only", async () => {
  await remoteOn(true);
  const origin = { origin: "https://mac.tail1234.ts.net" };
  const media = await proxy(remoteReq("GET", "/api/channels/UC_A/clip-reviews/c1/video"));
  assert.equal(media.status, 401, "a page via DNS rebinding or another tailnet device has no cookie: refused before the route");
  assert.equal((await proxy(remoteReq("GET", "/api/presence"))).status, 200, "the page's presence ping before sign-in");
  assert.equal((await proxy(remoteReq("GET", "/api/remote-access"))).status, 200, "the login page's status read");
  assert.equal((await proxy(remoteReq("POST", "/api/auth/callback/remote-password", origin))).status, 200, "the sign-in itself");
  const encoded = await proxy(remoteReq("POST", "/api/%6Dcp", origin));
  assert.equal(encoded.status, 403);
  assert.equal((await encoded.json()).error, "remote_access_mac_only");
  // local requests are untouched: no session needed at the proxy
  assert.equal((await proxy(new NextRequest(new Request("http://127.0.0.1:3000/api/channels/UC_A/clip-reviews/c1/video", { headers: { host: "127.0.0.1:3000" } })))).status, 200);
});
