import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createImageReviewsService, type ImageReviewsPorts } from "@/lib/image-reviews";
import { readImageInfo } from "@/lib/media-preview";
import { hashReviewFile, resolveReviewFile } from "@/lib/review-items";
import { createInboxWriter, createReviewNotify, isDirectory, sweepInboxTemp, type ReviewLedgerEntry } from "@/lib/review-notify";
import type { ImageReviewsSnapshot } from "@/lib/sync-gateway";
import { imageNoticesOf } from "./review-notify";

// BL-272 (ADR 0076, ADR 0066; coordinator brief item 3): each of the owner's three answers on a master still image writes ONE file
// `REVIEW-DECISION-image-<imageId>-<decisionId>.md` into the Producer's Inbox, with his words, exactly as the clip decisions do. The
// chain is real from the owner's decision to the file on disk (the image-reviews service on real files, the composition's mapper,
// the review-notify writer with its real Inbox writer); only the synced document is in memory. The Producer's withdrawal gives none.

const CH = { channelId: "UC_tropico", name: "Tropico Jazz" };

test("BL-272: approve, approve with a note and return each write REVIEW-DECISION-image-<imageId>-<decisionId>.md with the comment; a withdrawal writes none", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "image-review-notify-"));
  try {
    const workspace = path.join(root, "01 Tropico");
    const inbox = path.join(root, "00 YT Producer", "Inbox");
    await mkdir(inbox, { recursive: true });
    const doc: ImageReviewsSnapshot = { images: {}, decisions: {} };
    const clock = { t: Date.parse("2026-11-23T10:00:00.000Z") };
    let n = 0;
    const ports: ImageReviewsPorts = {
      store: {
        read: async () => JSON.parse(JSON.stringify(doc)),
        addImage: async (_c, image) => void (doc.images[image.imageId] = image),
        addDecision: async (_c, decision) => void (doc.decisions[decision.id] = decision),
      },
      isChannelConnected: async () => true,
      workspace: async () => workspace,
      resolveFile: resolveReviewFile,
      probeImage: readImageInfo,
      hashFile: hashReviewFile,
      preview: async () => null,
      assertDeviceAvailable: async () => undefined,
      deviceLabel: async () => "Mac",
      now: () => new Date(clock.t),
      randomId: () => `r${String(++n).padStart(4, "0")}`,
      withLock: (fn) => fn(),
      audit: async () => undefined,
    };
    const service = createImageReviewsService(ports);
    const ids: string[] = [];
    for (const scene of ["P46", "P47", "P48", "P49"]) {
      const rel = `03 Images/Scenes/${scene}/master.png`;
      await mkdir(path.join(workspace, "03 Images", "Scenes", scene), { recursive: true });
      await writeFile(path.join(workspace, ...rel.split("/")), await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 9, g: 9, b: 9 } } }).png().toBuffer());
      ids.push((await service.submit({ channelId: CH.channelId, sceneId: scene, imagePath: rel, batchId: "tropico-b1" }, { tokenId: "tok" })).image.imageId);
    }
    clock.t += 60_000;
    await service.decide(CH.channelId, ids[0], { action: "approve" }, "u1");
    await service.decide(CH.channelId, ids[1], { action: "approve_with_note", comment: "убрать прохожего" }, "u1");
    await service.decide(CH.channelId, ids[2], { action: "return", comment: "небо слишком светлое" }, "u1");
    await service.withdraw({ channelId: CH.channelId, imageId: ids[3] });

    const ledger = new Map<string, ReviewLedgerEntry>();
    const settings = { value: JSON.stringify({ enabled: true, inboxPath: inbox }) as string | null, state: null as string | null };
    const notify = createReviewNotify({
      decisionSources: [{ name: "images", list: async (since) => imageNoticesOf(CH, doc, Date.parse(since)) }],
      planSources: [],
      settings: { read: async () => settings.value, write: async (json) => void (settings.value = json) },
      state: { read: async () => settings.state, write: async (json) => void (settings.state = json) },
      ledger: { has: async (keys) => new Set(keys.filter((k) => ledger.has(k))), record: async (entries) => entries.forEach((e) => ledger.set(e.key, e)), prune: async () => undefined },
      inbox: { defaultPath: async () => inbox, producerFolderExists: async () => true, isDirectory, writeOnce: createInboxWriter(), sweepTemp: sweepInboxTemp },
      platform: () => "darwin",
      now: () => new Date(clock.t + 60_000),
      log: () => undefined,
    });
    await notify.tick();

    const decisionOf = (imageId: string) => Object.values(doc.decisions).find((d) => d.imageId === imageId)!.id;
    const expected = [ids[0], ids[1], ids[2]].map((id) => `REVIEW-DECISION-image-${id}-${decisionOf(id)}.md`).sort();
    assert.deepEqual((await readdir(inbox)).sort(), expected);
    const fileOf = (imageId: string) => readFile(path.join(inbox, `REVIEW-DECISION-image-${imageId}-${decisionOf(imageId)}.md`), "utf8");
    const approved = await fileOf(ids[0]);
    const noted = await fileOf(ids[1]);
    const returned = await fileOf(ids[2]);
    for (const [text, status] of [
      [approved, "approved"],
      [noted, "approved_with_note"],
      [returned, "returned"],
    ] as const) {
      assert.match(text, /kind: "?image"?/);
      assert.match(text, new RegExp(`status: "?${status}"?`));
      assert.match(text, /Медиа → «Кадры»/);
      assert.match(text, /producer_image_review_get/);
    }
    assert.match(noted, /убрать прохожего/);
    assert.match(returned, /небо слишком светлое/);
    assert.match(approved, /## Owner's comment\s+\(none\)/);
    assert.match(noted, /Scene: P47|P47/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("BL-272: imageNoticesOf -- only the owner's three kinds after the window start; the Producer's withdrawal and older decisions give none", () => {
  const image = (imageId: string) => ({ imageId, channelId: CH.channelId, sceneId: `S-${imageId}`, imagePath: `03 Images/${imageId}.png`, note: "", batchId: "b1", requestId: null, width: 1920, height: 1080, sizeBytes: 5, sha256: "e".repeat(64), submittedAt: "2026-11-23T08:00:00Z", submittedBy: "p", device: "Mac" });
  const snapshot: ImageReviewsSnapshot = {
    images: { i1: image("i1"), i2: image("i2"), i3: image("i3"), i4: image("i4"), i5: image("i5") },
    decisions: {
      d1: { id: "d1", imageId: "i1", kind: "approved", by: "owner", comment: null, device: "Mac", at: "2026-11-23T09:00:00Z" },
      d2: { id: "d2", imageId: "i2", kind: "approved_with_note", by: "owner", comment: "убрать прохожего", device: "Win", at: "2026-11-23T09:01:00Z" },
      d3: { id: "d3", imageId: "i3", kind: "returned", by: "owner", comment: "темно", device: "Mac", at: "2026-11-23T09:02:00Z" },
      d4: { id: "d4", imageId: "i4", kind: "withdrawn", by: "producer", comment: null, device: "Mac", at: "2026-11-23T09:03:00Z" },
      old: { id: "old", imageId: "i5", kind: "approved", by: "owner", comment: null, device: "Mac", at: "2026-11-22T23:59:59Z" },
    },
  };
  const notices = imageNoticesOf(CH, snapshot, Date.parse("2026-11-23T00:00:00Z"));
  assert.deepEqual(notices.map((x) => [x.kind, x.itemId, x.decisionId, x.status, x.comment, x.decidedOn]).sort(), [
    ["image", "i1", "d1", "approved", null, "Mac"],
    ["image", "i2", "d2", "approved_with_note", "убрать прохожего", "Win"],
    ["image", "i3", "d3", "returned", "темно", "Mac"],
  ]);
  const noted = notices.find((x) => x.decisionId === "d2")!;
  assert.deepEqual(noted.context.slice(0, 2), [
    { label: "Scene", value: "S-i2" },
    { label: "Image file", value: "03 Images/i2.png" },
  ]);
  assert.equal(noted.readTool, 'producer_image_review_get {"channelId":"UC_tropico","imageId":"i2"}');
});
