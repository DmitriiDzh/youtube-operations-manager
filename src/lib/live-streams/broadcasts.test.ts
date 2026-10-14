import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS, DomainError, type LivePrivacy } from "./contracts";
import { createLiveBroadcasts, START_LEAD_MS, type BroadcastsDependencies } from "./broadcasts";

// BL-176 acceptance (LIVE_STREAMS_PLAN.md §3.9, §4.1 "Quota" and "Gateway inventory"; ADR 0036 §3): a first Start costs 5
// units (liveStreams.insert, videos.list, liveBroadcasts.insert, bind, liveStreams.list), a later one 4; with Live writes
// off every Start, Stop and Edit write is refused and the encoder is not started; a wrong channel fails closed.

const NOW = new Date("2026-10-12T12:00:00Z");

function googleError(reason: string) {
  return Object.assign(new Error(reason), { response: { status: 403, data: { error: { errors: [{ reason }] } } } });
}

function harness(opts: { liveWrites?: boolean; streamId?: string | null; broadcastId?: string | null; intent?: "on" | "off"; wrongChannel?: boolean; transitionError?: string; bindError?: string; readBack?: Partial<{ title: string }>; encoderFails?: boolean } = {}) {
  const calls: string[] = [];
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
  let stream = {
    channelId: "UC1",
    intent: (opts.intent ?? "off") as "on" | "off",
    streamId: opts.streamId === undefined ? null : opts.streamId,
    broadcastId: (opts.broadcastId ?? null) as string | null,
    title: "Tropico Jazz Radio",
    description: "24/7",
    privacyStatus: "unlisted" as LivePrivacy,
    madeForKids: false,
  };
  let broadcast = { broadcastId: "BC1", title: "Tropico Jazz Radio", description: "24/7", scheduledStartTime: "2026-10-12T12:02:00.000Z", scheduledEndTime: null, lifeCycleStatus: "live", privacyStatus: "unlisted", categoryId: "10" };
  const sent: Record<string, unknown> = {};
  const deps: BroadcastsDependencies = {
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled: true, host: { ok: true } }),
    liveWritesEnabled: async () => opts.liveWrites ?? true,
    auth: { resolve: async () => ({ credentialRef: { userId: "u1" }, accessToken: "t", scopeSet: new Set() }) as never },
    writeContext: {
      assertWriteChannel: async ({ expectedChannelId }) => {
        calls.push("identity");
        if (opts.wrongChannel) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH" as never, message: `authorized channel is not ${expectedChannelId}` });
        return {};
      },
    },
    streams: {
      get: async () => stream,
      update: async (_c, set) => {
        stream = { ...stream, ...(set as object) };
        return true;
      },
      event: async (_c, kind, detail) => void events.push({ kind, detail }),
    },
    rotation: {
      recheck: async () => {
        calls.push("videos.list");
        return ["AAAAAAAAAA1"];
      },
    },
    youtube: {
      insertStream: async () => {
        calls.push("liveStreams.insert");
        return { streamId: "STREAM1" };
      },
      insertBroadcast: async (_c, args) => {
        calls.push("liveBroadcasts.insert");
        sent.broadcast = args;
        return { broadcastId: "BC1", lifeCycleStatus: "created" };
      },
      bind: async (_c, args) => {
        calls.push("liveBroadcasts.bind");
        if (opts.bindError) throw googleError(opts.bindError);
        return { boundStreamId: args.streamId };
      },
      transition: async (_c, args) => {
        calls.push(`liveBroadcasts.transition:${args.broadcastStatus}`);
        if (opts.transitionError) throw googleError(opts.transitionError);
        return { lifeCycleStatus: args.broadcastStatus };
      },
      update: async (_c, args) => {
        calls.push("liveBroadcasts.update");
        sent.update = args;
        broadcast = { ...broadcast, title: args.snippet.title, description: args.snippet.description, privacyStatus: args.privacyStatus, ...opts.readBack };
      },
      getBroadcast: async () => {
        calls.push("liveBroadcasts.list");
        return broadcast;
      },
    },
    supervisor: {
      startEncoder: async (_c, options) => {
        calls.push("liveStreams.list"); // the key read happens inside the encoder start
        if (opts.encoderFails) throw new Error("ffmpeg is not installed");
        assert.deepEqual(options.playable, ["AAAAAAAAAA1"], "Start hands over the rotation it just read (no second videos.list)");
        return { pid: 1 };
      },
      stopEncoder: async () => {
        calls.push(`stopEncoder:intent=${stream.intent}`);
        return true;
      },
    },
    clock: () => NOW,
  };
  return { broadcasts: createLiveBroadcasts(deps), calls, events, sent, stream: () => stream };
}

