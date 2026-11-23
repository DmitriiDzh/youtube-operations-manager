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

test("authorizeUrl with a Facebook Login for Business configuration: config_id instead of scope (2026-11-15)", () => {
  const url = new URL(createMetaClient().authorizeUrl({ appId: "123456789", redirectUri: "https://mac.ts.net/api/social/meta/callback", state: "s-2", configId: "1234567890123456" }));
  assert.equal(url.searchParams.get("config_id"), "1234567890123456");
  assert.equal(url.searchParams.get("scope"), null);
  assert.equal(url.searchParams.get("response_type"), "code");
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

test("inspectPageToken: debug_token with the APP token (never the Page token as caller), then the Page, then its Instagram", async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: { data: { is_valid: true, scopes: ["pages_manage_posts", "instagram_content_publish"], expires_at: 0 } } },
    { status: 200, body: { id: "111", name: "WWE" } },
    { status: 200, body: { id: "111", instagram_business_account: { id: "1784", username: "w" } } },
  ]);
  const out = await createMetaClient({ fetchImpl: impl }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" });
  assert.deepEqual(out, { valid: true, scopes: ["pages_manage_posts", "instagram_content_publish"], expiresAt: null, page: { pageId: "111", pageName: "WWE" }, instagram: { igUserId: "1784", username: "w" } });
  assert.match(calls[0].url.pathname, /\/debug_token$/);
  assert.equal(calls[0].url.searchParams.get("input_token"), "PT");
  assert.equal(calls[0].url.searchParams.get("access_token"), "1|S");
  assert.match(calls[1].url.pathname, /\/111$/);
  assert.equal(calls[1].url.searchParams.get("access_token"), "PT");
  assert.equal(calls[1].url.searchParams.get("fields"), "id,name");
  assert.match(calls[2].url.pathname, /\/111$/);
  assert.equal(calls[2].url.searchParams.get("fields"), "instagram_business_account{id,username}");
  assert.equal(calls.length, 3);
});

