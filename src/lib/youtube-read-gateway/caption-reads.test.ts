import assert from "node:assert/strict";
import test from "node:test";
import type { youtube_v3 } from "googleapis";
import { downloadVideoCaption, getVideoCaptionContext, listVideoCaptions } from "./data-api";

// BL-269 (VIDEO_CAPTIONS_PLAN.md §2): the caption writer's reads, shaped by the YouTube Data API reference -- captions.list
// part=snippet (trackKind / status / isDraft / lastUpdated), captions.download (the original format when tfmt is omitted) and
// videos.list fileDetails.videoStreams (rotation swaps the frame).

test("listVideoCaptions: part snippet of the video; every track mapped, a track without id dropped", async () => {
  const calls: unknown[] = [];
  const youtube = {
    captions: {
      list: async (args: unknown) => (
        calls.push(args),
        {
          data: {
            items: [
              { id: "A", snippet: { language: "en", name: "", trackKind: "standard", isDraft: false, status: "serving", lastUpdated: "2026-11-17T10:00:00Z" } },
              { id: "B", snippet: { language: "en", trackKind: "asr", status: "failed", failureReason: "processingFailed" } },
              { snippet: { language: "de" } },
            ],
          },
        }
      ),
    },
  } as unknown as youtube_v3.Youtube;
  const tracks = await listVideoCaptions(youtube, "vid");
  assert.deepEqual(calls, [{ part: ["snippet"], videoId: "vid" }]);
  assert.deepEqual(tracks, [
    { id: "A", language: "en", name: "", trackKind: "standard", isDraft: false, status: "serving", failureReason: null, lastUpdated: "2026-11-17T10:00:00Z" },
    { id: "B", language: "en", name: null, trackKind: "asr", isDraft: null, status: "failed", failureReason: "processingFailed", lastUpdated: null },
  ]);
});

test("downloadVideoCaption: by id, no tfmt (the original format), bytes back whatever shape the client returns", async () => {
  const seen: unknown[] = [];
  const make = (data: unknown) =>
    ({ captions: { download: async (args: unknown, options: unknown) => (seen.push([args, options]), { data }) } }) as unknown as youtube_v3.Youtube;
  assert.equal((await downloadVideoCaption(make(new TextEncoder().encode("WEBVTT\n").buffer), "T1")).toString("utf8"), "WEBVTT\n");
  assert.equal((await downloadVideoCaption(make("1\n"), "T1")).toString("utf8"), "1\n");
  assert.deepEqual(seen[0], [{ id: "T1" }, { responseType: "arraybuffer" }]);
  await assert.rejects(downloadVideoCaption(make(null), "T1"), /no content/);
});

test("getVideoCaptionContext: channel and frame; a quarter rotation swaps it; no stream or no video is null", async () => {
  const make = (items: unknown[]) => ({ videos: { list: async () => ({ data: { items } }) } }) as unknown as youtube_v3.Youtube;
  assert.deepEqual(await getVideoCaptionContext(make([{ snippet: { channelId: "UC1" }, fileDetails: { videoStreams: [{ widthPixels: 1920, heightPixels: 1080, rotation: "none" }] } }]), "v"), {
    channelId: "UC1",
    frame: { width: 1920, height: 1080 },
  });
  assert.deepEqual((await getVideoCaptionContext(make([{ snippet: { channelId: "UC1" }, fileDetails: { videoStreams: [{ widthPixels: 1920, heightPixels: 1080, rotation: "clockwise" }] } }]), "v"))?.frame, {
    width: 1080,
    height: 1920,
  });
  assert.equal((await getVideoCaptionContext(make([{ snippet: { channelId: "UC1" } }]), "v"))?.frame, null);
  assert.equal(await getVideoCaptionContext(make([]), "v"), null);
});
