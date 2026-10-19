import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveSegments,
  DAILY_SWITCH_CAP,
  GO_LIVE_TIMEOUT_MS,
  HANDOVER_ALERT_ATTEMPTS,
  PLAYLIST_MAX_ATTEMPTS,
  PLAYLIST_RETRY_MS,
  readSegmentSettings,
  STEP_RETRY_MS,
  SWITCH_RETRY_MS,
  switchDueAt,
  type SegmentSettings,
  type SegmentsDependencies,
  type SwitchMarker,
} from "./segments";

// BL-205 acceptance (docs/roadmap/plans/LIVE_SEGMENTS_PLAN.md §3, AC-SEG-01..13; independent review 2026-10-19). Expected values
// come from the plan and spike D: the new segment is made live first, the stream row then names it, and only then is the old one
// ended -- and the old one is ended until YouTube says it ended. A switch that fails never ends the old segment. Each tick makes one
// short step (the runner ticks every 15 s); a crash resumes from the persisted marker.

const H = 3_600_000;
const TICK = 15_000;
const START = Date.UTC(2026, 9, 19, 0, 0, 0); // 00:00 UTC
const ON: SegmentSettings = { v: 1, enabled: true, lengthMinutes: 660, switchHourUtc: null, recordingsPlaylist: null };

type Life = { lifeCycleStatus: string | null; actualStartTime: string | null; actualEndTime: string | null; recordFromStart?: boolean | null };
type Row = { id: string; broadcastId: string; startedAt: Date; endedAt: Date | null; recorded: boolean; playlistStatus: "none" | "pending" | "added" | "failed"; playlistAttempts: number };

