import assert from "node:assert/strict";
import test from "node:test";
import { runCliCommand } from "./video-metadata";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

// AC-LOCK-02: a mutating CLI command must be rejected while the local operation lock is held,
// via the exact same choke point src/proxy.ts and MCP use (assertDeviceAvailableForMutation),
// never bypassable by invoking the CLI directly.
test("a mutating CLI command is rejected while the operation lock is held; a read-only one is not", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const stderrLines: string[] = [];
    const exitCode = await runCliCommand({
      argv: ["auth", "logout"],
      auth: {
        login: async () => ({}),
        loginDevice: async () => ({}),
        whoami: async () => ({}),
        listKnownWriteChannels: async () => ({}),
        selectWriteChannel: async () => ({}),
        listUsers: async () => ({}),
        selectUser: async () => ({}),
        logout: async () => ({ ok: true }),
        revoke: async () => ({}),
        resolveEffectiveCredentialRef: async () => ({ userId: "u1" }),
      },
      writeStdout: () => {},
      writeStderr: (line) => stderrLines.push(line),
    });

    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stderrLines[0]);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, "operation_lock_held");

    // A read-only command must still work.
    const stdoutLines: string[] = [];
    const readonlyExit = await runCliCommand({
      argv: ["auth", "whoami"],
      auth: {
        login: async () => ({}),
        loginDevice: async () => ({}),
        whoami: async () => ({ activeUserId: "u1" }),
        listKnownWriteChannels: async () => ({}),
        selectWriteChannel: async () => ({}),
        listUsers: async () => ({}),
        selectUser: async () => ({}),
        logout: async () => ({}),
        revoke: async () => ({}),
        resolveEffectiveCredentialRef: async () => ({ userId: "u1" }),
      },
      writeStdout: (line) => stdoutLines.push(line),
      writeStderr: () => {},
    });
    assert.equal(readonlyExit, 0);
    assert.equal(JSON.parse(stdoutLines[0]).ok, true);
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});
