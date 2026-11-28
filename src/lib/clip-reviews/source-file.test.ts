import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import type { ClipReviewClip, ClipReviewsSnapshot } from "@/lib/sync-gateway";
import { hashClipFile, resolveClipFile } from "./adapters/files";
import type { ClipReviewsPorts } from "./contracts";
import { createClipReviewsService } from "./services";

// BL-280 (FO-REQ-0062 part B): when producer_clip_review_submit accepts a clip, YT Manager keeps the path it was given and the SHA-256
// of the bytes it read; every read of the clip or its decision returns { clipId, file, sha256, submittedAt }. A clip whose stored
// record lacks a field returns null for it (never guessed). Expected values are written by hand from that requirement: the SHA-256 of
// the bytes "abc" is the FIPS 180-2 test vector, not a value computed here.

const CH = "UC_source_A";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const CLIP_PATH = "03 Images/Scenes/bar/preview_v4.mp4";
const NOW = "2026-11-28T12:00:00.000Z";

function memoryStore(initial?: ClipReviewsSnapshot): ClipReviewsPorts["store"] {
  const doc: ClipReviewsSnapshot = initial ?? { clips: {}, decisions: {} };
  return {
    read: async () => JSON.parse(JSON.stringify(doc)),
    addClip: async (_channelId, clip) => void (doc.clips[clip.clipId] = clip),
    addDecision: async (_channelId, decision) => void (doc.decisions[decision.id] = decision),
  };
}

const unused = async (): Promise<never> => {
  throw new Error("not used in this test");
};

/** The real workspace rule and the real hash on a temporary channel folder; only ffprobe is replaced (30 s). */
function service(workspace: string, store: ClipReviewsPorts["store"]) {
  let n = 0;
  const ports: ClipReviewsPorts = {
    store,
    isChannelConnected: async (channelId) => channelId === CH,
    workspace: async () => workspace,
    resolveFile: resolveClipFile,
    probeDurationSeconds: async () => 30,
    hashFile: hashClipFile,
    assertDeviceAvailable: async () => undefined,
    deviceLabel: async () => "Mac",
    now: () => new Date(NOW),
    randomId: () => `src${String(++n).padStart(4, "0")}`,
    withLock: (fn) => fn(),
    audit: async () => undefined,
    logError: () => undefined,
    staging: { create: unused, get: unused, list: unused, append: unused, head: unused, readAll: unused, hash: unused, remove: unused, removeOlderThan: unused },
    attachmentFiles: { write: unused, remove: unused, resolve: unused },
  };
  return createClipReviewsService(ports);
}

async function channelFolder(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-clip-source-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "03 Images/Scenes/bar"), { recursive: true });
  await writeFile(path.join(root, CLIP_PATH), "abc");
  return root;
}

test("BL-280: the real hash adapter gives the SHA-256 of the bytes on disk ('abc' = the FIPS 180-2 vector)", async (t) => {
  const root = await channelFolder(t);
  assert.equal(await hashClipFile(path.join(root, CLIP_PATH)), ABC_SHA256);
});

test("BL-280: submit stores the path as given and the SHA-256 of the bytes read; submit, get, list, withdraw and the owner's list all return source", async (t) => {
  const root = await channelFolder(t);
  const clips = service(root, memoryStore());
  const { clip } = await clips.submit({ channelId: CH, sceneId: "bar-night", clipPath: CLIP_PATH, note: "v4" }, { tokenId: "tok" });
  const source = { clipId: clip.clipId, file: CLIP_PATH, sha256: ABC_SHA256, submittedAt: NOW };
  assert.deepEqual(clip.source, source);
  assert.equal(clip.sha256, ABC_SHA256);
  assert.deepEqual((await clips.get({ channelId: CH, clipId: clip.clipId })).clip.source, source);
  assert.deepEqual((await clips.list({ channelId: CH })).clips.map((c) => c.source), [source]);
  assert.deepEqual((await clips.ownerList(CH)).clips.map((c) => c.source), [source]);
  const withdrawn = (await clips.withdraw({ channelId: CH, clipId: clip.clipId })).clip;
  assert.equal(withdrawn.status, "withdrawn");
  assert.deepEqual(withdrawn.source, source);
  assert.deepEqual((await clips.list({ channelId: CH, status: "withdrawn" })).clips.map((c) => c.source), [source]);
});

test("BL-280: the owner's approval answers source, and the clip read after it (the Producer's decision lookup) still names the same file", async (t) => {
  const root = await channelFolder(t);
  const clips = service(root, memoryStore());
  const { clip } = await clips.submit({ channelId: CH, sceneId: "bar-night", clipPath: CLIP_PATH, note: "v4" }, { tokenId: "tok" });
  const source = { clipId: clip.clipId, file: CLIP_PATH, sha256: ABC_SHA256, submittedAt: NOW };
  const decided = (await clips.decide(CH, clip.clipId, { action: "approve" }, "owner")).clip;
  assert.equal(decided.status, "approved");
  assert.deepEqual(decided.source, source);
  const read = (await clips.get({ channelId: CH, clipId: clip.clipId })).clip;
  assert.equal(read.status, "approved");
  assert.deepEqual(read.source, source);
});

test("BL-280: the path rule of submit is unchanged -- '..', an absolute path and a backslash path are refused and nothing is stored", async (t) => {
  const root = await channelFolder(t);
  const clips = service(root, memoryStore());
  for (const clipPath of ["../outside.mp4", path.join(root, CLIP_PATH), "03 Images\\Scenes\\bar\\preview_v4.mp4"]) {
    await assert.rejects(clips.submit({ channelId: CH, sceneId: "s", clipPath, note: "n" }, { tokenId: "tok" }), (error: unknown) => isDomainError(error) && (error.code === "clip_review_file_unavailable" || error.code === "validation_failed"));
  }
  assert.deepEqual((await clips.list({ channelId: CH })).clips, []);
});

/** A clip as an older document may carry it: no clipPath and no sha256 (the fields this change reads). */
function oldClip(): ClipReviewClip {
  return { clipId: "clip_old", channelId: CH, sceneId: "old", note: "n", startSec: null, endSec: null, durationSeconds: 20, sizeBytes: 3, submittedAt: "2026-11-01T08:00:00.000Z", submittedBy: "p", device: "Mac" } as unknown as ClipReviewClip;
}

test("BL-280: a stored clip without the path or hash returns file and sha256 null on every read -- never the file now in the folder", async (t) => {
  const root = await channelFolder(t);
  const snapshot: ClipReviewsSnapshot = {
    clips: { clip_old: oldClip() },
    decisions: { cd_old: { id: "cd_old", clipId: "clip_old", kind: "approved", by: "owner", comment: null, device: "Mac", at: "2026-11-01T09:00:00.000Z" } },
  };
  const clips = service(root, memoryStore(snapshot));
  const expected = { clipId: "clip_old", file: null, sha256: null, submittedAt: "2026-11-01T08:00:00.000Z" };
  assert.deepEqual((await clips.get({ channelId: CH, clipId: "clip_old" })).clip.source, expected);
  assert.deepEqual((await clips.list({ channelId: CH })).clips.map((c) => c.source), [expected]);
  assert.deepEqual((await clips.ownerList(CH)).clips.map((c) => c.source), [expected]);
  // A malformed hash is not a hash either.
  const bad = service(root, memoryStore({ clips: { clip_old: { ...oldClip(), clipPath: CLIP_PATH, sha256: "x" } }, decisions: {} }));
  assert.deepEqual((await bad.get({ channelId: CH, clipId: "clip_old" })).clip.source, { ...expected, file: CLIP_PATH });
});
