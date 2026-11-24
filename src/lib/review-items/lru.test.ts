import assert from "node:assert/strict";
import test from "node:test";
import { createLruCache } from "./lru";

// BL-272 (review): the shared SHA-256 cache of the review files (clips and stills) drops the least recently used entry on overflow --
// never the whole cache -- and a read keeps an entry fresh. Expected values by hand.

test("BL-272: an overflow evicts the least recently used entry only; a get refreshes an entry", () => {
  const cache = createLruCache<string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  assert.equal(cache.get("a"), "1"); // "a" is now the most recent: "b" is the oldest
  cache.set("d", "4");
  assert.deepEqual(cache.keys(), ["c", "a", "d"]);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.size, 3);
  cache.set("e", "5"); // the oldest now is "c"
  assert.deepEqual(cache.keys(), ["a", "d", "e"]);
});

test("BL-272: setting a known key again refreshes it without growing the cache", () => {
  const cache = createLruCache<number>(2);
  cache.set("x", 1);
  cache.set("y", 2);
  cache.set("x", 3);
  cache.set("z", 4);
  assert.deepEqual(cache.keys(), ["x", "z"]);
  assert.equal(cache.get("x"), 3);
  assert.equal(cache.get("missing"), undefined);
});

test("BL-272: 501 entries in a cache of 500 drop only the very first one", () => {
  const cache = createLruCache<string>(500);
  for (let i = 0; i <= 500; i++) cache.set(`k${i}`, `v${i}`);
  assert.equal(cache.size, 500);
  assert.equal(cache.get("k0"), undefined);
  assert.equal(cache.get("k1"), "v1");
  assert.equal(cache.get("k500"), "v500");
});
