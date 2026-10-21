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

type HarnessVideo = {
  /** false = no video-details/playlist port plugged in (the module absent). */
  port?: boolean;
  applyFails?: string;
  thumbnailFile?: { kind: "jpeg" | "png"; bytes: Uint8Array } | null;
  thumbnailFails?: string;
  inPlaylist?: string[];
  addRefusals?: number;
  /** The refused add actually landed (a timeout): the playlist holds the video afterwards. */
  refusalLanded?: boolean;
  /** Stop the stream right after the fields step (the owner pressed Stop meanwhile). */
  stopAfterFields?: boolean;
  /** A segment switch replaces the broadcast right after the fields step (BL-205). */
  replaceAfterFields?: boolean;
  /** The video details port throws something unexpected, not a step failure. */
  crash?: boolean;
};

type HarnessLocalized = {
  /** false = no translations writer plugged in. */
  port?: false;
  result?: { verified: false; detail: string };
  throws?: string;
};

function harness(opts: { channelLanguage?: string | null; video?: HarnessVideo; recordingRequired?: boolean; insertError?: string; liveWrites?: boolean; streamId?: string | null; broadcastId?: string | null; intent?: "on" | "off"; wrongChannel?: boolean; transitionError?: string; bindError?: string; readBack?: Partial<{ title: string }>; encoderFails?: boolean; videoSettingsJson?: string | null; localizationsJson?: string | null; localized?: HarnessLocalized } = {}) {
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
    videoSettingsJson: opts.videoSettingsJson ?? null,
    localizationsJson: opts.localizationsJson ?? null,
  };
  const localized: Array<{ videoId: string; localizations: unknown; expected: unknown }> = [];
  let broadcast = { broadcastId: "BC1", title: "Tropico Jazz Radio", description: "24/7", scheduledStartTime: "2026-10-12T12:02:00.000Z", scheduledEndTime: null, lifeCycleStatus: "live", privacyStatus: "unlisted", categoryId: "10" };
  const sent: Record<string, unknown> = {};
  const tasks: Array<() => Promise<unknown>> = [];
  const video = opts.video ?? {};
  let addRefusals = video.addRefusals ?? 0;
  const applied: Array<{ videoId: string; patch: Record<string, unknown> }> = [];
  const landed: string[] = [];
  let inBackground = false;
  let resolved = 0;
  const tokens: Record<string, string> = {};
  const deps: BroadcastsDependencies = {
    background: (task) => void tasks.push(task),
    channelLanguage: async () => (opts.channelLanguage === undefined ? "en" : opts.channelLanguage),
    sleep: async () => undefined,
    thumbnails: { read: async () => video.thumbnailFile ?? null },
    videoFields:
      video.port === false
        ? undefined
        : {
            apply: async ({ videoId, patch }) => {
              calls.push("videos.update");
              if (video.applyFails) throw new Error(video.applyFails);
              applied.push({ videoId, patch });
              if (video.stopAfterFields) stream = { ...stream, intent: "off" };
              if (video.replaceAfterFields) stream = { ...stream, broadcastId: "BC2" };
              return { verified: true };
            },
            addToPlaylist: async ({ playlistId }) => {
              calls.push(`playlistItems.insert:${playlistId}`);
              if (addRefusals > 0) {
                addRefusals -= 1;
                if (video.refusalLanded) landed.push(playlistId);
                return { added: false, reason: "409: The operation was aborted." };
              }
              landed.push(playlistId);
              return { added: true };
            },
          },
    // BL-207: the translations writer (plugged in unless `localized.port` is false).
    localizations:
      opts.localized?.port === false
        ? undefined
        : {
            apply: async ({ videoId, localizations, expected }) => {
              calls.push("videos.update:localizations");
              localized.push({ videoId, localizations, expected });
              if (opts.localized?.throws) throw new DomainError({ code: "live_writes_disabled", message: opts.localized.throws });
              return opts.localized?.result ?? { verified: true };
            },
          },
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled: true, host: { ok: true } }),
    liveWritesEnabled: async () => opts.liveWrites ?? true,
    auth: { resolve: async () => ({ credentialRef: { userId: "u1" }, accessToken: `t${++resolved}`, scopeSet: new Set() }) as never },
    writeContext: {
      assertWriteChannel: async ({ expectedChannelId }) => {
        calls.push("identity");
        if (opts.wrongChannel) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH" as never, message: `authorized channel is not ${expectedChannelId}` });
        return {};
      },
    },
    streams: {
      get: async () => {
        if (video.crash && inBackground) throw new TypeError("the database went away");
        return stream;
      },
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
        tokens.insert = _c.accessToken;
        calls.push("liveBroadcasts.insert");
        sent.broadcast = args;
        if (opts.insertError) throw googleError(opts.insertError);
        if (opts.recordingRequired && args.recordFromStart === false) {
          throw Object.assign(new Error("The user is not permitted to disable recording."), { response: { status: 403, data: { error: { message: "The user is not permitted to disable recording.", errors: [{ reason: "forbidden", message: "The user is not permitted to disable recording." }] } } } });
        }
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
      setThumbnail: async (_c, videoId, image) => {
        tokens.thumbnail = _c.accessToken;
        calls.push(`thumbnails.set:${videoId}:${image.mimeType}`);
        if (video.thumbnailFails) throw new Error(video.thumbnailFails);
      },
      deleteVideo: async (_c, videoId) => void calls.push(`videos.delete:${videoId}`),
      playlistHasVideo: async (_c, playlistId) => {
        calls.push(`playlistItems.list:${playlistId}`);
        return (video.inPlaylist ?? []).includes(playlistId) || landed.includes(playlistId);
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
  return {
    broadcasts: createLiveBroadcasts(deps),
    calls,
    events,
    sent,
    stream: () => stream,
    applied,
    tokens,
    localized,
    /** Runs what Start left in the background (the video settings). */
    runBackground: async () => {
      inBackground = true;
      while (tasks.length > 0) await tasks.shift()!();
    },
  };
}

const YOUTUBE_CALLS = (calls: string[]) => calls.filter((c) => c !== "identity" && !c.startsWith("stopEncoder"));

test("quota: a first Start makes exactly the 5 calls of 1 unit each; a later Start 4", async () => {
  const first = harness();
  const result = await first.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(YOUTUBE_CALLS(first.calls), ["videos.list", "liveStreams.insert", "liveBroadcasts.insert", "liveBroadcasts.bind", "liveStreams.list"]);
  // BL-186 stage 3 (owner msg 3134): Start also says whether video settings are being applied (none were saved here).
  assert.deepEqual(result, { broadcastId: "BC1", streamId: "STREAM1", encoderStarted: true, videoSettings: "not_saved" });

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

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §2.1/§4.1 "Start"; stage 2): the saved broadcast settings ride on the insert -- no extra call,
// no extra unit; never saved, the insert is exactly what it was before; a stored value that fails the schema refuses Start before
// any call. The video-level settings are shown by the dry run but not sent yet (stage 3, after spike C).
const SAVED_SETTINGS = JSON.stringify({
  v: 1,
  tags: ["jazz", "lofi radio"],
  categoryId: "10",
  defaultLanguage: "en",
  defaultAudioLanguage: "zxx",
  license: "youtube",
  publicStatsViewable: true,
  containsSyntheticMedia: true,
  paidProductPlacement: false,
  recordingDate: null,
  playlists: [{ id: "PL0123456789abcdefghijklmnopqrstuv", title: "Radio" }],
  thumbnail: null,
  broadcast: { latencyPreference: "low", enableDvr: false, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" },
});

test("Start: saved broadcast settings go into the insert, with the same 5 calls", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS });
  await h.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(YOUTUBE_CALLS(h.calls), ["videos.list", "liveStreams.insert", "liveBroadcasts.insert", "liveBroadcasts.bind", "liveStreams.list"]);
  const insert = h.sent.broadcast as Record<string, unknown>;
  assert.equal(insert.latencyPreference, "low");
  assert.equal(insert.enableDvr, false);
  assert.equal(insert.enableEmbed, true);
  assert.equal(insert.closedCaptionsType, "closedCaptionsDisabled");
  assert.equal(insert.recordFromStart, false, "the fixed values stay");
  assert.equal(insert.enableAutoStop, false);
  assert.equal("tags" in insert, false, "video-level fields are not part of the broadcast insert");
});

