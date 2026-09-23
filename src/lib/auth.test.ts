import assert from "node:assert/strict";
import test from "node:test";
import { encode as encodeSessionToken } from "next-auth/jwt";
import {
  authOptions,
  buildGoogleLoopbackAuthUrl,
  parseCookieHeader,
  resolveExistingSessionToken,
  YOUTUBE_ANALYTICS_READ_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_SCOPES,
} from "./auth";
import { getUserOAuthTokens, upsertUserOAuthOnSignIn } from "./db";

/** Runs `fn` with `NEXTAUTH_SECRET` set, then always restores whatever value (or absence) it had
 * before -- mirrors `shared-crypto/index.test.ts`'s own env-mutation hygiene, so a later test file
 * (or a future change to test isolation) can never see a value one of these tests left behind. */
async function withNextAuthSecret<T>(secret: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.NEXTAUTH_SECRET;
    else process.env.NEXTAUTH_SECRET = previous;
  }
}

test("default YouTube scopes include youtube.force-ssl", () => {
  assert.equal(YOUTUBE_SCOPES.includes(YOUTUBE_FORCE_SSL_SCOPE), true);
});

// Phase 8 (BL-056, docs/roadmap/plans/PHASE_8_PLAN.md §10 item 1): owner-approved 2026-09-22.
test("default YouTube scopes include the yt-analytics.readonly scope, never the monetary scope", () => {
  assert.equal(YOUTUBE_SCOPES.includes(YOUTUBE_ANALYTICS_READ_SCOPE), true);
  assert.equal(YOUTUBE_ANALYTICS_READ_SCOPE, "https://www.googleapis.com/auth/yt-analytics.readonly");
  assert.equal(
    YOUTUBE_SCOPES.some((scope) => scope.includes("monetary")),
    false,
    "the monetary scope was never asked about or approved -- must never be requested implicitly"
  );
});

test("buildGoogleLoopbackAuthUrl includes redirect_uri in generated URL", () => {
  process.env.GOOGLE_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";

  const redirectUri = "http://127.0.0.1:43123";
  const authUrl = buildGoogleLoopbackAuthUrl({
    redirectUri,
    state: "test-state",
    codeChallenge: "test-challenge",
  });

  const url = new URL(authUrl);

  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("state"), "test-state");
  assert.equal(url.searchParams.get("code_challenge"), "test-challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    decodeURIComponent(url.searchParams.get("scope") ?? "").includes(YOUTUBE_FORCE_SSL_SCOPE),
    true
  );
});

// docs/decisions/0010-persistent-channel-connections.md -- the "channel-connections" Credentials
// provider's authorize() depends entirely on this parsing to ever see an existing session at all
// (independent review, round 1: flagged as the one safety-critical path with zero coverage).
test("parseCookieHeader reads a single cookie", () => {
  const cookies = parseCookieHeader("next-auth.session-token=abc123");
  assert.equal(cookies.get("next-auth.session-token"), "abc123");
});

test("parseCookieHeader reads multiple cookies separated by '; '", () => {
  const cookies = parseCookieHeader("foo=bar; next-auth.session-token=abc123; baz=qux");
  assert.equal(cookies.size, 3);
  assert.equal(cookies.get("next-auth.session-token"), "abc123");
  assert.equal(cookies.get("foo"), "bar");
  assert.equal(cookies.get("baz"), "qux");
});

test("parseCookieHeader handles a cookie value containing '='", () => {
  const cookies = parseCookieHeader("next-auth.session-token=abc.def=ghi");
  assert.equal(cookies.get("next-auth.session-token"), "abc.def=ghi");
});

test("parseCookieHeader reassembles a session token split into chunks (next-auth.session-token.0/.1)", () => {
  const cookies = parseCookieHeader("next-auth.session-token.0=part-one; next-auth.session-token.1=part-two");
  assert.equal(cookies.get("next-auth.session-token.0"), "part-one");
  assert.equal(cookies.get("next-auth.session-token.1"), "part-two");
});

test("parseCookieHeader decodes a percent-encoded cookie value", () => {
  const cookies = parseCookieHeader("name=" + encodeURIComponent("a value/with+special=chars"));
  assert.equal(cookies.get("name"), "a value/with+special=chars");
});

// The actual bug found by live testing: a real independent review confirmed this is the one
// scenario `getToken({req})` alone cannot handle, and the fix here must never silently abort
// parsing the rest of the header.
test("parseCookieHeader skips a cookie with malformed percent-encoding instead of throwing, and still parses the rest", () => {
  const cookies = parseCookieHeader("broken=%; next-auth.session-token=abc123");
  assert.equal(cookies.has("broken"), false);
  assert.equal(cookies.get("next-auth.session-token"), "abc123");
});

test("parseCookieHeader returns an empty map for an empty header", () => {
  const cookies = parseCookieHeader("");
  assert.equal(cookies.size, 0);
});

