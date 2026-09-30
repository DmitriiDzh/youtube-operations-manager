import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-assignments/contracts";
import { createMarketAssignmentsGetHandler, createMarketAssignmentsPutHandler } from "./route";

// docs/roadmap/plans/PHASE_12_PLAN.md slice 12.4: operator-only (session required); the query/body
// reach the core unchanged; domain errors keep their documented statuses.

const fail = async (): Promise<never> => {
  throw new Error("must not be called");
};

test("unauthenticated GET/PUT are rejected with 401 before touching the core", async () => {
  const deps = { getSession: async () => null, core: { listAssignments: fail, setAssignment: fail } };
  assert.equal((await createMarketAssignmentsGetHandler(deps)(new Request("http://x/api/market-assignments?recordKind=topic"))).status, 401);
  assert.equal((await createMarketAssignmentsPutHandler(deps)(new Request("http://x", { method: "PUT", body: "{}" }))).status, 401);
});

test("GET forwards recordKind; PUT forwards the body and maps domain errors", async () => {
  let listedWith: unknown;
  const deps = {
    getSession: async () => ({ user: { id: "u" } }),
    core: {
      async listAssignments(input: unknown) {
        listedWith = input;
        return [];
      },
      async setAssignment() {
        throw new DomainError({ code: "RESEARCH_CHANNEL_NOT_AVAILABLE", message: "x" });
      },
    },
  };
  const get = await createMarketAssignmentsGetHandler(deps)(new Request("http://x/api/market-assignments?recordKind=topic"));
  assert.equal(get.status, 200);
  assert.deepEqual(listedWith, { recordKind: "topic" });

  const put = await createMarketAssignmentsPutHandler(deps)(
    new Request("http://x", { method: "PUT", body: JSON.stringify({ recordKind: "topic", recordId: "t", channelIds: [] }) })
  );
  assert.equal(put.status, 404);
  assert.equal((await put.json()).error, "RESEARCH_CHANNEL_NOT_AVAILABLE");
});
