import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { ClipReviewDecision, ClipReviewsSnapshot } from "@/lib/sync-gateway";
import { createAttachmentFiles, createAttachmentStaging } from "./adapters/attachments";
import { hashClipFile, resolveClipFile } from "./adapters/files";
import type { ClipReviewsPorts } from "./contracts";
import { wellFormedAttachments } from "./model";
import { createClipReviewsService } from "./services";

// BL-246 (docs/roadmap/plans/CLIP_REVIEWS_PLAN.md items 10-17, AC-CR-17..27; ADR 0065). A real temporary channel workspace, the real
// staging folder and the real decision-folder writer (the shared workspace-exchange rule); only the document store is in memory.
// Expected values are written by hand from the plan (e.g. the SHA-256 of "hello" is the published test vector 2cf24dba...).

const CH = "UC_clip_A";
const OTHER = "UC_clip_B";
const CLIP_PATH = "03 Images/Scenes/bar/preview_30s.mp4";
const HELLO_SHA = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function memoryStore(): ClipReviewsPorts["store"] & { snapshot(channelId: string): ClipReviewsSnapshot; failNextDecision: boolean } {
  const docs = new Map<string, ClipReviewsSnapshot>();
  const doc = (channelId: string) => docs.get(channelId) ?? (docs.set(channelId, { clips: {}, decisions: {} }), docs.get(channelId)!);
  const store = {
    failNextDecision: false,
    read: async (channelId: string) => JSON.parse(JSON.stringify(doc(channelId))) as ClipReviewsSnapshot,
    addClip: async (channelId: string, clip: ClipReviewsSnapshot["clips"][string]) => void (doc(channelId).clips[clip.clipId] = clip),
    async addDecision(channelId: string, decision: ClipReviewDecision) {
      if (store.failNextDecision) {
        store.failNextDecision = false;
        throw new Error("the document could not be saved");
      }
      doc(channelId).decisions[decision.id] = JSON.parse(JSON.stringify(decision));
    },
    snapshot: (channelId: string) => doc(channelId),
  };
  return store;
}

type World = Awaited<ReturnType<typeof world>>;

async function world() {
  const root = await mkdtemp(path.join(tmpdir(), "clip-attachments-"));
  const workspace = path.join(root, "01 Tropico Jazz");
  const outside = path.join(root, "outside");
  const stagingDir = path.join(root, "app-data", "clip-review-uploads");
  await mkdir(path.join(workspace, "03 Images", "Scenes", "bar"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, CLIP_PATH), "0123456789");
  const store = memoryStore();
  const clock = { t: Date.parse("2026-11-06T10:00:00.000Z") };
  let n = 0;
  const audits: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];
  const ports: ClipReviewsPorts = {
    store,
    isChannelConnected: async () => true,
    workspace: async () => workspace,
    resolveFile: resolveClipFile,
    probeDurationSeconds: async () => 30,
    hashFile: hashClipFile,
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => new Date(clock.t),
    // 16 hex characters, as `randomUUID` gives in production.
    randomId: () => (++n).toString(16).padStart(16, "0"),
    withLock: (fn) => fn(),
    audit: async (entry) => void audits.push(entry.detail),
    logError: (event, context) => void logs.push({ event, ...context }),
    staging: createAttachmentStaging(stagingDir),
    attachmentFiles: createAttachmentFiles(),
  };
  const service = createClipReviewsService(ports);
  const submit = async (clipPath = CLIP_PATH, channelId = CH) => (await service.submit({ channelId, sceneId: "bar", clipPath, note: "n" }, { tokenId: "t" })).clip.clipId;
  /** Stages a file and sends it in one piece. */
  const upload = async (clipId: string, name: string, bytes: Buffer | string, type = "") => {
    const body = Buffer.from(bytes);
    const { uploadId } = await service.stageAttachment(CH, clipId, { name, type, size: body.length, sha256: sha(body) });
    await service.appendAttachmentPiece(CH, clipId, uploadId, 0, new Uint8Array(body));
    return uploadId;
  };
  const decisionsFolder = (clipId: string) => path.join(workspace, "99 Data Exchange", "From YTM", "clip-reviews", clipId);
  return { root, workspace, outside, stagingDir, store, clock, audits, logs, service, ports, submit, upload, decisionsFolder };
}

