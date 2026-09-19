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
    const response = await proxy(mutatingRequest("/api/rules"));
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
    const response = await proxy(readRequest("/api/rules"));
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
  const response = await proxy(mutatingRequest("/api/rules"));
  assert.notEqual(response.status, 409);
  assert.notEqual(response.status, 423);
});