function harness(opts: {
  settings?: SegmentSettings | null;
  now?: number;
  intent?: "on" | "off";
  marker?: SwitchMarker | null;
  rowBroadcast?: string;
  lifecycles?: Record<string, Life>;
  insertFails?: boolean;
  bindFails?: boolean;
  /** The new broadcast never leaves `ready`. */
  neverLive?: boolean;
  /** Ending the old segment is refused this many times. */
  completeOldRefusals?: number;
  deleteRefusals?: number;
  authFails?: boolean;
  switchesToday?: number;
  addRefusals?: number;
  oldRecorded?: boolean;
  rows?: Row[];
} = {}) {
  let now = opts.now ?? START + 11 * H;
  const calls: string[] = [];
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let stream = {
    channelId: "UC1",
    intent: opts.intent ?? ("on" as "on" | "off"),
    streamId: "STREAM1",
    broadcastId: opts.rowBroadcast ?? "OLD",
    onSince: new Date(START - 5 * 86_400_000), // started days ago: a segment is timed from YouTube's own start
    title: "Tropico Jazz Radio",
    description: "24/7",
    privacyStatus: "public" as const,
    madeForKids: false,
    segmentsJson: opts.settings === null ? null : JSON.stringify(opts.settings ?? ON),
    segmentSwitchingJson: opts.marker ? JSON.stringify(opts.marker) : (null as string | null),
  };
  const lifecycles: Record<string, Life> = { OLD: { lifeCycleStatus: "live", actualStartTime: new Date(START).toISOString(), actualEndTime: null, recordFromStart: opts.oldRecorded ?? true }, ...(opts.lifecycles ?? {}) };
  const rows: Row[] = opts.rows ?? [{ id: "S-OLD", broadcastId: "OLD", startedAt: new Date(START), endedAt: null, recorded: opts.oldRecorded ?? true, playlistStatus: "none", playlistAttempts: 0 }];
  let completeOldRefusals = opts.completeOldRefusals ?? 0;
  let deleteRefusals = opts.deleteRefusals ?? 0;
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
      insert: async (row) => void rows.push({ ...row, endedAt: null }),
      update: async (id, set) => {
        const r = rows.find((x) => x.id === id);
        if (r) Object.assign(r, set);
      },
      open: async () => rows.filter((s) => s.endedAt === null || s.playlistStatus === "pending").map((r) => ({ ...r })),
    },
    broadcastSettings: async () => ({ latencyPreference: "low", enableDvr: true, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" }),
    authorize: async () => {
      if (opts.authFails) throw new Error("Live writes are off");
      return { credentialRef: { userId: "u-tropico" }, credentials: { accessToken: "t" } as never };
    },
    youtube: {
      insertBroadcast: async (_c, args) => {
        calls.push(`insert(recordFromStart=${args.recordFromStart},autoStart=${args.enableAutoStart},latency=${args.latencyPreference},privacy=${args.privacyStatus})`);
        if (opts.insertFails) throw new Error("insufficientLivePermissions");
        lifecycles.NEW = { lifeCycleStatus: "ready", actualStartTime: null, actualEndTime: null, recordFromStart: true };
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
        if (args.broadcastStatus === "live" && !opts.neverLive) lifecycles[args.broadcastId] = { ...life, lifeCycleStatus: "liveStarting" };
        if (args.broadcastStatus === "complete") {
          if (args.broadcastId === "OLD" && completeOldRefusals > 0) {
            completeOldRefusals -= 1;
            throw new Error("backendError");
          }
          lifecycles[args.broadcastId] = { ...life, lifeCycleStatus: "complete", actualEndTime: new Date(now).toISOString() };
        }
      },
      lifecycles: async (_c, asked) => {
        calls.push(`read(${asked.join(",")})`);
        // YouTube: a broadcast asked to go live is live by the next read (spike D: about 8 s).
        for (const id of asked) if (lifecycles[id]?.lifeCycleStatus === "liveStarting") lifecycles[id] = { ...lifecycles[id]!, lifeCycleStatus: "live", actualStartTime: new Date(now).toISOString() };
        return Object.fromEntries(asked.filter((id) => lifecycles[id]).map((id) => [id, lifecycles[id]!]));
      },
      deleteVideo: async (_c, id) => {
        calls.push(`delete(${id})`);
        if (deleteRefusals > 0) {
          deleteRefusals -= 1;
          throw new Error("backendError");
        }
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
    withBroadcastLock: (_c, fn) => fn(),
    newId: () => `S-${++ids}`,
    clock: () => now,
  };
  const segments = createLiveSegments(deps);
  return {
    segments,
    calls,
    events,
    stream: () => stream,
    setStream: (set: Partial<typeof stream>) => void (stream = { ...stream, ...set }),
    lifecycles,
    rows,
    applied,
    advance: (ms: number) => void (now += ms),
    /** Ticks every 15 s, as the runner does. */
    ticks: async (n: number) => {
      for (let i = 0; i < n; i++) {
        await segments.tick("UC1");
        now += TICK;
      }
    },
    marker: () => (stream.segmentSwitchingJson ? (JSON.parse(stream.segmentSwitchingJson) as SwitchMarker) : null),
  };
}

const WRITES = (calls: string[]) => calls.filter((c) => !c.startsWith("read("));

test("AC-SEG-01: not due -- under the length, segments off, the stream off, or no settings: no YouTube call at all", async () => {
  const under = harness({ now: START + 10 * H, rows: [{ id: "S-OLD", broadcastId: "OLD", startedAt: new Date(START), endedAt: null, recorded: true, playlistStatus: "none", playlistAttempts: 0 }] });
  await under.ticks(3);
  assert.deepEqual(under.calls, []);
  for (const h of [harness({ settings: { ...ON, enabled: false } }), harness({ intent: "off" }), harness({ settings: null })]) {
    await h.ticks(3);
    assert.deepEqual(WRITES(h.calls), []);
  }
});

test("AC-SEG-01: the quiet hour moves a switch due within 2 h to that hour, never past 705 min", () => {
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 10 }, START), START + 10 * H);
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 12 }, START), START + 11 * H, "12:00 would exceed 705 min");
  assert.equal(switchDueAt({ ...ON, lengthMinutes: 600, switchHourUtc: 11 }, START), START + 11 * H);
  assert.equal(switchDueAt({ ...ON, switchHourUtc: 4 }, START), START + 11 * H);
});

test("a segment is timed from YouTube's own start, not from when the owner turned the stream on days ago", async () => {
  // No row yet for OLD (the owner's Start, before segments were on): the row is created from YouTube's actualStartTime.
  const h = harness({ now: START + 2 * H, rows: [] });
  await h.ticks(1);
  assert.equal(h.rows[0]!.startedAt.getTime(), START);
  assert.deepEqual(WRITES(h.calls), [], "2 h into an 11 h segment: nothing to do");
});

test("AC-SEG-02: the happy path, in order -- insert (recording on, auto-start off, the saved broadcast settings, the stream's privacy), bind, ONE live request, row -> new, THEN old complete", async () => {
  const h = harness();
  await h.ticks(4);
  assert.deepEqual(WRITES(h.calls), [
    "insert(recordFromStart=true,autoStart=false,latency=low,privacy=public)",
    "bind(NEW->STREAM1)",
    "transition(NEW->live)",
    "row.broadcastId=NEW",
    "transition(OLD->complete)",
  ]);
  assert.equal(h.stream().broadcastId, "NEW");
  assert.equal(h.marker(), null, "the marker is cleared");
  assert.ok(h.rows.find((r) => r.broadcastId === "OLD")!.endedAt);
  assert.ok(h.rows.find((r) => r.broadcastId === "NEW" && r.endedAt === null));
  assert.deepEqual(h.applied, ["NEW"]);
  assert.equal(h.events.find((e) => e.kind === "live_segment_switched")!.detail.to, "NEW");
});