test("Start: never-saved settings leave the insert exactly as before BL-186", async () => {
  const h = harness();
  await h.broadcasts.start("UC1", { userId: "u1" });
  assert.deepEqual(Object.keys(h.sent.broadcast as object).sort(), [
    "description",
    "enableAutoStart",
    "enableAutoStop",
    "enableMonitorStream",
    "privacyStatus",
    "recordFromStart",
    "scheduledStartTime",
    "selfDeclaredMadeForKids",
    "title",
  ]);
});

test("Start: a stored value that fails the schema is refused before the identity check or any call", async () => {
  for (const bad of ["{not json", JSON.stringify({ ...JSON.parse(SAVED_SETTINGS), broadcast: { latencyPreference: "fast", enableDvr: true, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" } })]) {
    const h = harness({ videoSettingsJson: bad });
    await assert.rejects(h.broadcasts.start("UC1", { userId: "u1" }), (error: unknown) => error instanceof DomainError && error.code === "validation_failed");
    assert.deepEqual(h.calls, []);
  }
});

// Stage 3 (owner msg 3134, after spike C): the video settings are now sent after Start, so the dry run lists them with their units.
test("previewStart: shows the broadcast settings and exactly the video settings Start will send, with their units", async () => {
  const preview = await harness({ videoSettingsJson: SAVED_SETTINGS }).broadcasts.previewStart("UC1");
  assert.deepEqual(preview.broadcast.settings, { latencyPreference: "low", enableDvr: false, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" });
  assert.deepEqual(preview.videoSettings?.tags, ["jazz", "lofi radio"]);
  assert.deepEqual(preview.videoSettingsApply, {
    patch: { license: "youtube", publicStatsViewable: true, containsSyntheticMedia: true, paidProductPlacement: false, embeddable: true, tags: ["jazz", "lofi radio"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "zxx" },
    thumbnail: false,
    playlists: [{ id: "PL0123456789abcdefghijklmnopqrstuv", title: "Radio" }],
    // 1 read + 50 update + 1 read-back, no thumbnail, one playlist: 1 owner read + 1 items read + 50 insert.
    units: 105, // 104 + 1 identity read for the fresh credentials of the playlist step (2026-10-20)
  });
  assert.equal(preview.videoSettingsProblem, null);
  assert.equal(preview.units, 5 + 105);
  const noPort = await harness({ videoSettingsJson: SAVED_SETTINGS, video: { port: false } }).broadcasts.previewStart("UC1");
  assert.equal(noPort.videoSettingsApply, null);
  assert.equal(noPort.units, 5);
  const never = await harness().broadcasts.previewStart("UC1");
  assert.equal(never.broadcast.settings, null);
  assert.equal(never.videoSettings, null);
  const corrupt = await harness({ videoSettingsJson: "{" }).broadcasts.previewStart("UC1");
  assert.match(String(corrupt.videoSettingsProblem), /not valid JSON/);
});

// Spike C (2026-10-19, LIVE_STREAMS_FIELDS_PLAN.md §4.2): Tropico got "The user is not permitted to disable recording."
test("a channel that may not switch recording off: Start retries once with recording on, the stream starts, and Start says so", async () => {
  const h = harness({ recordingRequired: true, streamId: "STREAM1" });
  const result = (await h.broadcasts.start("UC1", { userId: "u1" })) as { recordingForced?: boolean; encoderStarted: boolean };
  assert.equal(result.recordingForced, true);
  assert.equal(result.encoderStarted, true);
  assert.equal((h.sent.broadcast as { recordFromStart: boolean }).recordFromStart, true);
  assert.deepEqual(YOUTUBE_CALLS(h.calls), ["videos.list", "liveBroadcasts.insert", "liveBroadcasts.insert", "liveBroadcasts.bind", "liveStreams.list"]);
  assert.equal(h.events.filter((e) => e.kind === "recording_required").length, 1);
  const insertEvent = h.events.find((e) => e.kind === "youtube_write" && e.detail.method === "liveBroadcasts.insert");
  assert.equal((insertEvent?.detail.sent as { recordFromStart: boolean }).recordFromStart, true, "the event records what was really sent");
  assert.equal(h.stream().intent, "on");
});

test("any other refused insert is not retried and Start fails as before (nothing turned on)", async () => {
  const h = harness({ streamId: "STREAM1", insertError: "insufficientLivePermissions" });
  await assert.rejects(() => h.broadcasts.start("UC1", { userId: "u1" }), /not allowed to manage this channel's live broadcasts/);
  assert.deepEqual(YOUTUBE_CALLS(h.calls), ["videos.list", "liveBroadcasts.insert"]);
  assert.equal(h.events.filter((e) => e.kind === "recording_required").length, 0);
  assert.equal(h.stream().intent, "off");
});

// ---------------------------------------------------------------------------
// BL-186 stage 3 (LIVE_STREAMS_FIELDS_PLAN.md §2.2, §4.1 "Start" / "Partial failure"; spike C §4.2): the video-level settings.
// ---------------------------------------------------------------------------

const THUMB = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
// sha256 of THUMB, computed independently: `printf '\xff\xd8\xff\xe0\x01\x02\x03' | shasum -a 256`.
const THUMB_SHA = "474ebe266cd7f9ed28807fa3fdfe0c04cdb3cef9313cdda5c08b15910fcc8184";
const WITH_THUMB = JSON.stringify({ ...JSON.parse(SAVED_SETTINGS), thumbnail: { kind: "jpeg", bytes: THUMB.length, sha256: THUMB_SHA, savedAt: "2026-10-19T10:00:00Z" } });
const AFTER_START = (calls: string[]) => YOUTUBE_CALLS(calls).slice(YOUTUBE_CALLS(calls).indexOf("liveStreams.list") + 1);

test("Start answers at once; then the video settings go to the broadcast's video: one update with exactly the saved fields, the thumbnail, each playlist", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB } } });
  const result = (await h.broadcasts.start("UC1", { userId: "u1" })) as { videoSettings: string };
  assert.equal(result.videoSettings, "applying");
  assert.deepEqual(AFTER_START(h.calls), [], "nothing is sent before Start has answered");
  await h.runBackground();
  assert.deepEqual(AFTER_START(h.calls), ["videos.update", "thumbnails.set:BC1:image/jpeg", "playlistItems.list:PL0123456789abcdefghijklmnopqrstuv", "playlistItems.insert:PL0123456789abcdefghijklmnopqrstuv"]);
  assert.deepEqual(h.applied, [
    {
      videoId: "BC1",
      patch: { license: "youtube", publicStatsViewable: true, containsSyntheticMedia: true, paidProductPlacement: false, embeddable: true, tags: ["jazz", "lofi radio"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "zxx" },
    },
  ]);
  const summary = h.events.find((e) => e.kind === "video_settings_applied")?.detail as { ok: boolean; trigger: string; steps: Array<{ step: string; ok: boolean }> };
  assert.equal(summary.ok, true);
  assert.equal(summary.trigger, "start");
  assert.deepEqual(summary.steps.map((s) => s.step), ["fields", "thumbnail", "playlist:PL0123456789abcdefghijklmnopqrstuv"]);
});

test("an empty field is not sent: no tags, no category, no languages, no date -> only the values that always exist", async () => {
  const bare = JSON.stringify({ ...JSON.parse(SAVED_SETTINGS), tags: [], categoryId: null, defaultLanguage: null, defaultAudioLanguage: null, recordingDate: null, playlists: [] });
  // No channel baseline either (the language comes from it, owner msg 3153).
  const h = harness({ videoSettingsJson: bare, streamId: "STREAM1", channelLanguage: null });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  // The owner's embedding choice is sent explicitly too (review: spike C showed it is one flag with the broadcast's enableEmbed).
  assert.deepEqual(h.applied[0]?.patch, { license: "youtube", publicStatsViewable: true, containsSyntheticMedia: true, paidProductPlacement: false, embeddable: true });
});

test("a failed thumbnail leaves the broadcast and the encoder on, is reported, and Apply again repeats it (a playlist already holding the video is skipped)", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB }, thumbnailFails: "mediaBodyRequired" } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.equal(h.stream().intent, "on");
  assert.ok(!h.calls.some((c) => c.startsWith("stopEncoder")), "the encoder is never stopped by a failed setting");
  const first = h.events.filter((e) => e.kind === "video_settings_applied")[0]?.detail as { ok: boolean; steps: Array<{ step: string; ok: boolean; error?: string }> };
  assert.equal(first.ok, false);
  assert.deepEqual(first.steps.find((s) => s.step === "thumbnail"), { step: "thumbnail", ok: false, error: "mediaBodyRequired" });

  const again = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", intent: "on", broadcastId: "BC1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB }, inPlaylist: ["PL0123456789abcdefghijklmnopqrstuv"] } });
  const result = await again.broadcasts.applyVideoSettingsAgain("UC1", { userId: "u1" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.find((s) => s.step.startsWith("playlist:")), { step: "playlist:PL0123456789abcdefghijklmnopqrstuv", ok: true, skipped: "already_in_playlist" });
  assert.ok(!again.calls.some((c) => c.startsWith("playlistItems.insert")), "never added twice");
  assert.equal(again.events.find((e) => e.kind === "video_settings_applied")?.detail.trigger, "again");
});

