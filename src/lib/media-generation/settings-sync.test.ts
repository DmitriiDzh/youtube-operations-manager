import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MEDIA_SETTINGS, DomainError, type MediaSettings } from "./contracts";
import { changedSharedFields, createSettingsSync, planPeerApply, sharedValuesOf, SHARED_SETTING_FIELDS } from "./settings-sync";

// BL-150 (docs/roadmap/plans/PRODUCTION_SETTINGS_SYNC_PLAN.md; owner msgs 2008/2011): what this device applies of the shared
// Setup settings, and how.

const local = (over: Partial<MediaSettings> = {}): MediaSettings => ({ ...DEFAULT_MEDIA_SETTINGS, gpuFallbackIds: [], ...over });

test("AC-MS-06: the price is never shared; every other Setup field is", () => {
  assert.ok(!(SHARED_SETTING_FIELDS as readonly string[]).includes("gpuOnDemandPricePerHr"));
  assert.deepEqual(Object.keys(sharedValuesOf(local())).sort(), Object.keys(DEFAULT_MEDIA_SETTINGS).filter((k) => k !== "gpuOnDemandPricePerHr").sort());
});

test("only the fields a save really changed are published (an untouched conflicted field is not)", () => {
  assert.deepEqual(changedSharedFields(local({ maxUsdPerDay: 10, idleMinutes: 10 }), local({ maxUsdPerDay: 20, idleMinutes: 10 })), { maxUsdPerDay: 20 });
  assert.deepEqual(changedSharedFields(local({ gpuFallbackIds: ["a", "b"] }), local({ gpuFallbackIds: ["b", "a"] })), { gpuFallbackIds: ["b", "a"] });
  assert.deepEqual(changedSharedFields(local(), local({ gpuOnDemandPricePerHr: 0.5 })), {});
});

test("msg 2011 (a) / AC-MS-04: a conflicted field and, on another account, the account-bound fields are held, never applied", () => {
  const { patch, held } = planPeerApply({
    local: local({ maxUsdPerDay: 10, networkVolumeId: "vol-1", idleMinutes: 10 }),
    shared: { maxUsdPerDay: 15, networkVolumeId: "vol-2", idleMinutes: 5, gpuFallbackIds: ["L4"] },
    conflicted: new Set(["maxUsdPerDay"]),
    sameAccount: false,
  });
  assert.deepEqual(patch, { idleMinutes: 5, gpuFallbackIds: ["L4"] });
  assert.deepEqual(held.map((h) => h.field).sort(), ["maxUsdPerDay", "networkVolumeId"]);
  assert.deepEqual(planPeerApply({ local: local({ networkVolumeId: "vol-1" }), shared: { networkVolumeId: "vol-2" }, conflicted: new Set(), sameAccount: true }).patch, { networkVolumeId: "vol-2" });
});

function fixture(opts: { shared: Record<string, unknown>; conflicts?: Array<{ field: string; values: unknown[] }>; reject?: (patch: Record<string, unknown>) => Error | null; sameAccount?: boolean }) {
  let settings = local();
  const applies: Array<Record<string, unknown>> = [];
  const events: string[] = [];
  const seeded: Array<Record<string, unknown>> = [];
  const sync = createSettingsSync({
    shared: {
      read: async () => ({ values: opts.shared as never, conflicts: (opts.conflicts ?? []).map((c) => ({ ...c, valuesByActor: {} })) as never }),
      seedMissing: async (values) => {
        seeded.push(values);
        return { changed: [] };
      },
    },
    getSettings: async () => settings,
    applyUpdate: async (patch) => {
      applies.push(patch);
      const error = opts.reject?.(patch);
      if (error) throw error;
      settings = { ...settings, ...(patch as Partial<MediaSettings>) };
      return settings;
    },
    sameAccount: async () => opts.sameAccount ?? true,
    record: async (e) => void events.push(`${e.action}:${(e.details.fields as string[]).join(",")}`),
    clock: { now: () => new Date("2026-10-07T15:00:00.000Z") },
  });
  return { sync, applies, events, seeded, settings: () => settings };
}

