import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DomainError } from "@/lib/shared-domain";
import { createStoryboardRouteHandlers, type StoryboardRouteDeps } from "./handlers";

// BL-184 stage 1: the owner's storyboard routes need a Web session and the ACTIVE channel (AGENTS.md §F) -- another channel reaches
// nothing; the module's refusals keep their codes and statuses; a keyframe image is served with its type, or 404 when this
// computer has no copy, or 415 when it is not an image.

const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const json = (method: string, body: unknown) => new Request("http://x/", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// BL-184 stage 3: two takes of S1 in v2 -- a Gemini one with its video here, a GPU one still generating.
const VIDEO_FILE = path.join(tmpdir(), `storyboard-take-${process.pid}.mp4`);
const TAKES = [
  { source: "gemini" as const, jobId: "gm_1", segmentId: "S1", versionNumber: 2, status: "done", createdAt: "2026-10-13T12:00:00.000Z", label: "gemini-omni-1.1-flash", error: null, localPath: "/ws/99 Data Exchange/From YTM/gemini/gm_1/video-1.mp4" },
  { source: "media" as const, jobId: "job-1", segmentId: "S1", versionNumber: 2, status: "generating", createdAt: "2026-10-13T12:01:00.000Z", label: "ltx-flf · seed 7", error: null, localPath: null },
];

function make(options: { session?: { user: { id: string } } | null; refuse?: DomainError } = {}) {
  const calls: unknown[][] = [];
  const service: ReturnType<StoryboardRouteDeps["service"]> = {
    listForOwner: async (...args) => (calls.push(["list", ...args]), []),
    getForOwner: async (...args) => (calls.push(["get", ...args]), { latestVersion: 2 } as never),
    keyframeFiles: async (...args) => (calls.push(["files", ...args]), { K0: "ok" }),
    versionDiff: async (...args) => (calls.push(["diff", ...args]), null),
    keyframeFile: async (_c, _s, _v, keyframeId) => (keyframeId === "K0" ? { path: "/ws/K0.jpg", bytes: 3, file: "Sent to YTM/bar/K0.jpg" } : keyframeId === "TXT" ? { path: "/ws/a.txt", bytes: 1, file: "Sent to YTM/a.txt" } : null),
    ownerComment: async (...args) => {
      calls.push(["comment", ...args]);
      if (options.refuse) throw options.refuse;
      return { commentId: "c_1" };
    },
    ownerReply: async (...args) => (calls.push(["reply", ...args]), { replyId: "r_1" }),
    ownerSetCommentState: async (...args) => void calls.push(["state", ...args]),
    gateSetting: async (...args) => (calls.push(["gate", ...args]), { requireApproved: true, changedAt: null, changedBy: null }),
    setGateSetting: async (...args) => (calls.push(["setGate", ...args]), { requireApproved: false, changedAt: "2026-10-13T12:00:00.000Z", changedBy: "Mac" }),
    ownerPick: async (channelId, storyboardId, input, isTake) => {
      const { take, versionNumber, segmentId } = input as { take: { source: "media" | "gemini"; jobId: string }; versionNumber: number; segmentId: string };
      calls.push(["pick", channelId, storyboardId, await isTake(take, versionNumber, segmentId)]);
      return { picks: {} };
    },
    ownerDecide: async (...args) => {
      calls.push(["decide", ...args]);
      if (options.refuse) throw options.refuse;
      return { decisionId: "d_1", state: "approved" as const };
    },
  };
  const handlers = createStoryboardRouteHandlers({
    getSession: async () => (options.session === undefined ? { user: { id: "owner" } } : options.session),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
    },
    service: () => service,
    readFile: async () => new Uint8Array([1, 2, 3]),
    takes: async () => TAKES,
    takeFile: async (_channelId, take) => (take.localPath ? { path: VIDEO_FILE, bytes: 10 } : null),
  });
  return { handlers, calls };
}

test("a session and the active channel are required; another channel reaches nothing", async () => {
  const anonymous = make({ session: null });
  assert.equal((await anonymous.handlers.list(new Request("http://x/"), ctx({ channelId: "UC_active" }))).status, 401);
  const { handlers, calls } = make();
  const other = { channelId: "UC_other", storyboardId: "sb", commentId: "c", version: "1", keyframeId: "K0" };
  for (const response of [
    await handlers.list(new Request("http://x/"), ctx(other)),
    await handlers.detail(new Request("http://x/"), ctx(other)),
    await handlers.comment(json("POST", { versionNumber: 1, target: { kind: "storyboard" }, text: "x" }), ctx(other)),
    await handlers.reply(json("POST", { text: "x" }), ctx(other)),
    await handlers.setState(json("PATCH", { state: "resolved" }), ctx(other)),
    await handlers.decide(json("POST", { kind: "approved", versionNumber: 1 }), ctx(other)),
    await handlers.keyframe(new Request("http://x/"), ctx(other)),
    await handlers.gate(new Request("http://x/"), ctx(other)),
    await handlers.takes(new Request("http://x/"), ctx(other)),
    await handlers.takeVideo(new Request("http://x/"), ctx({ ...other, source: "gemini", jobId: "gm_1" })),
    await handlers.pick(json("POST", { versionNumber: 2, segmentId: "S1", take: { source: "gemini", jobId: "gm_1" } }), ctx(other)),
    await handlers.setGate(json("PUT", { requireApproved: false }), ctx(other)),
  ]) {
    assert.notEqual(response.status, 200);
  }
  assert.deepEqual(calls, []);
});

