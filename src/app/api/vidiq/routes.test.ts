import assert from "node:assert/strict";
import test from "node:test";
import { createVidiqHarness, SENTINEL_KEY } from "@/lib/vidiq-research/testing/harness";
import { createVidiqBalancePostHandler } from "./balance/route";
import { createVidiqCheckPostHandler } from "./check/route";
import { createVidiqKeyDeleteHandler, createVidiqKeyPutHandler } from "./key/route";
import { createVidiqStatusGetHandler } from "./route";
import { createVidiqSettingsPatchHandler } from "./settings/route";
import type { VidiqRouteDeps } from "./shared";

// BL-278 stage 1: the owner's Settings routes for vidIQ. Session required; thin calls into the module; no answer ever carries the key
// (AC-VQ-1.4 over API response bodies); a non-domain failure answers a fixed message, never the error's own text.

const session = async () => ({ user: { id: "owner" } });
const json = (method: string, body?: unknown) => new Request("http://127.0.0.1:3000/api/vidiq", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("every route answers 401 without a Web session and calls nothing", async () => {
  let touched = false;
  const core = new Proxy({}, { get: () => () => ((touched = true), Promise.resolve({})) }) as VidiqRouteDeps["core"];
  const deps: VidiqRouteDeps = { getSession: async () => null, core };
  for (const handler of [createVidiqStatusGetHandler(deps), createVidiqKeyPutHandler(deps), createVidiqKeyDeleteHandler(deps), createVidiqSettingsPatchHandler(deps), createVidiqBalancePostHandler(deps), createVidiqCheckPostHandler(deps)]) {
    assert.equal((await handler(json("POST", {}))).status, 401);
  }
  assert.equal(touched, false);
});

test("save, status, settings, balance, check and clear answer without the key (sentinel), with the error codes as status", async () => {
  const h = await createVidiqHarness();
  try {
    const deps: VidiqRouteDeps = { getSession: session, core: h.services };
    const bodies: string[] = [];
    const call = async (handler: (r: Request) => Promise<Response>, request: Request) => {
      const response = await handler(request);
      const text = await response.text();
      bodies.push(text);
      return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
    };
    const wrong = await call(createVidiqKeyPutHandler(deps), json("PUT", { apiKey: "vq_wrong_key_value_1" }));
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error, "vidiq_key_invalid");
    const saved = await call(createVidiqKeyPutHandler(deps), json("PUT", { apiKey: SENTINEL_KEY }));
    assert.equal(saved.status, 200);
    assert.equal((saved.body.key as { hint: string }).hint, "3a9c");
    assert.equal(saved.body.enabled, true);
    const status = await call(createVidiqStatusGetHandler(deps), json("GET"));
    assert.equal(status.status, 200);
    assert.equal((status.body.balance as { totalCredits: number }).totalCredits, 150);
    const budget = await call(createVidiqSettingsPatchHandler(deps), json("PATCH", { monthlyBudgetCredits: 120 }));
    assert.equal((budget.body.budget as { monthly: number }).monthly, 120);
    const badBudget = await call(createVidiqSettingsPatchHandler(deps), json("PATCH", { monthlyBudgetCredits: -3 }));
    assert.equal(badBudget.status, 400);
    assert.equal((await call(createVidiqBalancePostHandler(deps), json("POST"))).status, 200);
    const check = await call(createVidiqCheckPostHandler(deps), json("POST"));
    assert.equal((check.body.report as unknown[]).length, 18);
    h.fake.script.set("vidiq_balance", () => ({ http: 503 }));
    const down = await call(createVidiqBalancePostHandler(deps), json("POST"));
    assert.equal(down.status, 503);
    assert.equal(down.body.error, "vidiq_unavailable");
    const cleared = await call(createVidiqKeyDeleteHandler(deps), json("DELETE"));
    assert.equal((cleared.body.key as { state: string }).state, "none");
    assert.equal(cleared.body.enabled, false);
    const off = await call(createVidiqSettingsPatchHandler(deps), json("PATCH", { enabled: true }));
    assert.equal(off.status, 409);
    assert.equal(off.body.error, "vidiq_key_missing");
    for (const body of bodies) assert.equal(body.includes(SENTINEL_KEY), false, body.slice(0, 200));
  } finally {
    await h.close();
  }
});

test("a non-domain failure answers 500 with a fixed message, never the thrown text", async () => {
  const secretText = "Bearer vq_SENTINEL_7f3a9c in some header dump";
  const core = { getStatus: async () => Promise.reject(new Error(secretText)) } as unknown as VidiqRouteDeps["core"];
  const response = await createVidiqStatusGetHandler({ getSession: session, core })(json("GET"));
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes(secretText), false);
  assert.equal(text.includes(SENTINEL_KEY), false);
  assert.equal((JSON.parse(text) as { error: string }).error, "internal_error");
});

test("a body that is not JSON is a 400 validation_failed", async () => {
  const h = await createVidiqHarness();
  try {
    const request = new Request("http://127.0.0.1:3000/api/vidiq/key", { method: "PUT", headers: { "content-type": "application/json" }, body: "{not json" });
    const response = await createVidiqKeyPutHandler({ getSession: session, core: h.services })(request);
    assert.equal(response.status, 400);
    assert.equal(h.fake.requests.length, 0);
  } finally {
    await h.close();
  }
});