test("AC-MS-01/02: a received value is applied through the validated update; one invalid value holds only itself, and is not retried", async () => {
  const f = fixture({
    shared: { idleMinutes: 5, gpuTypeId: "NOT-A-GPU" },
    reject: (patch) => ("gpuTypeId" in patch ? new DomainError({ code: "media_settings_invalid", message: 'GPU type "NOT-A-GPU" is not in RunPod\'s catalog.' }) : null),
  });
  const first = await f.sync.tick();
  assert.equal(f.settings().idleMinutes, 5);
  assert.equal(f.settings().gpuTypeId, null);
  assert.deepEqual(first.pending.map((p) => [p.field, p.reason.startsWith("not applied:")]), [["gpuTypeId", true]]);
  assert.deepEqual(f.events, ["settings_applied_from_peer:idleMinutes"]);
  assert.equal(f.seeded.length, 1, "this device's values are offered for the fields the document lacks");
  const before = f.applies.length;
  await f.sync.tick();
  assert.equal(f.applies.length, before, "the same invalid value is not tried again (no RunPod catalog read per tick)");
});

test("AC-MS-03: a volume change waits while the volume is in use, and is applied on a later tick once it is free", async () => {
  let busy = true;
  const f = fixture({
    shared: { networkVolumeId: "vol-2" },
    reject: (patch) => (busy && "networkVolumeId" in patch ? new DomainError({ code: "media_session_conflict", message: "Cannot change the network volume while a generation session is open" }) : null),
  });
  const waiting = await f.sync.tick();
  assert.match(waiting.pending[0]?.reason ?? "", /waiting: the network volume is in use/);
  busy = false;
  const done = await f.sync.tick();
  assert.equal(f.settings().networkVolumeId, "vol-2");
  assert.deepEqual(done.pending, []);
});

test("a conflict is reported with this computer's value and leaves the local value as it is", async () => {
  const f = fixture({ shared: { maxUsdPerDay: 15 }, conflicts: [{ field: "maxUsdPerDay", values: [10, 15] }] });
  const status = await f.sync.tick();
  assert.equal(f.settings().maxUsdPerDay, 10);
  assert.deepEqual(status.conflicts, [{ field: "maxUsdPerDay", values: [10, 15], thisComputer: 10 }]);
  assert.equal(f.applies.length, 0);
});

// Independent review: only a value Production calls invalid is held; an outage (RunPod unreachable, keys not there yet) is retried.
test("a RunPod outage is retried on the next tick; only an invalid value is held", async () => {
  let down = true;
  const f = fixture({ shared: { gpuTypeId: "NVIDIA L4" }, reject: () => (down ? new Error("fetch failed: RunPod unreachable") : null) });
  const first = await f.sync.tick();
  assert.match(first.pending[0]?.reason ?? "", /retried/);
  down = false;
  await f.sync.tick();
  assert.equal(f.settings().gpuTypeId, "NVIDIA L4");
});

// Independent review: a datacenter and its volume are valid only together; each alone is refused.
test("fields valid only together are applied together", async () => {
  const f = fixture({
    shared: { datacenterId: "EU-RO-1", networkVolumeId: "vol-eu", idleMinutes: 5, gpuTypeId: "BAD" },
    reject: (patch) => {
      if ("gpuTypeId" in patch) return new DomainError({ code: "media_settings_invalid", message: "GPU not in the catalog" });
      const keys = Object.keys(patch);
      const one = keys.includes("datacenterId") !== keys.includes("networkVolumeId");
      return one ? new DomainError({ code: "media_settings_invalid", message: "volume is not in that datacenter" }) : null;
    },
  });
  const status = await f.sync.tick();
  assert.equal(f.settings().datacenterId, "EU-RO-1");
  assert.equal(f.settings().networkVolumeId, "vol-eu");
  assert.equal(f.settings().idleMinutes, 5);
  assert.deepEqual(status.pending.map((p) => p.field), ["gpuTypeId"]);
});
