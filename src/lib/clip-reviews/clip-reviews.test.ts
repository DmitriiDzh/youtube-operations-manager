import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createAutomergeCore, type DiscardedDocumentBackupStore, type DocumentByteStore } from "@/lib/sync-gateway/automerge-core";
import { createClipReviewsCore, emptyClipReviewsDocument, type ClipReviewClip, type ClipReviewDecision, type ClipReviewsDocument, type ClipReviewsSnapshot } from "@/lib/sync-gateway";
import { isDomainError } from "@/lib/shared-domain";
import { resolveClipFile } from "./adapters/files";
import type { ClipReviewsPorts } from "./contracts";
import { createClipReviewsService } from "./services";

// BL-241 (docs/roadmap/plans/CLIP_REVIEWS_PLAN.md AC-CR-01..10, 16; ADR 0061). Expected values are written from the plan, by hand:
// a pending clip reads status pending with no comment or decision time; the earliest owner decision counts; a withdrawal counts only
// without an owner decision. The path tests use the real shared workspace rule on a temporary folder.

const CH = "UC_clip_A";
const OTHER = "UC_clip_B";
const WS = "/Volumes/T9/YouTube/01 Tropico Jazz";
const SHA = "b".repeat(64);
const MB100 = 104_857_600;

type FakeFile = { bytes: number; sha: string; duration: number | null };

function memoryStore(): ClipReviewsPorts["store"] & { snapshot(channelId: string): ClipReviewsSnapshot } {
  const docs = new Map<string, ClipReviewsSnapshot>();
  const doc = (channelId: string) => docs.get(channelId) ?? (docs.set(channelId, { clips: {}, decisions: {} }), docs.get(channelId)!);
  return {
    read: async (channelId) => JSON.parse(JSON.stringify(doc(channelId))),
    addClip: async (channelId, clip) => void (doc(channelId).clips[clip.clipId] = clip),
    addDecision: async (channelId, decision) => void (doc(channelId).decisions[decision.id] = decision),
    snapshot: (channelId) => doc(channelId),
  };
}

const unused = async (): Promise<never> => {
  throw new Error("not used in this test");
};
const unusedStaging: ClipReviewsPorts["staging"] = { create: unused, get: unused, list: unused, append: unused, head: unused, readAll: unused, hash: unused, remove: unused, removeOlderThan: unused };
const unusedAttachmentFiles: ClipReviewsPorts["attachmentFiles"] = { write: unused, remove: unused, resolve: unused };

function setup(options: { files?: Record<string, FakeFile>; connected?: string[]; workspaces?: Record<string, string | null>; store?: ClipReviewsPorts["store"]; device?: string; clock?: { t: number } } = {}) {
  const files: Record<string, FakeFile> = options.files ?? { "03 Images/Scenes/bar/preview_30s.mp4": { bytes: MB100, sha: SHA, duration: 30 } };
  const audits: Array<{ channelId: string; clipId: string; detail: Record<string, unknown> }> = [];
  const store = options.store ?? memoryStore();
  const clock = options.clock ?? { t: Date.parse("2026-11-03T10:00:00.000Z") };
  let n = 0;
  const ports: ClipReviewsPorts = {
    store,
    isChannelConnected: async (channelId) => (options.connected ?? [CH, OTHER]).includes(channelId),
    workspace: async (channelId) => (options.workspaces ? (options.workspaces[channelId] ?? null) : WS),
    resolveFile: async (workspace, relativePath) => {
      const file = files[relativePath];
      return file ? { ok: true, path: path.posix.join(workspace, relativePath), bytes: file.bytes } : { ok: false, reason: `${relativePath} is not in the channel workspace` };
    },
    probeDurationSeconds: async (absolutePath) => files[path.posix.relative(WS, absolutePath)]?.duration ?? null,
    hashFile: async (absolutePath) => files[path.posix.relative(WS, absolutePath)]?.sha ?? "0".repeat(64),
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => options.device ?? "Mac",
    now: () => new Date(clock.t),
    randomId: () => `id${String(++n).padStart(4, "0")}${options.device ?? "Mac"}`,
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry),
    // BL-246: these tests attach nothing; the attachment ports have their own tests (attachments-service.test.ts).
    logError: () => undefined,
    staging: unusedStaging,
    attachmentFiles: unusedAttachmentFiles,
  };
  return { service: createClipReviewsService(ports), audits, files, store, clock };
}

