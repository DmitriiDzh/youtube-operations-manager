import assert from "node:assert/strict";
import test from "node:test";
import { buildGoogleLoopbackAuthUrl } from "./auth";

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
});
