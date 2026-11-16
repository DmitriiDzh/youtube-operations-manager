import assert from "node:assert/strict";
import test from "node:test";
import { createPackagesReader, invalidatePackagesEntry, PACKAGES_CACHE_MAX_MS, PACKAGES_CACHE_MS, type PackagesEntry } from "./packages-cache";

// BL-243 final triage: a progress answer built while the removed-list read failed ("none known") is not kept for the minute -- the
// next call reads the list again; a good answer is kept.
test("BL-243: an answer from a failed removed-list read is not cached; the next call retries the read", async () => {
  let now = 1_000_000;
  let fail = true;
  const reads: number[] = [];
  const packagesOf = createPackagesReader({
    removedVideos: async () => {
      reads.push(now);
      if (fail) throw new Error("db busy");
      return [{ videoId: "vid73", removedAt: "2026-11-03T19:54:00.000Z" }];
    },
    scan: async () => ({ status: "ok", packages: [] }),
    synthetic: async () => false,
    now: () => now,
    cache: new Map<string, PackagesEntry>(),
  });
  assert.deepEqual([...(await packagesOf("UC1")).removedVideoIds], [], "none known");
  now += 1_000; // well inside the minute
  fail = false;
  assert.deepEqual([...(await packagesOf("UC1")).removedVideoIds], ["vid73"], "read again, not the cached failure");
  assert.equal(reads.length, 2);
  now += 1_000;
  await packagesOf("UC1");
  assert.equal(reads.length, 2, "a good answer is kept");
  now += PACKAGES_CACHE_MS;
  await packagesOf("UC1");
  assert.equal(reads.length, 3, "after the minute: read again");
});

// BL-257 AC-PR-10 (PACKAGE_REVIEW_PLAN.md): a package-review decision drops the channel's kept answer -- the next read scans again
// well inside the minute; another channel's answer stays kept.
test("BL-257 AC-PR-10: invalidating a channel makes the next read scan again inside the minute; other channels stay cached", async () => {
  let now = 1_000_000;
  const scans: string[] = [];
  const cache = new Map<string, PackagesEntry>();
  const packagesOf = createPackagesReader({
    removedVideos: async () => [],
    scan: async (channelId) => {
      scans.push(channelId);
      return { status: "ok", packages: [] };
    },
    synthetic: async () => false,
    now: () => now,
    cache,
  });
  await packagesOf("UC_wwe");
  await packagesOf("UC_other");
  now += 1_000;
  await packagesOf("UC_wwe");
  assert.deepEqual(scans, ["UC_wwe", "UC_other"], "kept for the minute");
  invalidatePackagesEntry(cache, "UC_wwe");
  await packagesOf("UC_wwe");
  await packagesOf("UC_other");
  assert.deepEqual(scans, ["UC_wwe", "UC_other", "UC_wwe"]);
});

// BL-270 (owner TG 4662/4665): the plan schedule reads every minute, so a one-minute answer was always a miss. Past the minute a kept
// scan is reused while the scan's fingerprint is unchanged (up to 5 minutes); a changed manifest (a new fingerprint) is scanned at
// the next read; an unknown fingerprint is never trusted.
function reader(opts: { signature: () => string | null | Promise<string | null> }) {
  const state = { now: 1_000_000, scans: 0, signatureReads: 0 };
  const packagesOf = createPackagesReader({
    removedVideos: async () => [],
    scan: async () => {
      state.scans++;
      return { status: "ok", packages: [] };
    },
    synthetic: async () => false,
    signature: async () => {
      state.signatureReads++;
      return opts.signature();
    },
    now: () => state.now,
    cache: new Map<string, PackagesEntry>(),
  });
  return { state, packagesOf };
}

test("BL-270: a reader polled every minute reuses the scan while the fingerprint is unchanged, for at most 5 minutes", async () => {
  const { state, packagesOf } = reader({ signature: () => "same" });
  await packagesOf("UC1");
  assert.equal(state.scans, 1);
  for (let minute = 1; minute < 5; minute++) {
    state.now += 60_000;
    await packagesOf("UC1");
  }
  assert.equal(state.scans, 1, "minutes 1-4: same folder, same copy -- no scan");
  state.now += 60_000; // 5 minutes after the scan
  await packagesOf("UC1");
  assert.equal(state.scans, 2, "never older than PACKAGES_CACHE_MAX_MS");
  assert.equal(PACKAGES_CACHE_MAX_MS, 5 * 60_000);
});

test("BL-270 (negative): a manifest edited in place (a new fingerprint) is scanned at the very next read past the minute", async () => {
  let signature = "v1";
  const { state, packagesOf } = reader({ signature: () => signature });
  await packagesOf("UC1");
  state.now += 60_000;
  await packagesOf("UC1");
  assert.equal(state.scans, 1);
  signature = "v2"; // e.g. V12_release.json rewritten: its mtime/size moved
  state.now += 60_000;
  await packagesOf("UC1");
  assert.equal(state.scans, 2);
  state.now += 60_000;
  await packagesOf("UC1");
  assert.equal(state.scans, 2, "and the new scan is kept under the new fingerprint");
});

test("BL-270 (negative): an unknown fingerprint (null, or a failed read) is never trusted past the minute", async () => {
  const nul = reader({ signature: () => null });
  await nul.packagesOf("UC1");
  nul.state.now += 60_000;
  await nul.packagesOf("UC1");
  assert.equal(nul.state.scans, 2);
  let fail = false;
  const failing = reader({
    signature: () => {
      if (fail) throw new Error("drive gone");
      return "same";
    },
  });
  await failing.packagesOf("UC1");
  fail = true;
  failing.state.now += 60_000;
  await failing.packagesOf("UC1");
  assert.equal(failing.state.scans, 2);
});

test("BL-270: inside the first minute nothing extra is read (the fingerprint is not even computed)", async () => {
  const { state, packagesOf } = reader({ signature: () => "same" });
  await packagesOf("UC1");
  const reads = state.signatureReads;
  state.now += 30_000;
  await packagesOf("UC1");
  assert.equal(state.signatureReads, reads);
  assert.equal(state.scans, 1);
});