test("a playlist add refused once is tried once more; refused twice it is reported", async () => {
  const once = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1", video: { addRefusals: 1 } });
  await once.broadcasts.start("UC1", { userId: "u1" });
  await once.runBackground();
  assert.equal(once.calls.filter((c) => c.startsWith("playlistItems.insert")).length, 2);
  assert.equal((once.events.find((e) => e.kind === "video_settings_applied")?.detail as { ok: boolean }).ok, true);

  const twice = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1", video: { addRefusals: 2 } });
  await twice.broadcasts.start("UC1", { userId: "u1" });
  await twice.runBackground();
  const steps = (twice.events.find((e) => e.kind === "video_settings_applied")?.detail as { steps: Array<{ step: string; ok: boolean; error?: string }> }).steps;
  assert.deepEqual(steps.find((s) => s.step.startsWith("playlist:")), { step: "playlist:PL0123456789abcdefghijklmnopqrstuv", ok: false, error: "409: The operation was aborted." });
});

test("a thumbnail file that changed since it was chosen is not sent", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: new Uint8Array([9, 9, 9]) } } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.ok(!h.calls.some((c) => c.startsWith("thumbnails.set")));
  const steps = (h.events.find((e) => e.kind === "video_settings_applied")?.detail as { steps: Array<{ step: string; ok: boolean; error?: string }> }).steps;
  assert.match(String(steps.find((s) => s.step === "thumbnail")?.error), /changed since it was chosen/);
});

