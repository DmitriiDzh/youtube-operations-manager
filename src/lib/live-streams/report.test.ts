import assert from "node:assert/strict";
import test from "node:test";
import { deriveStreamState, streamReportEntry, type StreamReportInput } from "./report";

// BL-176 (LIVE_STREAMS_PLAN.md §3.10 states; §3.11 and §4.1 "Report": no field can hold a URL or a key).

const NOW = Date.parse("2026-10-12T12:00:00Z");
const KEY = "k3y-TEST-0000";
const base: StreamReportInput = {
  channelId: "UC1",
  intent: "on",
  onSince: Date.parse("2026-10-12T10:00:00Z"),
  helper: { state: "running", updatedAt: NOW - 5000, position: { index: 1, videoId: "BBBBBBBBBB2" }, lastExit: { at: Date.parse("2026-10-12T11:00:00Z"), cause: "encoder_exit" }, missingVideoId: null },
  rotationSize: 3,
  youtube: { lifeCycleStatus: "live", streamStatus: "active", healthStatus: "good", issueTypes: ["bitrateLow"], viewers: 12 },
  lastEndOrStart: "encoder_start",
};

test("states: off, ended by YouTube, starting (no helper / stale / stopped), live, replaying, no video, reconnecting", () => {
  assert.equal(deriveStreamState({ ...base, intent: "off" }, NOW), "off");
  assert.equal(deriveStreamState({ ...base, intent: "off", lastEndOrStart: "youtube_ended" }, NOW), "ended_by_youtube");
  assert.equal(deriveStreamState({ ...base, helper: null }, NOW), "starting");
  assert.equal(deriveStreamState({ ...base, helper: { ...base.helper!, updatedAt: NOW - 3 * 60_000 } }, NOW), "starting");
  assert.equal(deriveStreamState(base, NOW), "live");
  assert.equal(deriveStreamState({ ...base, helper: { ...base.helper!, state: "replaying" } }, NOW), "replaying");
  assert.equal(deriveStreamState({ ...base, helper: { ...base.helper!, state: "waiting_for_source" } }, NOW), "no_source");
  assert.equal(deriveStreamState({ ...base, helper: { ...base.helper!, state: "restarting" } }, NOW), "reconnecting");
});

test("entry: what plays (N of M), health issue types, the last interruption and viewers", () => {
  assert.deepEqual(streamReportEntry(base, NOW), {
    channelId: "UC1",
    state: "live",
    since: "2026-10-12T10:00:00.000Z",
    playing: { index: 1, total: 3, videoId: "BBBBBBBBBB2" },
    health: { lifeCycleStatus: "live", streamStatus: "active", healthStatus: "good", issueTypes: ["bitrateLow"] },
    lastInterruption: { at: "2026-10-12T11:00:00.000Z", cause: "encoder_exit" },
    viewers: 12,
  });
});

test("no field can carry a URL or a key: anything outside the fixed shapes is dropped", () => {
  const entry = streamReportEntry(
    {
      ...base,
      helper: { ...base.helper!, position: { index: 0, videoId: `rtmps://a.rtmps.youtube.com/live2/${KEY}` }, lastExit: { at: NOW, cause: `Error opening rtmps://x/${KEY}` } },
      youtube: { lifeCycleStatus: `live ${KEY}`, streamStatus: "rtmps://x", healthStatus: "good", issueTypes: [`https://x/${KEY}`, "gopSizeLong"], viewers: 3 },
    },
    NOW
  );
  const text = JSON.stringify(entry);
  assert.equal(text.includes(KEY), false);
  assert.equal(/rtmps?:\/\/|https?:\/\//.test(text), false);
  assert.deepEqual([entry.playing, entry.lastInterruption, entry.health?.lifeCycleStatus, entry.health?.issueTypes], [null, null, null, ["gopSizeLong"]]);
});

test("an off stream reports no position, health or viewers", () => {
  const entry = streamReportEntry({ ...base, intent: "off" }, NOW);
  assert.deepEqual([entry.state, entry.since, entry.playing, entry.health, entry.viewers], ["off", null, null, null, null]);
});
