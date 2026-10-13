import assert from "node:assert/strict";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "../automerge-core";
import { isDomainError, type ChannelPublishingSettingsDocument } from "./contracts";
import { createChannelPublishingSettingsCore, emptyDocument } from "./services";

// BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; FO-REQ-0023 §4 A3: "editable in the Content tab, synced between
// computers"; owner msg 2715: the defaults are chosen once). Acceptance:
// - a default saved on one computer is there on the other after one sync cycle;
// - the same value saved on both is not a conflict; different values are, and both computers then read the same value until the
//   owner keeps one of them, which becomes the value on both;
// - a save that changes nothing writes nothing (no echo back and forth).

const CH = "UC_tropico";

function computer() {
  const bytes = new Map<string, Uint8Array>();
  let saves = 0;
  const store: DocumentByteStore = {
    loadDocumentBytes: async (k) => bytes.get(k) ?? null,
    saveDocumentBytes: async (k, b) => {
      saves += 1;
      bytes.set(k, b);
    },
  };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  const core = createChannelPublishingSettingsCore({
    core: createAutomergeCore<ChannelPublishingSettingsDocument>({ store, discardedBackupStore: backups, emptyDocument }),
    store,
  });
  return { core, saves: () => saves };
}
type Computer = ReturnType<typeof computer>;

/** One sync cycle on both computers: each pushes its document (a computer without one pushes nothing), then merges the other's. */
async function cycle(a: Computer, b: Computer) {
  const exportOrNull = (c: Computer) => c.core.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.core.mergeIncoming(CH, fromB);
  if (fromA) await b.core.mergeIncoming(CH, fromA);
}

test("a default saved on one computer is on the other after one cycle; nothing saved reads as empty", async () => {
  const windows = computer();
  const mac = computer();
  assert.deepEqual(await mac.core.read(CH), { values: {}, conflicts: [] });
  await windows.core.save(CH, { publishTimeUtc: "12:00", playlistId: "PL_jazz", madeForKids: false });
  await cycle(windows, mac);
  assert.deepEqual((await mac.core.read(CH)).values, { publishTimeUtc: "12:00", playlistId: "PL_jazz", madeForKids: false });
  assert.deepEqual(await mac.core.listConflicts(CH), []);
});

test("both computers saving the same value is no conflict; both having saved fields on their own merges field by field", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save(CH, { publishTimeUtc: "12:00", categoryId: "10" });
  await mac.core.save(CH, { publishTimeUtc: "12:00", embeddable: true });
  await cycle(windows, mac);
  for (const c of [windows, mac]) {
    assert.deepEqual((await c.core.read(CH)).values, { publishTimeUtc: "12:00", categoryId: "10", embeddable: true });
    assert.deepEqual(await c.core.listConflicts(CH), []);
  }
});

test("different values are a conflict, both computers read the same value meanwhile, and the kept one wins everywhere", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save(CH, { publishTimeUtc: "12:00" });
  await mac.core.save(CH, { publishTimeUtc: "13:00" });
  await cycle(windows, mac);
  const [onWindows] = await windows.core.listConflicts(CH);
  const [onMac] = await mac.core.listConflicts(CH);
  assert.equal(onWindows.field, "publishTimeUtc");
  assert.deepEqual([...onWindows.values].sort(), ["12:00", "13:00"]);
  assert.deepEqual(onMac.valuesByActor, onWindows.valuesByActor, "the same two versions on both computers");
  assert.equal((await mac.core.read(CH)).values.publishTimeUtc, (await windows.core.read(CH)).values.publishTimeUtc, "one value read on both");

  const keepActor = Object.entries(onMac.valuesByActor).find(([, value]) => value === "13:00")![0];
  await mac.core.resolveConflict({ channelId: CH, field: "publishTimeUtc", winningActorId: keepActor });
  await cycle(windows, mac);
  for (const c of [windows, mac]) {
    assert.equal((await c.core.read(CH)).values.publishTimeUtc, "13:00");
    assert.deepEqual(await c.core.listConflicts(CH), []);
  }
});

test("the owner editing a conflicted field settles it; a version nobody saved cannot be kept", async () => {
  const windows = computer();
  const mac = computer();
  await windows.core.save(CH, { playlistId: "PL_a" });
  await mac.core.save(CH, { playlistId: "PL_b" });
  await cycle(windows, mac);
  await assert.rejects(mac.core.resolveConflict({ channelId: CH, field: "playlistId", winningActorId: "00ff" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  await mac.core.save(CH, { playlistId: null });
  await cycle(windows, mac);
  for (const c of [windows, mac]) {
    assert.equal((await c.core.read(CH)).values.playlistId, null);
    assert.deepEqual(await c.core.listConflicts(CH), []);
  }
  await assert.rejects(mac.core.resolveConflict({ channelId: CH, field: "playlistId", winningActorId: "00ff" }), (e: unknown) => isDomainError(e) && e.code === "not_found");
});

test("a save that changes nothing writes nothing", async () => {
  const mac = computer();
  await mac.core.save(CH, { publishTimeUtc: "12:00", madeForKids: false });
  const before = mac.saves();
  assert.deepEqual(await mac.core.save(CH, { publishTimeUtc: "12:00", madeForKids: false }), { changed: [] });
  assert.equal(mac.saves(), before);
  assert.deepEqual(await mac.core.save(CH, { madeForKids: true }), { changed: ["madeForKids"] });
});

// Independent review (owner msg 2753): the channel's own tags are a list. Through the real core: saved as the list, read back as
// the list on both computers, an equal list again is no change, two different lists are a conflict like any other value.
test("a list value (the channel tags) is kept, synced and compared by value", async () => {
  const mac = computer();
  const windows = computer();
  assert.deepEqual(await mac.core.save(CH, { channelTags: ["tropical jazz", "bossa"], paidProductPlacement: true }), { changed: ["channelTags", "paidProductPlacement"] });
  assert.deepEqual((await mac.core.read(CH)).values, { channelTags: ["tropical jazz", "bossa"], paidProductPlacement: true });
  await cycle(mac, windows);
  assert.deepEqual((await windows.core.read(CH)).values.channelTags, ["tropical jazz", "bossa"]);
  assert.deepEqual(await windows.core.save(CH, { channelTags: ["tropical jazz", "bossa"] }), { changed: [] });
  await mac.core.save(CH, { channelTags: ["a"] });
  await windows.core.save(CH, { channelTags: ["b"] });
  await cycle(mac, windows);
  const read = await mac.core.read(CH);
  assert.equal(read.conflicts.length, 1);
  assert.deepEqual(read.conflicts[0].values.map((v) => JSON.stringify(v)).sort(), ['["a"]', '["b"]']);
});