test("without the video details module plugged in, Start works as before and reports the settings as not applied", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1", video: { port: false } });
  const result = (await h.broadcasts.start("UC1", { userId: "u1" })) as { encoderStarted: boolean };
  assert.equal(result.encoderStarted, true);
  await h.runBackground();
  assert.deepEqual(AFTER_START(h.calls), []);
  assert.equal((h.events.find((e) => e.kind === "video_settings_applied")?.detail as { notApplied?: string }).notApplied, "module_unavailable");
});

test("never-saved video settings: Start schedules nothing", async () => {
  const h = harness({ streamId: "STREAM1" });
  const result = (await h.broadcasts.start("UC1", { userId: "u1" })) as { videoSettings: string };
  assert.equal(result.videoSettings, "not_saved");
  await h.runBackground();
  assert.equal(h.events.filter((e) => e.kind.startsWith("video_settings")).length, 0);
});

test("Apply again: refused with Live writes off or with the stream off, before any YouTube call", async () => {
  const off = harness({ videoSettingsJson: SAVED_SETTINGS, intent: "on", broadcastId: "BC1", liveWrites: false });
  await assert.rejects(off.broadcasts.applyVideoSettingsAgain("UC1", { userId: "u1" }), (e: unknown) => e instanceof DomainError && e.code === "live_writes_disabled");
  const stopped = harness({ videoSettingsJson: SAVED_SETTINGS, intent: "off", broadcastId: null });
  await assert.rejects(stopped.broadcasts.applyVideoSettingsAgain("UC1", { userId: "u1" }), /not on/);
  assert.deepEqual(YOUTUBE_CALLS(off.calls), []);
  assert.deepEqual(YOUTUBE_CALLS(stopped.calls), []);
});

