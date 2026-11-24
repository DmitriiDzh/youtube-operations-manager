import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPackageReviewAlertsHandler, createPackageReviewRouteHandlers, type PackageReviewRouteDeps } from "./handlers";

// BL-257 (PACKAGE_REVIEW_PLAN.md AC-PR-08 / AC-PR-09 / AC-PR-15; AGENTS.md §F): the owner's package-review routes need a Web session
// (401) and the ACTIVE channel (403); the media go only to the owner's browser (403 otherwise) and honour HTTP Range (RFC 9110 §14:
// a satisfiable `bytes=a-b` is 206 with exactly those bytes and `content-range: bytes a-b/size`; no Range is 200 with the whole
// file); the module's refusals keep their codes and statuses; a package without its file here is 404.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const MANIFEST = "a".repeat(64);
const req = (method: string, query = "", headers: Record<string, string> = {}, body?: unknown) =>
  new Request(`http://127.0.0.1:3000/x${query}`, { method, headers: { host: "127.0.0.1:3000", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function make(options: { session?: { user: { id: string } } | null; refuse?: DomainError; file?: { path: string; bytes: number; type: string } | null; ownerBrowser?: boolean } = {}) {
  const calls: unknown[][] = [];
  const deps: PackageReviewRouteDeps = {
    getSession: async () => (options.session === undefined ? { user: { id: "u1" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not the active channel" });
    },
    service: () => ({
      view: async (...args) => (calls.push(["view", ...args]), { channelId: "UC_active", required: true, requiredUpdatedAt: null, readable: true, packages: "ok", items: [], waiting: 0 }),
      setRequired: async (...args) => (calls.push(["switch", ...args]), { channelId: "UC_active", required: true, requiredUpdatedAt: null, readable: true, packages: "ok", items: [], waiting: 0 }),
      decide: async (...args) => {
        calls.push(["decide", ...args]);
        if (options.refuse) throw options.refuse;
        return { decision: {} as never, view: {} as never };
      },
      mediaFile: async (...args) => (calls.push(["media", ...args]), options.file ?? null),
      waiting: async (...args) => (calls.push(["waiting", ...args]), 0),
    }),
    isOwnerBrowser: () => options.ownerBrowser ?? true,
  };
  return { handlers: createPackageReviewRouteHandlers(deps), calls };
}

test("AC-PR-08: no session -> 401, another channel -> 403, a foreign browser -> 403 for the media; none reaches the module", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.list(req("GET"), ctx("UC_active"))).status, 401);
  assert.equal((await anonymous.handlers.decide(req("POST", "", {}, { manifestSha256: MANIFEST, kind: "approved" }), ctx("UC_active"))).status, 401);
  assert.equal((await anonymous.handlers.video(req("GET", `?manifest=${MANIFEST}`), ctx("UC_active"))).status, 401);
  const other = make();
  assert.equal((await other.handlers.setRequired(req("PUT", "", {}, { required: true }), ctx("UC_other"))).status, 403);
  assert.equal((await other.handlers.video(req("GET", `?manifest=${MANIFEST}`), ctx("UC_other"))).status, 403);
  const foreign = make({ ownerBrowser: false });
  assert.equal((await foreign.handlers.video(req("GET", `?manifest=${MANIFEST}`), ctx("UC_active"))).status, 403);
  assert.equal((await foreign.handlers.thumbnail(req("GET", `?manifest=${MANIFEST}`), ctx("UC_active"))).status, 403);
  assert.deepEqual([...anonymous.calls, ...other.calls, ...foreign.calls], []);
});

test("the switch and a decision reach the module with the channel and the body; refusals keep their codes and statuses", async () => {
  const { handlers, calls } = make();
  assert.equal((await handlers.setRequired(req("PUT", "", {}, { required: true }), ctx("UC_active"))).status, 200);
  const body = { manifestSha256: MANIFEST, kind: "returned", comment: "redo the intro" };
  assert.equal((await handlers.decide(req("POST", "", {}, body), ctx("UC_active"))).status, 200);
  assert.deepEqual(calls, [["switch", "UC_active", { required: true }], ["decide", "UC_active", body]]);
  for (const [code, status] of [["package_review_no_sha256", 422], ["package_review_video_mismatch", 409], ["package_review_not_found", 404], ["package_review_uploaded", 409]] as const) {
    const refused = make({ refuse: new DomainError({ code, message: "no" }) });
    const res = await refused.handlers.decide(req("POST", "", {}, body), ctx("UC_active"));
    assert.equal(res.status, status, code);
    assert.equal((await res.json()).error, code);
  }
});

test("AC-PR-09: the video streams the package's file with Range 206 (exact bytes) and 200 without; a missing file is 404; the manifest is passed through", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "package-review-route-"));
  try {
    const file = path.join(dir, "V11.mp4");
    await writeFile(file, "0123456789");
    const { handlers, calls } = make({ file: { path: file, bytes: 10, type: "video/mp4" } });
    const ranged = await handlers.video(req("GET", `?manifest=${MANIFEST}`, { range: "bytes=2-5" }), ctx("UC_active"));
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(ranged.headers.get("content-type"), "video/mp4");
    assert.equal(await ranged.text(), "2345");
    const whole = await handlers.video(req("GET", `?manifest=${MANIFEST}`), ctx("UC_active"));
    assert.equal(whole.status, 200);
    assert.equal(await whole.text(), "0123456789");
    assert.deepEqual(calls[0], ["media", "UC_active", MANIFEST, "video"]);
    const missing = make({ file: null });
    assert.equal((await missing.handlers.video(req("GET", `?manifest=${MANIFEST}`), ctx("UC_active"))).status, 404);
    assert.equal((await missing.handlers.thumbnail(req("GET", "?manifest=../../x"), ctx("UC_active"))).status, 404);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Fix (owner report 2026-11-24, WWE V31/V32 waited unseen): `GET /api/package-review-alerts` -- a session is required (401, nothing
// read); every connected channel is asked, the active one named, only channels with something waiting listed; one channel that cannot
// be read never hides the others (the storyboard alerts' rule).
test("package-review alerts: 401 without a session; per connected channel the waiting count, a failing channel skipped", async () => {
  const asked: string[] = [];
  const make = (session: { user: { id: string } } | null) =>
    createPackageReviewAlertsHandler({
      getSession: async () => session,
      activeChannelId: async () => "UC_wwe",
      connectedChannelIds: async () => ["UC_wwe", "UC_other", "UC_broken", "UC_quiet"],
      service: () => ({
        waiting: async (channelId) => {
          asked.push(channelId);
          if (channelId === "UC_broken") throw new Error("unreadable");
          return channelId === "UC_wwe" ? 2 : channelId === "UC_other" ? 1 : 0;
        },
      }),
    });
  assert.equal((await make(null)()).status, 401);
  assert.deepEqual(asked, []);
  const response = await make({ user: { id: "owner" } })();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    activeChannelId: "UC_wwe",
    channels: [
      { channelId: "UC_wwe", waiting: 2 },
      { channelId: "UC_other", waiting: 1 },
    ],
  });
  assert.deepEqual(asked.sort(), ["UC_broken", "UC_other", "UC_quiet", "UC_wwe"]);
});
