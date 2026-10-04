import assert from "node:assert/strict";
import test from "node:test";
import type { HealthProbe } from "@/lib/channel-connections";
import { createCloudConnectionServices } from "./services";
import { CLOUD_CONNECTION_SCOPE, DomainError } from "./contracts";
import { decryptSecret, encryptSecret } from "./crypto";

const FIXED_KEY = Buffer.alloc(32, 7);

type FakeStoredRow = {
  connectedEmail: string;
  scope: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  connectedAt: Date;
};

function createFixture(opts: {
  now?: Date;
  getToken?: () => Promise<{ tokens: Record<string, unknown> }>;
  refreshAccessToken?: () => Promise<{ credentials: Record<string, unknown> }>;
  revokeToken?: (token: string) => Promise<void>;
  probe?: (refreshToken: string) => Promise<HealthProbe>;
} = {}) {
  let row: FakeStoredRow | null = null;
  let nowValue = opts.now ?? new Date("2026-09-22T12:00:00Z");
  const probeCalls: string[] = [];
  const revokeCalls: string[] = [];
  const setCredentialsCalls: unknown[] = [];

  const store = {
    async get() {
      return row;
    },
    async upsert(input: { connectedEmail: string; scope: string; ciphertext: string; iv: string; authTag: string; connectedAt?: Date }) {
      // Mirrors db.ts: the date moves only when the caller passes one (a (re)connection), never on a token refresh.
      row = { ...input, connectedAt: input.connectedAt ?? row?.connectedAt ?? new Date("2026-09-22T12:00:00Z") };
    },
    async clear() {
      row = null;
    },
  };

  const oauth = {
    createOAuthClient: (() =>
      ({
        generateAuthUrl(args: { scope: string[]; state: string }) {
          return `https://accounts.google.com/o/oauth2/auth?scope=${encodeURIComponent(args.scope.join(" "))}&state=${args.state}`;
        },
        getToken:
          opts.getToken ??
          (async () => ({
            tokens: {
              access_token: "fake-access-token",
              refresh_token: "fake-refresh-token",
              expiry_date: (opts.now ?? new Date("2026-09-22T12:00:00Z")).getTime() + 3600_000,
              scope: CLOUD_CONNECTION_SCOPE,
              id_token: null,
            },
          })),
        setCredentials(args: unknown) {
          setCredentialsCalls.push(args);
        },
        refreshAccessToken:
          opts.refreshAccessToken ??
          (async () => ({
            credentials: {
              access_token: "refreshed-access-token",
              refresh_token: "fake-refresh-token",
              expiry_date: (opts.now ?? new Date("2026-09-22T12:00:00Z")).getTime() + 3600_000,
            },
          })),
      }) as unknown as ReturnType<typeof import("@/lib/auth").createGoogleOAuthClient>) as never,
    fetchIdentity: async () => ({ userId: "sub-1", email: "owner@example.com", name: null, image: null }),
    revokeToken:
      opts.revokeToken ??
      (async (token: string) => {
        revokeCalls.push(token);
      }),
    generateState: () => "fixed-state-value",
  };

  const services = createCloudConnectionServices({
    store,
    oauth,
    resolveEncryptionKey: () => FIXED_KEY,
    probeRefreshToken: async (token: string) => {
      probeCalls.push(token);
      return opts.probe ? opts.probe(token) : "ok";
    },
    clock: { now: () => nowValue },
  });

  return { services, revokeCalls, setCredentialsCalls, probeCalls, getRow: () => row, setNow: (d: Date) => { nowValue = d; } };
}

test("getStatus: nothing connected -> { connected: false }", async () => {
  const { services } = createFixture();
  assert.deepEqual(await services.getStatus(), { connected: false });
});

// Corrected twice, both times per a real requirement change (never "the implementation doesn't do
// this," per AGENTS.md §L): (1) 2026-09-22, a live failure showed `cloud-platform` alone leaves
// `fetchGoogleIdentity` (src/lib/auth.ts) with no way to resolve the connected account (needs
// `openid`/`email`, an id_token or the userinfo endpoint); (2) same day, a live spike found the
// Cloud Quotas API that originally justified the broad `cloud-platform` scope unnecessary, so the
// owner asked to narrow it to `monitoring.read` (the actual Cloud Monitoring API requirement,
// least privilege) -- see `CLOUD_CONNECTION_SCOPE`'s own doc comment in contracts.ts.
test("beginConnect: requests monitoring.read AND openid/email (needed to resolve connectedEmail), and returns a state to verify later", () => {
  const { services } = createFixture();
  const { authUrl, state } = services.beginConnect({ redirectUri: "http://localhost:3000/api/cloud-connection/callback" });

  assert.equal(state, "fixed-state-value");
  assert.ok(authUrl.includes(encodeURIComponent(CLOUD_CONNECTION_SCOPE)), "must request monitoring.read");
  assert.ok(authUrl.includes(encodeURIComponent("openid")), "must request openid, or fetchGoogleIdentity has no id_token to decode");
  assert.ok(authUrl.includes(encodeURIComponent("email")), "must request email, or the userinfo fallback cannot resolve it either");
  assert.ok(authUrl.includes("state=fixed-state-value"));
});

