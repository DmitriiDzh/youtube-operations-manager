import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "./contracts";
import { createMemoryVolumeLockStore, createVolumeLock, describeVolumeLockHolder } from "./volume-lock";

// Review round 9: AC-P14-18 ("no GPU session while a model pull writes the shared volume", and the reverse) as a
// DB-enforced constraint -- one lock row, one holder. Expected behaviour from PHASE_14_PLAN.md §2.6 and the AC.

test("one holder at a time: the second acquire is media_session_conflict naming the holder; the same owner may re-acquire; release frees it", async () => {
  const store = createMemoryVolumeLockStore();
  const lock = createVolumeLock({ store, isHolderActive: async () => true });
  await lock.acquire("session:s1");
  await lock.acquire("session:s1"); // re-entrant
  await assert.rejects(lock.acquire("pull:p1"), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict" && /generation session \(s1\)/.test(e.message));
  assert.equal(await lock.release("pull:p1"), false, "never another owner's lock");
  assert.equal(store.current(), "session:s1");
  assert.equal(await lock.release("session:s1"), true);
  await lock.acquire("pull:p1");
  await assert.rejects(lock.acquire("session:s2"), (e: unknown) => isDomainError(e) && /model pull \(p1\)/.test((e as Error).message));
});

test("a holder that is no longer active (left by a crash) is stolen; an active one never is", async () => {
  const store = createMemoryVolumeLockStore();
  await store.tryAcquire("session:dead");
  const active = new Set<string>();
  const lock = createVolumeLock({ store, isHolderActive: async (h) => active.has(h) });
  await lock.acquire("pull:p1");
  assert.equal(store.current(), "pull:p1");
  active.add("pull:p1");
  await assert.rejects(lock.acquire("session:s1"), (e: unknown) => isDomainError(e) && e.code === "media_session_conflict");
});

test("describeVolumeLockHolder names what blocks the volume", () => {
  assert.match(describeVolumeLockHolder("session:abc"), /session \(abc\)/);
  assert.match(describeVolumeLockHolder("pull:xyz"), /pull \(xyz\)/);
  assert.match(describeVolumeLockHolder("other"), /busy/);
});
