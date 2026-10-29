import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISK_GUARD_THRESHOLD_GB, DISK_GUARD_TICK_MS, GB, INITIAL_DISK_GUARD_STATE, type DiskConsumer, type DiskVolume } from "./contracts";
import { createDiskGuard, decideDiskAlert, diskAlertMessage, diskGuardSettingsFromJson, diskGuardStateFromJson } from "./services";

// BL-237 (owner, Telegram 2026-10-30, msgs 3864-3866). Requirements: checked every 15 min; free space below the threshold
// (default 20 GB, a setting of this computer) -> ONE bell notice and ONE System-topic message with the free GB and the top
// consumers; re-alert only after recovery above threshold + 2 GB (and a new drop) or after 24 h; a disk that cannot be read
// never alerts and never throws.

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 30, 0, 0, 0);

function harness(opts: { free: number[]; thresholdJson?: string | null; post?: (text: string) => Promise<boolean>; volumesFail?: boolean } = { free: [] }) {
  let freeIndex = 0;
  const store: { settings: string | null; state: string | null } = { settings: opts.thresholdJson ?? null, state: null };
  const posts: string[] = [];
  const clock = { t: T0 };
  let measured = 0;
  const consumers: DiskConsumer[] = [
    { key: "tempDir", path: "/tmp", bytes: 8.5 * GB, complete: false },
    { key: "nextCache", path: "/repo/.next/cache", bytes: 16 * GB, complete: true },
    { key: "backups", path: "/data/backups", bytes: 3.1 * GB, complete: true },
    { key: "liveStreamsBuffer", path: "/data/live-streams", bytes: 0.4 * GB, complete: true },
  ];
  const guard = createDiskGuard({
    volumes: async () => {
      if (opts.volumesFail) throw new Error("EACCES: statfs");
      const free = opts.free[Math.min(freeIndex++, opts.free.length - 1)];
      const volumes: DiskVolume[] = [
        { labels: ["appData", "program"], path: "/Users/x", freeBytes: free, totalBytes: 494 * GB },
        { labels: [], path: "/Volumes/big", freeBytes: 900 * GB, totalBytes: 1000 * GB },
      ];
      return volumes;
    },
    measureConsumers: async () => {
      measured++;
      return consumers;
    },
    getSettingsJson: async () => store.settings,
    setSettingsJson: async (json) => {
      store.settings = json;
    },
    getStateJson: async () => store.state,
    setStateJson: async (json) => {
      store.state = json;
    },
    postSystemMessage:
      opts.post ??
      (async (text) => {
        posts.push(text);
        return true;
      }),
    hostname: () => "Mac-mini",
    clock: () => clock.t,
  });
  return { guard, posts, clock, store, measured: () => measured };
}

test("defaults: 20 GB threshold, checked every 15 minutes", () => {
  assert.equal(DEFAULT_DISK_GUARD_THRESHOLD_GB, 20);
  assert.equal(DISK_GUARD_TICK_MS, 15 * 60 * 1000);
  assert.deepEqual(diskGuardSettingsFromJson(null), { thresholdGb: 20 });
  for (const bad of ["{", "[]", '{"thresholdGb":0}', '{"thresholdGb":"30"}', '{"thresholdGb":-1}']) assert.deepEqual(diskGuardSettingsFromJson(bad), { thresholdGb: 20 }, bad);
  assert.deepEqual(diskGuardSettingsFromJson('{"thresholdGb":50}'), { thresholdGb: 50 });
  assert.deepEqual(diskGuardStateFromJson("not json"), INITIAL_DISK_GUARD_STATE);
});

test("the alert rule, from the requirement's own sequence of free space values", () => {
  const th = 20;
  let s = INITIAL_DISK_GUARD_STATE;
  const step = (free: number, at: number) => {
    const d = decideDiskAlert(s, free * GB, th, at);
    s = d.state;
    return d.raise;
  };
  assert.equal(step(20, T0), false, "exactly at the threshold is not below it");
  assert.equal(step(19.9, T0 + 1), true, "below: one alert");
  assert.equal(step(15, T0 + 2), false, "still below: quiet");
  assert.equal(step(21, T0 + 3), false, "above the threshold but under +2 GB: the alert stays, quiet");
  assert.equal(s.alertActive, true);
  assert.equal(step(19, T0 + 4), false, "dipped again without a real recovery: quiet");
  assert.equal(step(22, T0 + 5), false, "threshold + 2 GB: the alert ends");
  assert.equal(s.alertActive, false);
  assert.equal(step(18, T0 + 6), true, "a new drop after recovery: alert again");
  assert.equal(step(18, T0 + 6 + 23 * HOUR), false, "23 h later still below: quiet");
  assert.equal(step(18, T0 + 6 + 24 * HOUR), true, "24 h after the last alert, still below: alert again");
  assert.equal(step(18, T0 + 6 + 25 * HOUR), false);
  assert.equal(step(21, T0 + 6 + 49 * HOUR), false, "24 h later but no longer below the threshold: no re-alert");
});