async function withWorld(run: (w: World) => Promise<void>) {
  const w = await world();
  try {
    await run(w);
  } finally {
    await rm(w.root, { recursive: true, force: true });
  }
}

async function refused(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => isDomainError(error) && error.code === code, code);
}

const exists = (p: string) => readdir(p).then(() => true, () => false);

test("AC-CR-20 / AC-CR-23 / AC-CR-25: a return with note.txt writes exactly its bytes into the decision folder and records it", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const uploadId = await w.upload(clipId, "note.txt", "hello", "text/plain");
    const { clip } = await w.service.decide(CH, clipId, { action: "return", comment: "see the note", attachments: [uploadId] }, "owner");
    const decisionId = clip.decisionId!;
    const expectedPath = `99 Data Exchange/From YTM/clip-reviews/${clipId}/${decisionId}/note.txt`;
    const expected = { path: expectedPath, name: "note.txt", mime: "text/plain", size: 5, sha256: HELLO_SHA };
    assert.equal(await readFile(path.join(w.workspace, ...expectedPath.split("/")), "utf8"), "hello");
    // No temporary file is left next to it.
    assert.deepEqual(await readdir(path.join(w.decisionsFolder(clipId), decisionId)), ["note.txt"]);
    assert.deepEqual(w.store.snapshot(CH).decisions[decisionId].attachments, [expected]);
    // The staged upload is gone.
    assert.deepEqual(await readdir(w.stagingDir), []);
    // The Producer reads it (get and list); the owner's list adds its place and this computer's copy.
    assert.deepEqual((await w.service.get({ channelId: CH, clipId })).clip.attachments, [expected]);
    assert.deepEqual((await w.service.list({ channelId: CH })).clips[0].attachments, [expected]);
    const owner = (await w.service.ownerList(CH)).clips[0];
    assert.equal(owner.decisionId, decisionId);
    assert.deepEqual(owner.attachments, [{ ...expected, index: 0, file: "ok" }]);
    assert.deepEqual(w.audits[0].attachments, [{ path: expectedPath, size: 5, sha256: HELLO_SHA }]);
    // Served back as text, never as HTML.
    const served = await w.service.attachmentFile(CH, clipId, decisionId, 0);
    assert.deepEqual([served.bytes, served.type, served.name], [5, "text/plain; charset=utf-8", "note.txt"]);
  }));

test("AC-CR-17: 10 files are recorded, an 11th is clip_attachment_too_many and nothing is written or recorded", () =>
  withWorld(async (w) => {
    const ten = await w.submit();
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push(await w.upload(ten, `a${i}.txt`, `file ${i}`));
    const { clip } = await w.service.decide(CH, ten, { action: "approve", attachments: ids }, "owner");
    assert.deepEqual(clip.attachments.map((a) => a.name), ["a1.txt", "a2.txt", "a3.txt", "a4.txt", "a5.txt", "a6.txt", "a7.txt", "a8.txt", "a9.txt", "a10.txt"]);

    await writeFile(path.join(w.workspace, "03 Images", "b.mp4"), "0123456789");
    const eleven = await w.submit("03 Images/b.mp4");
    const more: string[] = [];
    for (let i = 1; i <= 11; i++) more.push(await w.upload(eleven, `b${i}.txt`, `file ${i}`));
    await refused(w.service.decide(CH, eleven, { action: "approve", attachments: more }, "owner"), "clip_attachment_too_many");
    assert.equal(await exists(w.decisionsFolder(eleven)), false);
    assert.equal(Object.values(w.store.snapshot(CH).decisions).filter((d) => d.clipId === eleven).length, 0);
  }));

