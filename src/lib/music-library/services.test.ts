import assert from "node:assert/strict";
import test from "node:test";
import type { MusicLibraryFileRead } from "./contracts";
import { acceptancePercentOf, buildView, createMusicLibraryService, hoursOf, isStale, parseSnapshot } from "./services";

// BL-229 part A, AC-ML-01..07 (MUSIC_LIBRARY_PLAN.md §4). Every expected value is worked out by hand from the plan:
// 70 200 s / 3 600 = 19.5 h; 36 000 s / 3 600 = 10.0 h; 24 / 30 = 80 %.

const NOW = new Date("2026-10-27T12:00:00.000Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();

/** 13 batches × 30 tracks of the Japan control genre (AC-ML-01), batch 001 reviewed 24/30 and 002 not reviewed (AC-ML-04), a stub
 * genre with one batch (AC-ML-02), and 2 tracks without a genre in one batch (AC-ML-03). */
function snapshot(overrides: Record<string, unknown> = {}) {
  const control = Array.from({ length: 13 }, (_, i) => ({ batch: String(i + 1).padStart(3, "0"), genre: "rural-japan-control", playlist: "PLW3cmFOp7WbA", briefVersion: "3", tracks: 30, date: "2026-09-01", source: "suno" }));
  control[0] = { ...control[0], reviewed: 30, accepted: 24 } as (typeof control)[number];
  control[1] = { ...control[1], reviewed: 0, accepted: 0 } as (typeof control)[number];
  return {
    format: 1,
    generatedAt: ago(2),
    genres: [
      { id: "rural-japan-control", title: "Sounds of Rural Japan", label: "Control", color: "#4f9d69", playlist: "PLW3cmFOp7WbA", status: "active", batches: 13, tracks: 390, seconds: 70_200, neverUsedSeconds: 36_000, daysLeft: 41 },
      { id: "sleep-rain", title: "Sleep Rain", label: "Rain", status: "stub", batches: 1, tracks: 30, seconds: 5_400, neverUsedSeconds: 5_400, daysLeft: null },
    ],
    batches: [...control, { batch: "014", genre: "sleep-rain", tracks: 30 }, { batch: "015", genre: null, tracks: 2 }],
    tracksWithoutGenre: 2,
    ...overrides,
  };
}

function view(raw: unknown, now = NOW) {
  const parsed = parseSnapshot(JSON.stringify(raw));
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.reason);
  return buildView((parsed as { ok: true; snapshot: Parameters<typeof buildView>[0] }).snapshot, now);
}

test("AC-ML-01: the Japan control genre shows 13 batches, 390 tracks, 19.5 h, 10.0 h never used, 41 days left", () => {
  const row = view(snapshot()).genres[0];
  assert.equal(row.title, "Sounds of Rural Japan");
  assert.equal(row.status, "active");
  assert.equal(row.playlist, "PLW3cmFOp7WbA");
  assert.equal(row.batches, 13);
  assert.equal(row.tracks, 390);
  assert.equal(row.hours, 19.5);
  assert.equal(row.neverUsedHours, 10);
  assert.equal(row.daysLeft, 41);
  assert.equal(row.batchRows.length, 13);
  assert.deepEqual(row.batchRows.map((b) => b.batch).slice(0, 3), ["001", "002", "003"]);
});

test("hours keep one decimal: 70 200 s → 19.5, 36 000 s → 10, 0 → 0, 3 599 s → 1.0, 179 s → 0", () => {
  assert.equal(hoursOf(70_200), 19.5);
  assert.equal(hoursOf(36_000), 10);
  assert.equal(hoursOf(0), 0);
  assert.equal(hoursOf(3_599), 1);
  assert.equal(hoursOf(179), 0);
  assert.equal(hoursOf(5_400), 1.5);
});

test("AC-ML-02: a stub genre with one batch keeps its own label and the status stub; daysLeft null stays unknown", () => {
  const row = view(snapshot()).genres[1];
  assert.equal(row.label, "Rain");
  assert.equal(row.status, "stub");
  assert.equal(row.color, null);
  assert.equal(row.playlist, null);
  assert.equal(row.daysLeft, null);
  assert.deepEqual(row.batchRows.map((b) => b.batch), ["014"]);
  // daysLeft left out altogether is unknown too.
  const raw = snapshot();
  delete (raw.genres[1] as { daysLeft?: unknown }).daysLeft;
  assert.equal(view(raw).genres[1].daysLeft, null);
});

