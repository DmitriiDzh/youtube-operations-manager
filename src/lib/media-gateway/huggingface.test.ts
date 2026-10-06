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

function hub(overrides: { info?: { status: number; body?: unknown }; paths?: { status: number; body?: unknown } } = {}) {
  return fakeFetch((call) => {
    if (call.url.includes("/paths-info/")) return overrides.paths ?? { status: 200, body: [{ type: "file", path: "split/flux.safetensors", size: 17_236_328_572, oid: "gitoid", lfs: { oid: SHA, size: 17_236_328_572, pointerSize: 135 } }] };
    return overrides.info ?? { status: 200, body: { id: "Comfy-Org/flux1-schnell", sha: COMMIT, gated: false, private: false } };
  });
}

test("getFileInfo resolves the revision to a commit, then reads the file's size and LFS SHA-256 at that commit; both calls pass the gateway authorization", async () => {
  const authorized: string[] = [];
  const { fetchImpl, calls } = hub();
  const client = createHuggingFaceClient({ fetchImpl, authorize: async (c) => void authorized.push(c) });
  const info = await client.getFileInfo({ repoId: "Comfy-Org/flux1-schnell", file: "split/flux.safetensors" });
  assert.deepEqual(info, { repoId: "Comfy-Org/flux1-schnell", revision: "main", commitSha: COMMIT, path: "split/flux.safetensors", bytes: 17_236_328_572, sha256: SHA });
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

test("a gated or private repo is media_model_gated -- reported by the model info or as a 401/403", async () => {
  for (const info of [
    { status: 200, body: { sha: COMMIT, gated: "manual", private: false } },
    { status: 200, body: { sha: COMMIT, gated: "auto", private: false } },
    { status: 200, body: { sha: COMMIT, gated: false, private: true } },
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