test("AC-CR-17: 52,428,800 bytes may be staged; 52,428,801 is clip_attachment_too_large and 0 is validation_failed", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const input = (size: number) => ({ name: "big.mp4", type: "video/mp4", size, sha256: "a".repeat(64) });
    assert.match((await w.service.stageAttachment(CH, clipId, input(52_428_800))).uploadId, /^[a-f0-9]{32}$/);
    await refused(w.service.stageAttachment(CH, clipId, input(52_428_801)), "clip_attachment_too_large");
    await refused(w.service.stageAttachment(CH, clipId, input(0)), "validation_failed");
  }));

test("AC-CR-18: a type not on the list, a declared type of another kind, and bytes of another kind are refused", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const stage = (name: string, type: string) => w.service.stageAttachment(CH, clipId, { name, type, size: 10, sha256: "a".repeat(64) });
    for (const name of ["x.svg", "x.exe", "x.html", "noextension"]) await refused(stage(name, ""), "clip_attachment_type_not_allowed");
    await refused(stage("a.png", "application/pdf"), "clip_attachment_type_mismatch");
    for (const [name, bytes] of [
      ["fake.png", "%PDF-1.7 not an image"],
      ["bad.json", "{not json"],
      ["nul.txt", "a\u0000b"],
    ] as const) {
      await refused(w.upload(clipId, name, bytes), "clip_attachment_type_mismatch");
    }
    // A refused last piece drops the upload: nothing stays staged.
    assert.deepEqual(await readdir(w.stagingDir), []);
    // A real PNG without a declared type is accepted as image/png.
    const png = await w.upload(clipId, "shot.png", PNG, "");
    const { clip } = await w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [png] }, "owner");
    assert.equal(clip.attachments[0].mime, "image/png");
    assert.equal((await w.service.attachmentFile(CH, clipId, clip.decisionId!, 0)).type, "image/png");
  }));

test("AC-CR-19: names are sanitized by their place and de-duplicated ignoring case when the decision is made", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const ids = [await w.upload(clipId, "shot.png", PNG), await w.upload(clipId, "Shot.png", PNG), await w.upload(clipId, "../../etc/shot.png", PNG), await w.upload(clipId, "..png", PNG)];
    const { clip } = await w.service.decide(CH, clipId, { action: "approve", attachments: ids }, "owner");
    assert.deepEqual(clip.attachments.map((a) => a.name), ["shot.png", "Shot-2.png", "shot-3.png", "file-4.png"]);
    assert.deepEqual((await readdir(path.join(w.decisionsFolder(clipId), clip.decisionId!))).sort(), ["Shot-2.png", "file-4.png", "shot-3.png", "shot.png"]);
  }));

test("AC-CR-21: when recording the decision fails, its folder is removed and no decision exists", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const id = await w.upload(clipId, "note.txt", "hello");
    w.store.failNextDecision = true;
    await assert.rejects(w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [id] }, "owner"), /could not be saved/);
    assert.equal(await exists(w.decisionsFolder(clipId)), false);
    assert.deepEqual(w.store.snapshot(CH).decisions, {});
    // The staged file is kept, so the owner can press the button again.
    const again = await w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [id] }, "owner");
    assert.equal(again.clip.attachments.length, 1);
  }));

test("AC-CR-21: a refusal before writing (not pending; approval with the clip file missing) creates no folder", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const id = await w.upload(clipId, "note.txt", "hello");
    await rm(path.join(w.workspace, CLIP_PATH));
    await refused(w.service.decide(CH, clipId, { action: "approve", attachments: [id] }, "owner"), "clip_review_file_missing");
    assert.equal(await exists(path.join(w.workspace, "99 Data Exchange")), false);
    await w.service.decide(CH, clipId, { action: "return", comment: "c" }, "owner");
    await refused(w.service.decide(CH, clipId, { action: "approve", attachments: [id] }, "owner"), "clip_review_not_pending");
    assert.equal(await exists(path.join(w.workspace, "99 Data Exchange")), false);
  }));

