import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBannerStore } from "./banner-store";

// BL-223 (CHANNEL_BRANDING_PLAN.md §1): the banner is copied to `<root>/<channelId>/banner.<jpg|png>`; one banner per channel; a
// path-like channel id is refused (the folder name is the id).

test("write / read / replace with another type / remove, on a real temporary folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "banner-store-"));
  try {
    const store = createBannerStore(root);
    await store.write("UC1", { bytes: Buffer.from("png-bytes"), mimeType: "image/png" });
    assert.deepEqual(await readdir(path.join(root, "UC1")), ["banner.png"]);
    assert.equal((await store.read("UC1", "image/png"))?.toString(), "png-bytes");
    await store.write("UC1", { bytes: Buffer.from("jpg-bytes"), mimeType: "image/jpeg" });
    assert.deepEqual(await readdir(path.join(root, "UC1")), ["banner.jpg"]);
    assert.equal(await store.read("UC1", "image/png"), null);
    await store.remove("UC1");
    assert.deepEqual(await readdir(path.join(root, "UC1")), []);
    await assert.rejects(store.write("../x", { bytes: Buffer.from("x"), mimeType: "image/png" }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
