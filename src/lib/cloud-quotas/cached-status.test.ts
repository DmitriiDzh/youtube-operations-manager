import assert from "node:assert/strict";
import test from "node:test";
import { createCachedReader } from "./cached-status";

test("callers arriving together share one read", async () => {
  let loads = 0;
  const read = createCachedReader(async () => ++loads, 30_000, { now: () => 0 });
  const results = await Promise.all([read(), read(), read()]);
  assert.deepEqual(results, [1, 1, 1]);
  assert.equal(loads, 1);
});

test("a finished read is reused until it is ttl old, then read again", async () => {
  let clock = 0;
  let loads = 0;
  const read = createCachedReader(async () => ++loads, 30_000, { now: () => clock });
  assert.equal(await read(), 1);
  clock = 29_999;
  assert.equal(await read(), 1);
  clock = 30_000;
  assert.equal(await read(), 2);
  assert.equal(loads, 2);
});

test("a failed read is not reused: the next caller reads again", async () => {
  let loads = 0;
  const read = createCachedReader(
    async () => {
      loads += 1;
      if (loads === 1) throw new Error("monitoring down");
      return "ok";
    },
    30_000,
    { now: () => 0 }
  );
  await assert.rejects(read(), /monitoring down/);
  assert.equal(await read(), "ok");
  assert.equal(loads, 2);
});

test("a result keep() rejects (e.g. a degraded quota status) is not reused", async () => {
  let loads = 0;
  const read = createCachedReader(async () => ++loads, 30_000, { now: () => 0, keep: (value) => value > 1 });
  assert.equal(await read(), 1);
  assert.equal(await read(), 2);
  assert.equal(await read(), 2);
  assert.equal(loads, 2);
});