test("Apply again's dry run lists exactly what would be sent, and makes no call", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, intent: "on", broadcastId: "BC1" });
  const preview = await h.broadcasts.previewApplyVideoSettings("UC1");
  assert.equal(preview.broadcastId, "BC1");
  assert.equal(preview.units, 105);
  assert.deepEqual(preview.playlists, [{ id: "PL0123456789abcdefghijklmnopqrstuv", title: "Radio" }]);
  assert.deepEqual(h.calls, []);
});

// Independent review fixes (2026-10-19).
test("a refused playlist add that actually landed is not retried (looked again first): the video is never added twice", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1", video: { addRefusals: 1, refusalLanded: true } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.equal(h.calls.filter((c) => c.startsWith("playlistItems.insert")).length, 1);
  assert.equal((h.events.find((e) => e.kind === "video_settings_applied")?.detail as { ok: boolean }).ok, true);
});

test("the owner stops the stream while the settings are applied: the remaining steps are not sent", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB }, stopAfterFields: true } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.deepEqual(AFTER_START(h.calls), ["videos.update"]);
  const steps = (h.events.find((e) => e.kind === "video_settings_applied")?.detail as { steps: Array<{ step: string; skipped?: string }> }).steps;
  assert.deepEqual(steps.filter((s) => s.skipped === "stream_stopped").map((s) => s.step), ["thumbnail", "playlist:PL0123456789abcdefghijklmnopqrstuv"]);
});

