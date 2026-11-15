import assert from "node:assert/strict";
import test from "node:test";
import { createPackagesReader, invalidatePackagesEntry, PACKAGES_CACHE_MS, type PackagesEntry } from "./packages-cache";

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
