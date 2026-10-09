import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createReviewPresence, REVIEW_PRESENCE_FORMAT } from "./presence";

// BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.4): each computer writes only its own small presence file; the others read every well-formed
// file that speaks for the device it is named after.

const claim = (over: Record<string, unknown> = {}) => ({
  claimId: "claim-0001",
  planId: "R-0001",
  ownerDeviceId: "mac",
  scope: "attempt",
  itemKey: "C14/V04",
  attemptRef: "job:a",
  groupId: null,
  since: "2026-10-09T10:00:00.000Z",
  until: "2026-10-09T10:01:30.000Z",
  ...over,
});

async function setup(deviceId: string) {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), "presence-")), "generation-plans", "global");
  const at = new Date("2026-10-09T10:00:05.000Z");
  return { dir, presence: createReviewPresence({ location: async () => ({ dir, deviceId }), clock: { now: () => at } }) };
}

test("BL-162 §5.4: publish writes this device's claims into <deviceId>.presence.json, replacing the previous file", async () => {
  const { dir, presence } = await setup("win-1");
  await presence.publish({ hostname: "PC", claims: [claim() as never] });
  await presence.publish({ hostname: "PC", claims: [] });
  const doc = JSON.parse(await readFile(path.join(dir, "win-1.presence.json"), "utf8"));
  assert.deepEqual(doc, { format: REVIEW_PRESENCE_FORMAT, version: 1, deviceId: "win-1", hostname: "PC", updatedAt: "2026-10-09T10:00:05.000Z", claims: [] });
});

test("BL-162 §5.4: readPeers -- other devices' valid files only: not its own, not one speaking for another device, not malformed or oversized", async () => {
  const { dir, presence } = await setup("win-1");
  await mkdir(dir, { recursive: true });
  const doc = (deviceId: string, claims: unknown[] = [claim()]) => JSON.stringify({ format: REVIEW_PRESENCE_FORMAT, version: 1, deviceId, hostname: deviceId.toUpperCase(), updatedAt: "2026-10-09T10:00:00.000Z", claims });
  await writeFile(path.join(dir, "mac.presence.json"), doc("mac"));
  await writeFile(path.join(dir, "win-1.presence.json"), doc("win-1"));
  await writeFile(path.join(dir, "laptop.presence.json"), doc("mac"), "utf8"); // claims to be the Mac from the laptop's file
  await writeFile(path.join(dir, "broken.presence.json"), "{ not json");
  await writeFile(path.join(dir, "odd.presence.json"), doc("odd", [{ ...claim(), extra: 1 }])); // strict schema
  await writeFile(path.join(dir, "big.presence.json"), " ".repeat(300 * 1024));
  await writeFile(path.join(dir, "mac.automerge"), "report");
  const peers = await presence.readPeers();
  assert.deepEqual(peers.map((p) => [p.deviceId, p.hostname, p.claims.length]), [["mac", "MAC", 1]]);
});

test("BL-162 §5.4: no folder yet reads as no peers", async () => {
  const { presence } = await setup("win-1");
  assert.deepEqual(await presence.readPeers(), []);
});
