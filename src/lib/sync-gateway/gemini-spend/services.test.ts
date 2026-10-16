import assert from "node:assert/strict";
import test from "node:test";
import { GEMINI_SPEND_REPORT_FORMAT, type GeminiSpendReport } from "./contracts";
import { createGeminiSpendShareCore, type GeminiSpendReportStore } from "./services";

// BL-193 (ADR 0039): each computer publishes only its own Gemini spend; the peers' latest reports are kept. Requirements: the
// report is strict (no key, no extra field -- a field carrying the key itself is refused), a fingerprint is 32 hex characters or
// null, spend is bounded, a device speaks only for itself, an older report never replaces a newer one.

function memoryStore(): GeminiSpendReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => {
      local = json;
    },
    readPeers: async () => ({ ...peers }),
    writePeer: async (id, json) => {
      peers[id] = json;
    },
  };
}

const NOW = new Date("2026-10-16T12:00:00Z");
const report = (deviceId: string, extra: Partial<GeminiSpendReport> = {}): GeminiSpendReport => ({
  format: GEMINI_SPEND_REPORT_FORMAT,
  version: 1,
  deviceId,
  hostname: `${deviceId}-host`,
  keyFingerprint: "0123456789abcdef0123456789abcdef",
  updatedAt: "2026-10-16T11:00:00Z",
  spentTodayUsd: 1.25,
  spentMonthUsd: 7.5,
  ...extra,
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function core(own = "me") {
  return createGeminiSpendShareCore({ store: memoryStore(), ownDeviceId: async () => own, clock: { now: () => NOW } });
}

test("publishes only this device's report; a peer's newer report replaces its older one, never the reverse", async () => {
  const c = core();
  await c.publishLocalReport(report("me"));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await c.exportBytes())).deviceId, "me");
  await assert.rejects(c.publishLocalReport(report("someone-else")));
  assert.deepEqual(await c.mergeIncoming(bytes(report("pc", { updatedAt: "2026-10-16T11:30:00Z", spentTodayUsd: 2 })), "pc"), { accepted: true });
  assert.deepEqual(await c.mergeIncoming(bytes(report("pc", { updatedAt: "2026-10-16T10:00:00Z", spentTodayUsd: 9 })), "pc"), { accepted: false });
  assert.deepEqual((await c.listPeerReports()).map((r) => [r.deviceId, r.spentTodayUsd]), [["pc", 2]]);
  assert.deepEqual(await c.mergeIncoming(bytes(report("me")), "me"), { accepted: false }, "its own report never comes back as a peer");
});

test("the report is strict: a key-shaped field, a non-hex or wrong-length fingerprint, an absurd spend, another device's name are refused", async () => {
  const c = core();
  await assert.rejects(c.mergeIncoming(bytes({ ...report("pc"), apiKey: "AIzaSyLeaked" }), "pc"));
  await assert.rejects(c.mergeIncoming(bytes(report("pc", { keyFingerprint: "AIzaSyLeakedKeyLeakedKeyLeaked12" })), "pc"));
  await assert.rejects(c.mergeIncoming(bytes(report("pc", { keyFingerprint: "0123" })), "pc"));
  await assert.rejects(c.mergeIncoming(bytes(report("pc", { spentTodayUsd: 100_001 })), "pc"));
  await assert.rejects(c.mergeIncoming(bytes(report("pc", { spentMonthUsd: -1 })), "pc"));
  await assert.rejects(c.mergeIncoming(bytes(report("pc")), "laptop"), /claims to be from/);
  assert.deepEqual(await c.mergeIncoming(bytes(report("pc", { keyFingerprint: null })), "pc"), { accepted: true }, "no key there: a null fingerprint is valid");
  assert.equal((await c.listPeerReports()).length, 1);
});

test("nothing to push before this device's first report: not_found", async () => {
  await assert.rejects(core().exportBytes(), (error: unknown) => (error as { code?: string }).code === "not_found");
});
