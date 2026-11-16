import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import type { BackupSnapshot } from "@/lib/backup/contracts";
import type { CaptionActor, CaptionWriteInput, VideoCaptionTrack, VideoCaptionsDeps } from "./contracts";
import { sha256Hex } from "./hash";
import { createVideoCaptionsServices } from "./services";

// BL-269 writer acceptance (VIDEO_CAPTIONS_PLAN.md §3.2, §3.7, §7: AC-CAP-11..22, AC-CAP-38..47; ADR 0074 §4, §6, §10). Expected
// behaviour from the plan and the YouTube reference, never from the implementation:
// - ASR tracks never touched or counted; a standard/forced English track not recorded as ours is foreign (refused without overwrite);
// - ours with the same SHA-256 -> already present, no write; ours with another -> refused without overwrite;
// - overwrite: exactly one standard non-draft English track -> its content replaced (download backup first); none -> a plain insert;
//   two -> ambiguous; forced -> refused; draft -> refused; the runner never overwrites;
// - order: device gate, video read, list, quota guard, (dry run stops), backup (+download), identity, attempt mark, write, read-back;
// - budgets: insert 550, overwrite 800, dry run 51.

const VTT = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n");
const SHA = sha256Hex(VTT);
const OTHER_SHA = "f".repeat(64);
const owner: CaptionActor = { kind: "owner", userId: "owner-1" };
const producer: CaptionActor = { kind: "producer" };
const upload: CaptionActor = { kind: "upload", uploadId: "up-1", userId: "owner-1" };
const creds = { credentialRef: { userId: "owner-1" }, credentials: { accessToken: "t" } as unknown as ResolvedCredentials };

const track = (over: Partial<VideoCaptionTrack> & { id: string }): VideoCaptionTrack => ({
  language: "en",
  name: "",
  trackKind: "standard",
  isDraft: false,
  status: "serving",
  failureReason: null,
  lastUpdated: "2026-11-10T10:00:00Z",
  ...over,
});

type World = {
  tracks: VideoCaptionTrack[];
  /** What a list returns after the write (default: computed from the write). */
  afterTracks?: VideoCaptionTrack[][];
  frame?: { width: number; height: number } | null;
  videoChannel?: string;
  enabled?: boolean;
  quota?: "allow" | "insufficient" | "unknown";
  downloadFails?: boolean;
  backupHealthy?: boolean;
  identityFails?: boolean;
  insertError?: unknown;
  /** What a list returns after a failed insert (the lost answer's track). */
  relist?: VideoCaptionTrack[];
  scopeMissing?: boolean;
  deviceBusy?: boolean;
};

