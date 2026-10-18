import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createGithubClient } from "./github";

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