// 2026-11-23 (owner TG 4779: one network failing never stops another; review of 23.11): the Page and its Instagram are separate reads.
// Any failure of the Instagram read makes only Instagram unreadable -- a refusal (4xx) definitely, a 5xx / no answer as transient (ask
// again); the Page read failing still fails the whole inspection (both networks post with that Page).
test("inspectPageToken: the Instagram read failing (4xx, 5xx, no answer) marks only Instagram unreadable; the Page is still answered", async () => {
  const debug = () => ({ status: 200, body: { data: { is_valid: true, scopes: ["pages_manage_posts"], expires_at: 0 } } });
  const page = () => ({ status: 200, body: { id: "111", name: "WWE" } });
  const cases: Array<[string, { status: number; body: unknown }, Record<string, unknown>]> = [
    ["4xx refusal", { status: 400, body: { error: { message: "Unsupported get request", code: 100 } } }, { instagramUnreadable: true }],
    ["5xx", { status: 503, body: {} }, { instagramUnreadable: true, instagramReadTransient: true }],
    ["rate limit", { status: 429, body: { error: { message: "limit", code: 4 } } }, { instagramUnreadable: true, instagramReadTransient: true }],
  ];
  for (const [name, igAnswer, extra] of cases) {
    const f = fakeFetch([debug(), page(), igAnswer]);
    const out = await createMetaClient({ fetchImpl: f.impl }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" });
    assert.deepEqual(out, { valid: true, scopes: ["pages_manage_posts"], expiresAt: null, page: { pageId: "111", pageName: "WWE" }, instagram: null, ...extra }, name);
    assert.equal(f.calls.length, 3, name);
  }
  // No answer at all (the fetch itself throws, e.g. a timeout).
  let n = 0;
  const answers = [debug(), page()];
  const timeout = (async () => {
    const next = answers[n++];
    if (!next) throw new Error("The operation was aborted due to timeout");
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const out = await createMetaClient({ fetchImpl: timeout }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" });
  assert.equal(out.page?.pageId, "111");
  assert.equal(out.instagram, null);
  assert.equal(out.instagramUnreadable, true);
  assert.equal(out.instagramReadTransient, true);
});

test("inspectPageToken: the Page read failing fails the whole inspection (no Instagram read)", async () => {
  const debug = { status: 200, body: { data: { is_valid: true, scopes: ["pages_manage_posts"], expires_at: 0 } } };
  const down = fakeFetch([debug, { status: 503, body: {} }]);
  await assert.rejects(createMetaClient({ fetchImpl: down.impl }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" }), (e: unknown) => e instanceof DomainError && e.code === "social_request_rejected");
  assert.equal(down.calls.length, 2);
});

test("inspectPageToken: debug_token's profile_id (the token's Page) is passed on as a string", async () => {
  for (const id of ["222", 222]) {
    const f = fakeFetch([{ status: 200, body: { data: { is_valid: true, scopes: [], expires_at: 0, profile_id: id } } }, { status: 200, body: { id: "111", name: "WWE" } }, { status: 200, body: { id: "111" } }]);
    const out = await createMetaClient({ fetchImpl: f.impl }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" });
    assert.equal(out.profileId, "222");
  }
});

test("inspectPageToken: an invalid token stops after debug_token (no Page read)", async () => {
  const { calls, impl } = fakeFetch([{ status: 200, body: { data: { is_valid: false, scopes: [] } } }]);
  const out = await createMetaClient({ fetchImpl: impl }).inspectPageToken({ appId: "1", appSecret: "S", pageId: "111", pageToken: "PT" });
  assert.equal(out.valid, false);
  assert.equal(calls.length, 1);
});

// BL-252 stage 2: the publishing calls, from Meta's documented flows (Instagram content publishing with upload_type=resumable;
// Page Reels upload_phase start → rupload → finish). Every mutating call asks the switch first (AC-XP-2).
const body = (text = "VIDEO") => ({ stream: () => new Blob([text]).stream(), sizeBytes: text.length });

test("AC-XP-2: with the switch off (or absent) every mutating call fails before any request; reads still work", async () => {
  for (const postingAllowed of [undefined, async () => false]) {
    const { calls, impl } = fakeFetch([{ status: 200, body: { status_code: "FINISHED" } }]);
    const client = createMetaClient({ fetchImpl: impl, postingAllowed });
    const off = (e: unknown) => e instanceof DomainError && e.code === "social_posting_disabled";
    await assert.rejects(client.igCreateReelContainer({ igUserId: "1", token: "T", caption: "c", shareToFeed: true, isAiGenerated: true }), off);
    await assert.rejects(client.igUploadReel({ containerId: "C", token: "T", body: body() }), off);
    await assert.rejects(client.igPublish({ igUserId: "1", containerId: "C", token: "T" }), off);
    await assert.rejects(client.fbReelStart({ pageId: "P", token: "T" }), off);
    await assert.rejects(client.fbUploadReel({ uploadUrl: "https://rupload.facebook.com/video-upload/v23.0/V", token: "T", body: body() }), off);
    await assert.rejects(client.fbReelFinish({ pageId: "P", token: "T", videoId: "V", title: null, description: "d", isAiGenerated: true }), off);
    assert.equal(calls.length, 0);
    assert.equal(await client.igContainerStatus({ containerId: "C", token: "T" }), "FINISHED");
  }
});

test("Instagram Reel: container (REELS, resumable, caption, is_ai_generated; token in the body), bytes to rupload with OAuth header, publish", async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: { id: "C1" } },
    { status: 200, body: { success: true } },
    { status: 200, body: { id: "M1" } },
    { status: 200, body: { permalink: "https://www.instagram.com/reel/abc/" } },
  ]);
  const client = createMetaClient({ fetchImpl: impl, postingAllowed: async () => true });
  assert.deepEqual(await client.igCreateReelContainer({ igUserId: "1784", token: "PT", caption: "Hi #x", shareToFeed: true, isAiGenerated: true }), { containerId: "C1" });
  const form = new URLSearchParams(String(calls[0].init?.body));
  assert.match(calls[0].url.pathname, /\/1784\/media$/);
  assert.equal(calls[0].url.search, "");
  assert.deepEqual(Object.fromEntries(form), { media_type: "REELS", upload_type: "resumable", caption: "Hi #x", share_to_feed: "true", is_ai_generated: "true", access_token: "PT" });
  await client.igUploadReel({ containerId: "C1", token: "PT", body: body("12345") });
  assert.equal(calls[1].url.hostname, "rupload.facebook.com");
  assert.match(calls[1].url.pathname, /^\/ig-api-upload\/v\d+\.\d+\/C1$/);
  const h = new Headers(calls[1].init?.headers);
  assert.equal(h.get("authorization"), "OAuth PT");
  assert.equal(h.get("offset"), "0");
  assert.equal(h.get("file_size"), "5");
  // 2026-11-15: the whole file goes as one body of known length (fetch then sends Content-Length), never a chunked stream.
  assert.ok(calls[1].init?.body instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(calls[1].init?.body as Uint8Array), "12345");
  assert.deepEqual(await client.igPublish({ igUserId: "1784", containerId: "C1", token: "PT" }), { mediaId: "M1" });
  assert.equal(new URLSearchParams(String(calls[2].init?.body)).get("creation_id"), "C1");
  assert.equal(await client.igPermalink({ mediaId: "M1", token: "PT" }), "https://www.instagram.com/reel/abc/");
});

test("Facebook Reel: start → upload to the returned rupload URL → finish PUBLISHED now (never SCHEDULED) with is_ai_generated", async () => {
  const { calls, impl } = fakeFetch([
    { status: 200, body: { video_id: "V1", upload_url: "https://rupload.facebook.com/video-upload/v23.0/V1" } },
    { status: 200, body: { success: true } },
    { status: 200, body: { success: true } },
    { status: 200, body: { status: { video_status: "ready", publishing_phase: { status: "complete", publish_status: "published" } }, permalink_url: "/reel/123" } },
  ]);
  const client = createMetaClient({ fetchImpl: impl, postingAllowed: async () => true });
  assert.deepEqual(await client.fbReelStart({ pageId: "P1", token: "PT" }), { videoId: "V1", uploadUrl: "https://rupload.facebook.com/video-upload/v23.0/V1" });
  assert.equal(new URLSearchParams(String(calls[0].init?.body)).get("upload_phase"), "start");
  await client.fbUploadReel({ uploadUrl: "https://rupload.facebook.com/video-upload/v23.0/V1", token: "PT", body: body() });
  await client.fbReelFinish({ pageId: "P1", token: "PT", videoId: "V1", title: "T", description: "D #x", isAiGenerated: true });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(calls[2].init?.body))), { upload_phase: "finish", video_id: "V1", video_state: "PUBLISHED", description: "D #x", is_ai_generated: "true", access_token: "PT", title: "T" });
  assert.deepEqual(await client.fbVideoStatus({ videoId: "V1", token: "PT" }), { videoStatus: "ready", publishStatus: "published", permalink: "https://www.facebook.com/reel/123" });
});

