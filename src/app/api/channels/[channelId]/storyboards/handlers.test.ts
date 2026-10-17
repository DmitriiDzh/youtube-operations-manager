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
  { source: "gemini" as const, jobId: "gm_1", segmentId: "S1", versionNumber: 2, status: "done", createdAt: "2026-10-13T12:00:00.000Z", label: "gemini-omni-1.1-flash", error: null, device: null, localPath: "/ws/99 Data Exchange/From YTM/gemini/gm_1/video-1.mp4", exchangePath: null },
  { source: "media" as const, jobId: "job-1", segmentId: "S1", versionNumber: 2, status: "generating", createdAt: "2026-10-13T12:01:00.000Z", label: "ltx-flf · seed 7", error: null, device: null, localPath: null, exchangePath: null },
  // BL-189 (FO-REQ-0025 A): another computer's take of S2 -- made on the Mac, its file not in this computer's copy yet.
  { source: "media" as const, jobId: "mac-1", segmentId: "S2", versionNumber: 2, status: "done", createdAt: "2026-10-13T12:02:00.000Z", label: "h0004-ltx25-flf v3 · seed 8", error: null, device: { deviceId: "dev-mac", hostName: "Mac-mini" }, localPath: null, exchangePath: "From YTM/media/mac-1/ltx.mp4" },
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
    // BL-189: render "rn_here" has its file on this computer, "rn_away" does not.
    ownerRenderDecision: async (...args) => (calls.push(["renderDecide", ...args]), { decisionId: "rd_1", state: "approved" as const }),
    // BL-194: the owner's video picker.
    ownerSetVideo: async (...args) => (calls.push(["video", ...args]), { storyboard: { video: "V49" } as never }),
    renderFile: async (_channelId, _storyboardId, renderId) => {
      if (renderId === "rn_here") return { status: "ok" as const, path: VIDEO_FILE, bytes: 10, file: "Sent to YTM/bar/v3/loop.mp4" };
      if (renderId === "rn_away") return { status: "missing" as const, path: null, bytes: null, file: "Sent to YTM/bar/v3/loop.mp4" };
      throw new DomainError({ code: "storyboard_render_not_found", message: "No such final file" });
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
    isLoopback: (request) => request.headers.get("x-test-remote") === null,
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
    await handlers.setVideo(json("PUT", { videoNumber: "V49" }), ctx(other)),
  ]) {
    assert.notEqual(response.status, 200);
  }
  assert.deepEqual(calls, []);
});

test("BL-194: the video picker names the storyboard from the address and passes the body to the module", async () => {
  const { handlers, calls } = make();
  const response = await handlers.setVideo(json("PUT", { videoNumber: "V49" }), ctx({ channelId: "UC_active", storyboardId: "bar-loop" }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [["video", "UC_active", "bar-loop", { videoNumber: "V49" }]]);
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
  assert.deepEqual(list.takes.map((t: Record<string, unknown>) => [t.jobId, t.hasVideo, "localPath" in t]), [["gm_1", true, false], ["job-1", false, false], ["mac-1", false, false]]);
  // BL-189: another computer's take names that computer and never carries a path (neither this computer's nor the report's).
  assert.deepEqual(list.takes.map((t: Record<string, unknown>) => [t.device, "exchangePath" in t]), [[null, false], [null, false], [{ hostName: "Mac-mini" }, false]]);
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
  // BL-189 (FO-REQ-0025 §3 step 2): another computer's take is a take too -- of its own segment only.
  await handlers.pick(json("POST", { versionNumber: 2, segmentId: "S2", take: { source: "media", jobId: "mac-1" } }), ctx(base));
  await handlers.pick(json("POST", { versionNumber: 2, segmentId: "S1", take: { source: "media", jobId: "mac-1" } }), ctx(base));
  assert.deepEqual(calls.filter((c) => c[0] === "pick").map((c) => c[3]), [true, false, false, true, false]);
});

test("ADR 0029 decision 5: keyframe images and take videos are sent only to a request from this computer", async () => {
  const { handlers } = make();
  const remote = new Request("http://x/", { headers: { "x-test-remote": "1" } });
  assert.equal((await handlers.keyframe(remote, ctx({ channelId: "UC_active", storyboardId: "sb", version: "1", keyframeId: "K0" }))).status, 403);
  assert.equal((await handlers.takeVideo(remote, ctx({ channelId: "UC_active", storyboardId: "sb", source: "gemini", jobId: "gm_1" }))).status, 403);
});

test("BL-189 (FO-REQ-0025 B): a final file's status, the file with Range for this computer only, and the owner's verdict with the id from the address", async () => {
  await writeFile(VIDEO_FILE, "0123456789");
  const { handlers, calls } = make();
  const base = { channelId: "UC_active", storyboardId: "sb" };
  assert.deepEqual(await (await handlers.renderStatus(new Request("http://x/"), ctx({ ...base, renderId: "rn_here" }))).json(), { status: "ok" });
  assert.deepEqual(await (await handlers.renderStatus(new Request("http://x/"), ctx({ ...base, renderId: "rn_away" }))).json(), { status: "missing" });
  assert.equal((await handlers.renderStatus(new Request("http://x/"), ctx({ ...base, renderId: "rn_nope" }))).status, 404);
  const ranged = await handlers.renderVideo(new Request("http://x/", { headers: { range: "bytes=0-3" } }), ctx({ ...base, renderId: "rn_here" }));
  assert.deepEqual([ranged.status, ranged.headers.get("content-type"), await ranged.text()], [206, "video/mp4", "0123"]);
  assert.equal((await handlers.renderVideo(new Request("http://x/"), ctx({ ...base, renderId: "rn_away" }))).status, 404);
  assert.equal((await handlers.renderVideo(new Request("http://x/", { headers: { "x-test-remote": "1" } }), ctx({ ...base, renderId: "rn_here" }))).status, 403);
  await handlers.renderDecide(json("POST", { kind: "approved", renderId: "rn_other" }), ctx({ ...base, renderId: "rn_here" }));
  assert.deepEqual(calls.filter((c) => c[0] === "renderDecide"), [["renderDecide", "UC_active", "sb", "rn_here", { kind: "approved", renderId: "rn_other" }]]);
  // Another channel reaches nothing.
  assert.equal((await handlers.renderDecide(json("POST", { kind: "approved" }), ctx({ channelId: "UC_other", storyboardId: "sb", renderId: "rn_here" }))).status, 403);
});