test("completeConnect: state mismatch is refused before any token exchange side effect is persisted", async () => {
  const { services, getRow } = createFixture();

  await assert.rejects(
    () =>
      services.completeConnect({
        code: "auth-code",
        state: "attacker-supplied-state",
        expectedState: "fixed-state-value",
        redirectUri: "http://localhost:3000/api/cloud-connection/callback",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "AUTH_CALLBACK_INVALID"
  );
  assert.equal(getRow(), null);
});

test("completeConnect: success stores the encrypted token set and returns the public status", async () => {
  const { services, getRow } = createFixture();

  const status = await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });

  assert.deepEqual(status, {
    connected: true,
    connectedEmail: "owner@example.com",
    scope: CLOUD_CONNECTION_SCOPE,
    connectedAt: getRow()!.connectedAt.toISOString(),
  });

  const row = getRow()!;
  // Independent test-suite audit (2026-09-26): checking the raw base64 ciphertext string for a
  // plaintext substring does not prove real AES encryption happened -- base64-encoding a JSON
  // payload containing these exact strings does NOT preserve the substring in its output either
  // way, so this check alone would also pass for a hypothetical regression where completeConnect
  // stored a merely base64-"encoded" (not actually encrypted) token set. Decode first, and
  // separately prove a real decrypt round-trip recovers the exact original tokens.
  assert.ok(!row.ciphertext.includes("fake-access-token"), "the raw access token must never appear in the stored row");
  assert.ok(!row.ciphertext.includes("fake-refresh-token"), "the raw refresh token must never appear in the stored row");

  const decryptedJson = decryptSecret({ ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag }, FIXED_KEY);
  const decoded = JSON.parse(decryptedJson);
  assert.equal(decoded.accessToken, "fake-access-token");
  assert.equal(decoded.refreshToken, "fake-refresh-token");
});

test("completeConnect: a token exchange with no access_token is refused", async () => {
  const { services } = createFixture({ getToken: async () => ({ tokens: {} }) });

  await assert.rejects(
    () =>
      services.completeConnect({
        code: "auth-code",
        state: "fixed-state-value",
        expectedState: "fixed-state-value",
        redirectUri: "http://localhost:3000/api/cloud-connection/callback",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED"
  );
});

test("completeConnect: Google rejecting the token exchange (e.g. unregistered redirect URI, expired code) is wrapped with a distinguishable code, not left as a raw thrown error", async () => {
  const { services, getRow } = createFixture({
    getToken: async () => {
      throw new Error("invalid_grant");
    },
  });

  await assert.rejects(
    () =>
      services.completeConnect({
        code: "auth-code",
        state: "fixed-state-value",
        expectedState: "fixed-state-value",
        redirectUri: "http://localhost:3000/api/cloud-connection/callback",
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED" &&
      error.message.includes("invalid_grant")
  );
  assert.equal(getRow(), null);
});

test("disconnect: nothing connected -> no-op, never calls revoke", async () => {
  const { services, revokeCalls } = createFixture();
  await services.disconnect();
  assert.equal(revokeCalls.length, 0);
});

test("disconnect: revokes the refresh token with Google, then clears the stored row", async () => {
  const { services, getRow, revokeCalls } = createFixture();
  await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });
  assert.ok(getRow());

  await services.disconnect();

  assert.deepEqual(revokeCalls, ["fake-refresh-token"]);
  assert.equal(getRow(), null);
});

// Independent test-suite audit (2026-09-26): disconnect's own doc comment states it clears the
// row "regardless of whether the revoke call itself succeeded" (a try/finally), but both
// pre-existing disconnect tests used an always-succeeding revoke fake -- the finally branch was
// never actually exercised.
test("disconnect: clears the stored row even when Google's revoke call fails", async () => {
  const { services, getRow } = createFixture({
    revokeToken: async () => {
      throw new Error("revoke endpoint unreachable");
    },
  });
  await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });
  assert.ok(getRow());

  // The revoke failure still propagates (try/finally re-throws after cleanup runs) -- the row
  // being cleared regardless is what this test actually verifies, not that disconnect swallows
  // the error.
  await assert.rejects(() => services.disconnect(), /revoke endpoint unreachable/);

  assert.equal(getRow(), null, "the local row must be cleared even though Google's revoke call failed");
});

