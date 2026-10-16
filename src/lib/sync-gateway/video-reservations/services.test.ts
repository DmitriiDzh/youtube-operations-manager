import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError, type VideoReservationsReport } from "./contracts";
import { createVideoReservationsShareCore, type VideoReservationsReportStore } from "./services";

// BL-194 (ADR 0040): the video reservations report -- a per-device report (ADR 0028) whose peers are never forgotten, so a number
// a quiet computer reserved stays taken.

function memoryStore(): VideoReservationsReportStore & { peers: Record<string, string> } {
  let local: string | null = null;
  const peers: Record<string, string> = {};
  return {
    peers,
    readLocal: async () => local,
    writeLocal: async (json) => void (local = json),
    readPeers: async () => ({ ...peers }),
    writePeer: async (deviceId, json) => void (peers[deviceId] = json),
  };
}

const report = (deviceId: string, updatedAt: string, extra: Record<string, unknown> = {}): VideoReservationsReport =>
  ({
    format: "ytm-video-reservations",
    version: 1,
    deviceId,
    hostName: "WIN-PC",
    updatedAt,
    reservations: [{ channelId: "UC1", video: "V49", workingTitle: "Rain", reservedAt: updatedAt, state: "in_work", cancelledAt: null, replacedBy: null }],
    ...extra,
  }) as VideoReservationsReport;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

test("BL-194: a peer's reservations are kept however long that computer is quiet", async () => {
  let now = new Date("2026-10-17T10:00:00.000Z");
  const core = createVideoReservationsShareCore({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => now } });
  assert.deepEqual(await core.mergeIncoming(bytes(report("win", "2026-10-17T09:00:00.000Z")), "win"), { accepted: true });
  now = new Date("2026-12-17T10:00:00.000Z"); // two months later
  assert.deepEqual((await core.listPeerReports()).map((r) => [r.deviceId, r.reservations[0].video]), [["win", "V49"]]);
});

test("BL-194: a report is strict -- an unknown field, a malformed number or another device's name in a file is refused", async () => {
  const core = createVideoReservationsShareCore({ store: memoryStore(), ownDeviceId: async () => "mac", clock: { now: () => new Date("2026-10-17T10:00:00.000Z") } });
  const refused = (e: unknown) => isDomainError(e) && e.code === "validation_failed";
  await assert.rejects(core.mergeIncoming(bytes({ ...report("win", "2026-10-17T09:00:00.000Z"), extra: 1 }), "win"), refused);
  for (const video of ["V049", "49", "v49", "V0"]) {
    const bad = report("win", "2026-10-17T09:00:00.000Z");
    bad.reservations[0].video = video;
    await assert.rejects(core.mergeIncoming(bytes(bad), "win"), refused, video);
  }
  await assert.rejects(core.mergeIncoming(bytes(report("win", "2026-10-17T09:00:00.000Z")), "other"), refused);
  // This computer publishes only its own report.
  await assert.rejects(core.publishLocalReport(report("win", "2026-10-17T09:00:00.000Z")), refused);
  await core.publishLocalReport(report("mac", "2026-10-17T09:00:00.000Z"));
  assert.equal(JSON.parse(new TextDecoder().decode(await core.exportBytes())).deviceId, "mac");
});
