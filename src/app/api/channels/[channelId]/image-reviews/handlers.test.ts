import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createImageReviewRouteHandlers, type ImageReviewRouteDeps } from "./handlers";

// BL-272 (ADR 0076; AGENTS.md §F): the owner's image routes need a Web session (401) and the ACTIVE channel (403); the image and its
// preview go only to the owner's browser (403 otherwise); a decision reaches the module with the session's user; the module's
// refusals keep their codes and statuses (409 not pending, 404 not found).

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const post = (body: unknown) => new Request("http://127.0.0.1:3000/x", { method: "POST", headers: { "content-type": "application/json", host: "127.0.0.1:3000" }, body: JSON.stringify(body) });
const get = () => new Request("http://127.0.0.1:3000/x", { headers: { host: "127.0.0.1:3000" } });

function make(options: { session?: { user: { id: string } } | null; refuse?: DomainError; file?: { path: string; bytes: number; type: string } | null; preview?: Uint8Array | null; ownerBrowser?: boolean } = {}) {
  const calls: unknown[][] = [];
  const deps: ImageReviewRouteDeps = {
    getSession: async () => (options.session === undefined ? { user: { id: "u1" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel" });
    },
    service: () => ({
      ownerList: async (...args) => (calls.push(["list", ...args]), { images: [], waiting: 2 }),
      ownerWaiting: async (...args) => (calls.push(["waiting", ...args]), { waiting: 2 }),
      decide: async (...args) => {
        calls.push(["decide", ...args]);
        if (options.refuse) throw options.refuse;
        return { image: {} as never };
      },
      imageFile: async (...args) => {
        calls.push(["file", ...args]);
        if (options.refuse) throw options.refuse;
        return options.file ?? null;
      },
      previewFile: async (...args) => {
        calls.push(["preview", ...args]);
        if (!options.file) return null;
        return options.preview ? { body: options.preview, type: "image/jpeg" } : { file: options.file, type: options.file.type };
      },
    }),
    isOwnerBrowser: () => options.ownerBrowser ?? true,
  };
  return { handlers: createImageReviewRouteHandlers(deps), calls };
}

test("BL-272: no session -> 401, another channel -> 403, not the owner's browser -> 403; none reaches the module", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.list(get(), ctx({ channelId: "UC_active" }))).status, 401);
  assert.equal((await anonymous.handlers.image(get(), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 401);
  const other = make();
  assert.equal((await other.handlers.decide(post({ action: "approve" }), ctx({ channelId: "UC_other", imageId: "img_1" }))).status, 403);
  assert.equal((await other.handlers.preview(get(), ctx({ channelId: "UC_other", imageId: "img_1" }))).status, 403);
  const foreign = make({ ownerBrowser: false });
  assert.equal((await foreign.handlers.image(get(), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 403);
  assert.equal((await foreign.handlers.preview(get(), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 403);
  assert.deepEqual([...anonymous.calls, ...other.calls, ...foreign.calls], []);
});

test("BL-272: the list answers the module's waiting count; a decision reaches the module with the session's user; refusals keep their status", async () => {
  const ok = make();
  assert.deepEqual(await (await ok.handlers.list(get(), ctx({ channelId: "UC_active" }))).json(), { images: [], waiting: 2 });
  ok.calls.length = 0;
  const body = { action: "approve_with_note", comment: "убрать прохожего" };
  assert.equal((await ok.handlers.decide(post(body), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 200);
  assert.deepEqual(ok.calls, [["decide", "UC_active", "img_1", body, "u1"]]);
  const decided = make({ refuse: new DomainError({ code: "image_review_not_pending", message: "approved", details: { status: "approved" } }) });
  const res = await decided.handlers.decide(post({ action: "return", comment: "x" }), ctx({ channelId: "UC_active", imageId: "img_1" }));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "image_review_not_pending", message: "approved", details: { status: "approved" } });
  const gone = make({ refuse: new DomainError({ code: "image_review_not_found", message: "no" }) });
  assert.equal((await gone.handlers.image(get(), ctx({ channelId: "UC_active", imageId: "img_x" }))).status, 404);
});

test("BL-272: the image is served from this computer's copy with its type; the preview is the JPEG made here, else the original; missing is 404", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "image-review-route-"));
  try {
    const file = path.join(dir, "master.png");
    await writeFile(file, "PNGBYTES");
    const served = make({ file: { path: file, bytes: 8, type: "image/png" } });
    const full = await served.handlers.image(get(), ctx({ channelId: "UC_active", imageId: "img_1" }));
    assert.deepEqual([full.status, full.headers.get("content-type"), await full.text()], [200, "image/png", "PNGBYTES"]);
    const original = await served.handlers.preview(get(), ctx({ channelId: "UC_active", imageId: "img_1" }));
    assert.deepEqual([original.status, original.headers.get("content-type"), await original.text()], [200, "image/png", "PNGBYTES"]);
    const jpeg = make({ file: { path: file, bytes: 8, type: "image/png" }, preview: new Uint8Array([0xff, 0xd8, 0xff]) });
    const small = await jpeg.handlers.preview(get(), ctx({ channelId: "UC_active", imageId: "img_1" }));
    assert.deepEqual([small.status, small.headers.get("content-type"), [...new Uint8Array(await small.arrayBuffer())]], [200, "image/jpeg", [0xff, 0xd8, 0xff]]);
    const absent = make({ file: null });
    assert.equal((await absent.handlers.image(get(), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 404);
    assert.equal((await absent.handlers.preview(get(), ctx({ channelId: "UC_active", imageId: "img_1" }))).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("BL-272 (review): ?view=count answers only the waiting count through the count-only path -- never the list with its file work", async () => {
  const ok = make();
  const res = await ok.handlers.list(new Request("http://127.0.0.1:3000/x?view=count", { headers: { host: "127.0.0.1:3000" } }), ctx({ channelId: "UC_active" }));
  assert.deepEqual(await res.json(), { waiting: 2 });
  assert.deepEqual(ok.calls, [["waiting", "UC_active"]]);
  const other = make();
  assert.equal((await other.handlers.list(new Request("http://127.0.0.1:3000/x?view=count", { headers: { host: "127.0.0.1:3000" } }), ctx({ channelId: "UC_other" }))).status, 403);
  assert.deepEqual(other.calls, []);
});
