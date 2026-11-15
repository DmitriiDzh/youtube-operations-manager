import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type PackageReviewDecision, type PackageReviewsDocument } from "./contracts";
import { createPackageReviewsCore, emptyDocument } from "./services";

// BL-257 AC-PR-12 (PACKAGE_REVIEW_PLAN.md stage 1, ADR 0070 §1): the owner switches the gate and decides on one computer; after one
// sync cycle the other computer holds the same switch and decisions; decisions made on both at once are all kept. AC-PR-07's base:
// no document is told apart from a document that cannot be loaded (the read throws).

const CH = "UC_wwe";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createPackageReviewsCore({ core: createAutomergeCore<PackageReviewsDocument>({ store, discardedBackupStore: backups, emptyDocument }), store });
  return Object.assign(core, { bytes });
}
type Computer = ReturnType<typeof computer>;

async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

const decision = (id: string, kind: PackageReviewDecision["kind"]): PackageReviewDecision => ({
  id,
  manifestSha256: "a".repeat(64),
  video: "V11",
  thumbnailSha256: "b".repeat(64),
  kind,
  comment: kind === "returned" ? "the intro is cut" : null,
  by: "owner",
  device: "Mac",
  at: "2026-11-15T10:00:00.000Z",
});

test("AC-PR-12: no document reads as not existing; the switch and a decision made on the Mac reach Windows after one cycle", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await windows.read(CH), { exists: false, required: null, decisions: {} });
  await mac.setRequired(CH, { value: true, updatedAt: "2026-11-15T09:00:00.000Z", by: "owner", device: "Mac" });
  await mac.addDecision(CH, decision("d1", "returned"));
  await cycle(mac, windows);
  assert.deepEqual(await windows.read(CH), {
    exists: true,
    required: { value: true, updatedAt: "2026-11-15T09:00:00.000Z", by: "owner", device: "Mac" },
    decisions: { d1: decision("d1", "returned") },
  });
});

test("AC-PR-12: decisions made on both computers at once are all kept on both", async () => {
  const mac = computer();
  const windows = computer();
  await mac.setRequired(CH, { value: true, updatedAt: "2026-11-15T09:00:00.000Z", by: "owner", device: "Mac" });
  await cycle(mac, windows);
  await mac.addDecision(CH, decision("d-mac", "approved"));
  await windows.addDecision(CH, decision("d-win", "returned"));
  await cycle(mac, windows);
  for (const c of [mac, windows]) assert.deepEqual(Object.keys((await c.read(CH)).decisions).sort(), ["d-mac", "d-win"]);
});

test("AC-PR-07 base: a document whose bytes cannot be loaded makes read throw (never 'no document')", async () => {
  const mac = computer();
  mac.bytes.set(CH, new Uint8Array([1, 2, 3, 4, 5]));
  await assert.rejects(() => mac.read(CH));
});