test("a run that throws still leaves a failed summary (the page never waits forever)", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1", video: { crash: true } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  const summary = h.events.find((e) => e.kind === "video_settings_applied")?.detail as { ok: boolean; steps: Array<{ step: string; ok: boolean; error?: string }> };
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.steps.at(-1), { step: "run", ok: false, error: "the database went away" });
});

// Owner, Telegram msg 3153 (option а): the broadcast's title/description language is the channel's baseline, never the stream's field.
test("the language sent is the channel's baseline, whatever the stream's settings say; no baseline -> not sent", async () => {
  const german = JSON.stringify({ ...JSON.parse(SAVED_SETTINGS), defaultLanguage: "de" });
  const h = harness({ videoSettingsJson: german, streamId: "STREAM1", channelLanguage: "ja" });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.equal(h.applied[0]?.patch.defaultLanguage, "ja");

  const none = harness({ videoSettingsJson: german, streamId: "STREAM1", channelLanguage: null });
  await none.broadcasts.start("UC1", { userId: "u1" });
  await none.runBackground();
  assert.equal("defaultLanguage" in (none.applied[0]?.patch ?? {}), false);
});

// BL-205 AC-SEG-13: the old segment's application still running when a switch replaces it -- skipped as replaced, not stopped.
test("a segment switch replacing the broadcast mid-application skips the remaining steps as broadcast_replaced", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB }, replaceAfterFields: true } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  const steps = (h.events.find((e) => e.kind === "video_settings_applied")?.detail as { steps: Array<{ step: string; skipped?: string }> }).steps;
  assert.deepEqual(steps.filter((s) => s.skipped).map((s) => s.skipped), ["broadcast_replaced", "broadcast_replaced"]);
});

test("the thumbnail is sent with credentials resolved after the fields step, not the token Start began with (Tropico, 2026-10-20)", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB } } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.ok(h.tokens.insert && h.tokens.thumbnail);
  assert.notEqual(h.tokens.thumbnail, h.tokens.insert);
});

// ---------------------------------------------------------------------------
// BL-207 stage 3 (LIVE_LOCALIZATIONS_PLAN.md §2 stage 3, §3 AC-LL-04/05/06/08): the `localizations` step runs after the fields,
// only when they were written, with the stream's one stored set; no set -> no step, no call. Expected values by hand.
// ---------------------------------------------------------------------------

const SET = { de: { title: "Jazz Radio", description: "Rund um die Uhr" }, fr: { title: "Radio Jazz", description: "24h/24" } };
const SET_JSON = JSON.stringify(SET);
const EXPECTED = { tags: ["jazz", "lofi radio"], categoryId: "10", defaultLanguage: "en", defaultAudioLanguage: "zxx" };
const stepsOf = (h: ReturnType<typeof harness>) => (h.events.filter((e) => e.kind === "video_settings_applied").at(-1)?.detail as { steps: Array<{ step: string; ok: boolean; skipped?: string; error?: string }> }).steps;