test("Facebook Reel: an upload address outside rupload.facebook.com is refused (start and upload)", async () => {
  const { calls, impl } = fakeFetch([{ status: 200, body: { video_id: "V1", upload_url: "https://evil.example/x" } }]);
  const client = createMetaClient({ fetchImpl: impl, postingAllowed: async () => true });
  await assert.rejects(client.fbReelStart({ pageId: "P1", token: "PT" }), (e: unknown) => e instanceof DomainError && e.code === "social_request_rejected");
  await assert.rejects(client.fbUploadReel({ uploadUrl: "https://evil.example/x", token: "PT", body: body() }), (e: unknown) => e instanceof DomainError && e.code === "social_request_rejected");
  assert.equal(calls.length, 1);
});

test("2026-11-15: a rupload refusal carries Meta's debug_info message; a file whose bytes differ from its size is refused before the request", async () => {
  const { calls, impl } = fakeFetch([{ status: 400, body: { debug_info: { retriable: false, type: "ProcessingFailedError", message: "Request processing failed" } } }]);
  const client = createMetaClient({ fetchImpl: impl, postingAllowed: async () => true });
  await assert.rejects(client.igUploadReel({ containerId: "C1", token: "PT", body: body("12345") }), (e: unknown) => e instanceof DomainError && /ProcessingFailedError: Request processing failed/.test(e.message));
  await assert.rejects(client.igUploadReel({ containerId: "C1", token: "PT", body: { stream: () => new Blob(["123"]).stream(), sizeBytes: 5 } }), (e: unknown) => e instanceof DomainError && /changed while it was read/.test(e.message));
  assert.equal(calls.length, 1);
});
