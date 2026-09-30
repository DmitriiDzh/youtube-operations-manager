import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/agent-tokens/contracts";
import { createAgentTokensDeleteHandler, createAgentTokensGetHandler, createAgentTokensPostHandler } from "./route";

// docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-11: operator-only (session required), plaintext only in
// the POST response, error codes mapped to their documented statuses.

function jsonRequest(method: string, body: string) {
  return new Request("http://localhost/api/agent-tokens", { method, headers: { "content-type": "application/json" }, body });
}

function coreThatMustNotBeCalled() {
  const fail = async (): Promise<never> => {
    throw new Error("must not be called");
  };
  return { issueToken: fail, revokeToken: fail, listActiveTokens: fail };
}

test("unauthenticated GET/POST/DELETE are rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: coreThatMustNotBeCalled() };
  assert.equal((await createAgentTokensGetHandler(deps)()).status, 401);
  assert.equal((await createAgentTokensPostHandler(deps)(jsonRequest("POST", "{}"))).status, 401);
  assert.equal((await createAgentTokensDeleteHandler(deps)(jsonRequest("DELETE", "{}"))).status, 401);
});

test("POST returns the issued token once with no-store; GET returns metadata only", async () => {
  const deps = {
    getSession: async () => ({ user: { id: "u" } }),
    core: {
      ...coreThatMustNotBeCalled(),
      async issueToken() {
        return { tokenId: "t1", channelId: "UC_A", label: null, createdAt: "2026-09-30T00:00:00.000Z", token: "ytom_ch_abc" };
      },
      async listActiveTokens() {
        return [{ tokenId: "t1", channelId: "UC_A", label: null, createdAt: "2026-09-30T00:00:00.000Z" }];
      },
    },
  };
  const post = await createAgentTokensPostHandler(deps)(jsonRequest("POST", JSON.stringify({ channelId: "UC_A" })));
  assert.equal(post.status, 201);
  assert.equal(post.headers.get("cache-control"), "no-store");
  assert.equal((await post.json()).token.token, "ytom_ch_abc");

  const get = await createAgentTokensGetHandler(deps)();
  assert.equal(JSON.stringify(await get.json()).includes("ytom_ch_"), false);
});

test("domain errors map to their statuses; malformed JSON is 400", async () => {
  for (const [code, status] of [
    ["AGENT_TOKEN_CHANNEL_NOT_CONNECTED", 404],
    ["AGENT_TOKEN_IDENTITY_MISMATCH", 409],
  ] as const) {
    const response = await createAgentTokensPostHandler({
      getSession: async () => ({ user: { id: "u" } }),
      core: {
        ...coreThatMustNotBeCalled(),
        async issueToken() {
          throw new DomainError({ code, message: "x" });
        },
      },
    })(jsonRequest("POST", JSON.stringify({ channelId: "UC_A" })));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
  }
  const bad = await createAgentTokensDeleteHandler({ getSession: async () => ({ user: { id: "u" } }), core: coreThatMustNotBeCalled() })(
    jsonRequest("DELETE", "{nope")
  );
  assert.equal(bad.status, 400);
});
