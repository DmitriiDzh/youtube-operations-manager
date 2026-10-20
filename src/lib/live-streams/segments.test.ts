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
  HANDOVER_RETRY_MAX_MS,
  STEP_RETRY_MAX_MS,
  stepRetryDelay,
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
  /** Videos already in the recordings playlist (the Start's own playlist step put them there). */
  inPlaylist?: string[];
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
  let authorizations = 0;
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
      authorizations += 1;
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
      playlistHasVideo: async (_c, playlistId, videoId) => {
        calls.push(`playlistHas(${playlistId}:${videoId})`);
        return (opts.inPlaylist ?? []).includes(videoId);
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
    /** Identity checks since the last call. */
    countAuthorize: () => {
      const n = authorizations;
      authorizations = 0;
      return n;
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
  h.advance(stepRetryDelay(1));
  await h.ticks(1);
  h.advance(stepRetryDelay(2));
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
    h.advance(stepRetryDelay(i + 1));
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

test("AC-SEG-08b: a recording the Start's video settings already put into the same playlist is not added a second time", async () => {
  const h = harness({ settings: { ...ON, recordingsPlaylist: { id: "PLREC", title: "Записи" } }, inPlaylist: ["OLD"] });
  await h.ticks(6);
  assert.equal(h.rows.find((r) => r.broadcastId === "OLD")!.playlistStatus, "added");
  assert.ok(!h.calls.some((c) => c.startsWith("playlistItems.insert")));
  const added = h.events.find((e) => e.kind === "live_segment_recording_added");
  assert.ok(added);
  assert.ok(h.calls.includes("playlistHas(PLREC:OLD)"));
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

// Second independent review (2026-10-19).
const LIVE_NEW = { NEW: { lifeCycleStatus: "live", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: null } };
const HANDOVER: SwitchMarker = { phase: "handover", startedAt: START + 11 * H - TICK, fromBroadcastId: "OLD", newBroadcastId: "NEW", liveRequestedAt: START + 11 * H - TICK, liveRequests: 1, attempts: 0 };

test("review 2: a crash between writing the hand-over and moving the row -- the row is moved to the new one before the old one is ended", async () => {
  const h = harness({ marker: HANDOVER, lifecycles: LIVE_NEW }); // the row still names OLD
  await h.ticks(2);
  const moved = h.calls.indexOf("row.broadcastId=NEW");
  assert.ok(moved >= 0 && moved < h.calls.indexOf("transition(OLD->complete)"), "the row names NEW before OLD is ended");
  assert.equal(h.stream().broadcastId, "NEW");
  assert.equal(h.lifecycles.OLD!.lifeCycleStatus, "complete");
  assert.equal(h.lifecycles.NEW!.lifeCycleStatus, "live");
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switched").length, 1);
  assert.equal(h.marker(), null);
});

test("review 2: the owner's Stop during the hand-over -- both broadcasts end, nothing is handed over or applied, not a failure", async () => {
  const h = harness({ intent: "off", marker: HANDOVER, lifecycles: LIVE_NEW });
  await h.ticks(2);
  assert.ok(!h.calls.includes("row.broadcastId=NEW"));
  assert.equal(h.lifecycles.OLD!.lifeCycleStatus, "complete");
  assert.equal(h.lifecycles.NEW!.lifeCycleStatus, "complete");
  assert.deepEqual(h.applied, []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switched").length, 0);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_failed").length, 0);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_cancelled").length, 1);
  assert.equal(h.marker(), null);
});

test("review 2: a retry waits its growing pause before any call (the read and the identity check too); the pause stops growing at an hour", async () => {
  const h = harness({ completeOldRefusals: 100 });
  await h.ticks(2); // to handover
  while ((h.marker()!.attempts ?? 0) === 0) await h.ticks(1); // the first refusal
  h.calls.length = 0;
  h.countAuthorize();
  await h.ticks(Math.floor(stepRetryDelay(1) / TICK) - 2);
  assert.deepEqual(h.calls, [], "nothing at all inside the pause");
  assert.equal(h.countAuthorize(), 0, "no identity check inside the pause");
  h.advance(2 * TICK);
  await h.ticks(1);
  assert.equal(h.calls.filter((c) => c === "transition(OLD->complete)").length, 1);
  assert.equal(stepRetryDelay(2), 2 * stepRetryDelay(1));
  assert.equal(stepRetryDelay(50), STEP_RETRY_MAX_MS);
});

test("review 2: a recorded segment closed because the stream no longer names it still goes to the recordings playlist", async () => {
  const h = harness({
    settings: { ...ON, recordingsPlaylist: { id: "PLREC", title: "Записи" } },
    rowBroadcast: "OTHER",
    now: START + 2 * H,
    lifecycles: { OTHER: { lifeCycleStatus: "live", actualStartTime: new Date(START + H).toISOString(), actualEndTime: null, recordFromStart: true } },
  });
  await h.ticks(2);
  const old = h.rows.find((r) => r.broadcastId === "OLD")!;
  assert.ok(old.endedAt);
  assert.ok(old.playlistStatus === "pending" || old.playlistStatus === "added");
  assert.ok(h.calls.includes("playlistItems.insert(OLD->PLREC)"));
});

test("review 2: a broadcast that is not live yet is read again only after a few minutes", async () => {
  const h = harness({ rowBroadcast: "READY", rows: [], lifecycles: { READY: { lifeCycleStatus: "ready", actualStartTime: null, actualEndTime: null } } });
  await h.ticks(10); // 2.5 min
  assert.equal(h.calls.filter((c) => c === "read(READY)").length, 1);
  h.advance(5 * 60_000);
  await h.ticks(1);
  assert.equal(h.calls.filter((c) => c === "read(READY)").length, 2);
});

test("review 2: Stop and a new Start before the hand-over resumes -- the new segment is ended, the owner's new broadcast is left alone", async () => {
  const h = harness({ rowBroadcast: "THIRD", marker: HANDOVER, lifecycles: { ...LIVE_NEW, THIRD: { lifeCycleStatus: "live", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: null } } });
  await h.ticks(2);
  assert.equal(h.stream().broadcastId, "THIRD");
  assert.equal(h.lifecycles.NEW!.lifeCycleStatus, "complete");
  assert.equal(h.lifecycles.THIRD!.lifeCycleStatus, "live");
  assert.deepEqual(h.applied, []);
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switched").length, 0);
  assert.equal(h.marker(), null);
});

// Third independent review (2026-10-19).
test("review 3: ending the old segment is retried at least every 5 min; after the owner's Stop at least every minute", async () => {
  assert.equal(stepRetryDelay(20, HANDOVER_RETRY_MAX_MS), 5 * 60_000);
  const h = harness({ completeOldRefusals: 100 });
  await h.ticks(2);
  while ((h.marker()!.attempts ?? 0) < 8) {
    h.advance(HANDOVER_RETRY_MAX_MS);
    await h.ticks(1);
  }
  h.setStream({ intent: "off" }); // the owner's Stop
  h.calls.length = 0;
  h.advance(60_000);
  await h.ticks(1);
  assert.ok(h.calls.includes("transition(OLD->complete)"), "a Stop is not kept waiting behind a long pause");
});

test("review 3: Stop and Start while the new segment is still going live -- it is cleaned up, never asked to go live again", async () => {
  const h = harness({ neverLive: true });
  await h.segments.tick("UC1"); // insert, bind, live request; NEW stays ready
  h.setStream({ intent: "on", broadcastId: "THIRD" }); // Stop (OLD ended by it) and a new Start
  h.lifecycles.THIRD = { lifeCycleStatus: "live", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: null };
  h.calls.length = 0;
  h.advance(2 * 60_000);
  await h.ticks(3);
  assert.ok(!h.calls.includes("transition(NEW->live)"), "never asked to go live again");
  assert.ok(h.calls.includes("delete(NEW)"));
  assert.equal(h.stream().broadcastId, "THIRD");
  assert.equal(h.lifecycles.THIRD!.lifeCycleStatus, "live");
  assert.equal(h.marker(), null);
});

test("review 3: the new segment ended before the old one -- the row goes back to the old one, which stays live", async () => {
  const h = harness({ rowBroadcast: "NEW", marker: HANDOVER, lifecycles: { NEW: { lifeCycleStatus: "complete", actualStartTime: new Date(START + 11 * H).toISOString(), actualEndTime: new Date(START + 11 * H + 60_000).toISOString() } } });
  await h.ticks(3);
  assert.ok(!h.calls.includes("transition(OLD->complete)"));
  assert.equal(h.lifecycles.OLD!.lifeCycleStatus, "live");
  assert.equal(h.stream().broadcastId, "OLD");
  assert.equal(h.events.filter((e) => e.kind === "live_segment_switch_failed" && e.detail.stage === "handover").length, 1);
  assert.equal(h.marker(), null);
});

test("review 3: a cancelled hand-over closes both segments with YouTube's times; both recordings go to the playlist", async () => {
  const h = harness({ intent: "off", marker: HANDOVER, lifecycles: LIVE_NEW, settings: { ...ON, recordingsPlaylist: { id: "PLREC", title: "Записи" } } });
  await h.ticks(1);
  const old = h.rows.find((r) => r.broadcastId === "OLD")!;
  const fresh = h.rows.find((r) => r.broadcastId === "NEW")!;
  assert.ok(old.endedAt && fresh.endedAt);
  assert.equal(fresh.startedAt.getTime(), START + 11 * H);
  assert.equal(old.playlistStatus, "pending");
  assert.equal(fresh.playlistStatus, "pending");
});
