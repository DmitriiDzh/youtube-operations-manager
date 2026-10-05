import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/agent-tokens/contracts";
import { createImportFactoryTokenPostHandler } from "@/app/api/factory-agent-token/import/route";
import { createImportAgentTokenPostHandler } from "./route";

// docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md §2.4 and AC-TI-07/AC-TI-12: operator-only (session
// required), metadata-only response, documented statuses, and the plaintext in no response body.

const PLAINTEXT = `ytom_ch_UC_A.${"s".repeat(43)}`;
const handlers = [
  ["channel", createImportAgentTokenPostHandler],
  ["factory", createImportFactoryTokenPostHandler],
] as const;

function post(body: string) {
  return new Request("http://localhost/api/agent-tokens/import", { method: "POST", headers: { "content-type": "application/json" }, body });
}

const mustNotBeCalled = { importToken: async (): Promise<never> => { throw new Error("must not be called"); } };

test("AC-TI-12: without a Web session import is 401 and the core is never reached", async () => {
  for (const [, create] of handlers) {
    const response = await create({ getSession: async () => null, core: mustNotBeCalled })(post(JSON.stringify({ token: PLAINTEXT })));
    assert.equal(response.status, 401);
  }
});

test("a successful import is 201, no-store, metadata only", async () => {
  const summary = { tokenId: "t1", channelId: "UC_A", label: null, createdAt: "2026-10-05T00:00:00.000Z" };
  for (const [, create] of handlers) {
    const response = await create({
      getSession: async () => ({ user: { id: "u" } }),
      core: { importToken: async () => summary },
    })(post(JSON.stringify({ channelId: "UC_A", token: PLAINTEXT })));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { token: summary });
    assert.equal(text.includes(PLAINTEXT), false);
  }
});

test("import error codes map to the statuses in the plan; malformed JSON is 400", async () => {
  const expected: Array<[string, number]> = [
    ["AGENT_TOKEN_IMPORT_MALFORMED", 400],
    ["AGENT_TOKEN_IMPORT_LEGACY_FORMAT", 400],
    ["AGENT_TOKEN_CHANNEL_MISMATCH", 409],
    ["AGENT_TOKEN_IMPORT_REVOKED", 409],
    ["AGENT_TOKEN_CHANNEL_NOT_CONNECTED", 404],
    ["AGENT_TOKEN_IDENTITY_MISMATCH", 409],
  ];
  for (const [, create] of handlers) {
    for (const [code, status] of expected) {
      const response = await create({
        getSession: async () => ({ user: { id: "u" } }),
        core: { importToken: async () => { throw new DomainError({ code: code as never, message: "m" }); } },
      })(post(JSON.stringify({ token: PLAINTEXT })));
      assert.equal(response.status, status, code);
      assert.equal((await response.json()).error, code);
    }
    const malformed = await create({ getSession: async () => ({ user: { id: "u" } }), core: mustNotBeCalled })(post("{not json"));
    assert.equal(malformed.status, 400);
  }
});

test("AC-TI-07: an unexpected failure whose message contains the plaintext does not echo it", async () => {
  for (const [, create] of handlers) {
    const response = await create({
      getSession: async () => ({ user: { id: "u" } }),
      core: { importToken: async () => { throw new Error(`boom ${PLAINTEXT}`); } },
    })(post(JSON.stringify({ token: PLAINTEXT })));
    assert.equal(response.status, 500);
    assert.equal((await response.text()).includes(PLAINTEXT), false);
  }
});
