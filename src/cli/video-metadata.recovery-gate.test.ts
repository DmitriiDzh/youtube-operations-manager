import assert from "node:assert/strict";
import test from "node:test";
import { runCliCommand } from "./video-metadata";
import { rawSqlClient } from "@/lib/db";
import { acquireOperationLock, releaseOperationLock } from "@/lib/operation-lock";

// AC-LOCK-02: a mutating CLI command must be rejected while the local operation lock is held,
// via the exact same choke point src/proxy.ts and MCP use (assertDeviceAvailableForMutation),
// never bypassable by invoking the CLI directly. Uses `select-channel` (a local-state mutation,
// not on READ_ONLY_CLI_COMMANDS or AUTH_SESSION_EXEMPT_CLI_COMMANDS) rather than `logout` --
// `logout`/`login`/`revoke` are deliberately exempt from this gate (mirroring src/proxy.ts's
// unconditional exemption of `/api/auth/**`, decision 6), so asserting they're rejected here
// would itself be a bug, not a correct assertion.
test("a mutating CLI command is rejected while the operation lock is held; a read-only one is not", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const stderrLines: string[] = [];
    const exitCode = await runCliCommand({
      argv: ["auth", "select-channel", "--channelId", "chan-1"],
      auth: {
        login: async () => ({}),
        loginDevice: async () => ({}),
        whoami: async () => ({}),
        listKnownWriteChannels: async () => ({}),
        selectWriteChannel: async () => ({ ok: true }),
        listUsers: async () => ({}),
        selectUser: async () => ({}),
        logout: async () => ({}),
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

// Regression: `login`/`logout`/`revoke` establish/remove this device's own OAuth session and
// must remain available regardless of lock/recovery-mode state, mirroring src/proxy.ts's
// unconditional exemption of `/api/auth/**` (decision 6, docs/decisions/0002-...). Found by
// independent review that an earlier version of this file gated these while proxy.ts exempted
// the equivalent Web path -- an unintended divergence between interfaces for the identical
// operation.
test("login/logout/revoke remain available while the operation lock is held", async () => {
  await acquireOperationLock(rawSqlClient, "export");
  try {
    const fakeAuth = {
      login: async () => ({ ok: true }),
      loginDevice: async () => ({ ok: true }),
      whoami: async () => ({}),
      listKnownWriteChannels: async () => ({}),
      selectWriteChannel: async () => ({}),
      listUsers: async () => ({}),
      selectUser: async () => ({}),
      logout: async () => ({ ok: true }),
      revoke: async () => ({ ok: true }),
      resolveEffectiveCredentialRef: async () => ({ userId: "u1" }),
    };

    for (const argv of [["auth", "login"], ["auth", "logout"], ["auth", "revoke"]]) {
      const stdoutLines: string[] = [];
      const exitCode = await runCliCommand({
        argv,
        auth: fakeAuth,
        writeStdout: (line) => stdoutLines.push(line),
        writeStderr: () => {},
      });
      assert.equal(exitCode, 0, `${argv.join(" ")} must not be gated`);
      assert.equal(JSON.parse(stdoutLines[0]).ok, true);
    }
  } finally {
    await releaseOperationLock(rawSqlClient);
  }
});
