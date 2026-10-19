import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { assertCompleteAutomergeBytes } from "./document-bytes";

// BL-204 AC-MEM-02 (FAST_NAVIGATION_PLAN.md §4.3): a whole saved document passes; a cut or altered one is refused.
const whole = Automerge.save(Automerge.from({ channelId: "UC_x", changes: { c1: { proposedValue: "Hallo" } } }));

test("a whole saved document passes", () => {
  assert.doesNotThrow(() => assertCompleteAutomergeBytes(whole));
});

test("a document cut short anywhere (a file still being copied) is refused", () => {
  for (const length of [0, 3, 8, 12, Math.floor(whole.length / 2), whole.length - 1]) {
    assert.throws(() => assertCompleteAutomergeBytes(whole.slice(0, length)), /empty|incomplete|bad chunk header/, `length ${length}`);
  }
});

test("a changed byte inside the document is refused by the checksum", () => {
  const altered = whole.slice();
  altered[altered.length - 1] ^= 0xff;
  assert.throws(() => assertCompleteAutomergeBytes(altered), /checksum/);
});

test("bytes that are not an Automerge document are refused", () => {
  assert.throws(() => assertCompleteAutomergeBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])), /bad chunk header/);
});
