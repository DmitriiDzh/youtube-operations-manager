import assert from "node:assert/strict";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore } from "@/lib/device-secrets";
import { createGithubClient } from "@/lib/media-gateway";
import { DomainError, type MediaGenerationCore } from "@/lib/media-generation";
import { createGithubTokenServices } from "@/lib/media-generation/github-token";
import type { MediaRouteDeps } from "../shared";
import { createGithubTokenDeleteHandler, createGithubTokenGetHandler, createGithubTokenPutHandler } from "./route";
import { createGithubTokenTestHandler } from "./test/route";

// BL-230 (PRIVATE_RUNTIME_REPOS_PLAN.md AC-PR-04) at the HTTP boundary: 401 without a session; after a save no body of any of the
// four routes -- a refusal's included -- carries the token. The real token services over an in-memory store and a fake GitHub.

const T = "github_pat_" + "R0u7e5T3s7".repeat(8) + "_rr";

function deps(session: boolean): { deps: MediaRouteDeps; setGithubStatus: (s: number) => void } {
  let keyText: string | null = null;
  const access: KeyFileAccess = {
    read: async () => keyText,
    write: async (content) => void (keyText = JSON.stringify(content)),
    remove: async () => void (keyText = null),
    randomBytes: (n) => Buffer.alloc(n, 3),
  };
  const slot = createDeviceSecrets({
    store: createMemoryDeviceSecretStore(),
    keyFile: createKeyFile(access, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
  }).slot("github");
  let status = 200;
  const fetchImpl = (async () =>
    new Response(JSON.stringify(status === 200 ? { login: "DmitriiDzh" } : { message: "Bad credentials" }), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
  const services = createGithubTokenServices({ slot, github: createGithubClient({ fetchImpl, authorize: async () => {} }) });
  const core = {
    getGithubToken: services.getGithubToken,
    setGithubToken: services.setGithubToken,
    testGithubToken: services.testGithubToken,
    clearGithubToken: services.clearGithubToken,
  } as unknown as MediaGenerationCore;
  return {
    deps: { getSession: async () => (session ? { user: { id: "owner" } } : null), core, isConnectedChannel: async () => false },
    setGithubStatus: (s) => void (status = s),
  };
}

const put = (token: string) => new Request("http://localhost/api/media-generation/github-token", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
const plain = (method: string) => new Request("http://localhost/api/media-generation/github-token", { method });

test("AC-PR-04: every GitHub token route answers 401 without a session and stores nothing", async () => {
  const d = deps(false);
  for (const response of [
    await createGithubTokenGetHandler(d.deps)(plain("GET")),
    await createGithubTokenPutHandler(d.deps)(put(T)),
    await createGithubTokenTestHandler(d.deps)(plain("POST")),
    await createGithubTokenDeleteHandler(d.deps)(plain("DELETE")),
  ]) {
    assert.equal(response.status, 401);
  }
  assert.equal(await d.deps.core.getGithubToken().then((v) => v.state), "none");
});

test("AC-PR-04: after a save no response body carries the token -- GET, PUT, test, a refused test, DELETE", async () => {
  const d = deps(true);
  const bodies: string[] = [];
  const saved = await createGithubTokenPutHandler(d.deps)(put(T));
  assert.equal(saved.status, 200);
  bodies.push(await saved.text());
  assert.equal(JSON.parse(bodies[0]).login, "DmitriiDzh");
  const got = await createGithubTokenGetHandler(d.deps)(plain("GET"));
  bodies.push(await got.text());
  bodies.push(await (await createGithubTokenTestHandler(d.deps)(plain("POST"))).text());
  d.setGithubStatus(401);
  const refused = await createGithubTokenTestHandler(d.deps)(plain("POST"));
  assert.equal(refused.status, 422);
  const refusedBody = await refused.text();
  assert.equal(JSON.parse(refusedBody).error, "github_token_invalid");
  bodies.push(refusedBody);
  const badFormat = await createGithubTokenPutHandler(d.deps)(put(T + " x"));
  assert.equal(badFormat.status, 400);
  bodies.push(await badFormat.text());
  bodies.push(await (await createGithubTokenDeleteHandler(d.deps)(plain("DELETE"))).text());
  for (const body of bodies) assert.ok(!body.includes(T), body);
});