test("a check below the threshold raises one alert and posts one message with the free space and the big folders", async () => {
  const h = harness({ free: [14.2 * GB, 13 * GB, 12 * GB] });
  const first = await h.guard.tick();
  assert.deepEqual(first, { raised: true, posted: true, freeBytes: 14.2 * GB });
  assert.equal(h.posts.length, 1);
  const text = h.posts[0];
  assert.match(text, /Mac-mini/);
  assert.match(text, /14\.2 GB free of 494\.0 GB/);
  assert.match(text, /below 20 GB/);
  // The biggest first; a walk cut short by its time budget says "at least".
  assert.match(text, /build cache \(\.next\/cache\) 16\.0 GB, temp folder at least 8\.5 GB, backups 3\.1 GB, live-streams buffer 0\.4 GB/);
  assert.deepEqual(await h.guard.notice(), { freeBytes: 14.2 * GB, thresholdGb: 20, since: new Date(T0).toISOString() });
  // 15 and 30 minutes later, still below: nothing more.
  h.clock.t += 15 * 60_000;
  assert.equal((await h.guard.tick()).raised, false);
  h.clock.t += 15 * 60_000;
  assert.equal((await h.guard.tick()).raised, false);
  assert.equal(h.posts.length, 1);
  assert.equal(h.measured(), 1, "the folders are measured only for the alert");
  assert.equal((await h.guard.notice())?.freeBytes, 12 * GB, "the bell shows the latest free space");
});

test("enough free space: no alert, no message, no bell notice, no folder walk", async () => {
  const h = harness({ free: [120 * GB] });
  assert.deepEqual(await h.guard.tick(), { raised: false, posted: false, freeBytes: 120 * GB });
  assert.deepEqual(h.posts, []);
  assert.equal(await h.guard.notice(), null);
  assert.equal(h.measured(), 0);
});

test("the threshold is this computer's setting", async () => {
  const h = harness({ free: [40 * GB], thresholdJson: JSON.stringify({ thresholdGb: 50 }) });
  assert.equal((await h.guard.tick()).raised, true);
  assert.match(h.posts[0], /below 50 GB/);
});

test("the System topic off here: the alert still counts (bell), nothing is posted, and it is not retried every check", async () => {
  const offered: string[] = [];
  const h = harness({ free: [5 * GB], post: async (text) => (offered.push(text), false) });
  assert.deepEqual(await h.guard.tick(), { raised: true, posted: false, freeBytes: 5 * GB });
  assert.notEqual(await h.guard.notice(), null);
  h.clock.t += DISK_GUARD_TICK_MS;
  assert.equal((await h.guard.tick()).raised, false);
  assert.equal(offered.length, 1);
});

test("a failing post never throws and never makes the next check alert again", async () => {
  const h = harness({ free: [5 * GB], post: async () => Promise.reject(new Error("database is locked")) });
  assert.deepEqual(await h.guard.tick(), { raised: true, posted: false, freeBytes: 5 * GB });
  assert.equal((await h.guard.tick()).raised, false);
});

test("a disk that cannot be read: no alert, no throw, the reason is kept for the card", async () => {
  const h = harness({ free: [], volumesFail: true });
  assert.deepEqual(await h.guard.tick(), { raised: false, posted: false, freeBytes: null });
  assert.deepEqual(h.posts, []);
  assert.equal(await h.guard.notice(), null);
  assert.match(JSON.parse(h.store.state as string).lastError, /EACCES/);
  const view = await h.guard.view();
  assert.match(view.volumesError ?? "", /EACCES/);
  assert.deepEqual(view.volumes, []);
});

test("the card's view: volumes now, folders only when asked, and it changes nothing", async () => {
  const h = harness({ free: [100 * GB] });
  const plain = await h.guard.view();
  assert.equal(plain.consumers, null);
  assert.equal(plain.volumes.length, 2);
  assert.equal(plain.lastCheckAt, null);
  const measured = await h.guard.view({ measure: true });
  assert.equal(measured.consumers?.length, 4);
  assert.equal(h.store.state, null, "a view writes no state");
  assert.deepEqual(h.posts, []);
});

test("the threshold setting: a number of GB from 1 to 10000; anything else is refused and nothing is saved", async () => {
  const h = harness({ free: [100 * GB] });
  assert.deepEqual(await h.guard.updateSettings({ thresholdGb: 35 }), { thresholdGb: 35 });
  assert.deepEqual(JSON.parse(h.store.settings as string), { thresholdGb: 35 });
  for (const bad of [{ thresholdGb: 0 }, { thresholdGb: 10_001 }, { thresholdGb: "20" }, { thresholdGb: 20, extra: 1 }, null, []]) {
    await assert.rejects(() => h.guard.updateSettings(bad), (error: unknown) => (error as { code?: string }).code === "validation_failed", JSON.stringify(bad));
  }
  assert.deepEqual(JSON.parse(h.store.settings as string), { thresholdGb: 35 });
});

test("the message lists every volume and works without any folder sizes", () => {
  const text = diskAlertMessage({
    hostname: "Win-PC",
    thresholdGb: 20,
    volumes: [{ labels: ["appData"], path: "C:\\Users\\x", freeBytes: 3 * GB, totalBytes: 256 * GB }],
    consumers: [],
  });
  assert.equal(text, "Low disk space on Win-PC: below 20 GB free.\nC:\\Users\\x: 3.0 GB free of 256.0 GB\nServers -> Disk in the app shows the details.");
});