function harness(world: World) {
  const calls: string[] = [];
  const audits: Array<{ eventType: string; detail: Record<string, unknown> }> = [];
  const backups: BackupSnapshot[] = [];
  const marks: string[][] = [];
  let listCount = 0;
  let written: VideoCaptionTrack[] | null = null;
  const deps: VideoCaptionsDeps = {
    async credentials() {
      calls.push("credentials");
      if (world.scopeMissing) throw new DomainError({ code: "AUTH_SCOPE_INSUFFICIENT", message: "missing", details: {} });
      return creds;
    },
    captionsEnabled: async () => world.enabled ?? true,
    async readVideo() {
      calls.push("readVideo");
      return { channelId: world.videoChannel ?? "UC_wwe", frame: world.frame === undefined ? { width: 1920, height: 1080 } : world.frame };
    },
    async listTracks() {
      calls.push("list");
      listCount += 1;
      if (written === null) return world.tracks;
      const scripted = world.afterTracks?.shift();
      return scripted ?? written;
    },
    async downloadTrack(_c, trackId) {
      calls.push(`download:${trackId}`);
      if (world.downloadFails) throw Object.assign(new Error("couldNotConvert"), { code: 400 });
      return Buffer.from("old text");
    },
    async checkUnits(units) {
      calls.push(`quota:${units}`);
      return { decision: world.quota ?? "allow", remainingUnits: 100, resetsAt: null };
    },
    async assertDeviceAvailable() {
      calls.push("device");
      if (world.deviceBusy) throw Object.assign(new Error("lock"), { code: "operation_lock_held" });
    },
    backup: {
      checkInfrastructureHealth: async () => (world.backupHealthy === false ? { healthy: false, error: "disk" } : { healthy: true }),
      async captureBackup({ snapshot }) {
        calls.push("backup");
        backups.push(snapshot);
        return { path: "/backups/x.json", capturedAt: "now" };
      },
    },
    async assertWriteChannel() {
      calls.push("identity");
      if (world.identityFails) throw new DomainError({ code: "WRITE_CHANNEL_MISMATCH", message: "wrong channel", details: {} });
    },
    async markAttempt({ trackIdsBefore }) {
      calls.push("mark");
      marks.push(trackIdsBefore);
    },
    async insert(_c, args) {
      calls.push(`insert:${args.language}:${args.name}:${sha256Hex(args.media.bytes) === SHA ? "bytes-ok" : "bytes-bad"}`);
      if (world.insertError) {
        if (world.relist) written = world.relist;
        throw world.insertError;
      }
      written = [...world.tracks, track({ id: "NEW", name: args.name, lastUpdated: "2026-11-17T12:00:00Z" })];
      return { trackId: "NEW" };
    },
    async update(_c, args) {
      calls.push(`update:${args.trackId}:${sha256Hex(args.media.bytes) === SHA ? "bytes-ok" : "bytes-bad"}`);
      written = world.tracks.map((t) => (t.id === args.trackId ? { ...t, lastUpdated: "2026-11-17T12:00:00Z" } : t));
    },
    async audit({ eventType, detail }) {
      audits.push({ eventType, detail });
    },
    newOperationId: () => "op-1",
    sleep: async () => void calls.push("sleep"),
  };
  return { services: createVideoCaptionsServices(deps), calls, audits, backups, marks, lists: () => listCount };
}

const input = (over: Partial<CaptionWriteInput> = {}): CaptionWriteInput => ({
  channelId: "UC_wwe",
  videoId: "vid27",
  video: "V27",
  file: { name: "V27_captions.en.vtt", bytes: VTT },
  language: "en",
  name: "",
  sha256: SHA,
  durationSeconds: 600,
  ownTracks: [],
  ...over,
});

async function rejectsWith(promise: Promise<unknown>, code: string, reason?: string) {
  await assert.rejects(promise, (error: unknown) => {
    const e = error as { code?: string; details?: { reason?: string } };
    assert.equal(e.code, code);
    if (reason) assert.equal(e.details?.reason, reason);
    return true;
  });
}
const writes = (calls: string[]) => calls.filter((c) => /^(insert|update|delete)/.test(c));

test("AC-CAP-11/12/14/19/21 insert: order, exact call, backup, read-back serving -> verified, audit", async () => {
  const h = harness({ tracks: [track({ id: "DE", language: "de" })] });
  const result = await h.services.write(input({ name: "English" }), owner);
  assert.deepEqual(h.calls, ["device", "credentials", "readVideo", "list", "quota:550", "backup", "identity", "insert:en:English:bytes-ok", "list"]);
  assert.equal(result.mode, "insert");
  assert.equal(result.written, true);
  assert.equal(result.trackId, "NEW");
  assert.equal(result.verified, true);
  assert.equal(result.units, 550);
  const snapshot = h.backups[0] as Extract<BackupSnapshot, { kind: "video_captions" }>;
  assert.equal(snapshot.kind, "video_captions");
  assert.deepEqual(snapshot.tracks.map((t) => t.id), ["DE"]);
  assert.equal(Buffer.from(snapshot.sending.base64, "base64").toString("utf8"), new TextDecoder().decode(VTT));
  assert.equal(snapshot.replaced, null);
  assert.deepEqual(h.audits.map((a) => a.eventType), ["BACKUP", "RESULT", "VERIFICATION"]);
  for (const a of h.audits) {
    assert.equal(a.detail.source, "video_captions");
    assert.equal(a.detail.actor, "owner");
    assert.equal(a.detail.sha256, SHA);
  }
});

