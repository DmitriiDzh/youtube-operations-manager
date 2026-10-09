import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { createInactivityHandlers } from "./route";

// BL-163 (FO-REQ-0014 §A2): GET/POST "inactive after N months" -- session-gated, the body forwarded to the core as is.

function post(body: unknown) {
  return new Request("http://localhost/api/market-intelligence/inactivity", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
}

test("inactivity route: GET returns the setting; an unauthenticated request never reaches the core", async () => {
  let called = 0;
  const core = {
    async getInactivitySetting() {
      called += 1;
      return { inactiveAfterMonths: 6 };
    },
    async setInactivitySetting() {
      called += 1;
      return { inactiveAfterMonths: 6 };
    },
  };
  const ok = createInactivityHandlers({ getSession: async () => ({ user: { id: "u1" } }), core });
  const response = await ok.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { inactiveAfterMonths: 6 });

  called = 0;
  const denied = createInactivityHandlers({ getSession: async () => null, core });
  assert.equal((await denied.GET()).status, 401);
  assert.equal((await denied.POST(post({ inactiveAfterMonths: 3 }))).status, 401);
  assert.equal(called, 0);
});

test("inactivity route: POST forwards the body and returns the stored value; invalid JSON is 400; a validation DomainError is 400", async () => {
  let received: unknown;
  const handlers = createInactivityHandlers({
    getSession: async () => ({ user: { id: "u1" } }),
    core: {
      async getInactivitySetting() {
        return { inactiveAfterMonths: 6 };
      },
      async setInactivitySetting(input: unknown) {
        received = input;
        if ((input as { inactiveAfterMonths: number }).inactiveAfterMonths > 60) throw new DomainError({ code: "validation_failed", message: "bad", details: {} });
        return { inactiveAfterMonths: 9 };
      },
    },
  });
  const response = await handlers.POST(post({ inactiveAfterMonths: 9 }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { inactiveAfterMonths: 9 });
  assert.deepEqual(await response.json(), { inactiveAfterMonths: 9 });
  assert.equal((await handlers.POST(post("not json"))).status, 400);
  const failed = await handlers.POST(post({ inactiveAfterMonths: 61 }));
  assert.equal(failed.status, 400);
  assert.equal((await failed.json()).error, "validation_failed");
});
