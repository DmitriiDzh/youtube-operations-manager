import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/factory-agent-tokens/contracts";
import { createFactoryTokenDeleteHandler, createFactoryTokenGetHandler, createFactoryTokenPostHandler } from "./route";

// docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md AC-FO-12 (401 before touching the core) and
// AC-FO-10 (the plaintext token is returned exactly once, uncached).

function postRequest(body: string) {
  return new Request("http://localhost/api/factory-agent-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mustNotBeCalled() {
  const fail = async (): Promise<never> => {
    throw new Error("must not be called");
  };
  return { issueToken: fail, revokeToken: fail, getActiveToken: fail };
}

test("AC-FO-12: every unauthenticated method is rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: mustNotBeCalled() };
  assert.equal((await createFactoryTokenGetHandler(deps)()).status, 401);
  assert.equal((await createFactoryTokenPostHandler(deps)(postRequest("{}"))).status, 401);
  assert.equal((await createFactoryTokenDeleteHandler(deps)()).status, 401);
});

test("POST: malformed JSON is a 400 validation_failed; an empty body is accepted as no label", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const bad = await createFactoryTokenPostHandler({ getSession, core: mustNotBeCalled() })(postRequest("{not json"));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "validation_failed");

  let received: unknown = "unset";
  const ok = await createFactoryTokenPostHandler({
    getSession,
    core: {
      ...mustNotBeCalled(),
      async issueToken(input: unknown) {
        received = input;
        return { tokenId: "t1", label: null, createdAt: "2026-10-05T00:00:00.000Z", token: "ytom_fo_x" };
      },
    },
  })(postRequest(""));
  assert.equal(ok.status, 201);
  assert.deepEqual(received, {});
});

test("POST returns the plaintext token with no-store; GET and DELETE never include a token", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const core = {
    async issueToken() {
      return { tokenId: "t1", label: "x", createdAt: "2026-10-05T00:00:00.000Z", token: "ytom_fo_secret" };
    },
    async revokeToken() {
      return { revoked: 1 };
    },
    async getActiveToken() {
      return { tokenId: "t1", label: "x", createdAt: "2026-10-05T00:00:00.000Z" };
    },
  };
  const issued = await createFactoryTokenPostHandler({ getSession, core })(postRequest(JSON.stringify({ label: "x" })));
  assert.equal(issued.headers.get("cache-control"), "no-store");
  assert.equal((await issued.json()).token.token, "ytom_fo_secret");

  const status = await createFactoryTokenGetHandler({ getSession, core })();
  assert.equal(JSON.stringify(await status.json()).includes("ytom_fo_secret"), false);
  const revoked = await createFactoryTokenDeleteHandler({ getSession, core })();
  assert.deepEqual(await revoked.json(), { revoked: 1 });
});

test("a domain error maps to its HTTP status with the error code in the body", async () => {
  const response = await createFactoryTokenPostHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      ...mustNotBeCalled(),
      async issueToken() {
        throw new DomainError({ code: "validation_failed", message: "bad" });
      },
    },
  })(postRequest("{}"));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "validation_failed");
});