const YOUTUBE_CALLS = (calls: string[]) => calls.filter((c) => c !== "identity" && !c.startsWith("stopEncoder"));

test("quota: a first Start makes exactly the 5 calls of 1 unit each; a later Start 4", async () => {
  const first = harness();
  const result = await first.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(YOUTUBE_CALLS(first.calls), ["videos.list", "liveStreams.insert", "liveBroadcasts.insert", "liveBroadcasts.bind", "liveStreams.list"]);
  assert.deepEqual(result, { broadcastId: "BC1", streamId: "STREAM1", encoderStarted: true });

  const later = harness({ streamId: "STREAM1" });
  await later.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(YOUTUBE_CALLS(later.calls), ["videos.list", "liveBroadcasts.insert", "liveBroadcasts.bind", "liveStreams.list"]);
});

test("Start sends auto-start on, auto-stop off, monitor stream off, recording off, the saved texts, a start 2 minutes ahead; the intent goes on", async () => {
  const h = harness();
  await h.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(h.sent.broadcast, {
    title: "Tropico Jazz Radio",
    description: "24/7",
    scheduledStartTime: new Date(NOW.getTime() + START_LEAD_MS).toISOString(),
    privacyStatus: "unlisted",
    selfDeclaredMadeForKids: false,
    enableAutoStart: true,
    enableAutoStop: false,
    enableMonitorStream: false,
    recordFromStart: false,
  });
  assert.equal(h.stream().intent, "on");
  assert.deepEqual(h.events.filter((e) => e.kind === "youtube_write").map((e) => e.detail.method), ["liveStreams.insert", "liveBroadcasts.insert", "liveBroadcasts.bind"]);
});

test("Live writes off: Start, Go live, Stop and Edit are refused before any YouTube call, and the encoder is not started", async () => {
  const h = harness({ liveWrites: false, streamId: "STREAM1", broadcastId: "BC1" });
  const refused = (e: unknown) => e instanceof DomainError && e.code === "live_writes_disabled";
  await assert.rejects(() => h.broadcasts.start("UC1", { userId: "u1" }), refused);
  await assert.rejects(() => h.broadcasts.goLive("UC1", { userId: "u1" }), refused);
  await assert.rejects(() => h.broadcasts.stop("UC1", { userId: "u1" }, { encoderOnly: false }), refused);
  await assert.rejects(() => h.broadcasts.edit("UC1", { userId: "u1" }, { title: "x" }, { title: "Tropico Jazz Radio", description: "24/7", privacyStatus: "unlisted" }), refused);
  assert.deepEqual(h.calls, [], "no YouTube call, no identity call, no encoder");
  // Stopping only the encoder needs no YouTube write and stays possible.
  assert.deepEqual(await h.broadcasts.stop("UC1", {}, { encoderOnly: true }), { broadcastEnded: false });
  assert.deepEqual(h.calls, ["stopEncoder:intent=off"]);
});

test("a wrong channel fails closed before any write", async () => {
  const h = harness({ wrongChannel: true });
  await assert.rejects(() => h.broadcasts.start("UC1", { userId: "u1" }));
  assert.deepEqual(YOUTUBE_CALLS(h.calls), []);
});

test("if the encoder cannot start after the broadcast is bound, Start reports it and the intent stays on (the background loop retries)", async () => {
  const h = harness({ encoderFails: true });
  const result = await h.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual([result.encoderStarted, result.encoderError], [false, "ffmpeg is not installed"]);
  assert.equal(h.stream().intent, "on");
});