const submitInput = (overrides: Record<string, unknown> = {}) => ({ channelId: CH, sceneId: "bar-night", clipPath: "03 Images/Scenes/bar/preview_30s.mp4", note: "slower rain", ...overrides });
const producer = { tokenId: "tok-1" };

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code);
}

test("AC-CR-01: a 30 s mp4 inside the workspace becomes a pending clip with its size and SHA-256; get and list return it", async () => {
  const { service } = setup();
  const { clip } = await service.submit(submitInput({ sceneId: "  bar-night  ", startSec: 5, endSec: 25 }), producer);
  const expected = {
    clipId: clip.clipId,
    channelId: CH,
    sceneId: "bar-night",
    clipPath: "03 Images/Scenes/bar/preview_30s.mp4",
    note: "slower rain",
    startSec: 5,
    endSec: 25,
    durationSeconds: 30,
    sizeBytes: 104_857_600,
    sha256: SHA,
    submittedAt: "2026-11-03T10:00:00.000Z",
    device: "Mac",
    status: "pending",
    comment: null,
    decidedAt: null,
    decidedOn: null,
    // BL-246 (AC-CR-24/25): every clip view carries its deciding decision's attachments; a pending clip has none.
    attachments: [],
  };
  assert.deepEqual(clip, expected);
  assert.match(clip.clipId, /^clip_/);
  assert.deepEqual((await service.get({ channelId: CH, clipId: clip.clipId })).clip, expected);
  assert.deepEqual(await service.list({ channelId: CH }), { clips: [expected], pending: 1 });
});

test("AC-CR-04: a non-video extension is refused before the file is looked at; a missing file is refused", async () => {
  const { service, store } = setup({ files: { "a.txt": { bytes: 1, sha: SHA, duration: 30 }, "b.png": { bytes: 1, sha: SHA, duration: 30 }, "c.mkv": { bytes: 1, sha: SHA, duration: 30 } } });
  for (const clipPath of ["a.txt", "b.png", "c.mkv", "d.mov"]) await refused(service.submit(submitInput({ clipPath }), producer), "clip_review_not_video");
  await refused(service.submit(submitInput({ clipPath: "03 Images/missing.mp4" }), producer), "clip_review_file_unavailable");
  assert.deepEqual((await store.read(CH)).clips, {});
});

test("AC-CR-05: 4 s and 301 s are refused, 4.6 s and 300.4 s accepted (range widened before merge: 15-20 s loop previews); no ffprobe is probe_unavailable; a bad range is validation_failed", async () => {
  const f = (duration: number | null): FakeFile => ({ bytes: 10, sha: SHA, duration });
  const { service } = setup({ files: { "s4.mp4": f(4), "s301.mp4": f(301), "s4_6.mp4": f(4.6), "s300_4.webm": f(300.4), "none.mp4": f(null), "s60.mp4": f(60) } });
  for (const clipPath of ["s4.mp4", "s301.mp4"]) await refused(service.submit(submitInput({ clipPath }), producer), "clip_review_duration_out_of_range");
  assert.equal((await service.submit(submitInput({ clipPath: "s4_6.mp4" }), producer)).clip.status, "pending");
  assert.equal((await service.submit(submitInput({ clipPath: "s300_4.webm" }), producer)).clip.durationSeconds, 300.4);
  await refused(service.submit(submitInput({ clipPath: "none.mp4" }), producer), "clip_review_probe_unavailable");
  for (const range of [{ startSec: 20, endSec: 20 }, { startSec: 30, endSec: 10 }, { endSec: 61 }, { startSec: 60 }, { endSec: 0 }]) {
    await refused(service.submit(submitInput({ clipPath: "s60.mp4", ...range }), producer), "validation_failed");
  }
  assert.equal((await service.submit(submitInput({ clipPath: "s60.mp4", startSec: 59, endSec: 60 }), producer)).clip.endSec, 60);
});

