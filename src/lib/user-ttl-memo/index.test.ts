import assert from "node:assert/strict";
import test from "node:test";
import { createUserTtlMemo } from "./index";

// BL-197 (review): a per-user value kept for its TTL; a read that started before a forget never puts its older value back.

test("user TTL memo: recalled until just before the TTL, gone at the TTL", () => {
  const memo = createUserTtlMemo<string>("test.user-ttl-memo.ttl", 60_000);
  const at = new Date("2026-10-18T10:00:00Z");
  memo.remember("u", "a", memo.epoch("u"), at);
  assert.equal(memo.recall("u", new Date("2026-10-18T10:00:59Z")), "a");
  assert.equal(memo.recall("u", new Date("2026-10-18T10:01:00Z")), null);
});

test("user TTL memo: a value read before a forget is dropped; one read after it is kept", () => {
  const memo = createUserTtlMemo<string>("test.user-ttl-memo.race", 60_000);
  const at = new Date("2026-10-18T10:00:00Z");
  const before = memo.epoch("u");
  memo.forget("u");
  memo.remember("u", "stale", before, at);
  assert.equal(memo.recall("u", at), null);
  memo.remember("u", "fresh", memo.epoch("u"), at);
  assert.equal(memo.recall("u", at), "fresh");
});

test("user TTL memo: per user; forgetting one leaves the others; copies with the same key share state", () => {
  const memo = createUserTtlMemo<string>("test.user-ttl-memo.shared", 60_000);
  const copy = createUserTtlMemo<string>("test.user-ttl-memo.shared", 60_000);
  const at = new Date("2026-10-18T10:00:00Z");
  memo.remember("u1", "a", memo.epoch("u1"), at);
  memo.remember("u2", "b", memo.epoch("u2"), at);
  copy.forget("u1");
  assert.equal(memo.recall("u1", at), null);
  assert.equal(copy.recall("u2", at), "b");
});
