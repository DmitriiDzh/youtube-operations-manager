import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

function mutatingRequest(pathname: string) {
  return new NextRequest(new Request(`http://localhost${pathname}`, { method: "POST" }));
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

// Phase 8 (BL-053): analytics/collect is a real local-state mutation (writes video_metrics_daily
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

// Phase 8 (BL-054): the auto-collect trigger is a POST that MAY perform the same real mutation --
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