test("AC-CR-05: the input is strict -- a status or decision field, an empty note or a control character is refused", async () => {
  const { service } = setup();
  for (const extra of [{ status: "approved" }, { note: "   " }, { sceneId: "" }, { sceneId: "a\u0007b" }, { sceneId: "x".repeat(81) }, { note: "y".repeat(2001) }]) {
    await refused(service.submit(submitInput(extra), producer), "validation_failed");
  }
  assert.equal((await service.submit(submitInput({ note: "line one\nline two" }), producer)).clip.note, "line one\nline two");
});

test("AC-CR-06: a channel not connected here, a channel without a workspace, and a clip asked under another channel", async () => {
  const notHere = setup({ connected: [OTHER] });
  await refused(notHere.service.submit(submitInput(), producer), "CHANNEL_NOT_ACTIVE");
  await refused(notHere.service.list({ channelId: CH }), "CHANNEL_NOT_ACTIVE");
  const noWorkspace = setup({ workspaces: { [CH]: null } });
  await refused(noWorkspace.service.submit(submitInput(), producer), "clip_review_workspace_unavailable");
  const { service } = setup();
  const { clip } = await service.submit(submitInput(), producer);
  await refused(service.get({ channelId: OTHER, clipId: clip.clipId }), "clip_review_not_found");
  await refused(service.decide(OTHER, clip.clipId, { action: "approve" }, "u1"), "clip_review_not_found");
  await refused(service.withdraw({ channelId: OTHER, clipId: clip.clipId }), "clip_review_not_found");
  assert.equal(await service.clipFile(CH, clip.clipId).then((f) => f?.type), "video/mp4");
  await refused(service.clipFile(OTHER, clip.clipId), "clip_review_not_found");
});

test("AC-CR-07: the owner approves once; a second decision is refused and writes nothing; a return needs a comment", async () => {
  const { service, audits, clock, store } = setup({ files: { "a.mp4": { bytes: 5, sha: SHA, duration: 45 }, "b.mp4": { bytes: 5, sha: SHA, duration: 45 } } });
  const a = (await service.submit(submitInput({ clipPath: "a.mp4" }), producer)).clip;
  const b = (await service.submit(submitInput({ clipPath: "b.mp4" }), producer)).clip;
  clock.t = Date.parse("2026-11-03T12:00:00.000Z");
  const approved = (await service.decide(CH, a.clipId, { action: "approve" }, "owner-1")).clip;
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedAt, "2026-11-03T12:00:00.000Z");
  assert.equal(approved.comment, null);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].clipId, a.clipId);
  assert.equal(audits[0].detail.event, "clip_review.approved");
  assert.equal(audits[0].detail.by, "owner-1");
  for (const input of [{ action: "approve" }, { action: "return", comment: "darker" }]) {
    await assert.rejects(service.decide(CH, a.clipId, input, "owner-1"), (error: unknown) => isDomainError(error) && error.code === "clip_review_not_pending" && (error.details as { status: string }).status === "approved");
  }
  assert.equal(Object.keys((await store.read(CH)).decisions).length, 1);
  for (const comment of [undefined, "", "   "]) await refused(service.decide(CH, b.clipId, { action: "return", comment }, "owner-1"), "validation_failed");
  const returned = (await service.decide(CH, b.clipId, { action: "return", comment: "  the rain is too fast  " }, "owner-1")).clip;
  assert.equal(returned.status, "returned");
  assert.equal(returned.comment, "the rain is too fast");
  assert.deepEqual(
    (await service.get({ channelId: CH, clipId: b.clipId })).clip.comment,
    "the rain is too fast"
  );
});

