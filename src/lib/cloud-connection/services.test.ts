import assert from "node:assert/strict";
import test from "node:test";
import { createCloudConnectionServices } from "./services";
import { CLOUD_CONNECTION_SCOPE, DomainError } from "./contracts";
import { encryptSecret } from "./crypto";

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
} = {}) {
  let row: FakeStoredRow | null = null;
  const revokeCalls: string[] = [];
  const setCredentialsCalls: unknown[] = [];

  const store = {
    async get() {
      return row;
    },
    async upsert(input: { connectedEmail: string; scope: string; ciphertext: string; iv: string; authTag: string }) {
      row = { ...input, connectedAt: row?.connectedAt ?? new Date("2026-09-22T12:00:00Z") };
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
    revokeToken: async (token: string) => {
      revokeCalls.push(token);
    },
    generateState: () => "fixed-state-value",
  };

  const services = createCloudConnectionServices({
    store,
    oauth,
    resolveEncryptionKey: () => FIXED_KEY,
    clock: { now: () => opts.now ?? new Date("2026-09-22T12:00:00Z") },
  });

  return { services, revokeCalls, setCredentialsCalls, getRow: () => row };
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
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
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
  assert.ok(!row.ciphertext.includes("fake-access-token"), "the raw access token must never appear in the stored row");
  assert.ok(!row.ciphertext.includes("fake-refresh-token"), "the raw refresh token must never appear in the stored row");
});

test("completeConnect: a token exchange with no access_token is refused", async () => {
  const { services } = createFixture({ getToken: async () => ({ tokens: {} }) });

  await assert.rejects(() =>
    services.completeConnect({
      code: "auth-code",
      state: "fixed-state-value",
      expectedState: "fixed-state-value",
      redirectUri: "http://localhost:3000/api/cloud-connection/callback",
    })
  );
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
test("sanity: encryptSecret/decryptSecret round-trips a token-set JSON blob exactly", () => {
  const payload = { accessToken: "a", refreshToken: "b", tokenExpiry: 123 };
  const encrypted = encryptSecret(JSON.stringify(payload), FIXED_KEY);
  assert.ok(encrypted.ciphertext.length > 0);
});