test("detail: the latest version by default, ?version=N otherwise, a malformed one is a 400", async () => {
  const { handlers, calls } = make();
  const base = { channelId: "UC_active", storyboardId: "sb" };
  const latest = await handlers.detail(new Request("http://x/"), ctx(base));
  assert.equal(latest.status, 200);
  assert.deepEqual(await latest.json(), { storyboard: { latestVersion: 2 }, version: 2, files: { K0: "ok" }, diff: null });
  assert.equal((await (await handlers.detail(new Request("http://x/?version=1"), ctx(base))).json()).version, 1);
  assert.equal((await handlers.detail(new Request("http://x/?version=abc"), ctx(base))).status, 400);
  assert.deepEqual(
    calls.filter((c) => c[0] === "files").map((c) => c[3]),
    [2, 1]
  );
});

test("the comment's id comes from the address, never from the body; a refusal keeps its code and status", async () => {
  const { handlers, calls } = make({ refuse: new DomainError({ code: "storyboard_version_not_latest", message: "reload" }) });
  const base = { channelId: "UC_active", storyboardId: "sb", commentId: "c_path" };
  assert.equal((await handlers.reply(json("POST", { text: "ok", commentId: "c_body" }), ctx(base))).status, 200);
  assert.equal((await handlers.setState(json("PATCH", { state: "resolved", commentId: "c_body" }), ctx(base))).status, 200);
  assert.deepEqual(calls.map((c) => [c[0], (c[3] as { commentId: string }).commentId]), [["reply", "c_path"], ["state", "c_path"]]);
  const refused = await handlers.decide(json("POST", { kind: "approved", versionNumber: 1 }), ctx(base));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "storyboard_version_not_latest");
});

test("keyframe image: served with its type and no caching; 404 without a copy here; 415 for a non-image; 400 for a bad version", async () => {
  const { handlers } = make();
  const at = (keyframeId: string, version = "1") => ctx({ channelId: "UC_active", storyboardId: "sb", version, keyframeId });
  const image = await handlers.keyframe(new Request("http://x/"), at("K0"));
  assert.equal(image.status, 200);
  assert.deepEqual([image.headers.get("content-type"), image.headers.get("cache-control")], ["image/jpeg", "no-store"]);
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [1, 2, 3]);
  assert.equal((await handlers.keyframe(new Request("http://x/"), at("K9"))).status, 404);
  assert.equal((await handlers.keyframe(new Request("http://x/"), at("TXT"))).status, 415);
  assert.equal((await handlers.keyframe(new Request("http://x/"), at("K0", "0"))).status, 400);
});

test("BL-184 stage 2: the gate setting is read and changed for the active channel only, the body passed on as given", async () => {
  const { handlers, calls } = make();
  const base = { channelId: "UC_active" };
  assert.deepEqual(await (await handlers.gate(new Request("http://x/"), ctx(base))).json(), { requireApproved: true, changedAt: null, changedBy: null });
  assert.equal((await handlers.setGate(json("PUT", { requireApproved: false }), ctx(base))).status, 200);
  assert.deepEqual(calls, [["gate", "UC_active"], ["setGate", "UC_active", { requireApproved: false }]]);
});

test("BL-184 stage 3 (B5): takes list without file paths; a take's video with Range; 404 for a job that is not a take or has no video here", async () => {
  await writeFile(VIDEO_FILE, "0123456789");
  const { handlers } = make();
  const base = { channelId: "UC_active", storyboardId: "sb" };
  const list = await (await handlers.takes(new Request("http://x/"), ctx(base))).json();
  assert.deepEqual(list.takes.map((t: Record<string, unknown>) => [t.jobId, t.hasVideo, "localPath" in t]), [["gm_1", true, false], ["job-1", false, false]]);
  const ranged = await handlers.takeVideo(new Request("http://x/", { headers: { range: "bytes=2-5" } }), ctx({ ...base, source: "gemini", jobId: "gm_1" }));
  assert.deepEqual([ranged.status, ranged.headers.get("content-type"), ranged.headers.get("content-range"), await ranged.text()], [206, "video/mp4", "bytes 2-5/10", "2345"]);
  assert.equal((await handlers.takeVideo(new Request("http://x/"), ctx({ ...base, source: "media", jobId: "job-1" }))).status, 404, "no video yet");
  assert.equal((await handlers.takeVideo(new Request("http://x/"), ctx({ ...base, source: "media", jobId: "gm_1" }))).status, 404, "not a take");
});

test("BL-184 stage 3 (B5): a pick is checked against the storyboard's own takes (segment and version included)", async () => {
  const { handlers, calls } = make();
  const base = { channelId: "UC_active", storyboardId: "sb" };
  await handlers.pick(json("POST", { versionNumber: 2, segmentId: "S1", take: { source: "gemini", jobId: "gm_1" } }), ctx(base));
  await handlers.pick(json("POST", { versionNumber: 2, segmentId: "S2", take: { source: "gemini", jobId: "gm_1" } }), ctx(base));
  await handlers.pick(json("POST", { versionNumber: 1, segmentId: "S1", take: { source: "gemini", jobId: "gm_1" } }), ctx(base));
  assert.deepEqual(calls.filter((c) => c[0] === "pick").map((c) => c[3]), [true, false, false]);
});