test("AC-CR-08: approval needs this computer's file to be the submitted one; a return works without it", async () => {
  const { service, files } = setup({ files: { "a.mp4": { bytes: 100, sha: SHA, duration: 30 }, "b.mp4": { bytes: 100, sha: SHA, duration: 30 }, "c.mp4": { bytes: 100, sha: SHA, duration: 30 } } });
  const a = (await service.submit(submitInput({ clipPath: "a.mp4" }), producer)).clip;
  const b = (await service.submit(submitInput({ clipPath: "b.mp4" }), producer)).clip;
  const c = (await service.submit(submitInput({ clipPath: "c.mp4" }), producer)).clip;
  files["a.mp4"] = { bytes: 100, sha: "c".repeat(64), duration: 30 }; // same size, another file
  files["b.mp4"] = { bytes: 101, sha: SHA, duration: 30 }; // another size
  delete files["c.mp4"];
  const listed = Object.fromEntries((await service.ownerList(CH)).clips.map((clip) => [clip.clipId, clip.file]));
  // Independent review (BL-241): the list checks the size only (no hashing on every badge poll), so a same-size swap shows "ok"
  // there; the approval below still checks the SHA-256 and refuses it.
  assert.deepEqual(listed, { [a.clipId]: "ok", [b.clipId]: "changed", [c.clipId]: "missing" });
  await refused(service.decide(CH, a.clipId, { action: "approve" }, "u"), "clip_review_file_changed");
  await refused(service.decide(CH, b.clipId, { action: "approve" }, "u"), "clip_review_file_changed");
  await refused(service.decide(CH, c.clipId, { action: "approve" }, "u"), "clip_review_file_missing");
  assert.equal((await service.decide(CH, c.clipId, { action: "return", comment: "re-render" }, "u")).clip.status, "returned");
  assert.equal(await service.clipFile(CH, c.clipId), null);
});

test("AC-CR-09: withdraw makes a pending clip withdrawn; a decided or withdrawn clip cannot be withdrawn or decided", async () => {
  const { service } = setup({ files: { "a.mp4": { bytes: 5, sha: SHA, duration: 30 }, "b.mp4": { bytes: 5, sha: SHA, duration: 30 } } });
  const a = (await service.submit(submitInput({ clipPath: "a.mp4" }), producer)).clip;
  const b = (await service.submit(submitInput({ clipPath: "b.mp4" }), producer)).clip;
  const withdrawn = (await service.withdraw({ channelId: CH, clipId: a.clipId })).clip;
  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.comment, null);
  await refused(service.withdraw({ channelId: CH, clipId: a.clipId }), "clip_review_not_pending");
  await refused(service.decide(CH, a.clipId, { action: "approve" }, "u"), "clip_review_not_pending");
  await service.decide(CH, b.clipId, { action: "approve" }, "u");
  await refused(service.withdraw({ channelId: CH, clipId: b.clipId }), "clip_review_not_pending");
  // The same path may be submitted again once the earlier clip is no longer pending (a reworked render).
  assert.equal((await service.submit(submitInput({ clipPath: "a.mp4" }), producer)).clip.status, "pending");
});

test("submit limits: the same file pending twice is a duplicate; at most 50 pending clips per channel", async () => {
  const files: Record<string, FakeFile> = {};
  for (let i = 0; i < 51; i++) files[`c${i}.mp4`] = { bytes: 5, sha: SHA, duration: 30 };
  const { service } = setup({ files });
  const first = (await service.submit(submitInput({ clipPath: "c0.mp4" }), producer)).clip;
  await assert.rejects(service.submit(submitInput({ clipPath: "c0.mp4" }), producer), (error: unknown) => isDomainError(error) && error.code === "clip_review_duplicate" && (error.details as { clipId: string }).clipId === first.clipId);
  for (let i = 1; i < 50; i++) await service.submit(submitInput({ clipPath: `c${i}.mp4` }), producer);
  await refused(service.submit(submitInput({ clipPath: "c50.mp4" }), producer), "clip_review_too_many_pending");
});

test("AC-CR-16: pending first, oldest first; then the decided ones, newest first; list filters by status and limit", async () => {
  const files: Record<string, FakeFile> = {};
  for (const name of ["p1", "p2", "d1", "d2"]) files[`${name}.mp4`] = { bytes: 5, sha: SHA, duration: 30 };
  const { service, clock } = setup({ files });
  const ids: Record<string, string> = {};
  // Submitted in the order d1 (10:00), p1 (10:01), d2 (10:02), p2 (10:03).
  for (const [i, name] of ["d1", "p1", "d2", "p2"].entries()) {
    clock.t = Date.parse("2026-11-03T10:00:00.000Z") + i * 60_000;
    ids[name] = (await service.submit(submitInput({ clipPath: `${name}.mp4` }), producer)).clip.clipId;
  }
  await service.decide(CH, ids.d1, { action: "approve" }, "u");
  await service.decide(CH, ids.d2, { action: "return", comment: "no" }, "u");
  const order = (await service.list({ channelId: CH })).clips.map((c) => c.clipId);
  assert.deepEqual(order, [ids.p1, ids.p2, ids.d2, ids.d1]);
  assert.deepEqual((await service.ownerList(CH)).clips.map((c) => c.clipId), [ids.p1, ids.p2, ids.d2, ids.d1]);
  assert.equal((await service.ownerList(CH)).waiting, 2);
  assert.deepEqual((await service.list({ channelId: CH, status: "returned" })).clips.map((c) => c.clipId), [ids.d2]);
  assert.deepEqual((await service.list({ channelId: CH, limit: 1 })).clips.map((c) => c.clipId), [ids.p1]);
});