test("AC-ML-03: 2 tracks without a genre give the without-genre row with its batch; 0 gives no row", () => {
  const withRow = view(snapshot());
  assert.equal(withRow.withoutGenre?.tracks, 2);
  assert.deepEqual(withRow.withoutGenre?.batchRows.map((b) => b.batch), ["015"]);
  const none = snapshot({ tracksWithoutGenre: 0 });
  assert.equal(view(none).withoutGenre, null);
});

test("AC-ML-04: 24 of 30 reviewed is 80 %; 0 reviewed is no percent (shown «—», never 0 %)", () => {
  const rows = view(snapshot()).genres[0].batchRows;
  assert.equal(rows[0].accepted, 24);
  assert.equal(rows[0].reviewed, 30);
  assert.equal(rows[0].acceptancePercent, 80);
  assert.equal(rows[1].reviewed, 0);
  assert.equal(rows[1].acceptancePercent, null);
  assert.equal(rows[2].reviewed, null);
  assert.equal(rows[2].acceptancePercent, null);
  assert.equal(acceptancePercentOf(30, 30), 100);
  assert.equal(acceptancePercentOf(3, 2), 67);
  assert.equal(acceptancePercentOf(30, 0), 0);
  assert.equal(acceptancePercentOf(30, undefined), null);
});

test("AC-ML-05: generated 25 h ago is stale, 23 h ago is not; exactly 24 h is not stale; the age is in whole minutes", () => {
  assert.equal(view(snapshot({ generatedAt: ago(25) })).stale, true);
  const fresh = view(snapshot({ generatedAt: ago(23) }));
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMinutes, 23 * 60);
  assert.equal(isStale(ago(24), NOW), false);
  assert.equal(isStale(new Date(NOW.getTime() - 24 * HOUR - 1).toISOString(), NOW), true);
  // A snapshot time ahead of this computer's clock is not stale and is 0 minutes old.
  const ahead = view(snapshot({ generatedAt: new Date(NOW.getTime() + HOUR).toISOString() }));
  assert.equal(ahead.stale, false);
  assert.equal(ahead.ageMinutes, 0);
});

test("unknown extra fields are ignored at every level", () => {
  const raw = snapshot({ factoryVersion: "2.5.42", plannedSlots: [1, 2] });
  (raw.genres[0] as Record<string, unknown>).briefPath = "05 Docs/music/x.md";
  (raw.batches[0] as Record<string, unknown>).ledgerRow = 7;
  const v = view(raw);
  assert.equal(v.genres[0].hours, 19.5);
  assert.equal("briefPath" in v.genres[0], false);
});