// The `cookie` npm package (and this app's own `getServerSession()`, which uses it transitively)
// keeps the FIRST occurrence of a duplicate cookie name -- verified by reading
// node_modules/cookie's own `parse()`. This function must resolve the same identity
// `getServerSession()` would for the same request, or `authorize()` could reactivate a different
// session than the one the caller actually believes they hold.
test("parseCookieHeader keeps the first occurrence of a duplicate cookie name, matching the `cookie` package", () => {
  const cookies = parseCookieHeader("next-auth.session-token=first; next-auth.session-token=second");
  assert.equal(cookies.get("next-auth.session-token"), "first");
});

test("resolveExistingSessionToken returns null when no cookie header is present", async () => {
  await withNextAuthSecret("test-secret-at-least-32-chars-long!!", async () => {
    const token = await resolveExistingSessionToken({ headers: {} });
    assert.equal(token, null);
  });
});

test("resolveExistingSessionToken returns null for a garbage/tampered cookie value", async () => {
  await withNextAuthSecret("test-secret-at-least-32-chars-long!!", async () => {
    const token = await resolveExistingSessionToken({
      headers: { cookie: "next-auth.session-token=not-a-real-jwe-token" },
    });
    assert.equal(token, null);
  });
});

// The real regression test for the actual bug: a genuinely valid, correctly-encrypted NextAuth
// session token, round-tripped through this exact parsing path. Before the fix, `getToken({req})`
// saw no cookies at all (SessionStore only reads `req.cookies`, never `req.headers.cookie`) and
// always returned null even for a perfectly valid session -- this is the case that must pass.
test("resolveExistingSessionToken finds and correctly decodes a genuinely valid session cookie", async () => {
  const secret = "test-secret-at-least-32-chars-long!!";
  await withNextAuthSecret(secret, async () => {
    const encoded = await encodeSessionToken({ token: { sub: "user-1", email: "owner@example.com" }, secret });
    const token = await resolveExistingSessionToken({
      headers: { cookie: `next-auth.session-token=${encodeURIComponent(encoded)}` },
    });

    assert.ok(token);
    assert.equal(token!.sub, "user-1");
    assert.equal(token!.email, "owner@example.com");
  });
});

test("resolveExistingSessionToken is unaffected by an unrelated malformed cookie on the same request", async () => {
  const secret = "test-secret-at-least-32-chars-long!!";
  await withNextAuthSecret(secret, async () => {
    const encoded = await encodeSessionToken({ token: { sub: "user-1" }, secret });
    const token = await resolveExistingSessionToken({
      headers: { cookie: `some_ad_cookie=%; next-auth.session-token=${encodeURIComponent(encoded)}` },
    });

    assert.ok(token);
    assert.equal(token!.sub, "user-1");
  });
});

// docs/decisions/0010-persistent-channel-connections.md -- this branch is the one guard preventing
// a "channel-connections" sign-in (whose synthetic `account` carries no real OAuth tokens) from
// silently nulling out the reactivated identity's perfectly good, already-stored tokens
// (independent review, round 2: flagged as safety-critical with zero coverage, same class of gap
// as round 1's finding for the cookie-parsing side of this same feature).
test("signIn callback skips upsertUserOAuthOnSignIn for the channel-connections provider, preserving existing tokens", async () => {
  await upsertUserOAuthOnSignIn({
    userId: "test-user-channel-connections",
    name: "Real Name",
    email: "real@example.com",
    image: null,
    accessToken: "real-access-token",
    refreshToken: "real-refresh-token",
    tokenExpiry: 1234567890,
    scope: "real-scope",
  });

  const signIn = authOptions.callbacks!.signIn!;
  const result = await signIn({
    user: { id: "test-user-channel-connections", email: "real@example.com" },
    account: { provider: "channel-connections", type: "credentials", providerAccountId: "test-user-channel-connections" },
  } as Parameters<typeof signIn>[0]);

  assert.equal(result, true);

  const tokens = await getUserOAuthTokens("test-user-channel-connections");
  assert.equal(tokens?.accessToken, "real-access-token");
  assert.equal(tokens?.refreshToken, "real-refresh-token");
});

test("signIn callback still runs upsertUserOAuthOnSignIn for a real Google sign-in", async () => {
  const signIn = authOptions.callbacks!.signIn!;
  const result = await signIn({
    user: { id: "test-user-google", email: "google@example.com" },
    account: {
      provider: "google",
      type: "oauth",
      providerAccountId: "test-user-google",
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expires_at: 1234567890,
      scope: "fresh-scope",
    },
  } as Parameters<typeof signIn>[0]);

  assert.equal(result, true);

  const tokens = await getUserOAuthTokens("test-user-google");
  assert.equal(tokens?.accessToken, "fresh-access-token");
  assert.equal(tokens?.refreshToken, "fresh-refresh-token");
});
