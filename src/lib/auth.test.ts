import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGoogleLoopbackAuthUrl,
  YOUTUBE_ANALYTICS_READ_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_SCOPES,
} from "./auth";

test("default YouTube scopes include youtube.force-ssl", () => {
  assert.equal(YOUTUBE_SCOPES.includes(YOUTUBE_FORCE_SSL_SCOPE), true);
});

// Phase 8 (BL-051, docs/roadmap/plans/PHASE_8_PLAN.md §10 item 1): owner-approved 2026-09-22.
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