test("AC-ML-06: not JSON, no genres, or any wrong required field makes the whole file unreadable with a reason, never half-shown", () => {
  const notJson = parseSnapshot("{ not json");
  assert.equal(notJson.ok, false);
  assert.match((notJson as { reason: string }).reason, /^not JSON/);

  const cases: Array<[string, unknown, RegExp]> = [
    ["no genres", (() => { const raw = snapshot() as Record<string, unknown>; delete raw.genres; return raw; })(), /^genres: /],
    ["format 2", snapshot({ format: 2 }), /^format: /],
    ["bad time", snapshot({ generatedAt: "yesterday" }), /^generatedAt: must be an ISO 8601 time/],
    ["no tracksWithoutGenre", (() => { const raw = snapshot() as Record<string, unknown>; delete raw.tracksWithoutGenre; return raw; })(), /^tracksWithoutGenre: /],
    ["genre without seconds", (() => { const raw = snapshot(); delete (raw.genres[1] as { seconds?: unknown }).seconds; return raw; })(), /^genres\.1\.seconds: /],
    ["unknown status", (() => { const raw = snapshot(); (raw.genres[0] as { status: string }).status = "retired"; return raw; })(), /^genres\.0\.status: /],
    ["bad colour", (() => { const raw = snapshot(); (raw.genres[0] as { color: string }).color = "green"; return raw; })(), /^genres\.0\.color: must be #rrggbb/],
    ["negative tracks", (() => { const raw = snapshot(); (raw.batches[3] as { tracks: number }).tracks = -1; return raw; })(), /^batches\.3\.tracks: /],
    ["accepted over reviewed", (() => { const raw = snapshot(); Object.assign(raw.batches[0], { reviewed: 10, accepted: 11 }); return raw; })(), /^batches\.0\.accepted: accepted is more than reviewed/],
    ["unknown genre", (() => { const raw = snapshot(); (raw.batches[13] as { genre: string }).genre = "jazz"; return raw; })(), /batch "014" names genre "jazz", which is not in genres/],
    ["genre twice", (() => { const raw = snapshot(); raw.genres.push({ ...raw.genres[1] }); return raw; })(), /genre "sleep-rain" is listed twice/],
    ["top level is an array", [], /expected object/],
  ];
  for (const [name, raw, reason] of cases) {
    const parsed = parseSnapshot(JSON.stringify(raw));
    assert.equal(parsed.ok, false, name);
    assert.match((parsed as { reason: string }).reason, reason, name);
  }
});

function service(files: Record<string, MusicLibraryFileRead>, workspaces: Record<string, string>) {
  const asked: string[] = [];
  const read: string[] = [];
  const svc = createMusicLibraryService({
    getWorkspace: async (channelId) => {
      asked.push(channelId);
      return workspaces[channelId] ? { configured: true, path: workspaces[channelId] } : { configured: false };
    },
    files: {
      read: async (workspace) => {
        read.push(workspace);
        return files[workspace] ?? { kind: "missing" };
      },
    },
    now: () => NOW,
  });
  return { svc, asked, read };
}

test("AC-ML-06: each state is distinct -- no workspace, workspace unreachable, no file, unreadable (reason), ok", async () => {
  const { svc } = service(
    {
      "/ws/ok": { kind: "text", text: JSON.stringify(snapshot()) },
      "/ws/bad": { kind: "text", text: "[1," },
      "/ws/link": { kind: "refused", reason: "99 Data Exchange/Sent to YTM/music/library.json resolves outside the channel workspace" },
      "/ws/gone": { kind: "workspace_unavailable", reason: "path does not exist" },
    },
    { UC_none: "", UC_ok: "/ws/ok", UC_bad: "/ws/bad", UC_link: "/ws/link", UC_gone: "/ws/gone", UC_empty: "/ws/empty" }
  );
  assert.deepEqual(await svc.read("UC_none"), { status: "no_workspace" });
  assert.deepEqual(await svc.read("UC_empty"), { status: "no_file" });
  assert.deepEqual(await svc.read("UC_gone"), { status: "workspace_unavailable", reason: "path does not exist" });
  const bad = await svc.read("UC_bad");
  assert.equal(bad.status, "unreadable");
  assert.match((bad as { reason: string }).reason, /^not JSON/);
  assert.deepEqual(await svc.read("UC_link"), { status: "unreadable", reason: "99 Data Exchange/Sent to YTM/music/library.json resolves outside the channel workspace" });
  const ok = await svc.read("UC_ok");
  assert.equal(ok.status, "ok");
  assert.equal((ok as { view: { genres: unknown[] } }).view.genres.length, 2);
});

test("AC-ML-07: channel A's request looks up only channel A's workspace and reads only that folder", async () => {
  const { svc, asked, read } = service({ "/ws/A": { kind: "text", text: JSON.stringify(snapshot()) }, "/ws/B": { kind: "text", text: JSON.stringify(snapshot({ tracksWithoutGenre: 9 })) } }, { UC_A: "/ws/A", UC_B: "/ws/B" });
  const result = await svc.read("UC_A");
  assert.deepEqual(asked, ["UC_A"]);
  assert.deepEqual(read, ["/ws/A"]);
  assert.equal((result as { view: { withoutGenre: { tracks: number } } }).view.withoutGenre.tracks, 2);
});
