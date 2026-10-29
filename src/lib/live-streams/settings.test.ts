import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS, DomainError } from "./contracts";
import { createLiveStreamsSettings, liveStreamsHost, liveStreamsSettingsFromJson } from "./settings";

// BL-176 (LIVE_STREAMS_PLAN.md §3.1, §3.12; ADR 0036 §1–2; owner msg 2575 for the buffer depth of 2).

test("defaults: off, a buffer of 2, warn under 10 GB, refuse under 5 GB", () => {
  const s = liveStreamsSettingsFromJson(null);
  assert.deepEqual([s.enabled, s.bufferDepth, s.warnBelowGb, s.refuseBelowGb, s.ffmpegDir], [false, 2, 10, 5, null]);
});

test("a bad stored field falls back to its own default only; a refuse level not below the warning resets both", () => {
  const s = liveStreamsSettingsFromJson(JSON.stringify({ bufferDepth: 99, bitrateKbps: 4500, encoder: "nvenc" }));
  assert.deepEqual([s.bufferDepth, s.bitrateKbps, s.encoder], [DEFAULT_LIVE_STREAMS_SETTINGS.bufferDepth, 4500, DEFAULT_LIVE_STREAMS_SETTINGS.encoder]);
  const t = liveStreamsSettingsFromJson(JSON.stringify({ warnBelowGb: 4, refuseBelowGb: 6 }));
  assert.deepEqual([t.warnBelowGb, t.refuseBelowGb], [10, 5]);
  assert.deepEqual(liveStreamsSettingsFromJson("{not json"), { ...DEFAULT_LIVE_STREAMS_SETTINGS });
});

test("host: only the Mac running as the system service can host streams", () => {
  assert.deepEqual(liveStreamsHost({ platform: "darwin", serviceMode: "1" }), { ok: true });
  assert.equal(liveStreamsHost({ platform: "darwin", serviceMode: undefined }).ok, false);
  assert.equal(liveStreamsHost({ platform: "win32", serviceMode: "1" }).ok, false);
});

function store(host: ReturnType<typeof liveStreamsHost>) {
  let json: string | null = null;
  return { settings: createLiveStreamsSettings({ getJson: async () => json, setJson: async (j) => void (json = j), host: () => host }), read: () => json };
}

test("switching the module on is refused where streams cannot be hosted, and nothing is saved", async () => {
  const s = store({ ok: false, reason: "Live streams run only on the Mac." });
  await assert.rejects(() => s.settings.update({ enabled: true }), (e: unknown) => e instanceof DomainError && e.code === "live_streams_host_unsupported");
  assert.equal(s.read(), null);
  await s.settings.update({ bufferDepth: 3 });
  assert.equal(JSON.parse(s.read()!).bufferDepth, 3, "other settings can still be saved there");
});

test("on the service host the switch turns on; ranges and the refuse < warn rule are enforced", async () => {
  const s = store({ ok: true });
  assert.equal((await s.settings.update({ enabled: true })).enabled, true);
  for (const bad of [{ bufferDepth: 0 }, { bufferDepth: 7 }, { bitrateKbps: 500 }, { alertMinutes: 0 }, { encoder: "nvenc" }, { unknown: 1 }]) {
    await assert.rejects(() => s.settings.update(bad), (e: unknown) => e instanceof DomainError && e.code === "validation_failed", JSON.stringify(bad));
  }
  await assert.rejects(() => s.settings.update({ refuseBelowGb: 10 }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.deepEqual((await s.settings.get()).host, { ok: true });
});

// BL-233 (FO-REQ-0047 ask 2): the upload limit while live -- 2 Mbit/s by default, 0 = no limit -- and the starvation guard, 3
// minutes by default, 0 = never held. Per computer, like every setting here.
test("BL-233: upload limit 2 Mbit/s and guard 3 minutes by default; 0 is a valid value for both", async () => {
  const s = liveStreamsSettingsFromJson(null);
  assert.deepEqual([s.uploadCapMbps, s.uploadGuardMinutes], [2, 3]);
  const { settings } = store({ ok: true });
  const saved = await settings.update({ uploadCapMbps: 0, uploadGuardMinutes: 0 });
  assert.deepEqual([saved.uploadCapMbps, saved.uploadGuardMinutes], [0, 0]);
  assert.equal((await settings.update({ uploadCapMbps: 1.5 })).uploadCapMbps, 1.5);
});

test("BL-233: bad stored upload values fall back to their own defaults; out-of-range input is refused", async () => {
  for (const bad of [-1, 101, "2", null, Number.NaN]) {
    assert.equal(liveStreamsSettingsFromJson(JSON.stringify({ uploadCapMbps: bad, bitrateKbps: 4000 })).uploadCapMbps, 2, String(bad));
  }
  for (const bad of [-1, 61, 1.5, "3"]) assert.equal(liveStreamsSettingsFromJson(JSON.stringify({ uploadGuardMinutes: bad })).uploadGuardMinutes, 3, String(bad));
  const { settings } = store({ ok: true });
  await assert.rejects(() => settings.update({ uploadCapMbps: -0.5 }), DomainError);
  await assert.rejects(() => settings.update({ uploadCapMbps: 100.5 }), DomainError);
  await assert.rejects(() => settings.update({ uploadGuardMinutes: 2.5 }), DomainError);
  await assert.rejects(() => settings.update({ uploadGuardMinutes: 61 }), DomainError);
});