test("AC-CR-21: the writer removes the whole decision folder when the 3rd of 3 copies fails or a copy is not the expected bytes", () =>
  withWorld(async (w) => {
    const sources = path.join(w.root, "sources");
    await mkdir(sources);
    for (const name of ["a.txt", "b.txt"]) await writeFile(path.join(sources, name), "hello");
    const files = createAttachmentFiles();
    const one = (name: string, sourceName = name, sha256 = HELLO_SHA) => ({ sourcePath: path.join(sources, sourceName), name, size: 5, sha256 });
    await assert.rejects(files.write(w.workspace, "clip_1", "cd_1", [one("a.txt"), one("b.txt"), one("c.txt")]));
    assert.equal(await exists(path.join(w.decisionsFolder("clip_1"), "cd_1")), false);
    await assert.rejects(files.write(w.workspace, "clip_1", "cd_2", [one("a.txt"), one("b.txt", "b.txt", "0".repeat(64))]), /differ/);
    assert.equal(await exists(path.join(w.decisionsFolder("clip_1"), "cd_2")), false);
    // A decision folder that already exists is never written into.
    await mkdir(path.join(w.decisionsFolder("clip_1"), "cd_3"), { recursive: true });
    await writeFile(path.join(w.decisionsFolder("clip_1"), "cd_3", "keep.txt"), "x");
    await assert.rejects(files.write(w.workspace, "clip_1", "cd_3", [one("a.txt")]), /EEXIST/);
    assert.deepEqual(await readdir(path.join(w.decisionsFolder("clip_1"), "cd_3")), ["keep.txt"]);
  }));

test("AC-CR-22: serving refuses a stored path outside its decision folder, a symlink out, a missing and a changed file", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const ids = [await w.upload(clipId, "a.txt", "hello"), await w.upload(clipId, "b.txt", "world"), await w.upload(clipId, "c.txt", "12345")];
    const { clip } = await w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: ids }, "owner");
    const decisionId = clip.decisionId!;
    const folder = path.join(w.decisionsFolder(clipId), decisionId);
    assert.equal((await w.service.attachmentFile(CH, clipId, decisionId, 0)).bytes, 5);
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 3), "clip_attachment_not_found");
    await refused(w.service.attachmentFile(CH, clipId, "cd_none", 0), "clip_attachment_not_found");

    // A record whose path does not point into its own decision folder (as another computer's document could carry) is refused.
    const record = w.store.snapshot(CH).decisions[decisionId];
    const original = record.attachments![0].path;
    for (const bad of ["03 Images/a.txt", `99 Data Exchange/From YTM/clip-reviews/${clipId}/cd_other/a.txt`, `99 Data Exchange/From YTM/clip-reviews/${clipId}/${decisionId}/../a.txt`]) {
      record.attachments![0].path = bad;
      await refused(w.service.attachmentFile(CH, clipId, decisionId, 0), "clip_attachment_not_found");
    }
    record.attachments![0].path = original;
    record.attachments![0].name = "../a.txt";
    record.attachments![0].path = `99 Data Exchange/From YTM/clip-reviews/${clipId}/${decisionId}/../a.txt`;
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 0), "clip_attachment_not_found");
    record.attachments![0].name = "a.txt";
    record.attachments![0].path = original;

    // a.txt becomes a symlink to a 5-byte file outside the workspace: refused, never served.
    await writeFile(path.join(w.outside, "secret.txt"), "SECRT");
    await rm(path.join(folder, "a.txt"));
    await symlink(path.join(w.outside, "secret.txt"), path.join(folder, "a.txt"));
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 0), "clip_attachment_not_found");
    // b.txt not here (yet); c.txt the same size with other bytes, then another size.
    await rm(path.join(folder, "b.txt"));
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 1), "clip_attachment_missing");
    await writeFile(path.join(folder, "c.txt"), "54321");
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 2), "clip_attachment_changed");
    // AC-CR-23: the list checks the size only -- the same-size swap still reads ok there, the server refuses it above.
    assert.deepEqual((await w.service.ownerList(CH)).clips[0].attachments.map((a) => a.file), ["missing", "missing", "ok"]);
    await writeFile(path.join(folder, "c.txt"), "123456");
    await refused(w.service.attachmentFile(CH, clipId, decisionId, 2), "clip_attachment_changed");
    assert.deepEqual((await w.service.ownerList(CH)).clips[0].attachments.map((a) => a.file), ["missing", "missing", "changed"]);
  }));

