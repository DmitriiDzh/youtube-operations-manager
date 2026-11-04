import assert from "node:assert/strict";
import test from "node:test";
import { clipsWaitingBadge } from "./clip-reviews-badge";

// BL-241 (CLIP_REVIEWS_PLAN.md AC-CR-15): «Клипы» (now under Media, owner msg 4025) shows how many clips wait for the owner; a
// failed read shows no badge.
test("BL-241: the clips badge is the clips' waiting count; a failed read gives none", () => {
  assert.equal(clipsWaitingBadge({ waiting: 3 }), 3);
  assert.equal(clipsWaitingBadge({ waiting: 0 }), 0);
  assert.equal(clipsWaitingBadge(null), 0);
});
