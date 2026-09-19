import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
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

// RISK-34 (docs/TECHNICAL_DEBT.md): despite this file's name, no test above ever puts the
// device into actual recovery mode (an unresolved APPLYING/UNKNOWN ledger row, no lock held) --
// both only exercise the operation-lock branch of assertDeviceAvailableForMutation. A
// regression that broke recovery-mode enforcement specifically at this CLI choke point would
// pass every test above while the real safety property (AGENTS.md §G) silently failed.
test("a mutating CLI command is rejected while this device is in recovery mode (no lock held)", async () => {
  const channelId = `chan-${randomUUID()}`;
  const batchId = `batch-${randomUUID()}`;
  const rowId = `row-${randomUUID()}`;
  await rawSqlClient.execute({
    sql: "INSERT INTO channels (id, title, uploads_playlist_id) VALUES (?, ?, ?)",
    args: [channelId, "RISK-34 test channel", "UU_TEST"],
  });
  await rawSqlClient.execute({
    sql: "INSERT INTO batches (id, channel_id, status) VALUES (?, ?, ?)",
    args: [batchId, channelId, "RUNNING"],
  });
  await rawSqlClient.execute({
    sql: "INSERT INTO batch_ledger_rows (id, batch_id, video_id, change_ids_json, status) VALUES (?, ?, ?, ?, ?)",
    args: [rowId, batchId, "video-1", "[]", "UNKNOWN"],
  });

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
    assert.equal(parsed.error.code, "device_in_recovery_mode");

    // login/logout/revoke must remain available even in recovery mode (same exemption as the
    // operation-lock case above).
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
  } finally {
    await rawSqlClient.execute({ sql: "DELETE FROM batch_ledger_rows WHERE id = ?", args: [rowId] });
    await rawSqlClient.execute({ sql: "DELETE FROM batches WHERE id = ?", args: [batchId] });
    await rawSqlClient.execute({ sql: "DELETE FROM channels WHERE id = ?", args: [channelId] });
  }
});