test("AC-CAP-13 a video of another channel -> video_not_in_channel, nothing backed up or written", async () => {
  const h = harness({ tracks: [], videoChannel: "UC_other" });
  await rejectsWith(h.services.write(input(), owner), "video_not_in_channel");
  assert.deepEqual(writes(h.calls), []);
  assert.equal(h.backups.length, 0);
});

test("AC-CAP-13 the identity check fails -> no write (after the backup, before the call)", async () => {
  const h = harness({ tracks: [], identityFails: true });
  await rejectsWith(h.services.write(input(), owner), "WRITE_CHANNEL_MISMATCH");
  assert.deepEqual(writes(h.calls), []);
});

test("AC-CAP-14 a failed backup (storage down) -> no write", async () => {
  const h = harness({ tracks: [], backupHealthy: false });
  await rejectsWith(h.services.write(input(), owner), "backup_item_failed");
  assert.deepEqual(writes(h.calls), []);
});

test("AC-CAP-15 an ASR English track only -> insert proceeds; the ASR track is untouched and kept", async () => {
  const asr = track({ id: "ASR1", trackKind: "asr", name: "" });
  const h = harness({ tracks: [asr] });
  const result = await h.services.write(input(), owner);
  assert.equal(result.mode, "insert");
  assert.deepEqual(result.englishTracks, []);
  assert.equal(result.verified, true);
  assert.deepEqual(writes(h.calls), ["insert:en::bytes-ok"]);
});

test("AC-CAP-16 / AC-CAP-38 a foreign standard or forced English track without overwrite -> captions_foreign_track, no write", async () => {
  for (const kind of ["standard", "forced"]) {
    for (const actor of [owner, producer, upload]) {
      const h = harness({ tracks: [track({ id: "F1", trackKind: kind, language: "en-US" })] });
      await rejectsWith(h.services.write(input(), actor), "captions_foreign_track");
      assert.deepEqual(writes(h.calls), []);
      assert.equal(h.calls.some((c) => c.startsWith("download")), false);
    }
  }
});

test("AC-CAP-17 ours with the same SHA-256 -> already_present (no write); with another -> captions_own_track_differs", async () => {
  const same = harness({ tracks: [track({ id: "OURS" })] });
  const r = await same.services.write(input({ ownTracks: [{ trackId: "OURS", sha256: SHA }] }), upload);
  assert.deepEqual([r.mode, r.alreadyPresent, r.written, r.trackId, r.verified], ["none", true, false, "OURS", true]);
  assert.deepEqual(writes(same.calls), []);
  const differs = harness({ tracks: [track({ id: "OURS" })] });
  await rejectsWith(differs.services.write(input({ ownTracks: [{ trackId: "OURS", sha256: OTHER_SHA }] }), upload), "captions_own_track_differs");
  assert.deepEqual(writes(differs.calls), []);
});

test("AC-CAP-18 / AC-CAP-20 a backed-up track disappears after the insert -> written but not verified", async () => {
  const de = track({ id: "DE", language: "de" });
  const h = harness({ tracks: [de], afterTracks: [[track({ id: "NEW", lastUpdated: "2026-11-17T12:00:00Z" })]] });
  const result = await h.services.write(input(), owner);
  assert.equal(result.written, true);
  assert.equal(result.verified, false);
  assert.match(result.verificationDetail ?? "", /DE \(de\) disappeared/);
});

