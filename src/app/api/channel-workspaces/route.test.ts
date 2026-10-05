import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/channel-workspaces/contracts";
import { createChannelWorkspacesGetHandler, createChannelWorkspacesPutHandler } from "./route";

// docs/roadmap/plans/PHASE_11_PLAN.md AC-P11-13 (401 before touching the core) plus the
// DomainError -> HTTP status contract for the two new Phase 11 error codes.

function putRequest(body: string) {
  return new Request("http://localhost/api/channel-workspaces", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
  });
}

function coreThatMustNotBeCalled() {
  return {
    async listWorkspaces(): Promise<never> {
      throw new Error("must not be called");
    },
    async setWorkspace(): Promise<never> {
      throw new Error("must not be called");
    },
  };
}

test("AC-P11-13: unauthenticated GET and PUT are rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: coreThatMustNotBeCalled() };
  assert.equal((await createChannelWorkspacesGetHandler(deps)()).status, 401);
  assert.equal(
    (await createChannelWorkspacesPutHandler(deps)(putRequest(JSON.stringify({ channelId: "UC_A", path: "/x" })))).status,
    401
  );
});

test("PUT: malformed JSON is a 400 validation_failed, never reaching the core", async () => {
  const response = await createChannelWorkspacesPutHandler({
    getSession: async () => ({ user: { id: "user-1" } }),
    core: coreThatMustNotBeCalled(),
  })(putRequest("{not json"));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "validation_failed");
});

test("PUT: an invalid path maps to 400 and a non-connected channel to 404, with the error code in the body", async () => {
  for (const [code, status] of [
    ["CHANNEL_WORKSPACE_PATH_INVALID", 400],
    ["CHANNEL_WORKSPACE_CHANNEL_NOT_CONNECTED", 404],
  ] as const) {
    const response = await createChannelWorkspacesPutHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
      core: {
        ...coreThatMustNotBeCalled(),
        async setWorkspace() {
          throw new DomainError({ code, message: "rejected" });
        },
      },
    })(putRequest(JSON.stringify({ channelId: "UC_A", path: "/x" })));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
  }
});

test("PUT/GET: a successful call returns the core's own result unchanged", async () => {
  const deps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: {
      async listWorkspaces() {
        return [{ channelId: "UC_A", path: "/work/a", updatedAt: "2026-09-30T00:00:00.000Z" }];
      },
      async setWorkspace() {
        return { configured: true as const, path: "/work/a" };
      },
    },
  };
  const put = await createChannelWorkspacesPutHandler(deps)(putRequest(JSON.stringify({ channelId: "UC_A", path: "/work/a" })));
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { workspace: { configured: true, path: "/work/a" } });

  const get = await createChannelWorkspacesGetHandler(deps)();
  assert.deepEqual(await get.json(), {
    workspaces: [{ channelId: "UC_A", path: "/work/a", updatedAt: "2026-09-30T00:00:00.000Z" }],
  });
});
