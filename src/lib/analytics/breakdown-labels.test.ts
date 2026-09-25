import assert from "node:assert/strict";
import test from "node:test";
import {
  labelAgeGender,
  labelContentFormat,
  labelCountry,
  labelDeviceType,
  labelSubscribedStatus,
  labelTrafficSource,
} from "./breakdown-labels";

// Independent review round 1 finding (2026-09-26): breakdown-labels.ts had zero tests -- every
// mapping was only ever exercised indirectly through the UI. Expected values below are hand-stated
// from the real API responses this session's live probe (BL-093/BL-094) actually observed, per
// AGENTS.md §L, not copied from the implementation's own map.

test("labelTrafficSource maps every raw value the live probe actually observed", () => {
  assert.equal(labelTrafficSource(["RELATED_VIDEO"]), "Suggested videos");
  assert.equal(labelTrafficSource(["SUBSCRIBER"]), "Subscription feed");
  assert.equal(labelTrafficSource(["YT_SEARCH"]), "YouTube search");
  assert.equal(labelTrafficSource(["NO_LINK_OTHER"]), "Direct or unknown");
});

test("labelTrafficSource falls back to the raw value for an unrecognized enum, never throwing", () => {
  assert.equal(labelTrafficSource(["SOME_NEW_SOURCE_TYPE"]), "SOME_NEW_SOURCE_TYPE");
});

test("labelDeviceType maps every raw value the live probe actually observed", () => {
  assert.equal(labelDeviceType(["DESKTOP"]), "Computer");
  assert.equal(labelDeviceType(["MOBILE"]), "Mobile phone");
  assert.equal(labelDeviceType(["TABLET"]), "Tablet");
  assert.equal(labelDeviceType(["TV"]), "TV");
});

test("labelAgeGender formats a bounded age range with the gender as-is", () => {
  assert.equal(labelAgeGender(["age35-44", "female"]), "35-44, female");
  assert.equal(labelAgeGender(["age45-54", "male"]), "45-54, male");
});

test("labelAgeGender formats the unbounded top age group with a plus sign", () => {
  assert.equal(labelAgeGender(["age65-", "male"]), "65+, male");
});

test("labelAgeGender relabels user_specified gender as \"other\"", () => {
  assert.equal(labelAgeGender(["age25-34", "user_specified"]), "25-34, other");
});

test("labelCountry converts a real ISO country code to its English display name", () => {
  assert.equal(labelCountry(["US"]), "United States");
  assert.equal(labelCountry(["JP"]), "Japan");
  assert.equal(labelCountry(["MX"]), "Mexico");
});

test("labelSubscribedStatus maps both real values the live probe observed", () => {
  assert.equal(labelSubscribedStatus(["SUBSCRIBED"]), "Subscribed");
  assert.equal(labelSubscribedStatus(["UNSUBSCRIBED"]), "Not subscribed");
});

// Independent review round 1 finding: the exact casing for "shorts"/"live" was never confirmed
// against a real response (this channel has neither) -- these tests lock in only what IS confirmed
// (the real, observed "videoOnDemand" value, verbatim from a real response body) plus the documented
// uppercase alternative, and confirm the fallback degrades gracefully rather than asserting a label
// this session cannot actually verify.
test("labelContentFormat maps the real observed value (\"videoOnDemand\", lowerCamelCase, from a real response body)", () => {
  assert.equal(labelContentFormat(["videoOnDemand"]), "Videos");
});

test("labelContentFormat also maps the documented uppercase-snake-case alternative, in case the live casing differs by report shape", () => {
  assert.equal(labelContentFormat(["VIDEO_ON_DEMAND"]), "Videos");
  assert.equal(labelContentFormat(["SHORTS"]), "Shorts");
  assert.equal(labelContentFormat(["LIVE_STREAM"]), "Live");
});

test("labelContentFormat falls back to the raw value for a genuinely unmapped casing, never a wrong label", () => {
  assert.equal(labelContentFormat(["totally_unknown_format"]), "totally_unknown_format");
});
