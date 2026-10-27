import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createGithubClient, parseGithubTokenExpiration } from "./github";

// BL-200 (POD_RUNTIMES_PLAN.md §2, AC-RT-02): shapes from GitHub's REST API docs (releases: [{ tag_name, name, published_at,
// prerelease }]; commits/{ref}: { sha, commit: { committer: { date } } }), not from this implementation. No token is sent.

function fake(responder: (url: string) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const { status, body } = responder(String(input));
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const SHA = "6607f36b53c7b695b160ac5b52d595e9e3752a2d";

test("listReleases: tags, names, dates; through the gateway authorization; no Authorization header", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = fake(() => ({ status: 200, body: [{ tag_name: "v0.41.0", name: "v0.41.0", published_at: "2026-10-16T10:00:00Z", prerelease: false }, { name: "no tag" }] }));
  const releases = await createGithubClient({ fetchImpl, authorize: async (c) => void authorized.push(c) }).listReleases("comfyanonymous", "ComfyUI");
  assert.deepEqual(releases, [{ tag: "v0.41.0", name: "v0.41.0", publishedAt: "2026-10-16T10:00:00Z", prerelease: false }]);
  assert.equal(calls[0].url, "https://api.github.com/repos/comfyanonymous/ComfyUI/releases?per_page=30");
  assert.equal(new Headers(calls[0].init.headers).has("authorization"), false);
  assert.deepEqual(authorized, ["github_api"]);
});

test("resolveCommit: a tag becomes its 40-hex commit; an unknown ref is not_found; a bad ref or repo name is refused before any call", async () => {
  const ok = fake(() => ({ status: 200, body: { sha: SHA, commit: { committer: { date: "2026-10-18T13:26:43Z" } } } }));
  assert.deepEqual(await createGithubClient({ fetchImpl: ok.fetchImpl, authorize: async () => {} }).resolveCommit("comfyanonymous", "ComfyUI", "v0.41.0"), { commit: SHA, date: "2026-10-18T13:26:43Z" });
  assert.equal(ok.calls[0].url, "https://api.github.com/repos/comfyanonymous/ComfyUI/commits/v0.41.0");

  const missing = fake(() => ({ status: 422, body: { message: "No commit found for SHA: nope" } }));
  await assert.rejects(createGithubClient({ fetchImpl: missing.fetchImpl, authorize: async () => {} }).resolveCommit("comfyanonymous", "ComfyUI", "nope"), (e: unknown) => isDomainError(e) && e.code === "not_found");

  const none = fake(() => ({ status: 200, body: {} }));
  const client = createGithubClient({ fetchImpl: none.fetchImpl, authorize: async () => {} });
  await assert.rejects(client.resolveCommit("comfyanonymous", "ComfyUI", "../x"), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await assert.rejects(client.resolveCommit("bad owner", "ComfyUI", "v1"), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.equal(none.calls.length, 0);
});

test("a 403 (rate limit) or 5xx is github_unavailable", async () => {
  const limited = fake(() => ({ status: 403, body: { message: "API rate limit exceeded" } }));
  await assert.rejects(createGithubClient({ fetchImpl: limited.fetchImpl, authorize: async () => {} }).listReleases("comfyanonymous", "ComfyUI"), (e: unknown) => isDomainError(e) && e.code === "github_unavailable");
});

// BL-230 (PRIVATE_RUNTIME_REPOS_PLAN.md AC-PR-05/06): with the owner's token a call carries `Bearer <token>` and follows no redirect;
// GitHub's 401 to a token is github_token_invalid, its 404 (repository hidden) and 422 (unknown commit) stay apart. `T` is fake.
const T = "github_pat_" + "Z9y8X7w6V5".repeat(8) + "_ab";

function fakeWithHeaders(responder: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const { status, body, headers } = responder(String(input));
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("AC-PR-05: a token goes as Bearer with redirect 'error'; without one no Authorization header and the default redirect", async () => {
  const f = fakeWithHeaders(() => ({ status: 200, body: { sha: SHA, commit: { committer: { date: null } } } }));
  const client = createGithubClient({ fetchImpl: f.fetchImpl, authorize: async () => {} });
  await client.resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA, { token: T });
  await client.resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA);
  assert.equal(new Headers(f.calls[0].init.headers).get("authorization"), `Bearer ${T}`);
  assert.equal(f.calls[0].init.redirect, "error");
  assert.equal(new Headers(f.calls[1].init.headers).has("authorization"), false);
  assert.equal(f.calls[1].init.redirect, undefined);
});

test("AC-PR-05: GitHub's 401 to a token is github_token_invalid; neither its message nor its details carry the token", async () => {
  const f = fakeWithHeaders(() => ({ status: 401, body: { message: "Bad credentials" } }));
  const client = createGithubClient({ fetchImpl: f.fetchImpl, authorize: async () => {} });
  for (const call of [() => client.resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA, { token: T }), () => client.whoami(T)]) {
    await assert.rejects(call(), (e: unknown) => isDomainError(e) && e.code === "github_token_invalid" && !e.message.includes(T) && !JSON.stringify(e.details ?? {}).includes(T));
  }
});

