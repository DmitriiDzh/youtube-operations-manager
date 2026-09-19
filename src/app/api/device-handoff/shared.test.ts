import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSnapshotId } from "./shared";

// RISK-18 (docs/TECHNICAL_DEBT.md): the import route joins snapshotId directly into a
// filesystem path. This must reject anything that isn't a real randomUUID() shape *before*
// that join, or a value like "../../../../etc" escapes the intended snapshots directory.
test("isValidSnapshotId accepts a real UUID", () => {
  assert.equal(isValidSnapshotId("3fa85f64-5717-4562-b3fc-2c963f66afa6"), true);
});

test("isValidSnapshotId rejects path traversal", () => {
  assert.equal(isValidSnapshotId("../../../../etc/passwd"), false);
});

test("isValidSnapshotId rejects an absolute path", () => {
  assert.equal(isValidSnapshotId("/etc/passwd"), false);
});

test("isValidSnapshotId rejects a value embedding a UUID inside a longer traversal string", () => {
  assert.equal(isValidSnapshotId("../3fa85f64-5717-4562-b3fc-2c963f66afa6"), false);
});

test("isValidSnapshotId rejects non-string input", () => {
  assert.equal(isValidSnapshotId(123), false);
  assert.equal(isValidSnapshotId(null), false);
  assert.equal(isValidSnapshotId(undefined), false);
});

test("isValidSnapshotId rejects an empty string", () => {
  assert.equal(isValidSnapshotId(""), false);
});

// (independent review, second cycle): deviceHandoffErrorResponse previously duck-typed on
// `"code" in error` instead of checking instanceof specific known error classes -- the exact
// anti-pattern mcp/server.ts and cli/video-metadata.ts already call out and avoid, because a
// raw libsql error (e.g. SQLITE_BUSY) or a Node fs error (ENOENT/EACCES, embedding a real local
// file path) also carries a `.code` property and would be echoed straight into the HTTP
// response as if it were one of this module's own stable, documented error codes.
test("deviceHandoffErrorResponse echoes a real known error class's code/message/details", async () => {
  const { deviceHandoffErrorResponse } = await import("./shared");
  const { OperationLockError } = await import("@/lib/operation-lock");
  const error = new OperationLockError({
    heldBy: { id: "singleton", operationType: "export", holderPid: 123, acquiredAt: new Date().toISOString() },
    stale: false,
  });

  const response = deviceHandoffErrorResponse(error);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error, "operation_lock_held");
});

test("deviceHandoffErrorResponse never echoes an unrelated object's .code, even if it duck-types as one of this module's known codes", async () => {
  const { deviceHandoffErrorResponse } = await import("./shared");
  // Shaped exactly like a raw libsql/Node fs error carrying a real local file path -- must
  // never be echoed as if it were a genuine, stable device-handoff error code.
  const fakeDriverError = { code: "operation_lock_held", message: "/Users/real/local/path leaked" };

  const response = deviceHandoffErrorResponse(fakeDriverError);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, "internal_error");
  assert.notEqual(body.message, "/Users/real/local/path leaked");
});