test("AC-CAP-19 failed -> not verified with the reason; syncing -> one bounded re-read, then pending", async () => {
  const failed = harness({ tracks: [], afterTracks: [[track({ id: "NEW", status: "failed", failureReason: "processingFailed" })]] });
  const r1 = await failed.services.write(input(), owner);
  assert.deepEqual([r1.written, r1.verified, r1.pending], [true, false, false]);
  assert.match(r1.verificationDetail ?? "", /processingFailed/);
  const syncing = harness({ tracks: [], afterTracks: [[track({ id: "NEW", status: "syncing" })], [track({ id: "NEW", status: "syncing" })]] });
  const r2 = await syncing.services.write(input(), owner);
  assert.deepEqual([r2.verified, r2.pending], [false, true]);
  assert.equal(syncing.calls.filter((c) => c === "sleep").length, 1);
  assert.equal(syncing.lists(), 3, "list before, read-back, one re-read -- bounded");
  const thenServing = harness({ tracks: [], afterTracks: [[track({ id: "NEW", status: "syncing" })], [track({ id: "NEW", status: "serving" })]] });
  assert.equal((await thenServing.services.write(input(), owner)).verified, true);
});

test("AC-CAP-19 read-back of a draft, a wrong name or an ASR kind -> not verified", async () => {
  for (const after of [track({ id: "NEW", isDraft: true }), track({ id: "NEW", name: "Other" }), track({ id: "NEW", trackKind: "asr" })]) {
    const h = harness({ tracks: [], afterTracks: [[after]] });
    const r = await h.services.write(input(), owner);
    assert.deepEqual([r.written, r.verified], [true, false]);
  }
});

test("AC-CAP-20 after a successful insert, an unreadable read-back and failing audits are still reported as written", async () => {
  const r = await createVideoCaptionsServices(unreadableDeps()).write(input(), owner);
  assert.deepEqual([r.written, r.trackId, r.verified], [true, "NEW", false]);
  assert.match(r.verificationDetail ?? "", /could not be read back/);
});

/** Deps whose every list after the write fails and every audit after the BACKUP throws. */
function unreadableDeps(): VideoCaptionsDeps {
  let wrote = false;
  return {
    credentials: async () => creds,
    captionsEnabled: async () => true,
    readVideo: async () => ({ channelId: "UC_wwe", frame: { width: 1920, height: 1080 } }),
    listTracks: async () => {
      if (wrote) throw new Error("network");
      return [];
    },
    downloadTrack: async () => Buffer.from("x"),
    checkUnits: async () => ({ decision: "allow" }),
    assertDeviceAvailable: async () => undefined,
    backup: { checkInfrastructureHealth: async () => ({ healthy: true }), captureBackup: async () => ({ path: "/b", capturedAt: "now" }) },
    assertWriteChannel: async () => undefined,
    markAttempt: async () => undefined,
    insert: async () => ((wrote = true), { trackId: "NEW" }),
    update: async () => undefined,
    audit: async ({ eventType }) => {
      if (eventType !== "BACKUP") throw new Error("audit store down");
    },
    newOperationId: () => "op",
    sleep: async () => undefined,
  };
}

test("AC-CAP-21 dry run: no backup, no write, no RESULT audit; units 51; the real budget stated", async () => {
  const h = harness({ tracks: [] });
  const r = await h.services.write(input({ dryRun: true }), owner);
  assert.deepEqual(h.calls, ["credentials", "readVideo", "list"]);
  assert.deepEqual([r.dryRun, r.units, r.writeUnits, r.written, r.backupPath], [true, 51, 550, false, null]);
  assert.equal(h.audits.length, 0);
});

test("AC-CAP-22 a grant without youtube.force-ssl -> captions_scope_missing, no write", async () => {
  const h = harness({ tracks: [], scopeMissing: true });
  await rejectsWith(h.services.write(input(), upload), "captions_scope_missing");
  assert.deepEqual(writes(h.calls), []);
});