test("Stop ends the broadcast (transition complete), stops the encoder, turns the intent off; redundantTransition counts as done", async () => {
  const h = harness({ streamId: "STREAM1" });
  await h.broadcasts.start("UC1", { userId: "u1" });
  h.calls.length = 0;
  assert.deepEqual(await h.broadcasts.stop("UC1", { userId: "u1" }, { encoderOnly: false }), { broadcastEnded: true });
  assert.deepEqual(h.calls, ["identity", "liveBroadcasts.transition:complete", "stopEncoder:intent=off"], "the intent goes off before the encoder stops");
  assert.equal(h.stream().intent, "off");

  const again = harness({ streamId: "STREAM1", transitionError: "redundantTransition" });
  await again.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(await again.broadcasts.stop("UC1", { userId: "u1" }, { encoderOnly: false }), { broadcastEnded: true });
});

// Changed after the independent review (2026-10-12): `invalidTransition` / `liveBroadcastNotFound` mean YouTube has nothing to
// end, so Stop now stops the encoder anyway (test above). Any OTHER refusal is still shown in plain words and stops nothing.
test("any other refused transition is shown in plain words and nothing is stopped", async () => {
  const h = harness({ streamId: "STREAM1", transitionError: "livePermissionBlocked" });
  await h.broadcasts.start("UC1", { userId: "u1" });
  h.calls.length = 0;
  await assert.rejects(
    () => h.broadcasts.stop("UC1", { userId: "u1" }, { encoderOnly: false }),
    (e: unknown) => e instanceof DomainError && e.code === "update_failed" && /does not allow this channel to stream/.test(e.message)
  );
  assert.ok(!h.calls.some((c) => c.startsWith("stopEncoder")));
  assert.equal(h.stream().intent, "on");
});

