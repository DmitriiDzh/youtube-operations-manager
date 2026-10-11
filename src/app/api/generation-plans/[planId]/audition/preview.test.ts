import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { isPathInsideOrEqual } from "@/lib/local-path-validation";
import { createImagePreviewer, type SharpFactory } from "@/lib/media-preview";
import { DomainError } from "@/lib/shared-domain";
import { createExchangeFs, resolveFromYtmJobFile, resolveSentToYtmFile } from "@/lib/workspace-exchange";
import { createPreviewGetHandler } from "./serve";

// BL-175 AC-VR-12 (docs/roadmap/plans/VISUAL_REVIEW_PLAN.md §2.7/§3): the grid's image previews -- found and proven like the
// audition (never a path from the request), loopback only, images only, at most 480 px a side, the original when none is made.

async function workspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ytm-preview-")));
  const ws = path.join(root, "ws");
  const sent = path.join(ws, "99 Data Exchange", "Sent to YTM", "H-0004");
  await mkdir(sent, { recursive: true });
  // A 1000 x 500 PNG (the preview keeps its 2:1 shape: 480 x 240), a clip and a track.
  await sharp({ create: { width: 1000, height: 500, channels: 3, background: { r: 200, g: 120, b: 40 } } }).png().toFile(path.join(sent, "a1.png"));
  await writeFile(path.join(sent, "loop.mp4"), "not really a video");
  await writeFile(path.join(sent, "t.mp3"), "not really audio");
  await writeFile(path.join(sent, "broken.png"), "not an image at all");
  return { ws, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function handler(ws: string, preview: (file: string) => Promise<Uint8Array | null>) {
  const unavailable = (reason: string) => new Error(reason);
  const files: Record<string, string> = { a1: "H-0004/a1.png", v1: "H-0004/loop.mp4", m1: "H-0004/t.mp3", b1: "H-0004/broken.png" };
  return createPreviewGetHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    assertVisible: async () => undefined,
    async resolveAudition({ attemptRef }) {
      const file = files[attemptRef];
      if (!file) throw new DomainError({ code: "plan_mismatch", message: "nothing to show" });
      return { channelId: "UC1", kind: "sent", relativePath: file };
    },
    workspaceOf: async () => ws,
    resolveSentFile: (w, relativePath) => resolveSentToYtmFile({ workspace: w, relativePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
    resolveJobFile: (w, jobId, filePath) => resolveFromYtmJobFile({ workspace: w, subdir: "media", jobId, filePath, fs: createExchangeFs(), validateWorkspacePath: async () => ({ ok: true }), isPathInsideOrEqual, unavailable }),
    preview,
  });
}

const get = (h: ReturnType<typeof handler>, query: string, host = "127.0.0.1:3000") =>
  h(new Request(`http://${host}/api/generation-plans/P1/preview?${query}`, { headers: { host } }), { params: Promise.resolve({ planId: "P1" }) });

const previewer = () =>
  createImagePreviewer({
    loadSharp: async () => sharp as unknown as SharpFactory,
    stat: async (file) => {
      const { stat } = await import("node:fs/promises");
      const s = await stat(file);
      return { size: s.size, mtimeMs: s.mtimeMs };
    },
  });

test("AC-VR-12: an image attempt gets a JPEG no larger than 480 px a side; a video or a track is 415; an unknown attempt is the plan's own error", async () => {
  const w = await workspace();
  try {
    const p = previewer();
    const h = handler(w.ws, (file) => p.preview(file));
    const res = await get(h, "itemKey=W1/I&attemptRef=a1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["jpeg", 480, 240]);
    assert.equal((await get(h, "itemKey=W1/I&attemptRef=v1")).status, 415);
    assert.equal((await get(h, "itemKey=W1/I&attemptRef=m1")).status, 415);
    // plan_mismatch is 422 everywhere in this API (error-status.ts), as for an audition.
    assert.equal((await get(h, "itemKey=W1/I&attemptRef=zz")).status, 422);
  } finally {
    await w.cleanup();
  }
});

test("AC-VR-12: loopback only (403); a path never comes from the request -- any other parameter is refused (400)", async () => {
  const w = await workspace();
  try {
    let asked = 0;
    const h = handler(w.ws, async () => {
      asked++;
      return null;
    });
    assert.equal((await get(h, "itemKey=W1/I&attemptRef=a1", "192.168.1.20:3000")).status, 403);
    assert.equal((await get(h, "itemKey=W1/I&attemptRef=a1&path=/etc/passwd")).status, 400);
    assert.equal(asked, 0);
  } finally {
    await w.cleanup();
  }
});

test("AC-VR-12: when no preview can be made (no sharp, an unreadable image), the original image is sent", async () => {
  const w = await workspace();
  try {
    const none = createImagePreviewer({ loadSharp: async () => null, stat: async () => ({ size: 1, mtimeMs: 1 }) });
    const h = handler(w.ws, (file) => none.preview(file));
    const res = await get(h, "itemKey=W1/I&attemptRef=a1");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png", "the original");
    const broken = await get(handler(w.ws, (file) => previewer().preview(file)), "itemKey=W1/I&attemptRef=b1");
    assert.equal(broken.status, 200);
    assert.equal(broken.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await broken.arrayBuffer()).toString(), "not an image at all");
  } finally {
    await w.cleanup();
  }
});

test("AC-VR-12: the same file again comes from the cache; a rewritten file (new size or time) gets a new preview", async () => {
  let made = 0;
  const p = createImagePreviewer({
    loadSharp: async () =>
      ((() => {
        made++;
        const pipeline = { rotate: () => pipeline, resize: () => pipeline, jpeg: () => pipeline, toBuffer: async () => new Uint8Array([made]) };
        return pipeline;
      }) as unknown as SharpFactory),
    stat: async (file) => ({ size: file.length, mtimeMs: file.endsWith("new.png") ? 2 : 1 }),
    entries: 2,
  });
  assert.deepEqual([...((await p.preview("/x/a.png")) ?? [])], [1]);
  assert.deepEqual([...((await p.preview("/x/a.png")) ?? [])], [1], "cached");
  assert.deepEqual([...((await p.preview("/x/new.png")) ?? [])], [2]);
  assert.deepEqual([...((await p.preview("/x/b.png")) ?? [])], [3]);
  assert.deepEqual([...((await p.preview("/x/a.png")) ?? [])], [4], "evicted after 2 newer ones (the cache keeps 2)");
});