test("resolveCloudCredentials: nothing connected -> refuses", async () => {
  const { services } = createFixture();
  await assert.rejects(
    () => services.resolveCloudCredentials(),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
});

test("resolveCloudCredentials: not yet expired -> returns the stored access token without refreshing", async () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const { services, setCredentialsCalls } = createFixture({ now });
  await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });

  const result = await services.resolveCloudCredentials();

  assert.equal(result.accessToken, "fake-access-token");
  assert.equal(setCredentialsCalls.length, 0, "a still-valid token must never trigger a refresh call");
});

test("resolveCloudCredentials: expired with a refresh token -> refreshes, re-encrypts, and returns the new access token", async () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const { services, getRow } = createFixture({
    now,
    getToken: async () => ({
      tokens: {
        access_token: "fake-access-token",
        refresh_token: "fake-refresh-token",
        expiry_date: now.getTime() - 1000, // already expired
        scope: CLOUD_CONNECTION_SCOPE,
        id_token: null,
      },
    }),
  });
  await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });
  const beforeRefresh = getRow()!.ciphertext;

  const result = await services.resolveCloudCredentials();

  assert.equal(result.accessToken, "refreshed-access-token");
  assert.notEqual(getRow()!.ciphertext, beforeRefresh, "the stored row must be re-encrypted with the refreshed token set");
});

test("resolveCloudCredentials: expired with no refresh token -> refuses rather than silently failing later", async () => {
  const now = new Date("2026-09-22T12:00:00Z");
  const { services } = createFixture({
    now,
    getToken: async () => ({
      tokens: {
        access_token: "fake-access-token",
        refresh_token: null,
        expiry_date: now.getTime() - 1000,
        scope: CLOUD_CONNECTION_SCOPE,
        id_token: null,
      },
    }),
  });
  await services.completeConnect({
    code: "auth-code",
    state: "fixed-state-value",
    expectedState: "fixed-state-value",
    redirectUri: "http://localhost:3000/api/cloud-connection/callback",
  });

  await assert.rejects(
    () => services.resolveCloudCredentials(),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
});

// Sanity check on the crypto round-trip used by the fixture itself, so a future change to the
// token-set JSON shape doesn't silently start double-encoding.
// Independent test-suite audit (2026-09-26): this test never actually called decryptSecret --
// it would have passed even if decryption were completely broken or removed. Completed the
// actual round-trip this module's own re-exported encryptSecret/decryptSecret wrap.
test("sanity: encryptSecret/decryptSecret round-trips a token-set JSON blob exactly", () => {
  const payload = { accessToken: "a", refreshToken: "b", tokenExpiry: 123 };
  const encrypted = encryptSecret(JSON.stringify(payload), FIXED_KEY);
  assert.ok(encrypted.ciphertext.length > 0);

  const decrypted = decryptSecret(encrypted, FIXED_KEY);
  assert.deepEqual(JSON.parse(decrypted), payload);
});

// ---------------------------------------------------------------------------
// BL-126 -- Cloud grant health: the same 7-day rule the channel logins get. Connected at 2026-09-22T12:00Z in every test below;
// expected values are computed by hand from "Google expires a Testing-status refresh token 7 days after issue, warn from day 6".
// ---------------------------------------------------------------------------
const CONNECT_INPUT = { code: "auth-code", state: "s", expectedState: "s", redirectUri: "http://localhost:3000/api/cloud-connection/callback" };
const day = (n: number) => new Date(Date.parse("2026-09-22T12:00:00Z") + n * 86_400_000);

test("getHealth: nothing connected -> { connected: false }", async () => {
  const { services } = createFixture();
  assert.deepEqual(await services.getHealth(), { connected: false });
});

test("getHealth: 6 days old and the real check could not run -> expiring_soon with 1 day left", async () => {
  const { services, setNow } = createFixture({ probe: async () => "error" });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(6));
  const health = await services.getHealth();
  assert.deepEqual(health, { connected: true, connectedEmail: "owner@example.com", state: "expiring_soon", ageDays: 6, daysLeft: 1, checkedAt: null });
});

