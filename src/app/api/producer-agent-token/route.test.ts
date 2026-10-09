import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/producer-agent-tokens/contracts";
import { createImportProducerTokenPostHandler } from "./import/route";
import { createProducerTokenDeleteHandler, createProducerTokenGetHandler, createProducerTokenPostHandler } from "./route";

// docs/roadmap/plans/PRODUCER_ROLE_PLAN.md AC-PR-01: the operator manages the Producer token like the factory token --
// 401 without a Web session before the core is touched, the plaintext only in the issue answer (uncached), and an import
// answer or error never echoes the token.

const fail = async (): Promise<never> => {
  throw new Error("must not be called");
};
const post = (url: string, body: string) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body });

test("AC-PR-01: every unauthenticated method is rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: { issueToken: fail, revokeToken: fail, getActiveToken: fail } };
  assert.equal((await createProducerTokenGetHandler(deps)()).status, 401);
  assert.equal((await createProducerTokenPostHandler(deps)(post("http://localhost/api/producer-agent-token", "{}"))).status, 401);
  assert.equal((await createProducerTokenDeleteHandler(deps)()).status, 401);
  const importDeps = { getSession: async () => null, core: { importToken: fail } };
  assert.equal((await createImportProducerTokenPostHandler(importDeps)(post("http://localhost/api/producer-agent-token/import", "{}"))).status, 401);
});

test("AC-PR-01: issue answers 201 with the token once and no-store; status and revoke carry no token", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const core = {
    issueToken: async () => ({ tokenId: "t1", label: null, createdAt: "2026-10-09T10:00:00.000Z", token: "ytom_pr_secret" }),
    getActiveToken: async () => ({ tokenId: "t1", label: null, createdAt: "2026-10-09T10:00:00.000Z" }),
    revokeToken: async () => ({ revoked: 1 }),
  };
  const issued = await createProducerTokenPostHandler({ getSession, core })(post("http://localhost/api/producer-agent-token", ""));
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  assert.equal((await issued.json()).token.token, "ytom_pr_secret");
  assert.equal(JSON.stringify(await (await createProducerTokenGetHandler({ getSession, core })()).json()).includes("ytom_pr_"), false);
  assert.deepEqual(await (await createProducerTokenDeleteHandler({ getSession, core })()).json(), { revoked: 1 });
});

test("AC-PR-01: an import answer or error never echoes the presented token", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const token = `ytom_pr_${"Z".repeat(43)}`;
  const ok = await createImportProducerTokenPostHandler({
    getSession,
    core: { importToken: async () => ({ tokenId: "t9", label: null, createdAt: "2026-10-09T10:00:00.000Z" }) },
  })(post("http://localhost/api/producer-agent-token/import", JSON.stringify({ token })));
  assert.equal(ok.status, 201);
  assert.equal((await ok.text()).includes(token), false);
  const refused = await createImportProducerTokenPostHandler({
    getSession,
    core: { importToken: async () => { throw new DomainError({ code: "AGENT_TOKEN_IMPORT_REVOKED", message: "revoked" }); } },
  })(post("http://localhost/api/producer-agent-token/import", JSON.stringify({ token })));
  assert.equal(refused.status, 409);
  assert.equal((await refused.text()).includes(token), false);
  const crashed = await createImportProducerTokenPostHandler({
    getSession,
    core: { importToken: async () => { throw new Error(`boom ${token}`); } },
  })(post("http://localhost/api/producer-agent-token/import", JSON.stringify({ token })));
  assert.equal(crashed.status, 500);
  assert.equal((await crashed.text()).includes(token), false);
});