test("AC-SEG-03: the new segment never goes live in 5 min -- the old one is never ended, the row keeps it, the new one is deleted, `transition live` sent at most twice, retry not before 30 min", async () => {
  const h = harness({ neverLive: true });
  await h.ticks(Math.ceil(GO_LIVE_TIMEOUT_MS / TICK) + 3);
  assert.ok(!h.calls.includes("transition(OLD->complete)"));
  assert.equal(h.stream().broadcastId, "OLD");
  assert.ok(h.calls.includes("delete(NEW)"));
  assert.ok(h.calls.filter((c) => c === "transition(NEW->live)").length <= 2, "reads only after the first request (and one repeat)");
  assert.equal(h.events.find((e) => e.kind === "live_segment_switch_failed")!.detail.stage, "go_live");
  assert.equal(h.marker(), null);
  h.calls.length = 0;
  h.advance(SWITCH_RETRY_MS - 5 * 60_000);
  await h.ticks(2);
  assert.deepEqual(WRITES(h.calls), [], "no new attempt within 30 min of the failure");
  h.advance(10 * 60_000);
  await h.ticks(1);
  assert.ok(WRITES(h.calls).some((c) => c.startsWith("insert")));
});

test("AC-SEG-04: an insert refusal -- nothing to clean; a bind refusal -- the new one is deleted; the old one stays either way", async () => {
  const insert = harness({ insertFails: true });
  await insert.ticks(3);
  assert.ok(!insert.calls.some((c) => c.startsWith("delete")));
  assert.equal(insert.stream().broadcastId, "OLD");
  assert.equal(insert.marker(), null);

  const bind = harness({ bindFails: true });
  await bind.ticks(3);
  assert.ok(bind.calls.includes("delete(NEW)"));
  assert.ok(!bind.calls.includes("transition(OLD->complete)"));
  assert.equal(bind.marker(), null);
});

test("AC-SEG-04b (review): a failed delete keeps the marker and is retried until the new broadcast is gone", async () => {
  const h = harness({ bindFails: true, deleteRefusals: 2 });
  await h.ticks(2);
  assert.ok(h.marker(), "still tracked after a failed delete");
  h.advance(STEP_RETRY_MS);
  await h.ticks(1);
  h.advance(STEP_RETRY_MS);
  await h.ticks(1);
  assert.equal(h.calls.filter((c) => c === "delete(NEW)").length, 3);
  assert.equal(h.marker(), null);
});

test("AC-SEG-05: Live writes off -- no YouTube write; reported once per retry window", async () => {
  const h = harness({ authFails: true });
  await h.ticks(4);
  assert.deepEqual(WRITES(h.calls), []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_failed").length, 1);
});

test("AC-SEG-06: segments off while live -- nothing is ended", async () => {
  const h = harness({ settings: { ...ON, enabled: false } });
  await h.ticks(3);
  assert.deepEqual(WRITES(h.calls), []);
});

test("AC-SEG-06b (review): the owner stops the stream while the new one is going live -- the new one is ended, the old one is the owner's, nothing handed over, not counted as a failure", async () => {
  const h = harness();
  await h.segments.tick("UC1"); // insert, bind, live request
  h.setStream({ intent: "off" }); // the owner's Stop (it ended OLD itself)
  await h.ticks(3);
  assert.ok(h.calls.includes("transition(NEW->complete)") || h.calls.includes("delete(NEW)"));
  assert.ok(!h.calls.includes("row.broadcastId=NEW"));
  assert.equal(h.marker(), null);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_failed").length, 0);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_cancelled").length, 1);
});

test("AC-SEG-07 (review): ending the old segment is retried until YouTube says it ended -- never left live; the owner is told after a few tries", async () => {
  const h = harness({ completeOldRefusals: HANDOVER_ALERT_ATTEMPTS + 1 });
  await h.ticks(2); // to handover
  for (let i = 0; i < HANDOVER_ALERT_ATTEMPTS + 2; i++) {
    h.advance(STEP_RETRY_MS);
    await h.ticks(1);
  }
  assert.equal(h.calls.filter((c) => c === "transition(OLD->complete)").length, HANDOVER_ALERT_ATTEMPTS + 2);
  assert.equal(h.lifecycles.OLD!.lifeCycleStatus, "complete");
  assert.equal(h.marker(), null);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_end_old_retrying").length, 1);
  assert.equal(h.stream().broadcastId, "NEW");
});