test("validation: the bytes must hash to the stated SHA-256, parse, be en, a V code, and the switch on NOW", async () => {
  await rejectsWith(harness({ tracks: [] }).services.write(input({ sha256: OTHER_SHA }), owner), "captions_invalid", "sha256");
  const srt = new TextEncoder().encode("1\n00:00:01,000 --> 00:00:03,000\nHi\n");
  await rejectsWith(harness({ tracks: [] }).services.write(input({ file: { name: "x.vtt", bytes: srt }, sha256: sha256Hex(srt) }), owner), "captions_invalid", "format");
  await rejectsWith(harness({ tracks: [] }).services.write(input({ language: "en-US" }), owner), "captions_invalid", "language");
  await rejectsWith(harness({ tracks: [] }).services.write(input({ video: "S14" }), owner), "captions_invalid", "not_horizontal");
  await rejectsWith(harness({ tracks: [], enabled: false }).services.write(input(), upload), "captions_invalid", "channel_disabled");
  await rejectsWith(harness({ tracks: [] }).services.write(input({ file: { name: "x.vtt", bytes: new Uint8Array() } }), owner), "captions_invalid", "size");
});

test("AC-CAP-32 orientation: YouTube's vertical frame refused; no frame -> the memo; neither -> orientation_unknown", async () => {
  await rejectsWith(harness({ tracks: [], frame: { width: 1080, height: 1920 } }).services.write(input(), owner), "captions_invalid", "not_horizontal");
  await rejectsWith(harness({ tracks: [], frame: null }).services.write(input(), owner), "captions_invalid", "orientation_unknown");
  const memo = harness({ tracks: [], frame: null });
  assert.equal((await memo.services.write(input({ frameFallback: "horizontal" }), owner)).verified, true);
  await rejectsWith(harness({ tracks: [], frame: null }).services.write(input({ frameFallback: "vertical" }), owner), "captions_invalid", "not_horizontal");
});

test("AC-CAP-34 the device gate refuses before any read, backup or write (owner and Producer); the runner has none", async () => {
  for (const actor of [owner, producer]) {
    const h = harness({ tracks: [], deviceBusy: true });
    await assert.rejects(h.services.write(input(), actor), /lock/);
    assert.deepEqual(h.calls, ["device"]);
  }
  const runner = harness({ tracks: [], deviceBusy: true });
  await runner.services.write(input(), upload);
  assert.equal(runner.calls.includes("device"), false);
});

test("AC-CAP-25 the quota guard short -> youtube_quota_exceeded, nothing backed up or written; unknown is not judged", async () => {
  const h = harness({ tracks: [], quota: "insufficient" });
  await rejectsWith(h.services.write(input(), upload), "youtube_quota_exceeded");
  assert.deepEqual(writes(h.calls), []);
  assert.equal(h.backups.length, 0);
  assert.equal((await harness({ tracks: [], quota: "unknown" }).services.write(input(), upload)).written, true);
});

test("AC-CAP-27 lost answer: a mark, then a retry finds an unlisted standard en track with the name -> adopted, one insert in total", async () => {
  const first = harness({ tracks: [track({ id: "DE", language: "de" })] });
  await first.services.write(input({ name: "English" }), upload);
  assert.deepEqual(first.marks, [["DE"]], "the mark names the tracks listed before the insert");
  // The retry: the track made by the lost answer is there.
  const retry = harness({ tracks: [track({ id: "DE", language: "de" }), track({ id: "LOST", name: "English" })] });
  const r = await retry.services.write(input({ name: "English", adoptAfterAttempt: { trackIdsBefore: ["DE"] } }), upload);
  assert.deepEqual([r.adopted, r.trackId, r.verified], [true, "LOST", true]);
  assert.deepEqual(writes(retry.calls), []);
  // Without the mark the same track is foreign (no adoption on the owner's or Producer's path).
  await rejectsWith(harness({ tracks: [track({ id: "LOST", name: "English" })] }).services.write(input({ name: "English" }), producer), "captions_foreign_track");
});

