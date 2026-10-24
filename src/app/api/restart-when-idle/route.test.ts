import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createRestartHandlers, type RestartRouteDeps } from "./shared";

// BL-220 (RESTART_WHEN_IDLE_PLAN.md): the owner's routes -- a signed-in owner only (401, and the module is not called), the button
// requests as "owner", the owner ends any hold as "owner", the quiet minutes come from `{ quietMinutes }`, and a module refusal keeps
// its status (409 restart_needs_service outside the service, 400 validation_failed, 404 not_found).

function deps(overrides: Partial<RestartRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: RestartRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: () => ({
      status: async () => (calls.push(["status"]), { request: null }) as never,
      request: async (by) => {
        calls.push(["request", by]);
        throw new DomainError({ code: "restart_needs_service", message: "not the service" });
      },
      cancel: async () => {
        calls.push(["cancel"]);
        throw new DomainError({ code: "not_found", message: "none open" });
      },
      setQuietMinutes: async (minutes) => {
        calls.push(["quiet", minutes]);
        if (minutes !== 5) throw new DomainError({ code: "validation_failed", message: "1-30" });
        return { quietMinutes: 5 };
      },
      releaseHold: async (input) => (calls.push(["release", input]), { hold: {}, released: true }) as never,
    }),
    ...overrides,
  };
  return { handlers: createRestartHandlers(base), calls };
}

const holdCtx = (holdId: string) => ({ params: Promise.resolve({ holdId }) });
const put = (body: string) => new Request("http://x", { method: "PUT", body, headers: { "content-type": "application/json" } });

test("no session -> 401 on every route, and the module is not called", async () => {
  const { handlers, calls } = deps({ getSession: async () => null });
  const req = () => new Request("http://x");
  for (const response of [
    await handlers.GET(req(), undefined),
    await handlers.POST(req(), undefined),
    await handlers.DELETE(req(), undefined),
    await handlers.PUT_SETTINGS(put("{\"quietMinutes\":5}"), undefined),
    await handlers.DELETE_HOLD(req(), holdCtx("h1")),
  ]) {
    assert.equal(response.status, 401);
  }
  assert.deepEqual(calls, []);
});

test("POST requests as the owner; outside the service it answers 409 restart_needs_service (AC-RI-07)", async () => {
  const { handlers, calls } = deps();
  const response = await handlers.POST(new Request("http://x", { method: "POST" }), undefined);
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "restart_needs_service");
  assert.deepEqual(calls, [["request", "owner"]]);
});

test("DELETE with no open request answers 404; GET returns the status", async () => {
  const { handlers } = deps();
  assert.equal((await handlers.DELETE(new Request("http://x", { method: "DELETE" }), undefined)).status, 404);
  const status = await handlers.GET(new Request("http://x"), undefined);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { request: null });
});

test("PUT /settings: `{ quietMinutes }` is passed on; a bad value is 400; a body that is not a JSON object is 400", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.PUT_SETTINGS(put("{\"quietMinutes\":5}"), undefined)).status, 200);
  assert.equal((await handlers.PUT_SETTINGS(put("{\"quietMinutes\":31}"), undefined)).status, 400);
  assert.equal((await handlers.PUT_SETTINGS(put("not json"), undefined)).status, 400);
  assert.equal((await handlers.PUT_SETTINGS(put("[5]"), undefined)).status, 400);
  assert.deepEqual(calls, [["quiet", 5], ["quiet", 31]]);
});

test("DELETE /holds/[holdId]: the owner ends the hold as `owner` (AC-RI-04)", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.DELETE_HOLD(new Request("http://x", { method: "DELETE" }), holdCtx("h-42"))).status, 200);
  assert.deepEqual(calls, [["release", { holdId: "h-42", by: "owner" }]]);
});