test("AC-PR-06: 404 is not_found with missing 'repository' (hidden or absent), 422 is not_found with missing 'ref'", async () => {
  for (const [status, missing] of [[404, "repository"], [422, "ref"]] as const) {
    const f = fakeWithHeaders(() => ({ status, body: { message: "x" } }));
    await assert.rejects(
      createGithubClient({ fetchImpl: f.fetchImpl, authorize: async () => {} }).resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA),
      (e: unknown) => isDomainError(e) && e.code === "not_found" && (e.details as Record<string, unknown>).missing === missing
    );
  }
});

test("AC-PR-01: whoami is GET /user with the token -- the login, and the expiry from github-authentication-token-expiration", async () => {
  const f = fakeWithHeaders(() => ({ status: 200, body: { login: "DmitriiDzh", id: 1 }, headers: { "github-authentication-token-expiration": "2026-11-26 00:00:00 UTC" } }));
  const authorized: string[] = [];
  const me = await createGithubClient({ fetchImpl: f.fetchImpl, authorize: async (c) => void authorized.push(c) }).whoami(T);
  assert.deepEqual(me, { login: "DmitriiDzh", expiresAt: "2026-11-26T00:00:00.000Z" });
  assert.equal(f.calls[0].url, "https://api.github.com/user");
  assert.equal(new Headers(f.calls[0].init.headers).get("authorization"), `Bearer ${T}`);
  assert.deepEqual(authorized, ["github_api"]);
  const none = fakeWithHeaders(() => ({ status: 200, body: { login: "DmitriiDzh" } }));
  assert.equal((await createGithubClient({ fetchImpl: none.fetchImpl, authorize: async () => {} }).whoami(T)).expiresAt, null);
});

test("parseGithubTokenExpiration: GitHub's 'YYYY-MM-DD HH:MM:SS UTC' and an offset form; anything else is null", () => {
  assert.equal(parseGithubTokenExpiration("2026-11-26 00:00:00 UTC"), "2026-11-26T00:00:00.000Z");
  assert.equal(parseGithubTokenExpiration("2026-11-26 03:00:00 +0300"), "2026-11-26T00:00:00.000Z");
  assert.equal(parseGithubTokenExpiration("soon"), null);
  assert.equal(parseGithubTokenExpiration(null), null);
});

test("review M2: a 403 to the token that is not a rate limit is github_token_forbidden (Contents read / SSO), never 'unavailable'; a rate-limited 403 stays github_unavailable", async () => {
  const forbidden = fakeWithHeaders(() => ({ status: 403, body: { message: "Resource not accessible by personal access token" }, headers: { "x-ratelimit-remaining": "4999" } }));
  const client = createGithubClient({ fetchImpl: forbidden.fetchImpl, authorize: async () => {} });
  for (const call of [() => client.resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA, { token: T }), () => client.whoami(T)]) {
    await assert.rejects(call(), (e: unknown) => isDomainError(e) && e.code === "github_token_forbidden" && /Contents/.test(e.message) && /SSO/.test(e.message) && !/unavailable/i.test(e.message) && !e.message.includes(T));
  }
  const limited = fakeWithHeaders(() => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }));
  await assert.rejects(
    createGithubClient({ fetchImpl: limited.fetchImpl, authorize: async () => {} }).resolveCommit("DmitriiDzh", "ComfyUI-See-through", SHA, { token: T }),
    (e: unknown) => isDomainError(e) && e.code === "github_unavailable"
  );
  const noToken = fakeWithHeaders(() => ({ status: 403, body: {}, headers: { "x-ratelimit-remaining": "10" } }));
  await assert.rejects(createGithubClient({ fetchImpl: noToken.fetchImpl, authorize: async () => {} }).resolveCommit("o", "r", SHA), (e: unknown) => isDomainError(e) && e.code === "github_unavailable");
});
