import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createMetaClient, META_SCOPES } from "./index";

// BL-252 (ADR 0068): expectations from Meta's documented contract -- Facebook Login (manual flow: /dialog/oauth with client_id,
// redirect_uri, state, scope; /oauth/access_token code exchange; grant_type=fb_exchange_token for the long-lived token) and
// GET /me/accounts with instagram_business_account (Instagram API with Facebook Login).

type Call = { url: URL; init?: RequestInit };
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, impl };
}

test("authorizeUrl: Meta's OAuth dialog with the app id, redirect URI, state, response_type=code and every scope", () => {
  const url = new URL(createMetaClient().authorizeUrl({ appId: "123456789", redirectUri: "http://localhost:3000/api/social/meta/callback", state: "s-1" }));
  assert.equal(url.hostname, "www.facebook.com");
  assert.match(url.pathname, /^\/v\d+\.\d+\/dialog\/oauth$/);
  assert.equal(url.searchParams.get("client_id"), "123456789");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:3000/api/social/meta/callback");
  assert.equal(url.searchParams.get("state"), "s-1");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.deepEqual(url.searchParams.get("scope")?.split(","), ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "business_management", "instagram_basic", "instagram_content_publish"]);
  assert.equal(META_SCOPES.length, 6);
});

test("exchangeCode: code -> short token -> long-lived token (two GETs to /oauth/access_token), expiry from expires_in", async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: { access_token: "SHORT", token_type: "bearer" } },
    { status: 200, body: { access_token: "LONG", token_type: "bearer", expires_in: 5_184_000 } },
  ]);
  const before = Date.now();
  const out = await createMetaClient({ fetchImpl: impl }).exchangeCode({ appId: "1", appSecret: "sec", redirectUri: "http://localhost:3000/cb", code: "C" });
  assert.equal(out.userToken, "LONG");
  assert.ok(out.expiresAt !== null && out.expiresAt >= before + 5_184_000_000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.hostname, "graph.facebook.com");
  assert.match(calls[0].url.pathname, /\/oauth\/access_token$/);
  assert.equal(calls[0].url.searchParams.get("code"), "C");
  assert.equal(calls[0].url.searchParams.get("redirect_uri"), "http://localhost:3000/cb");
  assert.equal(calls[1].url.searchParams.get("grant_type"), "fb_exchange_token");
  assert.equal(calls[1].url.searchParams.get("fb_exchange_token"), "SHORT");
});

test("listPages: Pages with their tokens; the linked Instagram account when there is one; rows without id/token skipped", async () => {
  const { calls, impl } = fakeFetch([
    {
      status: 200,
      body: {
        data: [
          { id: "111", name: "WWE Page", access_token: "PT1", instagram_business_account: { id: "1784", username: "wwexplained", profile_picture_url: "https://x/p.jpg" } },
          { id: "222", name: "Other", access_token: "PT2" },
          { id: "333", name: "No token" },
        ],
      },
    },
  ]);
  const pages = await createMetaClient({ fetchImpl: impl }).listPages("UT");
  assert.deepEqual(pages, [
    { pageId: "111", pageName: "WWE Page", pageToken: "PT1", instagram: { igUserId: "1784", username: "wwexplained", pictureUrl: "https://x/p.jpg" } },
    { pageId: "222", pageName: "Other", pageToken: "PT2", instagram: null },
  ]);
  assert.match(calls[0].url.pathname, /\/me\/accounts$/);
  assert.match(calls[0].url.searchParams.get("fields") ?? "", /instagram_business_account/);
});

test("errors: OAuth error 190 -> social_token_invalid, code 4 -> social_rate_limited, other -> social_request_rejected; the token never in the message", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ error: { message: "Error validating access token", code: 190 } }, 400, "social_token_invalid"],
    [{ error: { message: "Application request limit reached", code: 4 } }, 400, "social_rate_limited"],
    [{ error: { message: "Invalid redirect_uri", code: 191 } }, 400, "social_request_rejected"],
  ];
  for (const [body, status, code] of cases) {
    const { impl } = fakeFetch([{ status, body }]);
    await assert.rejects(createMetaClient({ fetchImpl: impl }).listPages("SECRET-TOKEN"), (e: unknown) => e instanceof DomainError && e.code === code && !e.message.includes("SECRET-TOKEN"));
  }
  const failing = (async () => {
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  await assert.rejects(createMetaClient({ fetchImpl: failing }).listPages("T"), (e: unknown) => e instanceof DomainError && e.code === "social_unavailable");
});