test("AC-CR-24: a decision stored without attachments (an older build) reads attachments [] everywhere", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    // Exactly the BL-241 record shape: no `attachments` key at all.
    w.store.snapshot(CH).decisions.cd_old = { id: "cd_old", clipId, kind: "returned", by: "owner", comment: "old", device: "Windows", at: "2026-11-04T10:00:00.000Z" };
    assert.deepEqual((await w.service.get({ channelId: CH, clipId })).clip.attachments, []);
    assert.deepEqual((await w.service.list({ channelId: CH })).clips[0].attachments, []);
    const owner = (await w.service.ownerList(CH)).clips[0];
    assert.deepEqual([owner.status, owner.decisionId, owner.attachments], ["returned", "cd_old", []]);
  }));

test("AC-CR-25: a withdrawn clip carries no attachments; only an owner decision does", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    await w.service.withdraw({ channelId: CH, clipId });
    assert.deepEqual((await w.service.get({ channelId: CH, clipId })).clip.attachments, []);
  }));

test("AC-CR-26: another channel's clip is not found at every step; an upload of clip X cannot go into a decision on clip Y", () =>
  withWorld(async (w) => {
    const x = await w.submit();
    await writeFile(path.join(w.workspace, "03 Images", "y.mp4"), "0123456789");
    const y = await w.submit("03 Images/y.mp4");
    const input = { name: "a.txt", type: "", size: 5, sha256: HELLO_SHA };
    await refused(w.service.stageAttachment(OTHER, x, input), "clip_review_not_found");
    const uploadId = await w.upload(x, "a.txt", "hello");
    await refused(w.service.appendAttachmentPiece(OTHER, x, uploadId, 5, new Uint8Array([1])), "clip_review_not_found");
    await refused(w.service.discardAttachment(OTHER, x, uploadId), "clip_review_not_found");
    await refused(w.service.decide(CH, y, { action: "return", comment: "c", attachments: [uploadId] }, "owner"), "clip_attachment_upload_unknown");
    await refused(w.service.decide(OTHER, x, { action: "return", comment: "c", attachments: [uploadId] }, "owner"), "clip_review_not_found");
    const { clip } = await w.service.decide(CH, x, { action: "return", comment: "c", attachments: [uploadId] }, "owner");
    await refused(w.service.attachmentFile(OTHER, x, clip.decisionId!, 0), "clip_review_not_found");
    await refused(w.service.attachmentFile(CH, y, clip.decisionId!, 0), "clip_attachment_not_found");
  }));

