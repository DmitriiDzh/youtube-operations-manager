import assert from "node:assert/strict";
import test from "node:test";
import { createRotationPicker, type PickerDependencies } from "./picker-service";

// BL-187 (LIVE_STREAMS_FIELDS_PLAN.md §2.4, §4.1 "Picker matching"): the dialog's list is read-only; a channel with no
// workspace, or a workspace that is not reachable now (the T9 unmounted), gives a plain status and nothing to check; only
// the files the dialog shows are probed; a file the workspace rule refuses is left out.

const V56 = "04 Videos/10 October/1010 V56/V56 Tropico Jazz.mp4";
const CLIP = "04 Videos/10 October/1010 V56/Runway clip.mov";

function deps(over: Partial<PickerDependencies> = {}, probed: string[] = []): PickerDependencies {
  return {
    workspace: async () => ({ configured: true, path: "/ws" }),
    validateWorkspace: async () => ({ ok: true }),
    listVideoFiles: async () => [V56, CLIP],
    async describe(_root, relativePath) {
      probed.push(relativePath);
      return { bytes: 10, durationSeconds: 7200 };
    },
    readUploadRecord: async (_root, relativePath) => (relativePath === "04 Videos/10 October/1010 V56/V56_youtube.json" ? "VIDEO0000V5" : null),
    readRegistry: async () => null,
    channelVideos: async () => [
      {
        videoId: "VIDEO0000V5",
        title: "V56",
        privacyStatus: "public",
        publishAt: null,
        publishedAt: "2026-10-10T15:00:00Z",
        durationSeconds: 7200,
        thumbnailUrl: null,
      },
    ],
    rotation: async () => [],
    sources: async () => [],
    clock: () => new Date("2026-10-14T12:00:00Z"),
    ...over,
  };
}

test("no workspace set for the channel: a plain status, nothing is read", async () => {
  let listed = false;
  const result = await createRotationPicker(
    deps({ workspace: async () => ({ configured: false }), listVideoFiles: async () => ((listed = true), []) }),
  ).listCandidates("UC1", { showAll: false });
  assert.deepEqual(result, { status: "no_workspace" });
  assert.equal(listed, false);
});

test("a workspace that is not reachable now gives its reason, nothing is read", async () => {
  let listed = false;
  const result = await createRotationPicker(
    deps({ validateWorkspace: async () => ({ ok: false, reason: "The folder does not exist" }), listVideoFiles: async () => ((listed = true), []) }),
  ).listCandidates("UC1", { showAll: false });
  assert.deepEqual(result, { status: "workspace_unavailable", reason: "The folder does not exist" });
  assert.equal(listed, false);
});

test("the release file is matched by its Vn_youtube.json; only the shown file is probed", async () => {
  const probed: string[] = [];
  const result = await createRotationPicker(deps({}, probed)).listCandidates("UC1", { showAll: false });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(probed, [V56]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].match?.videoId, "VIDEO0000V5");
  assert.equal(result.rows[0].match?.source, "upload_record");
  assert.equal(result.rows[0].state, "available");
  assert.equal(result.filesFound, 2);
});

test("with «show all files» the clip is probed and listed too; a file the workspace rule refuses is left out", async () => {
  const probed: string[] = [];
  const result = await createRotationPicker(
    deps({ describe: async (_r, p) => (probed.push(p), p === CLIP ? null : { bytes: 1, durationSeconds: 7200 }) }),
  ).listCandidates("UC1", { showAll: true });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(probed.sort(), [CLIP, V56].sort());
  assert.deepEqual(
    result.rows.map((r) => r.file),
    [V56],
  );
});

test("ffprobe missing is reported; durations stay unknown", async () => {
  const result = await createRotationPicker(deps({ describe: async () => ({ bytes: 1, durationSeconds: "no_ffprobe" }) })).listCandidates("UC1", {
    showAll: false,
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.ffprobeMissing, true);
  assert.equal(result.rows[0].durationSeconds, null);
});