test("AC-CAP-27 a 409 captionExists on the runner's insert -> the new track is adopted, not inserted twice; elsewhere it fails", async () => {
  const conflict = () => Object.assign(new Error("exists"), { response: { status: 409, data: { error: { errors: [{ reason: "captionExists" }] } } } });
  const lost = track({ id: "LOST", name: "English" });
  const h = harness({ tracks: [], insertError: conflict(), relist: [lost] });
  const r = await h.services.write(input({ name: "English" }), upload);
  assert.deepEqual([r.adopted, r.trackId, r.verified], [true, "LOST", true]);
  assert.equal(writes(h.calls).length, 1, "one insert attempt in total");
  const ownerPath = harness({ tracks: [], insertError: conflict(), relist: [lost] });
  await assert.rejects(ownerPath.services.write(input({ name: "English" }), owner), /exists/);
});

// ---- Explicit overwrite (owner msg 4660) ----

test("AC-CAP-38 the runner never overwrites (refused before anything is read)", async () => {
  const h = harness({ tracks: [track({ id: "F1" })] });
  await rejectsWith(h.services.write(input({ overwrite: true }), upload), "validation_failed");
  assert.deepEqual(h.calls, []);
});

test("AC-CAP-39 / AC-CAP-44 overwrite of one foreign standard track: list, quota 800, download, backup, identity, one update", async () => {
  const h = harness({ tracks: [track({ id: "F1", name: "Mine", language: "en-GB" }), track({ id: "ASR1", trackKind: "asr" })] });
  const r = await h.services.write(input({ overwrite: true }), producer);
  assert.deepEqual(h.calls, ["device", "credentials", "readVideo", "list", "quota:800", "download:F1", "backup", "identity", "update:F1:bytes-ok", "list"]);
  assert.deepEqual([r.mode, r.trackId, r.trackName, r.verified, r.units], ["update", "F1", "Mine", true, 800]);
  assert.equal(r.target?.ours, false);
  const snapshot = h.backups[0] as Extract<BackupSnapshot, { kind: "video_captions" }>;
  assert.deepEqual([snapshot.mode, snapshot.replaced?.trackId, Buffer.from(snapshot.replaced!.base64, "base64").toString()], ["update", "F1", "old text"]);
  const result = h.audits.find((a) => a.eventType === "RESULT")!;
  assert.deepEqual([result.detail.event, result.detail.mode, result.detail.actor, result.detail.previousLastUpdated], ["video_captions.updated", "update", "producer", "2026-11-10T10:00:00Z"]);
});

test("AC-CAP-40 overwrite of our own track: another SHA -> update; the same SHA -> already_present, no download, no write", async () => {
  const differs = harness({ tracks: [track({ id: "OURS" })] });
  const r = await differs.services.write(input({ overwrite: true, ownTracks: [{ trackId: "OURS", sha256: OTHER_SHA }] }), owner);
  assert.deepEqual([r.mode, r.target?.ours], ["update", true]);
  const same = harness({ tracks: [track({ id: "OURS" })] });
  const s = await same.services.write(input({ overwrite: true, ownTracks: [{ trackId: "OURS", sha256: SHA }] }), owner);
  assert.deepEqual([s.mode, s.alreadyPresent], ["none", true]);
  assert.equal(same.calls.some((c) => c.startsWith("download") || c.startsWith("update") || c.startsWith("insert")), false);
});

test("AC-CAP-41 overwrite with no English standard track -> a plain insert with the insert budget", async () => {
  const h = harness({ tracks: [track({ id: "ASR1", trackKind: "asr" }), track({ id: "DE", language: "de" })] });
  const r = await h.services.write(input({ overwrite: true }), owner);
  assert.deepEqual([r.mode, r.units, r.target], ["insert", 550, null]);
  assert.deepEqual(writes(h.calls), ["insert:en::bytes-ok"]);
});

