import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createChannelBrandingHandlers, type ChannelBrandingRouteDeps } from "./shared";

// BL-223 (CHANNEL_BRANDING_PLAN.md §4/§6): the owner's routes -- a Web session and the active channel first; the owner saves as
// "owner" (JSON, or multipart with a banner file); «Применить» passes the session's user as the credential reference and the
// previewed draftVersion; a refused draft answers 400 with details.refused; branding_changed answers 409.

function deps(overrides: Partial<ChannelBrandingRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: ChannelBrandingRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC1") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE" as never, message: "not active" });
    },
    core: {
      get: async (channelId) => (calls.push(["get", channelId]), { channelId }) as never,
      save: async (channelId, input, by) => {
        calls.push(["save", channelId, input.description, input.keywords, input.banner?.kind ?? null, input.banner?.kind === "bytes" ? input.banner.bytes.toString() : null, by]);
        if (input.description === "bad") throw new DomainError({ code: "validation_failed", message: "Refused", details: { refused: [{ field: "description", reason: "description_too_long" }] } });
        return { draft: null };
      },
      bannerBytes: async () => ({ bytes: Buffer.from("png"), mimeType: "image/png" as const }),
      preview: async (channelId) => (calls.push(["preview", channelId]), {}) as never,
      apply: async (channelId, credentialRef, draftVersion) => {
        calls.push(["apply", channelId, credentialRef, draftVersion]);
        if (draftVersion === "old") throw new DomainError({ code: "branding_changed", message: "changed" });
        return { ok: true } as never;
      },
    },
    ...overrides,
  };
  return { handlers: createChannelBrandingHandlers(base), calls };
}

const ctx = (channelId = "UC1") => ({ params: Promise.resolve({ channelId }) });
const json = (method: string, body: unknown) => new Request("http://x", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("no session -> 401 and the module is not called", async () => {
  const { handlers, calls } = deps({ getSession: async () => null });
  assert.equal((await handlers.APPLY(json("POST", {}), ctx())).status, 401);
  assert.equal((await handlers.GET(new Request("http://x"), ctx())).status, 401);
  assert.deepEqual(calls, []);
});

test("a channel that is not the active one -> 403 and the module is not called", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.APPLY(json("POST", { draftVersion: "v1" }), ctx("UC2"))).status, 403);
  assert.equal((await handlers.PUT(json("PUT", { description: "x" }), ctx("UC2"))).status, 403);
  assert.deepEqual(calls, []);
});

test("PUT JSON saves as the owner (keepBanner keeps the stored banner); a refused draft answers 400 with details.refused", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.PUT(json("PUT", { description: "D", keywords: ["a"], keepBanner: true }), ctx())).status, 200);
  const refused = await handlers.PUT(json("PUT", { description: "bad" }), ctx());
  assert.equal(refused.status, 400);
  assert.deepEqual(((await refused.json()) as { details: unknown }).details, { refused: [{ field: "description", reason: "description_too_long" }] });
  assert.deepEqual(calls[0], ["save", "UC1", "D", ["a"], "keep", null, "owner"]);
});

test("PUT multipart carries the banner file's bytes with the draft fields", async () => {
  const { handlers, calls } = deps();
  const form = new FormData();
  form.set("draft", JSON.stringify({ description: "D" }));
  form.set("banner", new Blob([Buffer.from("banner-bytes")], { type: "image/png" }), "b.png");
  assert.equal((await handlers.PUT(new Request("http://x", { method: "PUT", body: form }), ctx())).status, 200);
  assert.deepEqual(calls, [["save", "UC1", "D", undefined, "bytes", "banner-bytes", "owner"]]);
});

test("POST /apply passes the session's user and the previewed draftVersion; branding_changed -> 409; bad JSON -> 400", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.APPLY(json("POST", { draftVersion: "v1" }), ctx())).status, 200);
  assert.deepEqual(calls, [["apply", "UC1", { userId: "user-1" }, "v1"]]);
  assert.equal((await handlers.APPLY(json("POST", { draftVersion: "old" }), ctx())).status, 409);
  assert.equal((await handlers.APPLY(new Request("http://x", { method: "POST", body: "not json" }), ctx())).status, 400);
});

test("GET /banner answers the stored image with its type", async () => {
  const { handlers } = deps();
  const response = await handlers.BANNER(new Request("http://x"), ctx());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), "png");
});
