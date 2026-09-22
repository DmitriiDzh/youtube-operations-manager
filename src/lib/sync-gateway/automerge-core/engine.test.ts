import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { DomainError } from "@/lib/video-metadata/contracts";
import { createAutomergeCore } from "./engine";
import type { DiscardedDocumentBackupStore, DocumentByteStore } from "./store";

type TestDoc = { key: string; note: string };

function emptyTestDoc(key: string): TestDoc {
  return { key, note: "" };
}

function fakeStore(): DocumentByteStore {
  const files = new Map<string, Uint8Array>();
  return {
    async loadDocumentBytes(key) {
      return files.get(key) ?? null;
    },
    async saveDocumentBytes(key, bytes) {
      files.set(key, bytes);
    },
  };
}

function fakeBackupStore(): DiscardedDocumentBackupStore & { backups: Array<{ key: string; bytes: Uint8Array }> } {
  const backups: Array<{ key: string; bytes: Uint8Array }> = [];
  return {
    backups,
    async backup(key, bytes) {
      backups.push({ key, bytes });
      return { path: `/fake/${key}.automerge`, capturedAt: new Date().toISOString() };
    },
  };
}

test("loadOrCreate: returns a fresh empty document when nothing is stored yet", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });
  const doc = await core.loadOrCreate("chan-1");
  assert.deepEqual({ key: doc.key, note: doc.note }, { key: "chan-1", note: "" });
});

test("loadOrThrow: throws not_found when nothing is stored", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });
  await assert.rejects(
    () => core.loadOrThrow("chan-1"),
    (error: unknown) => error instanceof DomainError && error.code === "not_found"
  );
});

test("save + exportBytes round-trips a document's content", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });
  const doc = await core.loadOrCreate("chan-1");
  const next = Automerge.change(doc, "set note", (d) => {
    d.note = "hello";
  });
  await core.save("chan-1", next);

  const bytes = await core.exportBytes("chan-1");
  const reloaded = Automerge.load<TestDoc>(bytes);
  assert.equal(reloaded.note, "hello");
});

// The empirically-found 55%-of-runs data loss bug from change-drafts/services.ts's own
// mergeIncoming: a device with NO local document yet must ADOPT the incoming bytes directly,
// never attempt Automerge.merge() between two independently-created documents.
test("mergeIncoming: a device with no local document adopts the incoming one directly (never a real merge)", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });

  const peerDoc = Automerge.change(Automerge.from<TestDoc>({ key: "chan-1", note: "" }), "set", (d) => {
    d.note = "from peer";
  });
  const incomingBytes = Automerge.save(peerDoc);

  const { merged } = await core.mergeIncoming("chan-1", incomingBytes);
  assert.equal(merged.note, "from peer");
});

test("mergeIncoming: two documents with real shared history merge concurrent edits to different fields", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });

  // Establish real shared history: adopt an initial document first.
  const origin = Automerge.from<TestDoc>({ key: "chan-1", note: "origin" });
  await core.mergeIncoming("chan-1", Automerge.save(origin)).then(({ merged }) => core.save("chan-1", merged));

  const local = await core.loadOrCreate("chan-1");
  const localNext = Automerge.change(local, "local edit", (d) => {
    d.note = "local-changed";
  });
  await core.save("chan-1", localNext);

  const peerNext = Automerge.change(Automerge.clone(origin), "peer edit", (d) => {
    d.key = "chan-1-peer-marker";
  });

  const { merged } = await core.mergeIncoming("chan-1", Automerge.save(peerNext));
  // Local's field change and peer's field change are on different properties -- both survive.
  assert.equal(merged.note, "local-changed");
  assert.equal(merged.key, "chan-1-peer-marker");
});

// The empirically-found deterministic (100/100) data loss bug: two documents with genuinely
// independent origins (no shared genesis change) must be rejected, never silently merged.
test("mergeIncoming: refuses with divergent_document_lineage when local and incoming share no history", async () => {
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: fakeBackupStore(), emptyDocument: emptyTestDoc });

  const localOrigin = Automerge.from<TestDoc>({ key: "chan-1", note: "local origin" });
  await core.save("chan-1", localOrigin);

  const independentPeer = Automerge.from<TestDoc>({ key: "chan-1", note: "independent peer origin" });

  await assert.rejects(
    () => core.mergeIncoming("chan-1", Automerge.save(independentPeer)),
    (error: unknown) => error instanceof DomainError && error.code === "divergent_document_lineage"
  );
});

test("discardLocalAndAdoptPeer: backs up the discarded document and returns the adopted one, without saving either", async () => {
  const store = fakeStore();
  const backupStore = fakeBackupStore();
  const core = createAutomergeCore<TestDoc>({ store, discardedBackupStore: backupStore, emptyDocument: emptyTestDoc });

  const localDoc = Automerge.from<TestDoc>({ key: "chan-1", note: "local" });
  await core.save("chan-1", localDoc);

  const peerDoc = Automerge.from<TestDoc>({ key: "chan-1", note: "peer" });
  const result = await core.discardLocalAndAdoptPeer("chan-1", Automerge.save(peerDoc));

  assert.equal(backupStore.backups.length, 1);
  assert.equal(result.backupPath, "/fake/chan-1.automerge");
  assert.equal(result.discarded?.note, "local");
  assert.equal(result.adopted.note, "peer");

  // Caller owns saving -- the store still has the OLD bytes until the caller calls `save`.
  const stillStored = await store.loadDocumentBytes("chan-1");
  const stillLocal = stillStored ? Automerge.load<TestDoc>(stillStored) : null;
  assert.equal(stillLocal?.note, "local");
});

test("discardLocalAndAdoptPeer: no backup is taken when there was no local document to discard", async () => {
  const backupStore = fakeBackupStore();
  const core = createAutomergeCore<TestDoc>({ store: fakeStore(), discardedBackupStore: backupStore, emptyDocument: emptyTestDoc });

  const peerDoc = Automerge.from<TestDoc>({ key: "chan-1", note: "peer" });
  const result = await core.discardLocalAndAdoptPeer("chan-1", Automerge.save(peerDoc));

  assert.equal(backupStore.backups.length, 0);
  assert.equal(result.backupPath, null);
  assert.equal(result.discarded, null);
  assert.equal(result.adopted.note, "peer");
});