test("AC-CAP-42 overwrite refused: two English standard tracks, a forced one, a draft; ASR never counted", async () => {
  const cases: Array<[VideoCaptionTrack[], string]> = [
    [[track({ id: "A" }), track({ id: "B", language: "en-US" })], "captions_track_ambiguous"],
    [[track({ id: "A", trackKind: "forced" }), track({ id: "ASR", trackKind: "asr" })], "captions_track_forced"],
    [[track({ id: "A", isDraft: true })], "captions_track_draft"],
  ];
  for (const [tracks, code] of cases) {
    const h = harness({ tracks });
    await rejectsWith(h.services.write(input({ overwrite: true }), owner), code);
    assert.deepEqual(writes(h.calls), []);
    assert.equal(h.backups.length, 0);
  }
});

test("AC-CAP-43 overwrite: the download fails -> backup_item_failed, no backup written, no update", async () => {
  const h = harness({ tracks: [track({ id: "F1" })], downloadFails: true });
  await rejectsWith(h.services.write(input({ overwrite: true }), owner), "backup_item_failed");
  assert.deepEqual(writes(h.calls), []);
  assert.equal(h.backups.length, 0);
});

test("AC-CAP-44 overwrite with the quota short -> youtube_quota_exceeded before any download", async () => {
  const h = harness({ tracks: [track({ id: "F1" })], quota: "insufficient" });
  await rejectsWith(h.services.write(input({ overwrite: true }), owner), "youtube_quota_exceeded");
  assert.equal(h.calls.some((c) => c.startsWith("download")), false);
  assert.deepEqual(writes(h.calls), []);
});

test("AC-CAP-45 overwrite read-back: lastUpdated unchanged, the id gone, another track changed, the name changed -> not verified", async () => {
  const f1 = track({ id: "F1", name: "Mine" });
  const de = track({ id: "DE", language: "de" });
  const cases: Array<[VideoCaptionTrack[], RegExp]> = [
    [[f1, de], /previous version/],
    [[de], /F1 is not listed/],
    [[{ ...f1, lastUpdated: "2026-11-17T12:00:00Z" }, { ...de, lastUpdated: "2026-11-17T12:00:01Z" }], /DE \(de\) changed/],
    [[{ ...f1, name: "Other", lastUpdated: "2026-11-17T12:00:00Z" }, de], /name/],
  ];
  for (const [after, detail] of cases) {
    const h = harness({ tracks: [f1, de], afterTracks: [after] });
    const r = await h.services.write(input({ overwrite: true }), owner);
    assert.deepEqual([r.written, r.verified], [true, false]);
    assert.match(r.verificationDetail ?? "", detail);
  }
});

test("AC-CAP-46 overwrite dry run: no download, no backup, no write; units 51; names the track; the owner's pin refuses a change", async () => {
  const h = harness({ tracks: [track({ id: "F1", name: "Mine" })] });
  const r = await h.services.write(input({ overwrite: true, dryRun: true }), owner);
  assert.deepEqual(h.calls, ["credentials", "readVideo", "list"]);
  assert.deepEqual([r.mode, r.units, r.writeUnits, r.target?.trackId, r.target?.name], ["update", 51, 800, "F1", "Mine"]);
  const changed = harness({ tracks: [track({ id: "F2" })] });
  await rejectsWith(changed.services.write(input({ overwrite: true, expectedTrackId: "F1" }), owner), "captions_track_changed");
  assert.deepEqual(writes(changed.calls), []);
  // The preview said "an insert" (null) but a track appeared since.
  await rejectsWith(harness({ tracks: [track({ id: "F2" })] }).services.write(input({ overwrite: true, expectedTrackId: null }), owner), "captions_track_changed");
  // The pin matches: written.
  assert.equal((await harness({ tracks: [track({ id: "F1" })] }).services.write(input({ overwrite: true, expectedTrackId: "F1" }), owner)).written, true);
});