test("AC-LL-06 (Start): the set goes to the broadcast's video right after the fields, before the thumbnail, with the fields' snippet values", async () => {
  const h = harness({ videoSettingsJson: WITH_THUMB, localizationsJson: SET_JSON, streamId: "STREAM1", video: { thumbnailFile: { kind: "jpeg", bytes: THUMB } } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.deepEqual(AFTER_START(h.calls).slice(0, 3), ["videos.update", "videos.update:localizations", "thumbnails.set:BC1:image/jpeg"]);
  assert.deepEqual(h.localized, [{ videoId: "BC1", localizations: SET, expected: EXPECTED }]);
  assert.deepEqual(stepsOf(h).map((s) => [s.step, s.ok]), [["fields", true], ["localizations", true], ["thumbnail", true], ["playlist:PL0123456789abcdefghijklmnopqrstuv", true]]);
  // Each step is an event like the others.
  assert.ok(h.events.some((e) => e.kind === "video_settings_step" && e.detail.step === "localizations" && e.detail.ok === true));
});

test("AC-LL-06 (Применить снова, segment): the same set, through the same step", async () => {
  const again = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, intent: "on", broadcastId: "BC1" });
  const result = await again.broadcasts.applyVideoSettingsAgain("UC1", { userId: "u1" });
  assert.equal(result.ok, true);
  assert.deepEqual(again.localized, [{ videoId: "BC1", localizations: SET, expected: EXPECTED }]);

  const segment = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, intent: "on", broadcastId: "BC7" });
  segment.broadcasts.applyVideoSettingsForSegment({ channelId: "UC1", broadcastId: "BC7", credentialRef: { userId: "u1" }, credentials: { accessToken: "t0" } as never });
  await new Promise((resolve) => setImmediate(resolve));
  await segment.runBackground();
  assert.deepEqual(segment.localized, [{ videoId: "BC7", localizations: SET, expected: EXPECTED }]);
  assert.equal(segment.events.find((e) => e.kind === "video_settings_applied")?.detail.trigger, "segment");
});

test("AC-LL-05: no stored set -- no localizations step and no call", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, streamId: "STREAM1" });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.deepEqual(h.localized, []);
  assert.ok(!stepsOf(h).some((s) => s.step === "localizations"));
  assert.ok(!h.calls.includes("videos.update:localizations"));
});

test("AC-LL-04: the fields step failed -- the localizations step is skipped and no call is made", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, streamId: "STREAM1", video: { applyFails: "quotaExceeded" } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.deepEqual(h.localized, []);
  assert.deepEqual(stepsOf(h).find((s) => s.step === "localizations"), { step: "localizations", ok: true, skipped: "fields_failed" });
});

test("AC-LL-08: a read-back without de is a failed step saying so; the thumbnail and playlists still run", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, streamId: "STREAM1", localized: { result: { verified: false, detail: "language missing: de" } } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  const steps = stepsOf(h);
  assert.deepEqual(steps.find((s) => s.step === "localizations"), { step: "localizations", ok: false, error: "YouTube reads back something else: language missing: de" });
  assert.ok(steps.some((s) => s.step.startsWith("playlist:") && s.ok));
});

test("a writer refusal (e.g. Live writes off) is the step's error, never an end of the run", async () => {
  const h = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, streamId: "STREAM1", localized: { throws: "Real YouTube write execution is disabled" } });
  await h.broadcasts.start("UC1", { userId: "u1" });
  await h.runBackground();
  assert.deepEqual(stepsOf(h).find((s) => s.step === "localizations"), { step: "localizations", ok: false, error: "Real YouTube write execution is disabled" });
});

test("a stored set without the writer plugged in is reported as not applied; a corrupt stored set is reported, never sent", async () => {
  const absent = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, streamId: "STREAM1", localized: { port: false } });
  await absent.broadcasts.start("UC1", { userId: "u1" });
  await absent.runBackground();
  const step = stepsOf(absent).find((s) => s.step === "localizations");
  assert.equal(step?.ok, false);
  assert.match(String(step?.error), /not available/);

  const corrupt = harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: '{"pt-br":{"title":"T","description":"D"}}', streamId: "STREAM1" });
  await corrupt.broadcasts.start("UC1", { userId: "u1" });
  await corrupt.runBackground();
  assert.deepEqual(corrupt.localized, []);
  assert.equal(stepsOf(corrupt).find((s) => s.step === "localizations")?.ok, false);
});

test("the dry runs count the translations: 1 read + 50 update + 1 read-back = 52 more units, and name the languages", async () => {
  const preview = await harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON }).broadcasts.previewStart("UC1");
  assert.equal(preview.videoSettingsApply?.units, 105 + 52);
  assert.deepEqual(preview.videoSettingsApply?.localizations, ["de", "fr"]);
  assert.equal(preview.units, 5 + 105 + 52);
  const again = await harness({ videoSettingsJson: SAVED_SETTINGS, localizationsJson: SET_JSON, intent: "on", broadcastId: "BC1" }).broadcasts.previewApplyVideoSettings("UC1");
  assert.equal(again.units, 105 + 52);
});
