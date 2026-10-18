import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createHuggingFaceClient } from "./huggingface";

// Expected request/response shapes come from the Hugging Face Hub HTTP API as used by `huggingface_hub`
// (`model_info`: GET /api/models/{repo}/revision/{rev} -> { sha, gated, private }; `get_paths_info`:
// POST /api/models/{repo}/paths-info/{rev} form `paths=…&expand=false` -> [{ type, path, size, lfs?: { oid, size } }],
// where `lfs.oid` is the file's SHA-256) and from docs/roadmap/plans/FACTORY_MEDIA_CONTROL_PLAN.md §2.1, not from this
// implementation.

type Call = { url: string; init: RequestInit };

function fakeFetch(responder: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = responder(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const SHA = "a".repeat(64);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function hub(overrides: { info?: { status: number; body?: unknown }; paths?: { status: number; body?: unknown }; resolve?: { status: number }; infoWithToken?: { status: number; body?: unknown } } = {}) {
  return fakeFetch((call) => {
    // BL-134 (review): the HEAD on the file's resolve URL (an LFS file redirects to the CDN: 302 without following it).
    if (call.url.includes("/resolve/")) return overrides.resolve ?? { status: 302 };
    if (overrides.infoWithToken && !call.url.includes("/paths-info/") && new Headers(call.init.headers).has("authorization")) return overrides.infoWithToken;
    if (call.url.includes("/paths-info/")) return overrides.paths ?? { status: 200, body: [{ type: "file", path: "split/flux.safetensors", size: 17_236_328_572, oid: "gitoid", lfs: { oid: SHA, size: 17_236_328_572, pointerSize: 135 } }] };
    return overrides.info ?? { status: 200, body: { id: "Comfy-Org/flux1-schnell", sha: COMMIT, gated: false, private: false } };
  });
}

test("getFileInfo resolves the revision to a commit, then reads the file's size and LFS SHA-256 at that commit; both calls pass the gateway authorization", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = hub();
  const client = createHuggingFaceClient({ fetchImpl, authorize: async (c) => void authorized.push(c) });
  const info = await client.getFileInfo({ repoId: "Comfy-Org/flux1-schnell", file: "split/flux.safetensors" });
  // BL-134: the result also names the card's licence (none in this fixture).
  assert.deepEqual(info, { repoId: "Comfy-Org/flux1-schnell", revision: "main", commitSha: COMMIT, path: "split/flux.safetensors", bytes: 17_236_328_572, sha256: SHA, licenseId: null, licenseUrl: null, authenticated: false });
  assert.equal(calls[0].url, "https://huggingface.co/api/models/Comfy-Org/flux1-schnell/revision/main");
  assert.equal(calls[1].url, `https://huggingface.co/api/models/Comfy-Org/flux1-schnell/paths-info/${COMMIT}`);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(String(calls[1].init.body), "paths=split%2Fflux.safetensors&expand=false");
  assert.deepEqual(authorized, ["huggingface_api", "huggingface_api"]);
  // No credential of any kind is sent (public repos only in this phase).
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
});

test("an explicit revision is used as given (URL-encoded); a non-LFS file has sha256 null", async () => {
  const { fetchImpl, calls } = hub({ paths: { status: 200, body: [{ type: "file", path: "config.json", size: 512, oid: "gitoid" }] } });
  const info = await createHuggingFaceClient({ fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "a/b", file: "config.json", revision: "refs/pr/1" });
  assert.equal(calls[0].url, "https://huggingface.co/api/models/a/b/revision/refs%2Fpr%2F1");
  assert.equal(info.sha256, null);
  assert.equal(info.bytes, 512);
});

// BL-134 changed this requirement (FO-REQ-0028 acceptance 1, owner msg 3007): a repo the model info marks gated or private, with no
// token stored, is now `hf_token_missing` (a token would open it); an unauthenticated 401/403 (repo may not even exist) stays
// `media_model_gated`.
test("without a token: a repo marked gated or private is hf_token_missing; an unauthenticated 401/403 stays media_model_gated", async () => {
  for (const info of [
    { status: 200, body: { sha: COMMIT, gated: "manual", private: false } },
    { status: 200, body: { sha: COMMIT, gated: "auto", private: false } },
    { status: 200, body: { sha: COMMIT, gated: false, private: true } },
  ]) {
    const { fetchImpl, calls } = hub({ info });
    await assert.rejects(
      createHuggingFaceClient({ fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "black-forest-labs/FLUX.1-dev", file: "flux1-dev.safetensors" }),
      (e: unknown) => isDomainError(e) && e.code === "hf_token_missing" && (e.details as { repoUrl?: string }).repoUrl === "https://huggingface.co/black-forest-labs/FLUX.1-dev"
    );
    assert.equal(calls.length, 1, "nothing is asked after the model info");
  }
  for (const info of [
    { status: 401, body: { error: "Invalid username or password." } },
    { status: 403, body: { error: "Access to model is restricted" } },
  ]) {
    const { fetchImpl } = hub({ info });
    await assert.rejects(createHuggingFaceClient({ fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "black-forest-labs/FLUX.1-dev", file: "flux1-dev.safetensors" }), (e: unknown) => isDomainError(e) && e.code === "media_model_gated");
  }
});

test("an unknown repo or revision (404) or a file not in the repo is media_model_not_found; a 5xx or a network failure is huggingface_unavailable", async () => {
  const missingRepo = hub({ info: { status: 404, body: { error: "Repository not found" } } });
  await assert.rejects(createHuggingFaceClient({ fetchImpl: missingRepo.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "media_model_not_found");
  const missingFile = hub({ paths: { status: 200, body: [] } });
  await assert.rejects(createHuggingFaceClient({ fetchImpl: missingFile.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "media_model_not_found");
  const folder = hub({ paths: { status: 200, body: [{ type: "directory", path: "x", oid: "t" }] } });
  await assert.rejects(createHuggingFaceClient({ fetchImpl: folder.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "media_model_not_found");
  const down = hub({ info: { status: 503, body: { error: "busy" } } });
  await assert.rejects(createHuggingFaceClient({ fetchImpl: down.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "huggingface_unavailable");
  const offline = createHuggingFaceClient({
    authorize: async () => {},
    fetchImpl: (async () => {
      throw new Error("ENOTFOUND huggingface.co");
    }) as typeof fetch,
  });
  await assert.rejects(offline.getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "huggingface_unavailable");
});

test("a blocked gateway stops the call before any request", async () => {
  const { fetchImpl, calls } = hub();
  const client = createHuggingFaceClient({
    fetchImpl,
    authorize: async () => {
      const { DomainError } = await import("@/lib/shared-domain");
      throw new DomainError({ code: "media_gateway_disabled", message: "off" });
    },
  });
  await assert.rejects(client.getFileInfo({ repoId: "a/b", file: "x" }), (e: unknown) => isDomainError(e) && e.code === "media_gateway_disabled");
  assert.equal(calls.length, 0);
});

// BL-134 (docs/roadmap/plans/DEVICE_SECRETS_PLAN.md AC-HF-01..03, 05): the owner's read token is sent as a Bearer header to the Hub
// only; the error codes follow FO-REQ-0028 §2B; the token never appears in an error.
const TOKEN = "hf_" + "x".repeat(34);

test("AC-HF-01 (review): a public repo is read without the token -- it is not even asked for -- and no call carries Authorization", async () => {
  const { fetchImpl, calls } = hub();
  let asked = 0;
  await createHuggingFaceClient({ fetchImpl, authorize: async () => {} }).getFileInfo({
    repoId: "Comfy-Org/flux1-schnell",
    file: "split/flux.safetensors",
    tokenFor: async () => {
      asked += 1;
      return TOKEN;
    },
  });
  assert.equal(asked, 0);
  assert.ok(calls.every((c) => !new Headers(c.init.headers).has("authorization")));
});

test("AC-HF-01/03: a gated repo: model info unauthenticated, then paths-info and a HEAD on the file with Bearer; a 403 on the file is hf_gate_not_accepted before any pod", async () => {
  const ok = hub({ info: { status: 200, body: { sha: COMMIT, gated: "manual", private: false } } });
  const info = await createHuggingFaceClient({ fetchImpl: ok.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "black-forest-labs/flux-3-image-klein-comfy", file: "split/flux.safetensors", tokenFor: async () => TOKEN });
  assert.equal(info.sha256, SHA);
  assert.equal(info.authenticated, true);
  assert.equal(new Headers(ok.calls[0].init.headers).has("authorization"), false, "model info is public");
  const head = ok.calls.find((c) => c.url.includes("/resolve/"));
  assert.ok(head && head.init.method === "HEAD" && head.url === `https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/${COMMIT}/split/flux.safetensors`);
  assert.ok(ok.calls.slice(1).every((c) => new Headers(c.init.headers).get("authorization") === `Bearer ${TOKEN}`));

  const refused = hub({ info: { status: 200, body: { sha: COMMIT, gated: "manual" } }, resolve: { status: 403 } });
  await assert.rejects(
    createHuggingFaceClient({ fetchImpl: refused.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "black-forest-labs/flux-3-image-klein-comfy", file: "split/flux.safetensors", tokenFor: async () => TOKEN }),
    (e: unknown) =>
      isDomainError(e) &&
      e.code === "hf_gate_not_accepted" &&
      (e.details as { repoUrl?: string }).repoUrl === "https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy" &&
      !JSON.stringify({ m: e.message, d: e.details }).includes(TOKEN)
  );
});

test("AC-HF-01: a private repo (unauthenticated 401) is asked again with the token; without a stored token it stays media_model_gated", async () => {
  const privateRepo = hub({ info: { status: 401, body: { error: "Repository not found" } }, infoWithToken: { status: 200, body: { sha: COMMIT, gated: false, private: true } } });
  const info = await createHuggingFaceClient({ fetchImpl: privateRepo.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "owner/private-model", file: "split/flux.safetensors", tokenFor: async () => TOKEN });
  assert.equal(info.authenticated, true);
  const noToken = hub({ info: { status: 401, body: { error: "Repository not found" } } });
  await assert.rejects(
    createHuggingFaceClient({ fetchImpl: noToken.fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "owner/private-model", file: "split/flux.safetensors", tokenFor: async () => null }),
    (e: unknown) => isDomainError(e) && e.code === "media_model_gated"
  );
});

test("AC-HF-02: whoami with a refused token is hf_token_invalid (never echoing it); an accepted one gives the user name", async () => {
  const refused = fakeFetch(() => ({ status: 401, body: { error: "Invalid credentials in Authorization header" } }));
  await assert.rejects(
    createHuggingFaceClient({ fetchImpl: refused.fetchImpl, authorize: async () => {} }).whoami(TOKEN),
    (e: unknown) => isDomainError(e) && e.code === "hf_token_invalid" && !JSON.stringify({ m: e.message, d: e.details }).includes(TOKEN)
  );
  assert.equal(refused.calls[0].url, "https://huggingface.co/api/whoami-v2");
  const accepted = fakeFetch(() => ({ status: 200, body: { type: "user", name: "owner-hf" } }));
  assert.deepEqual(await createHuggingFaceClient({ fetchImpl: accepted.fetchImpl, authorize: async () => {} }).whoami(TOKEN), { name: "owner-hf" });
  assert.equal(new Headers(accepted.calls[0].init.headers).get("authorization"), `Bearer ${TOKEN}`);
});

test("AC-HF-05: the licence comes from the repo card -- a relative link at the commit, an id alone gives the repo page, none gives nulls", async () => {
  const cases: Array<[unknown, { licenseId: string | null; licenseUrl: string | null }]> = [
    [{ license: "other", license_link: "LICENSE.md" }, { licenseId: "other", licenseUrl: `https://huggingface.co/acme/model/blob/${COMMIT}/LICENSE.md` }],
    [{ license: "apache-2.0" }, { licenseId: "apache-2.0", licenseUrl: "https://huggingface.co/acme/model" }],
    [undefined, { licenseId: null, licenseUrl: null }],
  ];
  for (const [cardData, expected] of cases) {
    const { fetchImpl } = hub({ info: { status: 200, body: { sha: COMMIT, gated: false, private: false, ...(cardData ? { cardData } : {}) } } });
    const info = await createHuggingFaceClient({ fetchImpl, authorize: async () => {} }).getFileInfo({ repoId: "acme/model", file: "split/flux.safetensors" });
    assert.deepEqual({ licenseId: info.licenseId, licenseUrl: info.licenseUrl }, expected);
  }
});