test("AC-CR-27: pieces must continue the file; a corrupt file is dropped; an unfinished upload cannot be attached; old uploads are swept", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const body = Buffer.from("hello world");
    const { uploadId } = await w.service.stageAttachment(CH, clipId, { name: "a.txt", type: "text/plain", size: body.length, sha256: sha(body) });
    await refused(w.service.appendAttachmentPiece(CH, clipId, uploadId, 3, new Uint8Array(body.subarray(0, 5))), "clip_attachment_upload_offset");
    assert.deepEqual(await w.service.appendAttachmentPiece(CH, clipId, uploadId, 0, new Uint8Array(body.subarray(0, 5))), { received: 5, complete: false });
    await refused(w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [uploadId] }, "owner"), "clip_attachment_upload_incomplete");
    await refused(w.service.appendAttachmentPiece(CH, clipId, uploadId, 5, new Uint8Array(Buffer.from("world!!"))), "clip_attachment_upload_offset");
    assert.deepEqual(await w.service.appendAttachmentPiece(CH, clipId, uploadId, 5, new Uint8Array(body.subarray(5))), { received: 11, complete: true });

    // The browser said one SHA-256, other bytes arrived: refused and dropped.
    const { uploadId: corrupt } = await w.service.stageAttachment(CH, clipId, { name: "b.txt", type: "", size: 5, sha256: HELLO_SHA });
    await refused(w.service.appendAttachmentPiece(CH, clipId, corrupt, 0, new Uint8Array(Buffer.from("HELLO"))), "clip_attachment_upload_corrupt");
    await refused(w.service.appendAttachmentPiece(CH, clipId, corrupt, 0, new Uint8Array(Buffer.from("hello"))), "clip_attachment_upload_unknown");

    // × on a chip drops its upload.
    assert.deepEqual(await w.service.discardAttachment(CH, clipId, uploadId), { removed: true });
    await refused(w.service.discardAttachment(CH, clipId, uploadId), "clip_attachment_upload_unknown");

    // An upload staged now is removed when another one is staged more than 24 h later.
    w.clock.t = Date.now();
    const { uploadId: stale } = await w.service.stageAttachment(CH, clipId, { name: "c.txt", type: "", size: 5, sha256: HELLO_SHA });
    w.clock.t = Date.now() + 23 * 3_600_000;
    await w.service.stageAttachment(CH, clipId, { name: "d.txt", type: "", size: 5, sha256: HELLO_SHA });
    assert.ok((await readdir(w.stagingDir)).includes(`${stale}.part`));
    w.clock.t = Date.now() + 25 * 3_600_000;
    await w.service.stageAttachment(CH, clipId, { name: "e.txt", type: "", size: 5, sha256: HELLO_SHA });
    assert.ok(!(await readdir(w.stagingDir)).includes(`${stale}.part`));
  }));

test("AC-CR-27: a piece larger than 4 MiB is refused", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const size = 4 * 1024 * 1024 + 1;
    const { uploadId } = await w.service.stageAttachment(CH, clipId, { name: "v.mp4", type: "video/mp4", size, sha256: "a".repeat(64) });
    await refused(w.service.appendAttachmentPiece(CH, clipId, uploadId, 0, new Uint8Array(size)), "validation_failed");
  }));

// ---- Independent review of BL-246 (2026-11-06): fixes, each with its expected behaviour written by hand ----

test("review 1: a failed write answers a fixed message without the computer's paths; the detail goes to the server log", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const id = await w.upload(clipId, "note.txt", "hello");
    const reason = `EACCES: permission denied, open '${w.workspace}/99 Data Exchange/From YTM/clip-reviews/x'`;
    w.ports.attachmentFiles.write = async () => {
      throw new Error(reason);
    };
    await assert.rejects(w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [id] }, "owner"), (error: unknown) => {
      assert.ok(isDomainError(error) && error.code === "clip_attachment_write_failed");
      assert.equal(error.message, "The files could not be written into the channel folder on this computer");
      assert.deepEqual(error.details, { clipId });
      return true;
    });
    assert.equal(w.logs.length, 1);
    assert.equal(w.logs[0].event, "clip_review.attachments_write_failed");
    assert.equal(w.logs[0].reason, reason);
    assert.deepEqual(w.store.snapshot(CH).decisions, {});
  }));

test("review 2: removing a staged file runs under the module's lock", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const id = await w.upload(clipId, "note.txt", "hello");
    const original = w.ports.withLock;
    let locked = 0;
    w.ports.withLock = (fn) => {
      locked++;
      return original(fn);
    };
    await w.service.discardAttachment(CH, clipId, id);
    assert.equal(locked, 1);
    assert.deepEqual(await readdir(w.stagingDir), []);
  }));

test("review 5: a decision id that is not a plain folder name is refused before any folder is made", () =>
  withWorld(async (w) => {
    const files = createAttachmentFiles();
    for (const [clipId, decisionId] of [["clip_1", "../evil"], ["clip_1", "a.b"], ["../x", "cd_1"], ["clip_1", ""]]) {
      await assert.rejects(files.write(w.workspace, clipId, decisionId, []), /not a clip or decision folder name/);
    }
    assert.equal(await exists(path.join(w.workspace, "99 Data Exchange")), false);
  }));

