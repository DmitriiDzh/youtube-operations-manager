import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createDiskGuardHandlers, type DiskGuardRouteDeps } from "./shared";

// BL-237: the disk guard's routes -- a signed-in owner only (401, the module is not called); the card measures folders only
// with ?measure=1; the bell never breaks (a failing read is "no notice"); the threshold comes from `{ thresholdGb }` and a
// refusal keeps its status (400 validation_failed).

function deps(overrides: Partial<DiskGuardRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: DiskGuardRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: () => ({
      view: async (options) => (calls.push(["view", options]), { settings: { thresholdGb: 20 } }) as never,
      notice: async () => (calls.push(["notice"]), { freeBytes: 1, thresholdGb: 20, since: "2026-10-30T00:00:00.000Z" }),
      updateSettings: async (input) => {
        calls.push(["settings", input]);
        if ((input as { thresholdGb?: unknown })?.thresholdGb !== 30) throw new DomainError({ code: "validation_failed", message: "1-10000" });
        return { thresholdGb: 30 };
      },
    }),
  };
  return { deps: { ...base, ...overrides }, calls };
}

const put = (body: string) => new Request("http://localhost/api/disk-guard/settings", { method: "PUT", body, headers: { "Content-Type": "application/json" } });

test("no session: 401 on every route and the module is never called", async () => {
  const { deps: d, calls } = deps({ getSession: async () => null });
  const h = createDiskGuardHandlers(d);
  assert.equal((await h.GET(new Request("http://localhost/api/disk-guard"))).status, 401);
  assert.equal((await h.GET_NOTICE()).status, 401);
  assert.equal((await h.PUT_SETTINGS(put('{"thresholdGb":30}'))).status, 401);
  assert.deepEqual(calls, []);
});

test("the card: folders are measured only with ?measure=1", async () => {
  const { deps: d, calls } = deps();
  const h = createDiskGuardHandlers(d);
  assert.equal((await h.GET(new Request("http://localhost/api/disk-guard"))).status, 200);
  assert.equal((await h.GET(new Request("http://localhost/api/disk-guard?measure=1"))).status, 200);
  assert.deepEqual(calls, [["view", { measure: false }], ["view", { measure: true }]]);
});

test("the bell: the notice, and a failing read is no notice (200), never an error", async () => {
  const ok = createDiskGuardHandlers(deps().deps);
  assert.deepEqual(await (await ok.GET_NOTICE()).json(), { notice: { freeBytes: 1, thresholdGb: 20, since: "2026-10-30T00:00:00.000Z" } });
  const failing = createDiskGuardHandlers(
    deps({ core: () => ({ view: async () => ({}) as never, notice: async () => Promise.reject(new Error("database locked")), updateSettings: async () => ({ thresholdGb: 20 }) }) }).deps
  );
  const response = await failing.GET_NOTICE();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { notice: null });
});

test("the threshold: saved from { thresholdGb }; a bad value is 400 validation_failed; a body that is not JSON is 400", async () => {
  const { deps: d, calls } = deps();
  const h = createDiskGuardHandlers(d);
  const saved = await h.PUT_SETTINGS(put('{"thresholdGb":30}'));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { settings: { thresholdGb: 30 } });
  const refused = await h.PUT_SETTINGS(put('{"thresholdGb":0}'));
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { error: string }).error, "validation_failed");
  assert.equal((await h.PUT_SETTINGS(put("not json"))).status, 400);
  assert.deepEqual(calls, [["settings", { thresholdGb: 30 }], ["settings", { thresholdGb: 0 }]]);
});
