import assert from "node:assert/strict";
import test from "node:test";
import { createGeminiSettingsSync, DomainError, type GeminiMediaSettings, type GeminiSharedValue } from "@/lib/gemini-media";
import type { GeminiRouteCore, GeminiRouteDeps } from "../shared";
import { createGeminiSettingsSyncResolveHandler } from "./resolve/route";
import { createGeminiSettingsSyncGetHandler } from "./route";

// BL-193 (ADR 0039 §5, ADR 0030's rules) at the HTTP boundary: both routes need a Web session (401); the GET reports what is
// held and what conflicts, and never applies a shared value (a GET must not write); the resolve route accepts only one of the four
// shared limits with a number, refuses a value that is not one of the conflicting ones, and applies the owner's choice here.

type SharedDoc = { values: Record<string, GeminiSharedValue>; conflicts: Array<{ field: string; values: GeminiSharedValue[] }> };

function harness(opts: { session?: boolean; local?: Partial<GeminiMediaSettings>; shared?: SharedDoc; sharedFails?: boolean } = {}) {
  let local: GeminiMediaSettings = { enabled: false, maxUsdPerJob: 1, maxUsdPerDay: 5, maxUsdPerMonth: 50, maxActiveJobs: 2, ...opts.local };
  const doc: SharedDoc = opts.shared ?? { values: {}, conflicts: [] };
  const applied: Array<Record<string, unknown>> = [];
  const shared = {
    read: async () => {
      if (opts.sharedFails) throw new Error("the shared document cannot be read");
      return { values: { ...doc.values }, conflicts: doc.conflicts.map((c) => ({ ...c })) };
    },
    seedMissing: async (values: Record<string, GeminiSharedValue>) => {
      const changed = Object.keys(values).filter((field) => !Object.hasOwn(doc.values, field));
      for (const field of changed) doc.values[field] = values[field];
      return { changed };
    },
    // The engine's rule (media-settings resolveConflict): only a conflicted field, only one of its values.
    resolveConflict: async (input: { field: string; value: GeminiSharedValue }) => {
      const conflict = doc.conflicts.find((c) => c.field === input.field);
      if (!conflict) throw new DomainError({ code: "not_found", message: `Setting "${input.field}" has no conflict to resolve.` });
      if (!conflict.values.includes(input.value)) throw new DomainError({ code: "validation_failed", message: "The chosen value is not one of the conflicting values." });
      doc.values[input.field] = input.value;
      doc.conflicts = doc.conflicts.filter((c) => c.field !== input.field);
    },
  };
  const sync = createGeminiSettingsSync({
    shared,
    getSettings: async () => local,
    applyUpdate: async (patch) => {
      applied.push(patch);
      local = { ...local, ...patch };
      return local;
    },
    clock: { now: () => new Date("2026-10-16T12:00:00Z") },
  });
  const core = {
    getSettingsSyncStatus: () => sync.status(),
    peekSettingsSync: () => sync.peek(),
    // As the production core composes it: the choice goes into the shared document, then is applied here at once.
    resolveSettingConflict: async (input: { field: string; value: GeminiSharedValue }) => {
      await sync.exclusive(() => shared.resolveConflict(input));
      return sync.tick();
    },
  } as unknown as GeminiRouteCore;
  const deps: GeminiRouteDeps = { getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }), core };
  return { deps, applied, doc, local: () => local };
}

const get = () => new Request("http://localhost/api/gemini-media/settings-sync");
const post = (body: unknown) =>
  new Request("http://localhost/api/gemini-media/settings-sync/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("without a Web session both routes answer 401 and nothing is applied", async () => {
  const h = harness({ session: false, shared: { values: { maxUsdPerDay: 8 }, conflicts: [{ field: "maxUsdPerDay", values: [5, 8] }] } });
  assert.equal((await createGeminiSettingsSyncGetHandler(h.deps)(get())).status, 401);
  assert.equal((await createGeminiSettingsSyncResolveHandler(h.deps)(post({ field: "maxUsdPerDay", value: 8 }))).status, 401);
  assert.deepEqual(h.applied, []);
  assert.equal(h.doc.conflicts.length, 1);
});

test("GET reports a conflict with this computer's value and a pending shared value, and applies neither", async () => {
  const h = harness({ local: { maxUsdPerDay: 5, maxUsdPerMonth: 50 }, shared: { values: { maxUsdPerDay: 8, maxUsdPerMonth: 70 }, conflicts: [{ field: "maxUsdPerDay", values: [5, 8] }] } });
  const response = await createGeminiSettingsSyncGetHandler(h.deps)(get());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.conflicts, [{ field: "maxUsdPerDay", values: [5, 8], thisComputer: 5 }]);
  assert.deepEqual(
    body.pending.map((p: { field: string; value: number }) => [p.field, p.value]),
    [
      ["maxUsdPerDay", 8],
      ["maxUsdPerMonth", 70],
    ]
  );
  assert.equal(body.error, null);
  assert.deepEqual(h.applied, []);
  assert.equal(h.local().maxUsdPerMonth, 50);
});

test("GET with an unreadable shared document answers 200 with the error, never 500", async () => {
  const h = harness({ sharedFails: true });
  const response = await createGeminiSettingsSyncGetHandler(h.deps)(get());
  assert.equal(response.status, 200);
  assert.match((await response.json()).error, /cannot be read/);
});

test("resolve validates the body: bad JSON, an unshared or unknown field, a non-number, extra keys → 400, nothing changes", async () => {
  const h = harness({ shared: { values: { maxUsdPerDay: 8 }, conflicts: [{ field: "maxUsdPerDay", values: [5, 8] }] } });
  const handler = createGeminiSettingsSyncResolveHandler(h.deps);
  for (const body of ["{not json", { field: "enabled", value: 1 }, { field: "maxUsdPerWeek", value: 8 }, { field: "maxUsdPerDay", value: "8" }, { field: "maxUsdPerDay" }, { field: "maxUsdPerDay", value: 8, extra: true }]) {
    const response = await handler(post(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "validation_failed");
  }
  assert.deepEqual(h.applied, []);
  assert.equal(h.doc.conflicts.length, 1);
});

test("resolve applies the owner's choice here and clears the conflict", async () => {
  const h = harness({ local: { maxUsdPerDay: 5 }, shared: { values: { maxUsdPerDay: 5 }, conflicts: [{ field: "maxUsdPerDay", values: [5, 8] }] } });
  const response = await createGeminiSettingsSyncResolveHandler(h.deps)(post({ field: "maxUsdPerDay", value: 8 }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.conflicts, []);
  assert.deepEqual(body.lastApplied?.fields, ["maxUsdPerDay"]);
  assert.equal(h.local().maxUsdPerDay, 8);
  assert.equal(h.doc.values.maxUsdPerDay, 8);
});

test("resolve refuses a value that is not one of the conflicting ones (400) and a field with no conflict (404)", async () => {
  const h = harness({ shared: { values: { maxUsdPerDay: 5 }, conflicts: [{ field: "maxUsdPerDay", values: [5, 8] }] } });
  const handler = createGeminiSettingsSyncResolveHandler(h.deps);
  const notOffered = await handler(post({ field: "maxUsdPerDay", value: 7 }));
  assert.equal(notOffered.status, 400);
  const noConflict = await handler(post({ field: "maxUsdPerMonth", value: 70 }));
  assert.equal(noConflict.status, 404);
  assert.equal((await noConflict.json()).error, "not_found");
  assert.deepEqual(h.applied, []);
  assert.equal(h.doc.conflicts.length, 1);
});
