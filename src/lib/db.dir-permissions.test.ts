import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { appDataPaths } from "@/lib/db";

// RISK-24 (docs/TECHNICAL_DEBT.md): the app-data directory holds the DB file with plaintext
// OAuth tokens (RISK-07's accepted tradeoff assumes directory-level protection). Chmod is a
// POSIX permission-bits concept; Windows uses ACLs instead, so this assertion only applies on
// POSIX platforms -- it is not a claim about Windows protection.
test("app-data directory is locked to 0700 on boot (POSIX)", { skip: process.platform === "win32" }, () => {
  const mode = statSync(appDataPaths.appDataDir).mode & 0o777;
  assert.equal(mode, 0o700);
});
