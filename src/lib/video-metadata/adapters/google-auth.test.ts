import assert from "node:assert/strict";
import test from "node:test";
import * as authModule from "@/lib/auth";
import { DomainError } from "../contracts";
import { createGoogleCredentialResolver } from "./google-auth";

type OAuthClientStub = {
  setCredentials: (value: unknown) => void;
  getTokenInfo: (token: string) => Promise<{ scopes?: string[] }>;
  refreshAccessToken: () => Promise<{
    credentials: {
      access_token?: string;
      refresh_token?: string;
      expiry_date?: number;
    };
  }>;
};

function makeOAuthClientStub(overrides?: Partial<OAuthClientStub>): OAuthClientStub {
  return {
    setCredentials: () => undefined,
    getTokenInfo: async () => ({ scopes: [authModule.YOUTUBE_READ_SCOPE] }),
    refreshAccessToken: async () => ({ credentials: {} }),
    ...overrides,
  };
}

test("resolveGoogleCredentials returns usable auth context for non-web adapters", async () => {
  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient:
      () => makeOAuthClientStub() as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => null,
    saveUserTokens: async () => undefined,
  });

  const result = await resolveGoogleCredentials({
    credentialRef: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
      scope: authModule.YOUTUBE_READ_SCOPE,
    },
    requiredScopes: [authModule.YOUTUBE_READ_SCOPE],
  });

  assert.equal(result.accessToken, "access-token");
  assert.equal(result.scopeSet.has(authModule.YOUTUBE_READ_SCOPE), true);
});

test("resolveGoogleCredentials rejects credentials with insufficient scopes", async () => {
  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient: () =>
      makeOAuthClientStub({
        getTokenInfo: async () => ({ scopes: [authModule.YOUTUBE_READ_SCOPE] }),
      }) as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => null,
    saveUserTokens: async () => undefined,
  });

  await assert.rejects(
    () =>
      resolveGoogleCredentials({
        credentialRef: {
          accessToken: "access-token",
          tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
          scope: authModule.YOUTUBE_READ_SCOPE,
        },
        requiredScopes: [authModule.YOUTUBE_WRITE_SCOPE],
      }),
    (error: unknown) => {
      if (!(error instanceof DomainError)) return false;
      if (error.code !== "AUTH_SCOPE_INSUFFICIENT") return false;

      const details = error.details as { missingScopes?: string[] };
      return details.missingScopes?.includes(authModule.YOUTUBE_WRITE_SCOPE) === true;
    }
  );
});

// Phase 8 (BL-056, docs/roadmap/plans/PHASE_8_PLAN.md §10 item 1): a token stored before the
// analytics scope was added to YOUTUBE_SCOPES (a real "pre-existing user" scenario, not a
// hypothetical) must fail closed for a future Analytics adapter requiring it -- proving the
// re-consent claim in BL-056's own commit message, not just asserting it.
test("resolveGoogleCredentials rejects a pre-Phase-8 token missing the analytics scope", async () => {
  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient: () =>
      makeOAuthClientStub({
        getTokenInfo: async () => ({ scopes: [authModule.YOUTUBE_READ_SCOPE, authModule.YOUTUBE_WRITE_SCOPE] }),
      }) as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => null,
    saveUserTokens: async () => undefined,
  });

  await assert.rejects(
    () =>
      resolveGoogleCredentials({
        credentialRef: {
          accessToken: "access-token",
          tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
          scope: `${authModule.YOUTUBE_READ_SCOPE} ${authModule.YOUTUBE_WRITE_SCOPE}`,
        },
        requiredScopes: [authModule.YOUTUBE_ANALYTICS_READ_SCOPE],
      }),
    (error: unknown) => {
      if (!(error instanceof DomainError)) return false;
      if (error.code !== "AUTH_SCOPE_INSUFFICIENT") return false;

      const details = error.details as { missingScopes?: string[] };
      return details.missingScopes?.includes(authModule.YOUTUBE_ANALYTICS_READ_SCOPE) === true;
    }
  );
});

test("resolveGoogleCredentials fails consistently when token is expired and cannot refresh", async () => {
  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient:
      () => makeOAuthClientStub() as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => ({
      userId: "user-1",
      accessToken: "expired-token",
      refreshToken: null,
      tokenExpiry: Math.floor(Date.now() / 1000) - 30,
      scope: authModule.YOUTUBE_READ_SCOPE,
    }),
    saveUserTokens: async () => undefined,
  });

  await assert.rejects(
    () =>
      resolveGoogleCredentials({
        credentialRef: { userId: "user-1" },
        requiredScopes: [authModule.YOUTUBE_READ_SCOPE],
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "AUTH_REFRESH_TOKEN_MISSING"
  );
});

test("resolveGoogleCredentials fails with AUTH_USER_NOT_FOUND for missing persisted user", async () => {
  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient:
      () => makeOAuthClientStub() as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => null,
    saveUserTokens: async () => undefined,
  });

  await assert.rejects(
    () =>
      resolveGoogleCredentials({
        credentialRef: { userId: "missing-user" },
        requiredScopes: [authModule.YOUTUBE_READ_SCOPE],
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "AUTH_USER_NOT_FOUND" &&
      error.message === "User not found for credential resolution"
  );
});

test("resolveGoogleCredentials refreshes and persists fetched scopes before scope assertion", async () => {
  const savedPatches: Array<Record<string, unknown>> = [];
  let tokenInfoCalls = 0;

  const resolveGoogleCredentials = createGoogleCredentialResolver({
    createOAuthClient: () =>
      makeOAuthClientStub({
        getTokenInfo: async (token: string) => {
          tokenInfoCalls += 1;

          if (token === "expired-token") {
            throw new Error("legacy scope missing");
          }

          return { scopes: [authModule.YOUTUBE_READ_SCOPE, authModule.YOUTUBE_WRITE_SCOPE] };
        },
        refreshAccessToken: async () => ({
          credentials: {
            access_token: "fresh-token",
            refresh_token: "fresh-refresh",
            expiry_date: (Math.floor(Date.now() / 1000) + 3600) * 1000,
          },
        }),
      }) as unknown as ReturnType<typeof authModule.createGoogleOAuthClient>,
    getUserTokens: async () => ({
      userId: "user-1",
      accessToken: "expired-token",
      refreshToken: "refresh-token",
      tokenExpiry: Math.floor(Date.now() / 1000) - 30,
      scope: null,
    }),
    saveUserTokens: async (_userId, patch) => {
      savedPatches.push(patch as Record<string, unknown>);
    },
  });

  const result = await resolveGoogleCredentials({
    credentialRef: { userId: "user-1" },
    requiredScopes: [authModule.YOUTUBE_WRITE_SCOPE],
  });

  assert.equal(result.accessToken, "fresh-token");
  assert.equal(result.scopeSet.has(authModule.YOUTUBE_WRITE_SCOPE), true);
  assert.equal(tokenInfoCalls, 2);
  assert.equal(savedPatches.length, 1);
  assert.equal(savedPatches[0]?.scope, `${authModule.YOUTUBE_READ_SCOPE} ${authModule.YOUTUBE_WRITE_SCOPE}`);
});
