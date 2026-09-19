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