test("Edit: refused if the broadcast changed since the preview; sends the full snippet with its start time; read back; both versions in the event", async () => {
  const h = harness({ streamId: "STREAM1" });
  await h.broadcasts.start("UC1", { userId: "u1" });
  const preview = await h.broadcasts.previewEdit("UC1", { userId: "u1" }, { title: "New title" });
  assert.deepEqual(preview.after.title, "New title");

  await assert.rejects(() => h.broadcasts.edit("UC1", { userId: "u1" }, { title: "New title" }, { ...preview.before, title: "stale" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.ok(!h.calls.includes("liveBroadcasts.update"));

  const result = await h.broadcasts.edit("UC1", { userId: "u1" }, { title: "New title" }, preview.before);
  assert.equal(result.verified, true);
  assert.deepEqual(h.sent.update, {
    broadcastId: "BC1",
    snippet: { title: "New title", description: "24/7", scheduledStartTime: "2026-10-12T12:02:00.000Z", scheduledEndTime: null, categoryId: "10" },
    privacyStatus: "unlisted",
  });
  const event = h.events.find((e) => e.detail.method === "liveBroadcasts.update");
  assert.deepEqual([(event?.detail.before as { title: string }).title, (event?.detail.after as { title: string }).title], ["Tropico Jazz Radio", "New title"]);
  assert.equal(h.stream().title, "New title");
});

test("Edit: a read-back that differs is reported as a failure, with the event recording it unverified", async () => {
  const h = harness({ streamId: "STREAM1", readBack: { title: "Something else" } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  const preview = await h.broadcasts.previewEdit("UC1", { userId: "u1" }, { title: "New title" });
  await assert.rejects(() => h.broadcasts.edit("UC1", { userId: "u1" }, { title: "New title" }, preview.before), (e: unknown) => e instanceof DomainError && e.code === "update_failed");
  assert.equal(h.events.find((e) => e.detail.method === "liveBroadcasts.update")?.detail.verified, false);
});

test("previewStart: no YouTube call; 5 units the first time, 4 after", async () => {
  const first = harness();
  const preview = await first.broadcasts.previewStart("UC1");
  assert.deepEqual([preview.units, preview.createsStream, preview.broadcast.enableAutoStop, preview.broadcast.recordFromStart], [5, true, false, false]);
  assert.deepEqual(first.calls, []);
  assert.equal((await harness({ streamId: "STREAM1" }).broadcasts.previewStart("UC1")).units, 4);
});

// --- Independent review (2026-10-12) ---

test("a second Start while the stream is on is refused before any YouTube call (no second broadcast)", async () => {
  const h = harness({ streamId: "STREAM1", broadcastId: "BC1", intent: "on" });
  await assert.rejects(() => h.broadcasts.start("UC1", { userId: "u1" }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.deepEqual(YOUTUBE_CALLS(h.calls), []);
  assert.equal(h.stream().broadcastId, "BC1");
});

test("Stop still stops the encoder and turns the intent off when YouTube has no broadcast to end (deleted in Studio)", async () => {
  for (const reason of ["liveBroadcastNotFound", "invalidTransition"]) {
    const h = harness({ streamId: "STREAM1", broadcastId: "BC1", intent: "on", transitionError: reason });
    assert.deepEqual(await h.broadcasts.stop("UC1", { userId: "u1" }, { encoderOnly: false }), { broadcastEnded: false, youtubeRefusal: reason });
    assert.ok(h.calls.some((c) => c.startsWith("stopEncoder")), reason);
    assert.equal(h.stream().intent, "off", reason);
  }
});

test("a stream deleted in Studio: the bind fails, the stream is forgotten for the next Start, no broadcast is recorded", async () => {
  const h = harness({ streamId: "GONE", bindError: "liveStreamNotFound" });
  await assert.rejects(
    () => h.broadcasts.start("UC1", { userId: "u1" }),
    (e: unknown) => e instanceof DomainError && e.code === "update_failed" && (e.details as { reason?: string }).reason === "liveStreamNotFound"
  );
  assert.deepEqual([h.stream().streamId, h.stream().broadcastId, h.stream().intent], [null, null, "off"]);
  assert.ok(!h.calls.includes("liveStreams.list"), "no encoder start");
});

test("Edit is validated before any YouTube call: missing what the preview showed, an unknown privacy, an empty title", async () => {
  const h = harness({ streamId: "STREAM1", broadcastId: "BC1", intent: "on" });
  const expected = { title: "Tropico Jazz Radio", description: "24/7", privacyStatus: "unlisted" };
  for (const [patch, exp] of [
    [{ title: "x" }, undefined],
    [{ privacyStatus: "everyone" }, expected],
    [{ title: "   " }, expected],
    [{ title: "x".repeat(101) }, expected],
    [{ title: "x", extra: 1 }, expected],
  ] as const) {
    await assert.rejects(() => h.broadcasts.edit("UC1", { userId: "u1" }, patch, exp), (e: unknown) => e instanceof DomainError && e.code === "validation_failed", JSON.stringify(patch));
  }
  assert.deepEqual(YOUTUBE_CALLS(h.calls), []);
});

test("Edit sends the title trimmed, as YouTube keeps it, so its read-back matches", async () => {
  const h = harness({ streamId: "STREAM1", broadcastId: "BC1", intent: "on" });
  const preview = await h.broadcasts.previewEdit("UC1", { userId: "u1" }, { title: "  New title  " });
  const result = await h.broadcasts.edit("UC1", { userId: "u1" }, { title: "  New title  " }, preview.before);
  assert.equal(result.verified, true);
  assert.equal((h.sent.update as { snippet: { title: string } }).snippet.title, "New title");
  assert.equal(h.stream().title, "New title");
});

// --- Verification review (2026-10-12) ---

test("two Starts at the same moment make ONE set of YouTube writes; the second is refused as already on", async () => {
  const h = harness({ streamId: "STREAM1" });
  const results = await Promise.allSettled([h.broadcasts.start("UC1", { userId: "u1" }), h.broadcasts.start("UC1", { userId: "u1" })]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(h.calls.filter((c) => c === "liveBroadcasts.insert").length, 1);
});