test("AC-SEG-08: a recorded segment goes into the playlist after the switch, retried every 10 min, given up after 2 h; a non-recorded one never; nothing without a playlist", async () => {
  const playlist = { ...ON, recordingsPlaylist: { id: "PLREC", title: "Записи" } };
  const h = harness({ settings: playlist, addRefusals: 1 });
  await h.ticks(4);
  assert.equal(h.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "pending");
  await h.ticks(1); // the first attempt: refused
  assert.equal(h.calls.filter((c) => c.startsWith("playlistItems")).length, 1);
  await h.ticks(2); // within 10 min: no attempt
  assert.equal(h.calls.filter((c) => c.startsWith("playlistItems")).length, 1);
  h.advance(PLAYLIST_RETRY_MS);
  await h.ticks(1);
  assert.equal(h.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "added");

  const giveUp = harness({ settings: playlist, addRefusals: 100 });
  await giveUp.ticks(4);
  for (let i = 0; i < PLAYLIST_MAX_ATTEMPTS + 2; i++) {
    giveUp.advance(PLAYLIST_RETRY_MS);
    await giveUp.ticks(1);
  }
  assert.equal(giveUp.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "failed");
  assert.equal(giveUp.calls.filter((c) => c.startsWith("playlistItems")).length, PLAYLIST_MAX_ATTEMPTS);

  // The owner's first broadcast was started without recording (segments turned on later): its "recording" is not added.
  const unrecorded = harness({ settings: playlist, oldRecorded: false });
  await unrecorded.ticks(6);
  assert.equal(unrecorded.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "none");
  assert.ok(!unrecorded.calls.some((c) => c.startsWith("playlistItems")));

  const none = harness();
  await none.ticks(4);
  assert.equal(none.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "none");
});

test("AC-SEG-09: a restart mid-switch resumes from the marker and leaves exactly one live broadcast", async () => {
  const base = { startedAt: START + 11 * H - TICK, fromBroadcastId: "OLD", newBroadcastId: "NEW", liveRequestedAt: START + 11 * H - TICK, liveRequests: 1 };
  // Crashed while going live: the next process reads NEW live and hands over.
  const going = harness({ marker: { ...base, phase: "going_live" }, lifecycles: { NEW: { lifeCycleStatus: "live", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: null } } });
  await going.ticks(3);
  assert.equal(going.stream().broadcastId, "NEW");
  assert.equal(going.lifecycles.OLD!.lifeCycleStatus, "complete");
  // Crashed after the row named NEW, before OLD ended: OLD is ended.
  const handover = harness({ rowBroadcast: "NEW", marker: { ...base, phase: "handover", attempts: 0 }, lifecycles: { NEW: { lifeCycleStatus: "live", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: null } } });
  await handover.ticks(2);
  assert.equal(handover.lifecycles.OLD!.lifeCycleStatus, "complete");
  assert.ok(handover.rows.find((r) => r.broadcastId === "NEW"), "the new segment's row is created on the resume");
  // Crashed while cleaning up a never-live NEW: deleted.
  const cleanup = harness({ marker: { ...base, phase: "cleanup", reason: "go_live", attempts: 0 }, lifecycles: { NEW: { lifeCycleStatus: "ready", actualStartTime: null, actualEndTime: null } } });
  await cleanup.ticks(2);
  assert.ok(cleanup.calls.includes("delete(NEW)"));
  assert.equal(cleanup.lifecycles.OLD!.lifeCycleStatus, "live", "the old segment is never touched by a cleanup");
  for (const h of [going, handover, cleanup]) assert.equal(h.marker(), null);
});

test("AC-SEG-10: the daily cap of 6 stops further switches that UTC day; the cap is reported once", async () => {
  const h = harness({ switchesToday: DAILY_SWITCH_CAP });
  await h.ticks(4);
  assert.deepEqual(WRITES(h.calls), []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_cap_reached").length, 1);
  const under = harness({ switchesToday: DAILY_SWITCH_CAP - 1 });
  await under.ticks(4);
  assert.ok(under.calls.includes("transition(OLD->complete)"));
});

test("AC-SEG-12: stored settings that do not pass the schema read as off (never a switch on a guess)", () => {
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, lengthMinutes: 800 })).enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, lengthMinutes: 10 })).enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify({ ...ON, switchHourUtc: 24 })).enabled, false);
  assert.equal(readSegmentSettings("{").enabled, false);
  assert.equal(readSegmentSettings(JSON.stringify(ON)).enabled, true);
});

test("rows of broadcasts that are no longer the stream's (the owner's Stop and a new Start) are closed, never shown as running", async () => {
  const h = harness({ rowBroadcast: "OTHER", now: START + 2 * H, lifecycles: { OTHER: { lifeCycleStatus: "live", actualStartTime: new Date(START + H).toISOString(), actualEndTime: null, recordFromStart: false } } });
  await h.ticks(1);
  assert.ok(h.rows.find((r) => r.broadcastId === "OLD")!.endedAt, "the old row is closed");
  assert.ok(h.rows.find((r) => r.broadcastId === "OTHER" && r.endedAt === null));
});