test("getHealth: exactly 7 days old and the real check could not run -> reauth_required, 0 days left", async () => {
  const { services, setNow } = createFixture({ probe: async () => "error" });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(7));
  const health = await services.getHealth();
  assert.equal(health.connected && health.state, "reauth_required");
  assert.equal(health.connected && health.daysLeft, 0);
  assert.equal(health.connected && health.ageDays, 7);
});

test("getHealth: 3 days old and the real check passes -> ok, 4 days left", async () => {
  const { services, setNow } = createFixture({ probe: async () => "ok" });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(3));
  const health = await services.getHealth();
  assert.equal(health.connected && health.state, "ok");
  assert.equal(health.connected && health.daysLeft, 4);
  assert.equal(health.connected && health.checkedAt, day(3).toISOString());
});

test("getHealth: a passing real check overrides the age (9 days old but Google still accepts it -> ok, no limit)", async () => {
  const { services, setNow } = createFixture({ probe: async () => "ok" });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(9));
  const health = await services.getHealth();
  assert.equal(health.connected && health.state, "ok");
  assert.equal(health.connected && health.daysLeft, null);
});

test("getHealth: invalid_grant from Google is final even for a 1-day-old connection", async () => {
  const { services, setNow } = createFixture({ probe: async () => "invalid_grant" });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(1));
  const health = await services.getHealth();
  assert.equal(health.connected && health.state, "reauth_required");
  assert.equal(health.connected && health.daysLeft, 0);
});

test("getHealth: a stored grant with no refresh token needs a new login without asking Google", async () => {
  const { services, probeCalls } = createFixture({
    getToken: async () => ({ tokens: { access_token: "fake-access-token", expiry_date: Date.parse("2026-09-22T13:00:00Z") } }),
  });
  await services.completeConnect(CONNECT_INPUT);
  const health = await services.getHealth();
  assert.equal(health.connected && health.state, "reauth_required");
  assert.equal(probeCalls.length, 0);
});

test("getHealth: the real check is reused for 10 minutes, forceRefresh bypasses it, and a failed check is never cached", async () => {
  let n = 0;
  const { services, setNow, probeCalls } = createFixture({ probe: async () => (n++ === 0 ? "error" : "ok") });
  await services.completeConnect(CONNECT_INPUT);
  setNow(day(1));
  await services.getHealth(); // call 1 -> "error": not cached
  await services.getHealth(); // call 2 -> "ok": cached from here
  await services.getHealth(); // served from the cache
  assert.equal(probeCalls.length, 2);
  setNow(new Date(day(1).getTime() + 9 * 60_000));
  await services.getHealth(); // 9 minutes later: still cached
  assert.equal(probeCalls.length, 2);
  await services.getHealth({ forceRefresh: true });
  assert.equal(probeCalls.length, 3);
  setNow(new Date(day(1).getTime() + 20 * 60_000));
  await services.getHealth(); // 11 minutes after the last real check: asks again
  assert.equal(probeCalls.length, 4);
});

test("getHealth never exposes a token", async () => {
  const { services } = createFixture();
  await services.completeConnect(CONNECT_INPUT);
  const json = JSON.stringify(await services.getHealth());
  assert.ok(!json.includes("fake-refresh-token") && !json.includes("fake-access-token"));
});

test("a plain access-token refresh keeps the original connection date, but reconnecting restarts the 7-day clock", async () => {
  const { services, getRow, setNow } = createFixture({ probe: async () => "error" });
  await services.completeConnect(CONNECT_INPUT);
  assert.equal(getRow()?.connectedAt.toISOString(), day(0).toISOString());

  // Expire the stored access token, then refresh it 8 days later: the date must stay at day 0.
  const expired = encryptSecret(JSON.stringify({ accessToken: "old", refreshToken: "fake-refresh-token", tokenExpiry: Math.floor(day(1).getTime() / 1000) }), FIXED_KEY);
  await (async () => {
    const row = getRow()!;
    Object.assign(row, expired);
  })();
  setNow(day(8));
  await services.resolveCloudCredentials();
  assert.equal(getRow()?.connectedAt.toISOString(), day(0).toISOString());

  // Reconnect in place (no disconnect first): the date moves to now.
  await services.completeConnect(CONNECT_INPUT);
  assert.equal(getRow()?.connectedAt.toISOString(), day(8).toISOString());
  const health = await services.getHealth();
  assert.equal(health.connected && health.ageDays, 0);
});
