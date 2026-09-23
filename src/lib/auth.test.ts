import assert from "node:assert/strict";
import test from "node:test";
import { encode as encodeSessionToken } from "next-auth/jwt";
import {
  buildGoogleLoopbackAuthUrl,
  parseCookieHeader,
  resolveExistingSessionToken,
  YOUTUBE_ANALYTICS_READ_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_SCOPES,
} from "./auth";

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

test("resolveExistingSessionToken returns null when no cookie header is present", async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-chars-long!!";
  const token = await resolveExistingSessionToken({ headers: {} });
  assert.equal(token, null);
});

test("resolveExistingSessionToken returns null for a garbage/tampered cookie value", async () => {
  process.env.NEXTAUTH_SECRET = "test-secret-at-least-32-chars-long!!";
  const token = await resolveExistingSessionToken({
    headers: { cookie: "next-auth.session-token=not-a-real-jwe-token" },
  });
  assert.equal(token, null);
});

// The real regression test for the actual bug: a genuinely valid, correctly-encrypted NextAuth
// session token, round-tripped through this exact parsing path. Before the fix, `getToken({req})`
// saw no cookies at all (SessionStore only reads `req.cookies`, never `req.headers.cookie`) and
// always returned null even for a perfectly valid session -- this is the case that must pass.
test("resolveExistingSessionToken finds and correctly decodes a genuinely valid session cookie", async () => {
  const secret = "test-secret-at-least-32-chars-long!!";
  process.env.NEXTAUTH_SECRET = secret;

  const encoded = await encodeSessionToken({ token: { sub: "user-1", email: "owner@example.com" }, secret });
  const token = await resolveExistingSessionToken({
    headers: { cookie: `next-auth.session-token=${encodeURIComponent(encoded)}` },
  });

  assert.ok(token);
  assert.equal(token!.sub, "user-1");
  assert.equal(token!.email, "owner@example.com");
});

test("resolveExistingSessionToken is unaffected by an unrelated malformed cookie on the same request", async () => {
  const secret = "test-secret-at-least-32-chars-long!!";
  process.env.NEXTAUTH_SECRET = secret;

  const encoded = await encodeSessionToken({ token: { sub: "user-1" }, secret });
  const token = await resolveExistingSessionToken({
    headers: { cookie: `some_ad_cookie=%; next-auth.session-token=${encodeURIComponent(encoded)}` },
  });

  assert.ok(token);
  assert.equal(token!.sub, "user-1");
});
