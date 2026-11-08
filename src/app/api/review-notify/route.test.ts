import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createReviewNotifyHandlers, type ReviewNotifyRouteDeps } from "./shared";

// BL-248 (ADR 0066): a signed-in owner only (401, the module is never called); a refusal keeps its status (400 validation_failed).

function deps(overrides: Partial<ReviewNotifyRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: ReviewNotifyRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: () => ({
      view: async () => (calls.push(["view"]), { enabled: true }) as never,
      updateSettings: async (input) => {
        calls.push(["settings", input]);
        if ((input as { inboxPath?: unknown }).inboxPath === "relative") throw new DomainError({ code: "validation_failed", message: "absolute path" });
        return { enabled: false } as never;
      },
    }),
  };
  return { deps: { ...base, ...overrides }, calls };
}

const put = (body: string) => new Request("http://localhost/api/review-notify", { method: "PUT", body, headers: { "Content-Type": "application/json" } });

test("no session: 401 and the module is never called", async () => {
  const { deps: d, calls } = deps({ getSession: async () => null });
  const h = createReviewNotifyHandlers(d);
  assert.equal((await h.GET()).status, 401);
  assert.equal((await h.PUT(put('{"enabled":false}'))).status, 401);
  assert.deepEqual(calls, []);
});

test("the card and a save; a bad body is 400 and a refused path keeps validation_failed", async () => {
  const { deps: d, calls } = deps();
  const h = createReviewNotifyHandlers(d);
  assert.deepEqual(await (await h.GET()).json(), { enabled: true });
  assert.deepEqual(await (await h.PUT(put('{"enabled":false}'))).json(), { enabled: false });
  assert.equal((await h.PUT(put("not json"))).status, 400);
  const refused = await h.PUT(put('{"inboxPath":"relative"}'));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "validation_failed");
  assert.deepEqual(calls, [["view"], ["settings", { enabled: false }], ["settings", { inboxPath: "relative" }]]);
});
