import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveSegments,
  DAILY_SWITCH_CAP,
  GO_LIVE_TIMEOUT_MS,
  PLAYLIST_MAX_ATTEMPTS,
  PLAYLIST_RETRY_MS,
  readSegmentSettings,
  SWITCH_RETRY_MS,
  switchDueAt,
  type SegmentSettings,
  type SegmentsDependencies,
} from "./segments";

// BL-205 acceptance (docs/roadmap/plans/LIVE_SEGMENTS_PLAN.md §3, AC-SEG-01..10). Expected values come from the plan and spike D:
// the new segment is made live first, the stream row then names it, and only then is the old one completed; a switch that fails
// never ends the old segment.

const H = 3_600_000;
const START = Date.UTC(2026, 9, 19, 0, 0, 0); // 00:00 UTC
const ON: SegmentSettings = { v: 1, enabled: true, lengthMinutes: 660, switchHourUtc: null, recordingsPlaylist: null };

type Life = { lifeCycleStatus: string | null; actualStartTime: string | null; actualEndTime: string | null };

function harness(opts: {
  settings?: SegmentSettings | null;
  now?: number;
  intent?: "on" | "off";
  marker?: { startedAt: number; fromBroadcastId: string; newBroadcastId: string | null } | null;
  rowBroadcast?: string;
  lifecycles?: Record<string, Life>;
  insertFails?: boolean;
  bindFails?: boolean;
  neverLive?: boolean;
  authFails?: boolean;
  switchesToday?: number;
  stopDuringSwitch?: boolean;
  addRefusals?: number;
  segments?: Array<{ id: string; broadcastId: string; startedAt: Date; endedAt: Date | null; playlistStatus: "none" | "pending" | "added" | "failed"; playlistAttempts: number }>;
} = {}) {
  let now = opts.now ?? START + 11 * H;
  const calls: string[] = [];
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let stream = {
    channelId: "UC1",
    intent: opts.intent ?? ("on" as "on" | "off"),
    streamId: "STREAM1",
    broadcastId: opts.rowBroadcast ?? "OLD",
    onSince: new Date(START),
    title: "Tropico Jazz Radio",
    description: "24/7",
    privacyStatus: "unlisted" as const,
    madeForKids: false,
    segmentsJson: opts.settings === null ? null : JSON.stringify(opts.settings ?? ON),
    segmentSwitchingJson: opts.marker ? JSON.stringify(opts.marker) : (null as string | null),
  };
  const lifecycles: Record<string, Life> = { OLD: { lifeCycleStatus: "live", actualStartTime: new Date(START).toISOString(), actualEndTime: null }, ...(opts.lifecycles ?? {}) };
  const segments = [...(opts.segments ?? [{ id: "S-OLD", broadcastId: "OLD", startedAt: new Date(START), endedAt: null, playlistStatus: "none" as const, playlistAttempts: 0 }])];
  const segmentUpdates: Array<{ id: string; set: Record<string, unknown> }> = [];
  let addRefusals = opts.addRefusals ?? 0;
  const applied: string[] = [];
  let ids = 0;
  const deps: SegmentsDependencies = {
    streams: {
      get: async () => stream,
      update: async (_c, set) => {
        if ("broadcastId" in set) calls.push(`row.broadcastId=${String(set.broadcastId)}`);
        stream = { ...stream, ...(set as object) };
      },
      event: async (_c, kind, detail) => void events.push({ kind, detail }),
      countEventsSince: async () => opts.switchesToday ?? 0,
    },
    segments: {
      insert: async (row) => void segments.push({ ...row, endedAt: null }),
      update: async (id, set) => {
        segmentUpdates.push({ id, set });
        const s = segments.find((x) => x.id === id);
        if (s) Object.assign(s, set);
      },
      open: async () => segments.filter((s) => s.endedAt === null || s.playlistStatus === "pending"),
    },
    broadcastSettings: async () => ({ latencyPreference: "low", enableDvr: true, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" }),
    authorize: async () => {
      calls.push("authorize");
      if (opts.authFails) throw new Error("Live writes are off");
      return { credentialRef: { userId: "u-tropico" }, credentials: { accessToken: "t" } as never };
    },
    youtube: {
      insertBroadcast: async (_c, args) => {
        calls.push(`insert(recordFromStart=${args.recordFromStart},autoStart=${args.enableAutoStart},latency=${args.latencyPreference})`);
        if (opts.insertFails) throw new Error("insufficientLivePermissions");
        lifecycles.NEW = { lifeCycleStatus: "ready", actualStartTime: null, actualEndTime: null };
        return { broadcastId: "NEW" };
      },
      bind: async (_c, args) => {
        calls.push(`bind(${args.broadcastId}->${args.streamId})`);
        if (opts.bindFails) throw new Error("liveStreamNotFound");
      },
      transition: async (_c, args) => {
        calls.push(`transition(${args.broadcastId}->${args.broadcastStatus})`);
        const life = lifecycles[args.broadcastId];
        if (!life) throw new Error("liveBroadcastNotFound");
        if (args.broadcastStatus === "live" && !opts.neverLive) {
          if (opts.stopDuringSwitch) stream = { ...stream, intent: "off" };
          lifecycles[args.broadcastId] = { lifeCycleStatus: "live", actualStartTime: new Date(now).toISOString(), actualEndTime: null };
        }
        if (args.broadcastStatus === "complete") lifecycles[args.broadcastId] = { ...life, lifeCycleStatus: "complete", actualEndTime: new Date(now).toISOString() };
      },
      lifecycles: async (_c, idsAsked) => Object.fromEntries(idsAsked.filter((id) => lifecycles[id]).map((id) => [id, lifecycles[id]!])),
      deleteVideo: async (_c, id) => {
        calls.push(`delete(${id})`);
        delete lifecycles[id];
      },
    },
    applyVideoSettings: ({ broadcastId }) => void applied.push(broadcastId),
    addToPlaylist: async ({ playlistId, videoId }) => {
      calls.push(`playlistItems.insert(${videoId}->${playlistId})`);
      if (addRefusals > 0) {
        addRefusals -= 1;
        return { added: false, reason: "processing" };
      }
      return { added: true };
    },
    playedVideos: async () => ["V1", "V2"],
    newId: () => `S-${++ids}`,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  return {
    segments: createLiveSegments(deps),
    calls,
    events,
    stream: () => stream,
    lifecycles,
    rows: segments,
    segmentUpdates,
    applied,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const WRITES = (calls: string[]) => calls.filter((c) => c !== "authorize");

test("AC-SEG-01: not due -- under the length, segments off, the stream off, or no settings: no call at all", async () => {
  for (const h of [
    harness({ now: START + 10 * H }),
    harness({ settings: { ...ON, enabled: false } }),
    harness({ intent: "off" }),
    harness({ settings: null }),
  ]) {
    await h.segments.tick("UC1");
    assert.deepEqual(h.calls, []);
  }
});

test("AC-SEG-01: the quiet hour moves a switch due within 2 h to that hour, never past 705 min", () => {
  // 11 h segment from 00:00 is due at 11:00; a 10:00 quiet hour is within 2 h -> 10:00.
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 10 }, START), START + 10 * H);
  // 12:30 would make it 12.5 h (> 705 min): the segment keeps its own 11:00.
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 12 }, START), START + 11 * H);
  // 11 h 45 min (705) is the most: a quiet hour at 11:00 for a 10 h segment is fine (within 2 h, under 705 min).
  assert.equal(switchDueAt({ ...ON, lengthMinutes: 600, switchHourUtc: 11 }, START), START + 11 * H);
  // No quiet hour within 2 h: the own length.
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 4 }, START), START + 11 * H);
});

