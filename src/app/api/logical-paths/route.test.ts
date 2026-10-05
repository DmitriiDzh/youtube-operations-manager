import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/logical-paths/contracts";
import { createLogicalPathsDeleteHandler, createLogicalPathsGetHandler, createLogicalPathsPostHandler } from "./route";
import { createLogicalPathValuePutHandler } from "./value/route";

// docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md AC-FO-12 (401 before touching the core) plus the
// DomainError -> HTTP status contract for the logical-path error codes.

function jsonRequest(method: string, body: string) {
  return new Request("http://localhost/api/logical-paths", {
    method,
    headers: { "content-type": "application/json" },
    body,
  });
}

function mustNotBeCalled() {
  const fail = async (): Promise<never> => {
    throw new Error("must not be called");
  };
  return { listForOperator: fail, createPath: fail, deletePath: fail, setValue: fail };
}

test("AC-FO-12: every unauthenticated method is rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: mustNotBeCalled() };
  assert.equal((await createLogicalPathsGetHandler(deps)()).status, 401);
  assert.equal((await createLogicalPathsPostHandler(deps)(jsonRequest("POST", "{}"))).status, 401);
  assert.equal((await createLogicalPathsDeleteHandler(deps)(jsonRequest("DELETE", "{}"))).status, 401);
  assert.equal((await createLogicalPathValuePutHandler(deps)(jsonRequest("PUT", "{}"))).status, 401);
});

test("malformed JSON is a 400 validation_failed, never reaching the core", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const core = mustNotBeCalled();
  for (const response of [
    await createLogicalPathsPostHandler({ getSession, core })(jsonRequest("POST", "{not json")),
    await createLogicalPathsDeleteHandler({ getSession, core })(jsonRequest("DELETE", "{not json")),
    await createLogicalPathValuePutHandler({ getSession, core })(jsonRequest("PUT", "{not json")),
  ]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "validation_failed");
  }
});

test("domain errors map to their HTTP status with the error code in the body", async () => {
  const cases = [
    ["LOGICAL_PATH_NOT_FOUND", 404],
    ["LOGICAL_PATH_ALREADY_EXISTS", 409],
    ["LOGICAL_PATH_VALUE_INVALID", 400],
    ["LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE", 409],
  ] as const;
  for (const [code, status] of cases) {
    const failing = async () => {
      throw new DomainError({ code, message: "rejected" });
    };
    const response = await createLogicalPathValuePutHandler({
      getSession: async () => ({ user: { id: "user-1" } }),
      core: { ...mustNotBeCalled(), setValue: failing },
    })(jsonRequest("PUT", JSON.stringify({ name: "factory_shared", path: "/x" })));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, code);
  }
});

test("happy paths: GET lists, POST creates with 201, DELETE removes, PUT returns the stored value", async () => {
  const getSession = async () => ({ user: { id: "user-1" } });
  const core = {
    async listForOperator() {
      return [{ name: "factory_shared", audience: "all_agents" as const, description: "", path: null, status: null, updatedAt: null }];
    },
    async createPath(input: unknown) {
      return { name: (input as { name: string }).name };
    },
    async deletePath(input: unknown) {
      return { name: (input as { name: string }).name };
    },
    async setValue(input: unknown) {
      return { name: (input as { name: string }).name, path: "/x" };
    },
  };
  const list = await createLogicalPathsGetHandler({ getSession, core })();
  assert.equal(list.status, 200);
  assert.equal((await list.json()).paths[0].name, "factory_shared");

  const created = await createLogicalPathsPostHandler({ getSession, core })(jsonRequest("POST", JSON.stringify({ name: "abc" })));
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json()).path, { name: "abc" });

  const deleted = await createLogicalPathsDeleteHandler({ getSession, core })(jsonRequest("DELETE", JSON.stringify({ name: "abc" })));
  assert.equal(deleted.status, 200);

  const put = await createLogicalPathValuePutHandler({ getSession, core })(jsonRequest("PUT", JSON.stringify({ name: "abc", path: "/x" })));
  assert.deepEqual((await put.json()).value, { name: "abc", path: "/x" });
});
