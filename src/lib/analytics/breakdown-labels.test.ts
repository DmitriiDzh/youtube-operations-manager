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
// mapping was only ever exercised indirectly through the UI. Expected values for the enum VALUES
// tested below (e.g. "SUBSCRIBER", "DESKTOP") are hand-stated from the real API responses this
// session's live probe (BL-093/BL-094) actually observed, per AGENTS.md §L, not copied from the
// implementation's own map. **Updated, independent review round 5 (2026-09-26):** this no longer
// describes every test in this file -- round 4 added tests for enum values Google documents but
// this app's live probe never observed (this channel has no Shorts/Live/Hashtags/etc. activity);
// those tests' expected LABEL TEXT is this app's own plain-language gloss of each value's
// documented meaning (see the source map's own comments at those entries), not something a live
// response demonstrated -- an intentionally different, and weaker, kind of independence than the
// live-observed cases, not equivalent to them.

test("labelTrafficSource maps every raw value the live probe actually observed", () => {
  assert.equal(labelTrafficSource(["RELATED_VIDEO"]), "Suggested videos");
  // Independent review round 2 (2026-09-26): this test originally asserted "Subscription feed",
  // copied from the implementation's own (then-inaccurate) map rather than independently checked
  // against SUBSCRIBER's documented meaning -- exactly the §L failure mode this test claims to
  // avoid. Google's own docs describe SUBSCRIBER as the YouTube home feed OR subscription
  // features, so the expected value here is corrected to match that documented scope.
  assert.equal(labelTrafficSource(["SUBSCRIBER"]), "Home feed or subscriptions");
  assert.equal(labelTrafficSource(["YT_SEARCH"]), "YouTube search");
  assert.equal(labelTrafficSource(["NO_LINK_OTHER"]), "Direct or unknown");
});

// Independent review round 3 (2026-09-26): PROMOTED is documented as specifically an UNPAID
// YouTube promotion mechanism, distinct from ADVERTISING (paid) -- a label that drops "unpaid"
// invites exactly that confusion sitting next to ADVERTISING in the same list.
test("labelTrafficSource keeps the documented \"unpaid\" distinction for PROMOTED vs. ADVERTISING", () => {
  assert.equal(labelTrafficSource(["PROMOTED"]), "YouTube-promoted (unpaid)");
  assert.equal(labelTrafficSource(["ADVERTISING"]), "Advertising");
});

test("labelTrafficSource falls back to the raw value for an unrecognized enum, never throwing", () => {
  assert.equal(labelTrafficSource(["SOME_NEW_SOURCE_TYPE"]), "SOME_NEW_SOURCE_TYPE");
});

// Independent review round 4 (2026-09-26): the previous "External website/app" label had actually
// borrowed NO_LINK_OTHER's own documented scope ("direct traffic... as well as traffic on mobile
// apps") -- Google's docs scope EXT_URL to websites only.
test("labelTrafficSource scopes EXT_URL to websites only, not apps (that's NO_LINK_OTHER's documented scope)", () => {
  assert.equal(labelTrafficSource(["EXT_URL"]), "External website");
});

// Independent review round 4 (2026-09-26): these 7 values are all currently documented by Google
// but were entirely missing from the map -- a real (if less common) response would have silently
// fallen through to the raw API string.
test("labelTrafficSource maps every previously-missing documented value to a human label, not a raw fallback", () => {
  assert.equal(labelTrafficSource(["HASHTAGS"]), "Hashtag page");
  assert.equal(labelTrafficSource(["LIVE_REDIRECT"]), "Live stream redirect");
  assert.equal(labelTrafficSource(["NO_LINK_EMBEDDED"]), "Embedded player");
  assert.equal(labelTrafficSource(["PRODUCT_PAGE"]), "Product page");
  assert.equal(labelTrafficSource(["SOUND_PAGE"]), "Sound page");
  assert.equal(labelTrafficSource(["VIDEO_REMIXES"]), "Video remixes");
  // Independent review round 5 (2026-09-26): this test originally asserted "Watch together" -- a
  // generic paraphrase of a specific named YouTube feature ("Watch With", a Creator Commentary
  // stream) -- corrected to keep the feature's own name.
  assert.equal(labelTrafficSource(["WATCH_WITH"]), "Watch With");
});

test("labelDeviceType maps every raw value the live probe actually observed", () => {
  assert.equal(labelDeviceType(["DESKTOP"]), "Computer");
  assert.equal(labelDeviceType(["MOBILE"]), "Mobile phone");
  assert.equal(labelDeviceType(["TABLET"]), "Tablet");
  assert.equal(labelDeviceType(["TV"]), "TV");
});

// Independent review round 4 (2026-09-26): these 3 values are currently documented but were
// entirely missing from the map.
test("labelDeviceType maps every previously-missing documented value to a human label, not a raw fallback", () => {
  assert.equal(labelDeviceType(["AUTOMOTIVE"]), "Car");
  assert.equal(labelDeviceType(["WEARABLE"]), "Wearable device");
  assert.equal(labelDeviceType(["UNKNOWN_PLATFORM"]), "Unknown device");
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

// Independent review round 6 (2026-09-26): "ZZ" is the one special value Google's own `country`
// dimension docs explicitly document ("YouTube could not identify the associated country") -- never
// exercised by a test until now. `Intl.DisplayNames.of("ZZ")` returns "Unknown Region" rather than
// throwing (confirmed directly, not assumed), so the existing fallback-free code path already
// handles this correctly; this test just locks that behavior in.
test("labelCountry handles ZZ (YouTube's own \"country could not be identified\" value) without throwing", () => {
  assert.equal(labelCountry(["ZZ"]), "Unknown Region");
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