test("AC-SEG-02: the happy path in order -- insert (recording on, auto-start off, the saved broadcast settings), bind to the same stream, new live, row -> new, THEN old complete", async () => {
  const h = harness();
  await h.segments.tick("UC1");
  assert.deepEqual(WRITES(h.calls), [
    "insert(recordFromStart=true,autoStart=false,latency=low)",
    "bind(NEW->STREAM1)",
    "transition(NEW->live)",
    "row.broadcastId=NEW",
    "transition(OLD->complete)",
  ]);
  assert.equal(h.stream().broadcastId, "NEW");
  assert.equal(h.stream().segmentSwitchingJson, null, "the marker is cleared");
  const old = h.rows.find((r) => r.broadcastId === "OLD")!;
  assert.ok(old.endedAt, "the old segment has its end");
  assert.ok(h.rows.find((r) => r.broadcastId === "NEW" && r.endedAt === null), "the new segment has a row");
  assert.deepEqual(h.applied, ["NEW"], "the video settings follow for the new segment");
  const switched = h.events.find((e) => e.kind === "live_segment_switched")!.detail;
  assert.equal(switched.from, "OLD");
  assert.equal(switched.to, "NEW");
  assert.equal(switched.oldEnded, true);
});

test("AC-SEG-03: the new segment never goes live in 5 min -- the old one is never ended, the row keeps it, the new one is deleted, retry not before 30 min", async () => {
  const h = harness({ neverLive: true });
  await h.segments.tick("UC1");
  assert.ok(!h.calls.includes("transition(OLD->complete)"), "the old segment is never ended");
  assert.equal(h.stream().broadcastId, "OLD");
  assert.ok(h.calls.includes("delete(NEW)"));
  const failed = h.events.find((e) => e.kind === "live_segment_switch_failed")!.detail;
  assert.equal(failed.stage, "go_live");
  assert.equal(failed.newDeleted, true);
  assert.ok(h.calls.filter((c) => c === "transition(NEW->live)").length > 1, "it kept trying for the 5 minutes");

  h.calls.length = 0;
  h.advance(SWITCH_RETRY_MS - 60_000);
  await h.segments.tick("UC1");
  assert.deepEqual(WRITES(h.calls), [], "no new attempt before 30 min");
  h.advance(2 * 60_000);
  await h.segments.tick("UC1");
  assert.ok(WRITES(h.calls).length > 0, "tried again after 30 min");
  assert.ok(GO_LIVE_TIMEOUT_MS === 5 * 60_000);
});

