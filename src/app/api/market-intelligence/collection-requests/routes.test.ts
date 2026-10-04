import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createCollectionRequestsListHandlers } from "./route";
import { createCollectionLimitsHandlers } from "./limits/route";
import { createCollectionApproveHandlers } from "./[requestId]/approve/route";
import { createCollectionRejectHandlers } from "./[requestId]/reject/route";

const SESSION = async () => ({ user: { id: "u1" } });
const NO_SESSION = async () => null;
const params = (requestId: string) => ({ params: Promise.resolve({ requestId }) });
const json = (body: unknown) => new Request("http://localhost/x", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("collection-requests routes: every route answers 401 without a session and never reaches the core", async () => {
  let calls = 0;
  const bump = async () => {
    calls += 1;
    return {} as never;
  };
  const list = createCollectionRequestsListHandlers({ getSession: NO_SESSION, core: { listCollectionRequests: bump } });
  const limits = createCollectionLimitsHandlers({ getSession: NO_SESSION, core: { getCollectionLimits: bump } });
  const approve = createCollectionApproveHandlers({ getSession: NO_SESSION, core: { runApprovedCollectionRequest: bump } });
  const reject = createCollectionRejectHandlers({ getSession: NO_SESSION, core: { rejectCollectionRequest: bump } });
  assert.equal((await list.GET()).status, 401);
  assert.equal((await limits.GET()).status, 401);
  assert.equal((await approve.POST(json({}), params("cr-1"))).status, 401);
  assert.equal((await reject.POST(json({ reason: "x" }), params("cr-1"))).status, 401);
  assert.equal(calls, 0);
});

test("collection-requests routes: GET list and GET limits return the core's data", async () => {
  const list = createCollectionRequestsListHandlers({ getSession: SESSION, core: { listCollectionRequests: async () => ({ requests: [] }) } });
  assert.deepEqual(await (await list.GET()).json(), { requests: [] });
  const limitsValue = { dailyBudgetUnits: 1000 };
  const limits = createCollectionLimitsHandlers({ getSession: SESSION, core: { getCollectionLimits: async () => limitsValue as never } });
  assert.deepEqual(await (await limits.GET()).json(), limitsValue);
});

test("collection-requests approve: runs the request with the SESSION user as credential (never a body-supplied one) and returns the finished request", async () => {
  let received: unknown;
  const handlers = createCollectionApproveHandlers({
    getSession: SESSION,
    core: {
      runApprovedCollectionRequest: async (input: unknown) => {
        received = input;
        return { requestId: "cr-1", status: "done" } as never;
      },
    },
  });
  const response = await handlers.POST(json({ credentialRef: { userId: "attacker" } }), params("cr-1"));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { requestId: "cr-1", credentialRef: { userId: "u1" } });
  assert.deepEqual(await response.json(), { requestId: "cr-1", status: "done" });
});

test("collection-requests approve: domain errors keep their code and status (not pending 409, unknown 404, budget unset 409, budget used up 429); anything else is 500", async () => {
  const failing = (error: unknown) =>
    createCollectionApproveHandlers({
      getSession: SESSION,
      core: {
        runApprovedCollectionRequest: async () => {
          throw error;
        },
      },
    });
  const cases: Array<[string, number]> = [
    ["COLLECTION_REQUEST_NOT_PENDING", 409],
    ["COLLECTION_REQUEST_NOT_FOUND", 404],
    ["MARKET_INTELLIGENCE_QUOTA_DISABLED", 409],
    ["MARKET_INTELLIGENCE_QUOTA_EXCEEDED", 429],
  ];
  for (const [code, status] of cases) {
    const response = await failing(new DomainError({ code: code as never, message: "m", details: { a: 1 } })).POST(json({}), params("cr-1"));
    assert.equal(response.status, status, code);
    assert.deepEqual(await response.json(), { error: code, message: "m", details: { a: 1 } });
  }
  const internal = await failing(new Error("boom")).POST(json({}), params("cr-1"));
  assert.equal(internal.status, 500);
  assert.equal((await internal.json()).error, "internal_error");
});

test("collection-requests reject: forwards the reason; invalid JSON is 400; a non-object body reaches the core without a reason (the schema rejects it); domain errors keep their code", async () => {
  const received: unknown[] = [];
  const handlers = createCollectionRejectHandlers({
    getSession: SESSION,
    core: {
      rejectCollectionRequest: async (input: unknown) => {
        received.push(input);
        if ((input as { reason?: unknown }).reason === undefined) throw new DomainError({ code: "validation_failed", message: "reason is required" });
        return { requestId: "cr-1", status: "rejected" } as never;
      },
    },
  });
  const ok = await handlers.POST(json({ reason: "too expensive" }), params("cr-1"));
  assert.equal(ok.status, 200);
  assert.deepEqual(received[0], { requestId: "cr-1", reason: "too expensive" });
  assert.equal((await handlers.POST(json("not json"), params("cr-1"))).status, 400);
  const nullBody = await handlers.POST(json("null"), params("cr-1"));
  assert.equal(nullBody.status, 400, "validation_failed maps to 400 like every other market-intelligence route");
  assert.deepEqual(received[1], { requestId: "cr-1", reason: undefined });
});
