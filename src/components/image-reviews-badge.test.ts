import assert from "node:assert/strict";
import test from "node:test";
import { stillsWaitingBadge, stillsWaitingUrl } from "./image-reviews-badge";

// BL-272 (review, item 1): the «Кадры» badge reads every minute, so it asks the count-only view of the owner's list (no file work on
// the channel's images, handlers.test.ts and image-reviews.test.ts); a failed read shows no badge.

test("BL-272 (review): the badge asks the count-only view of the active channel's list", () => {
  assert.equal(stillsWaitingUrl("UC_a/b"), "/api/channels/UC_a%2Fb/image-reviews?view=count");
});

test("BL-272: the badge is the waiting count, 0 for a failed read or a negative value", () => {
  assert.equal(stillsWaitingBadge({ waiting: 3 }), 3);
  assert.equal(stillsWaitingBadge(null), 0);
  assert.equal(stillsWaitingBadge({ waiting: -1 }), 0);
});
