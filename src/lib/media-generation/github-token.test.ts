import assert from "node:assert/strict";
import test from "node:test";
import { createKeyFile, type KeyFileAccess } from "@/lib/device-key-file";
import { createDeviceSecrets, createMemoryDeviceSecretStore, type DeviceSecretSlot } from "@/lib/device-secrets";
import { createGithubClient } from "@/lib/media-gateway";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import { createGithubTokenServices } from "./github-token";

// BL-230 (PRIVATE_RUNTIME_REPOS_PLAN.md AC-PR-01..03): a token is checked with GitHub (`GET /user`) before it is stored; no view
// carries it; a malformed one is refused before any call; a check result lands only on the token that was checked. The real
// gateway child runs over a fake fetch whose answers follow GitHub's REST docs. `T` is a token-shaped fake.

const T = "github_pat_" + "11ABCDEFG0".repeat(2) + "_" + "q".repeat(59);
const CLASSIC = "ghp_" + "a1".repeat(18);

function memorySlot(): DeviceSecretSlot {
  let keyText: string | null = null;
  const access: KeyFileAccess = {
    read: async () => keyText,
    write: async (content) => void (keyText = JSON.stringify(content)),
    remove: async () => void (keyText = null),
    randomBytes: (n) => Buffer.alloc(n, 7),
  };
  return createDeviceSecrets({
    store: createMemoryDeviceSecretStore(),
    keyFile: createKeyFile(access, (detail) => new DomainError({ code: "encryption_key_not_configured", message: detail })),
  }).slot("github");
}

function github(status: () => number) {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    const s = status();
    return new Response(JSON.stringify(s === 200 ? { login: "DmitriiDzh" } : { message: "Bad credentials" }), {
      status: s,
      headers: { "content-type": "application/json", "github-authentication-token-expiration": "2026-11-26 00:00:00 UTC" },
    });
  }) as typeof fetch;
  return { client: createGithubClient({ fetchImpl, authorize: async () => {} }), calls };
}

test("AC-PR-01: set checks GET /user with Bearer T, then stores; the view has the login and expiry, never the token", async () => {
  const gh = github(() => 200);
  const services = createGithubTokenServices({ slot: memorySlot(), github: gh.client, now: () => 1_761_000_000_000 });
  const view = await services.setGithubToken({ token: `  ${T} ` });
  assert.deepEqual(gh.calls, [{ url: "https://api.github.com/user", authorization: `Bearer ${T}` }]);
  assert.deepEqual(view, {
    state: "set",
    login: "DmitriiDzh",
    status: "ok",
    expiresAt: "2026-11-26T00:00:00.000Z",
    verifiedAt: new Date(1_761_000_000_000).toISOString(),
    updatedAt: view.updatedAt,
  });
  assert.ok(!JSON.stringify(view).includes(T));
  assert.ok(!JSON.stringify(await services.getGithubToken()).includes(T));
  assert.equal(await services.readGithubToken(), T);
  // A classic token is accepted as well.
  assert.equal((await services.setGithubToken({ token: CLASSIC })).state, "set");
});

test("AC-PR-02: malformed tokens are refused with validation_failed before any call; nothing is stored", async () => {
  const gh = github(() => 200);
  const services = createGithubTokenServices({ slot: memorySlot(), github: gh.client });
  const bad = [
    "hf_" + "a".repeat(34),
    "ghp_short",
    "github_pat_" + "a".repeat(10),
    "github_pat_" + "a".repeat(30) + " " + "b".repeat(30),
    "gho_" + "a".repeat(36),
    "",
    "github_pat_" + "a".repeat(40) + "\n" + "b".repeat(40),
    "ghp_" + "a".repeat(30) + "_" + "b".repeat(10),
  ];
  for (const token of bad) {
    await assert.rejects(services.setGithubToken({ token }), (e: unknown) => isDomainError(e) && e.code === "validation_failed" && !e.message.includes(token || "\u0000"), JSON.stringify(token));
  }
  await assert.rejects(services.setGithubToken({ token: T, extra: 1 }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  assert.equal(gh.calls.length, 0);
  assert.equal((await services.getGithubToken()).state, "none");
});

test("AC-PR-03: a 401 stores nothing; test without a token is github_token_missing; a refused test marks the token invalid; clear", async () => {
  let status = 401;
  const gh = github(() => status);
  const services = createGithubTokenServices({ slot: memorySlot(), github: gh.client, now: () => 1_761_000_100_000 });
  await assert.rejects(services.setGithubToken({ token: T }), (e: unknown) => isDomainError(e) && e.code === "github_token_invalid" && !e.message.includes(T));
  assert.equal((await services.getGithubToken()).state, "none");
  await assert.rejects(services.testGithubToken(), (e: unknown) => isDomainError(e) && e.code === "github_token_missing");

  status = 200;
  await services.setGithubToken({ token: T });
  assert.equal((await services.testGithubToken()).status, "ok");
  status = 401;
  await assert.rejects(services.testGithubToken(), (e: unknown) => isDomainError(e) && e.code === "github_token_invalid" && !JSON.stringify(e).includes(T));
  assert.equal((await services.getGithubToken()).status, "invalid");
  const cleared = await services.clearGithubToken();
  assert.deepEqual({ state: cleared.state, login: cleared.login }, { state: "none", login: null });
  assert.equal(await services.readGithubToken(), null);
});