test("review 6: malformed attachments from the other computer's document are skipped, never thrown on", () =>
  withWorld(async (w) => {
    const valid = { path: "99 Data Exchange/From YTM/clip-reviews/c/cd/a.txt", name: "a.txt", mime: "text/plain", size: 5, sha256: HELLO_SHA };
    assert.deepEqual(wellFormedAttachments("x"), []);
    assert.deepEqual(wellFormedAttachments(null), []);
    assert.deepEqual(wellFormedAttachments([null, 3, { path: 1 }, { ...valid, size: -1 }, { ...valid, size: "5" }, valid]), [valid]);

    const clipId = await w.submit();
    const id = await w.upload(clipId, "a.txt", "hello");
    const { clip } = await w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [id] }, "owner");
    const record = w.store.snapshot(CH).decisions[clip.decisionId!];
    record.attachments = [{ junk: true } as never, ...record.attachments!];
    const owner = (await w.service.ownerList(CH)).clips[0];
    assert.deepEqual(owner.attachments.map((a) => [a.index, a.name, a.file]), [[0, "a.txt", "ok"]]);
    // The place the screen shows is the place the route serves.
    assert.equal((await w.service.attachmentFile(CH, clipId, clip.decisionId!, 0)).name, "a.txt");
    (record as { attachments: unknown }).attachments = "not a list";
    assert.deepEqual((await w.service.get({ channelId: CH, clipId })).clip.attachments, []);
  }));

test("review 7: the start-up sweep removes idle, stray and no-longer-usable uploads, and keeps one still being sent", () =>
  withWorld(async (w) => {
    w.clock.t = Date.now();
    const pending = await w.submit();
    await writeFile(path.join(w.workspace, "03 Images", "b.mp4"), "0123456789");
    const answered = await w.submit("03 Images/b.mp4");
    const keep = await w.upload(pending, "keep.txt", "hello");
    const gone = await w.upload(answered, "gone.txt", "hello");
    await w.service.decide(CH, answered, { action: "return", comment: "c" }, "owner");
    // An upload started 2 days ago whose last piece arrived just now: active as a whole, kept.
    const body = Buffer.from("hello world");
    const { uploadId: active } = await w.service.stageAttachment(CH, pending, { name: "active.txt", type: "", size: body.length, sha256: sha(body) });
    await w.service.appendAttachmentPiece(CH, pending, active, 0, new Uint8Array(body.subarray(0, 5)));
    const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000);
    await utimes(path.join(w.stagingDir, `${active}.json`), twoDaysAgo, twoDaysAgo);
    // An upload idle for 2 days (both files): removed.
    const { uploadId: idle } = await w.service.stageAttachment(CH, pending, { name: "idle.txt", type: "", size: 5, sha256: HELLO_SHA });
    for (const ext of ["json", "part"]) await utimes(path.join(w.stagingDir, `${idle}.${ext}`), twoDaysAgo, twoDaysAgo);
    // A stray piece without its description: removed.
    const stray = "f".repeat(32);
    await writeFile(path.join(w.stagingDir, `${stray}.part`), "x");

    assert.deepEqual(await w.service.sweepStaged(), { removed: 3 });
    const left = (await readdir(w.stagingDir)).sort();
    assert.deepEqual(left, [`${active}.json`, `${active}.part`, `${keep}.json`, `${keep}.part`].sort());
    assert.ok(!left.some((name) => name.startsWith(gone) || name.startsWith(idle) || name.startsWith(stray)));
    // Nothing in the channel folder was touched by the sweep.
    assert.equal(await exists(path.join(w.workspace, "99 Data Exchange")), false);
  }));

test("review 7: a decision refused because the clip was answered meanwhile removes the files it named", () =>
  withWorld(async (w) => {
    const clipId = await w.submit();
    const id = await w.upload(clipId, "note.txt", "hello");
    await w.service.decide(CH, clipId, { action: "approve" }, "owner");
    await refused(w.service.decide(CH, clipId, { action: "return", comment: "c", attachments: [id] }, "owner"), "clip_review_not_pending");
    assert.deepEqual(await readdir(w.stagingDir), []);
  }));