// AC-CR-10 at the module level: two computers, each with its own Automerge document, synced by exchanging their bytes.
function automergeComputer() {
  const bytes = new Map<string, Uint8Array>();
  const store: DocumentByteStore = { loadDocumentBytes: async (k) => bytes.get(k) ?? null, saveDocumentBytes: async (k, b) => void bytes.set(k, b) };
  const backups = { backup: async () => ({ path: "/backup", capturedAt: "" }) } as DiscardedDocumentBackupStore;
  return createClipReviewsCore({ core: createAutomergeCore<ClipReviewsDocument>({ store, discardedBackupStore: backups, emptyDocument: emptyClipReviewsDocument }), store });
}
async function syncCycle(a: ReturnType<typeof automergeComputer>, b: ReturnType<typeof automergeComputer>) {
  const exportOrNull = (c: ReturnType<typeof automergeComputer>) => c.exportBytes(CH).catch((error) => (isDomainError(error) && error.code === "not_found" ? null : Promise.reject(error)));
  const fromA = await exportOrNull(a);
  const fromB = await exportOrNull(b);
  if (fromB) await a.mergeIncoming(CH, fromB);
  if (fromA) await b.mergeIncoming(CH, fromA);
}

test("AC-CR-10: approved on the Mac at 10:00 and returned on Windows at 10:05 (offline) reads approved on both", async () => {
  const macStore = automergeComputer();
  const winStore = automergeComputer();
  const mac = setup({ store: macStore, device: "Mac", clock: { t: Date.parse("2026-11-03T09:00:00.000Z") } });
  const win = setup({ store: winStore, device: "Windows", clock: { t: Date.parse("2026-11-03T09:00:00.000Z") } });
  const { clip } = await mac.service.submit(submitInput(), producer);
  await syncCycle(macStore, winStore);
  assert.equal((await win.service.get({ channelId: CH, clipId: clip.clipId })).clip.status, "pending");
  mac.clock.t = Date.parse("2026-11-03T10:00:00.000Z");
  await mac.service.decide(CH, clip.clipId, { action: "approve" }, "u");
  win.clock.t = Date.parse("2026-11-03T10:05:00.000Z");
  await win.service.decide(CH, clip.clipId, { action: "return", comment: "too dark" }, "u");
  await syncCycle(macStore, winStore);
  for (const side of [mac, win]) {
    const read = (await side.service.get({ channelId: CH, clipId: clip.clipId })).clip;
    assert.deepEqual([read.status, read.comment, read.decidedAt, read.decidedOn], ["approved", null, "2026-11-03T10:00:00.000Z", "Mac"]);
  }
});

test("AC-CR-10: a withdrawal on the Mac and a return on Windows read returned on both (the owner's decision wins)", async () => {
  const macStore = automergeComputer();
  const winStore = automergeComputer();
  const mac = setup({ store: macStore, device: "Mac" });
  const win = setup({ store: winStore, device: "Windows" });
  const { clip } = await mac.service.submit(submitInput(), producer);
  await syncCycle(macStore, winStore);
  mac.clock.t = Date.parse("2026-11-03T10:00:00.000Z");
  await mac.service.withdraw({ channelId: CH, clipId: clip.clipId });
  win.clock.t = Date.parse("2026-11-03T10:30:00.000Z");
  await win.service.decide(CH, clip.clipId, { action: "return", comment: "redo the loop point" }, "u");
  await syncCycle(macStore, winStore);
  for (const side of [mac, win]) {
    const read = (await side.service.get({ channelId: CH, clipId: clip.clipId })).clip;
    assert.deepEqual([read.status, read.comment, read.decidedOn], ["returned", "redo the loop point", "Windows"]);
  }
});

