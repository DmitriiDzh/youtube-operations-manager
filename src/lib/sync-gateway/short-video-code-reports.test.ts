import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { isDomainError } from "@/lib/shared-domain";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "./per-device-report";
import { createPublishingUploadsShareCore } from "./publishing-uploads/services";
import { createVideoCostsShareCore } from "./video-costs/services";
import { createVideoReservationsShareCore } from "./video-reservations/services";

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §5, AC-SC-10; ADR 0071 §3): the three per-device reports that validate a video code. A report
// holding no S code is version 1 exactly as before; with one S row it is version 2; this build reads both; a v1-only reader (an
// older build) refuses a v2 report with "newer than this app understands", never "invalid".

function memoryStore(): PerDeviceReportStore {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    readLocal: async () => local,
    writeLocal: async (json) => void (local = json),
    readPeers: async () => ({ ...peers }),
    writePeer: async (deviceId, json) => void (peers[deviceId] = json),
  };
}
const NOW = new Date("2026-11-16T10:00:00.000Z");
const AT = "2026-11-16T09:00:00.000Z";
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const deps = () => ({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => NOW } });

const reservation = (video: string, replacedBy: string | null = null) => ({ channelId: "UC1", video, workingTitle: null, reservedAt: AT, state: replacedBy ? "cancelled" : "in_work", cancelledAt: replacedBy ? AT : null, replacedBy });
const reservations = (version: number, rows: unknown[]) => ({ format: "ytm-video-reservations", version, deviceId: "win", hostName: "WIN", updatedAt: AT, reservations: rows });
const uploads = (version: number, rows: unknown[]) => ({ format: "ytm-publishing-uploads", version, deviceId: "win", hostName: "WIN", updatedAt: AT, uploads: rows });
const run = (video: string | null) => ({
  runId: "gemini:j1", source: "gemini", kind: "job", channelId: "UC1", video, label: null, mediaKind: null, storyboardId: null, storyboardVersion: null,
  segmentId: null, planId: null, status: "done", usd: 0.1, basis: "usage", overheadUsd: null, gpuSeconds: null, createdAt: AT, finishedAt: AT,
});
const costs = (version: number, rows: unknown[]) => ({ format: "ytm-video-costs", version, deviceId: "win", hostName: "WIN", updatedAt: AT, runs: rows });

const refusedWith = (fragment: string) => (e: unknown) => isDomainError(e) && e.code === "validation_failed" && e.message.includes(fragment);

test("AC-SC-10: reservations -- v1 with V codes and v2 with an S code are read; a v1 report naming an S is invalid; v3 is 'newer'", async () => {
  const core = createVideoReservationsShareCore(deps());
  assert.deepEqual(await core.mergeIncoming(bytes(reservations(1, [reservation("V49")])), "win"), { accepted: true });
  const later = { ...reservations(2, [reservation("V14", "S12"), reservation("S12")]), updatedAt: "2026-11-16T09:30:00.000Z" };
  assert.deepEqual(await core.mergeIncoming(bytes(later), "win"), { accepted: true });
  assert.deepEqual((await core.listPeerReports())[0].reservations.map((r) => [r.video, r.replacedBy]), [["V14", "S12"], ["S12", null]]);
  await assert.rejects(core.mergeIncoming(bytes(reservations(1, [reservation("S12")])), "win"), refusedWith("invalid video reservations report"));
  await assert.rejects(core.mergeIncoming(bytes(reservations(3, [reservation("V1")])), "win"), refusedWith("version 3 is newer than this app understands"));
  for (const bad of ["S0", "S014", "s12", "S1000000"]) await assert.rejects(core.mergeIncoming(bytes(reservations(2, [reservation(bad)])), "win"), refusedWith("invalid"), bad);
});

test("AC-SC-10: uploads -- a legacy V07 row stays valid in v1; S rows only in v2; S014 is refused", async () => {
  const core = createPublishingUploadsShareCore(deps());
  assert.deepEqual(await core.mergeIncoming(bytes(uploads(1, [{ channelId: "UC1", video: "V07", state: "uploaded" }])), "win"), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes({ ...uploads(2, [{ channelId: "UC1", video: "S12", state: "uploaded" }]), updatedAt: "2026-11-16T09:30:00.000Z" }), "win"), { accepted: true });
  await assert.rejects(core.mergeIncoming(bytes(uploads(1, [{ channelId: "UC1", video: "S12", state: "uploaded" }])), "win"), refusedWith("invalid"));
  await assert.rejects(core.mergeIncoming(bytes(uploads(2, [{ channelId: "UC1", video: "S014", state: "uploaded" }])), "win"), refusedWith("invalid"));
});

test("AC-SC-10: costs -- v1 with V and unlinked runs; v2 with an S run; a v1 report naming an S is invalid", async () => {
  const core = createVideoCostsShareCore(deps());
  assert.deepEqual(await core.mergeIncoming(bytes(costs(1, [run("V49"), { ...run(null), runId: "gemini:j2" }])), "win"), { accepted: true });
  assert.deepEqual(await core.mergeIncoming(bytes({ ...costs(2, [run("S14")]), updatedAt: "2026-11-16T09:30:00.000Z" }), "win"), { accepted: true });
  await assert.rejects(core.mergeIncoming(bytes(costs(1, [run("S14")])), "win"), refusedWith("invalid"));
});

test("AC-SC-10: an older build (a v1-only reader with the V-only schema) refuses a v2 report with 'newer than this app understands'", async () => {
  // The schema of the build before BL-263, rebuilt here from its contract: version literal 1, V-only codes.
  const oldSchema = z
    .object({
      format: z.literal("ytm-publishing-uploads"),
      version: z.literal(1),
      deviceId: z.string(),
      hostName: z.string().nullable(),
      updatedAt: z.string().datetime(),
      uploads: z.array(z.object({ channelId: z.string(), video: z.string().regex(/^V\d{1,6}$/), state: z.string() }).strict()),
    })
    .strict();
  const old = createPerDeviceReportCore({ schema: oldSchema, label: "publishing uploads report", currentVersion: 1, ...deps() });
  await assert.rejects(
    old.mergeIncoming(bytes(uploads(2, [{ channelId: "UC1", video: "S12", state: "uploaded" }])), "win"),
    refusedWith("publishing uploads report version 2 is newer than this app understands; update the app on this device"),
  );
  // And it still reads a V-only report of this build (written as version 1).
  assert.deepEqual(await old.mergeIncoming(bytes(uploads(1, [{ channelId: "UC1", video: "V61", state: "queued" }])), "win"), { accepted: true });
});
