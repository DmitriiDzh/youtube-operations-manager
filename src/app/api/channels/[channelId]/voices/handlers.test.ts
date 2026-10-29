import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createVoicesRouteHandlers, type VoicesRouteDeps } from "./handlers";

// BL-236 (ADR 0057; AGENTS.md §F, Playbook §6.6): the owner's voices routes need a Web session and the ACTIVE channel; the approval
// is recorded as the owner's; a body cannot redirect to another channel or voice.

function harness(options: { session?: boolean; active?: boolean; previewType?: string } = {}) {
  const calls: string[] = [];
  const deps: VoicesRouteDeps = {
    getSession: async () => (options.session === false ? null : { user: { id: "owner" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (options.active === false) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel", details: { channelId } });
    },
    registry: async () => ({
      list: async (input) => (calls.push(`list:${JSON.stringify(input)}`), { voices: [] }),
      update: async (input) => (calls.push(`update:${JSON.stringify(input)}`), { voice: {} as never }),
      approve: async (input, actor) => (calls.push(`approve:${JSON.stringify(input)}:${actor}`), { voice: {} as never }),
      previewFile: async (channelId, voiceId, previewId) => (calls.push(`preview:${channelId}:${voiceId}:${previewId}`), { localPath: "/tmp/p.mp3", mimeType: options.previewType ?? "audio/mpeg" }),
    }),
    readFile: async () => Buffer.from("MP3"),
  };
  return { handlers: createVoicesRouteHandlers(deps), calls };
}

const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });
const json = (body: unknown) => new Request("http://x/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("no session → 401; not the active channel → refused before the registry", async () => {
  const anon = harness({ session: false });
  assert.equal((await anon.handlers.list(new Request("http://x/"), ctx({ channelId: "UC1" }))).status, 401);
  const other = harness({ active: false });
  const response = await other.handlers.approve(json({ previewId: "p1" }), ctx({ channelId: "UC2", voiceId: "vc_1" }));
  assert.notEqual(response.status, 200);
  assert.deepEqual(other.calls, []);
});

test("approve is the owner's pick; a body naming channelId or voiceId is refused; the preview plays with its type", async () => {
  const h = harness();
  assert.equal((await h.handlers.approve(json({ previewId: "p2" }), ctx({ channelId: "UC1", voiceId: "vc_1" }))).status, 200);
  assert.deepEqual(h.calls, ['approve:{"previewId":"p2","channelId":"UC1","voiceId":"vc_1"}:owner']);
  assert.equal((await h.handlers.update(json({ channelId: "UC2", archived: true }), ctx({ channelId: "UC1", voiceId: "vc_1" }))).status, 400);
  const preview = await h.handlers.preview(new Request("http://x/"), ctx({ channelId: "UC1", voiceId: "vc_1", previewId: "p1" }));
  assert.equal(preview.headers.get("content-type"), "audio/mpeg");
  assert.equal(Buffer.from(await preview.arrayBuffer()).toString(), "MP3");
});

test("review item 8: a preview is served as audio only (anything else as octet-stream), always with nosniff", async () => {
  for (const [stored, served] of [["audio/wav", "audio/wav"], ["text/html", "application/octet-stream"], ["audio/mpeg; x=<script>", "application/octet-stream"]] as const) {
    const h = harness({ previewType: stored });
    const response = await h.handlers.preview(new Request("http://x/"), ctx({ channelId: "UC1", voiceId: "vc_1", previewId: "p1" }));
    assert.equal(response.headers.get("content-type"), served, stored);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});