test("AC-SEG-04: an insert refusal -- nothing to delete; a bind refusal -- the new one is deleted; the old one stays either way", async () => {
  const insert = harness({ insertFails: true });
  await insert.segments.tick("UC1");
  assert.ok(!insert.calls.some((c) => c.startsWith("delete")));
  assert.equal(insert.events.find((e) => e.kind === "live_segment_switch_failed")!.detail.stage, "insert");
  assert.equal(insert.stream().broadcastId, "OLD");

  const bind = harness({ bindFails: true });
  await bind.segments.tick("UC1");
  assert.ok(bind.calls.includes("delete(NEW)"));
  assert.ok(!bind.calls.includes("transition(OLD->complete)"));
  assert.equal(bind.events.find((e) => e.kind === "live_segment_switch_failed")!.detail.stage, "bind");
});

test("AC-SEG-05: Live writes off or a wrong channel -- no YouTube call; reported once, not every tick", async () => {
  const h = harness({ authFails: true });
  await h.segments.tick("UC1");
  await h.segments.tick("UC1");
  assert.deepEqual(WRITES(h.calls), []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_failed").length, 1);
});

test("AC-SEG-06: segments switched off while live -- nothing is ended, no write", async () => {
  const h = harness({ settings: { ...ON, enabled: false } });
  await h.segments.tick("UC1");
  assert.deepEqual(h.calls, []);
  assert.equal(h.stream().broadcastId, "OLD");
});

test("AC-SEG-06b: the owner stops the stream during the switch -- the new segment is ended too and nothing is handed over", async () => {
  const h = harness({ stopDuringSwitch: true });
  await h.segments.tick("UC1");
  assert.ok(h.calls.includes("transition(NEW->complete)"));
  assert.ok(!h.calls.includes("transition(OLD->complete)"));
  assert.equal(h.stream().broadcastId, "OLD");
});

test("AC-SEG-08: the recording goes into the playlist after the switch, retried every 10 min, given up after 2 h; nothing without a playlist", async () => {
  const playlist = { ...ON, recordingsPlaylist: { id: "PLREC", title: "Записи" } };
  const h = harness({ settings: playlist, addRefusals: 1 });
  await h.segments.tick("UC1"); // the switch; OLD becomes pending
  assert.equal(h.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "pending");
  h.advance(1000);
  await h.segments.tick("UC1"); // first attempt: refused
  assert.ok(h.calls.includes("playlistItems.insert(OLD->PLREC)"));
  h.calls.length = 0;
  await h.segments.tick("UC1"); // within 10 min: no attempt
  assert.ok(!h.calls.some((c) => c.startsWith("playlistItems")));
  h.advance(PLAYLIST_RETRY_MS);
  await h.segments.tick("UC1"); // second attempt: added
  assert.equal(h.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "added");

  const giveUp = harness({ settings: playlist, addRefusals: 100 });
  await giveUp.segments.tick("UC1");
  for (let i = 0; i < PLAYLIST_MAX_ATTEMPTS + 2; i++) {
    giveUp.advance(PLAYLIST_RETRY_MS);
    await giveUp.segments.tick("UC1");
  }
  assert.equal(giveUp.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "failed");
  assert.equal(giveUp.calls.filter((c) => c.startsWith("playlistItems")).length, PLAYLIST_MAX_ATTEMPTS);

  const none = harness();
  await none.segments.tick("UC1");
  assert.equal(none.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "none");
});

test("AC-SEG-09: recovery from a marker left mid-switch leaves exactly one live broadcast", async () => {
  const live = (start: number): Life => ({ lifeCycleStatus: "live", actualStartTime: new Date(start).toISOString(), actualEndTime: null });
  // New live and the row names it: the old one is completed.
  const a = harness({ marker: { startedAt: START, fromBroadcastId: "OLD", newBroadcastId: "NEW" }, rowBroadcast: "NEW", lifecycles: { NEW: live(START) } });
  await a.segments.tick("UC1");
  assert.deepEqual(WRITES(a.calls), ["transition(OLD->complete)"]);
  // New live, the row still names the old one: the new one is completed.
  const b = harness({ marker: { startedAt: START, fromBroadcastId: "OLD", newBroadcastId: "NEW" }, lifecycles: { NEW: live(START) } });
  await b.segments.tick("UC1");
  assert.deepEqual(WRITES(b.calls), ["transition(NEW->complete)"]);
  // New only ready: deleted.
  const c = harness({ marker: { startedAt: START, fromBroadcastId: "OLD", newBroadcastId: "NEW" }, lifecycles: { NEW: { lifeCycleStatus: "ready", actualStartTime: null, actualEndTime: null } } });
  await c.segments.tick("UC1");
  assert.deepEqual(WRITES(c.calls), ["delete(NEW)"]);
  // No new id yet: the marker is cleared, nothing else.
  const d = harness({ marker: { startedAt: START, fromBroadcastId: "OLD", newBroadcastId: null } });
  await d.segments.tick("UC1");
  assert.deepEqual(d.calls, []);
  for (const h of [a, b, c, d]) assert.equal(h.stream().segmentSwitchingJson, null);
});

test("AC-SEG-10: the daily cap of 6 (switches and failures together) stops further switches that UTC day", async () => {
  const h = harness({ switchesToday: DAILY_SWITCH_CAP });
  await h.segments.tick("UC1");
  await h.segments.tick("UC1");
  assert.deepEqual(WRITES(h.calls), []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_cap_reached").length, 1);
  const under = harness({ switchesToday: DAILY_SWITCH_CAP - 1 });
  await under.segments.tick("UC1");
  assert.ok(under.calls.includes("transition(OLD->complete)"));
});

test("AC-SEG-12: stored settings that do not pass the schema read as off (never a switch on a guess)", () => {
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, lengthMinutes: 800 })).enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, lengthMinutes: 10 })).enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, switchHourUtc: 24 })).enabled, false);
  assert.equal(readSegmentSettings("{").enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify(ON)).enabled, true);
});