test("AC-CR-10: two owner decisions at the same instant -- the smaller decision id counts on both computers", async () => {
  const clip: ClipReviewClip = { clipId: "clip_x", channelId: CH, sceneId: "s", clipPath: "a.mp4", note: "n", startSec: null, endSec: null, durationSeconds: 30, sizeBytes: 1, sha256: SHA, submittedAt: "2026-11-03T09:00:00.000Z", submittedBy: "t", device: null };
  const at = "2026-11-03T10:00:00.000Z";
  const decisions: ClipReviewDecision[] = [
    { id: "cd_b", clipId: "clip_x", kind: "approved", by: "owner", comment: null, device: "Mac", at },
    { id: "cd_a", clipId: "clip_x", kind: "returned", by: "owner", comment: "no", device: "Windows", at },
  ];
  const { clipViewOf } = await import("./model");
  assert.equal(clipViewOf(clip, decisions).status, "returned");
  assert.equal(clipViewOf(clip, [...decisions].reverse()).status, "returned");
});

// AC-CR-02 / AC-CR-03 with the real shared workspace rule on a temporary folder: `..`, absolute paths, backslashes and a symlink
// out of the workspace are refused at submit; the player gets nothing for a clip whose file became such a symlink.
test("AC-CR-02 / AC-CR-03: the real workspace rule refuses .., absolute paths, backslashes and a symlink out of the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "clip-reviews-"));
  try {
    const workspace = path.join(root, "01 Tropico Jazz");
    const outside = path.join(root, "outside");
    await mkdir(path.join(workspace, "03 Images", "Scenes", "bar"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(workspace, "03 Images", "Scenes", "bar", "preview_30s.mp4"), "0123456789");
    await writeFile(path.join(outside, "secret.mp4"), "outside!!");
    await symlink(path.join(outside, "secret.mp4"), path.join(workspace, "03 Images", "escape.mp4"));

    const ok = await resolveClipFile(workspace, "03 Images/Scenes/bar/preview_30s.mp4");
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.bytes, 10);
    for (const bad of ["../outside/secret.mp4", "03 Images/../../outside/secret.mp4", path.join(outside, "secret.mp4"), "03 Images\\Scenes\\bar\\preview_30s.mp4", "03 Images/escape.mp4", "03 Images/Scenes/bar/none.mp4"]) {
      assert.equal((await resolveClipFile(workspace, bad)).ok, false, bad);
    }

    const store = memoryStore();
    const audits: unknown[] = [];
    const service = createClipReviewsService({
      store,
      isChannelConnected: async () => true,
      workspace: async () => workspace,
      resolveFile: resolveClipFile,
      probeDurationSeconds: async () => 30,
      hashFile: async () => SHA,
      assertDeviceAvailable: async () => undefined,
      deviceLabel: async () => null,
      now: () => new Date("2026-11-03T10:00:00.000Z"),
      randomId: () => "r1",
      withLock: (fn) => fn(),
      audit: async (entry) => void audits.push(entry),
      logError: () => undefined,
    staging: unusedStaging,
      attachmentFiles: unusedAttachmentFiles,
    });
    for (const clipPath of ["../outside/secret.mp4", "03 Images/escape.mp4", path.join(outside, "secret.mp4"), "03 Images\\Scenes\\bar\\preview_30s.mp4"]) {
      await refused(service.submit(submitInput({ clipPath }), producer), "clip_review_file_unavailable");
    }
    assert.deepEqual(store.snapshot(CH).clips, {});
    // A clip submitted while its file was real, then replaced by a symlink out of the workspace: the player gets nothing.
    const { clip } = await service.submit(submitInput(), producer);
    assert.equal((await service.clipFile(CH, clip.clipId))?.bytes, 10);
    const file = path.join(workspace, "03 Images", "Scenes", "bar", "preview_30s.mp4");
    await rm(file);
    await symlink(path.join(outside, "secret.mp4"), file);
    assert.equal(await service.clipFile(CH, clip.clipId), null);
    assert.equal((await service.ownerList(CH)).clips[0].file, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
