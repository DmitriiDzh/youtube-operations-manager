import assert from "node:assert/strict";
import test from "node:test";
import { ownSettingsUnavailable } from "./settings-unavailable";

test("ownSettingsUnavailable is true only when one of the card's own fields failed to read", () => {
  assert.equal(ownSettingsUnavailable({ unavailable: ["cloudQuotaStatus"] }, ["liveWritesEnabled"]), false);
  assert.equal(ownSettingsUnavailable({ unavailable: ["cloudQuotaStatus", "liveWritesEnabled"] }, ["liveWritesEnabled"]), true);
  assert.equal(ownSettingsUnavailable({ unavailable: [] }, ["liveWritesEnabled"]), false);
  assert.equal(ownSettingsUnavailable({}, ["liveWritesEnabled"]), false);
});
