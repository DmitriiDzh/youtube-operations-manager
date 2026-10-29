import assert from "node:assert/strict";
import test from "node:test";
import { createUploadBandwidthGetHandler } from "./route";

// BL-233: the line's data is for the signed-in owner only; it carries the report as it is (codes and numbers).
test("upload-bandwidth: 401 without a session; the report (or null) with one", async () => {
  const report = { active: true, limit: "held" as const, capMbps: 2, guardMinutes: 3, heldSince: "2026-10-29T14:10:00.000Z", heldForChannelId: "UCc", ceilingReleasedAt: null, speeds: {} };
  assert.equal((await createUploadBandwidthGetHandler({ getSession: async () => null, report: () => report })()).status, 401);
  const ok = await createUploadBandwidthGetHandler({ getSession: async () => ({ user: { id: "u" } }), report: () => report })();
  assert.deepEqual(await ok.json(), { upload: report });
  const none = await createUploadBandwidthGetHandler({ getSession: async () => ({ user: { id: "u" } }), report: () => null })();
  assert.deepEqual(await none.json(), { upload: null });
});
