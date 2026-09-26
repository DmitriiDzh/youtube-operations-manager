// Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4/§4.4)
// -- human-readable labels for each breakdown card's raw API dimension values. Pure, no I/O, safe
// to import from a client component (mirrors `period.ts`'s own existing client-safe pattern).
//
// Traffic sources deliberately shows the RAW `insightTrafficSourceType` enum values (one row per
// value YouTube's API returns), not Studio's own bucketed groups (e.g. its "Suggested videos" tab
// appears to fold several raw values together) -- that exact grouping was never confirmed against
// a real response in this session's research and is not guessed at here; each label below states
// what that specific enum value means, per the API's own documented semantics.
const TRAFFIC_SOURCE_LABELS: Record<string, string> = {
  // NO_LINK_OTHER covers direct traffic AND mobile-app traffic with no referrer, per Google's own
  // docs -- deliberately does not say "or app" the way EXT_URL used to (independent review round 4,
  // 2026-09-26, found that wording had actually been borrowed from THIS value's own documented
  // scope, not EXT_URL's).
  NO_LINK_OTHER: "Direct or unknown",
  // Independent review round 2 (2026-09-26) found the original "Subscription feed" label was too
  // narrow: Google's own dimension docs describe SUBSCRIBER as views referred from either the
  // YouTube homepage feed OR subscription features -- homepage-feed views are commonly the larger
  // share of this bucket, so a pure "subscription" label would materially mislead a channel owner.
  SUBSCRIBER: "Home feed or subscriptions",
  YT_CHANNEL: "Channel page",
  YT_SEARCH: "YouTube search",
  RELATED_VIDEO: "Suggested videos",
  YT_OTHER_PAGE: "Other YouTube features",
  // Independent review round 4 (2026-09-26): the previous "External website/app" wording actually
  // described NO_LINK_OTHER's own documented scope (see above), not this value's -- Google's docs
  // scope EXT_URL to websites specifically (a link on another website, including Google Search
  // results), not apps.
  EXT_URL: "External website",
  PLAYLIST: "Playlist",
  NOTIFICATION: "Notification",
  // Independent review round 4 (2026-09-26): confirmed via Google's own revision history (Dec 4,
  // 2023 entry) that this value was merged into PLAYLIST project-wide -- "both types of views will
  // be associated with the PLAYLIST dimension value" going forward. The current live API can never
  // return this value; kept mapped only in case an older/cached report ever surfaces it, never
  // expected to be exercised.
  YT_PLAYLIST_PAGE: "Playlist page",
  SHORTS: "Shorts feed",
  END_SCREEN: "End screen",
  ANNOTATION: "Annotation",
  // Same review: Google's docs describe this as views from a claimed, user-uploaded video the
  // content owner used to promote the viewed content (a Content ID promotion mechanism), not a
  // literal UI "card" -- relabeled to match that documented meaning, not the enum name's own
  // surface resemblance to "cardImpressions"/"cardClicks" (an unrelated, legacy end-screen metric).
  // Independent review round 4 (2026-09-26): also confirmed this value is documented as valid only
  // for content-owner reports -- this app only ever issues channel-scoped queries (`AGENTS.md` §G),
  // so it can never actually appear in a real response here; the label is accurate but moot.
  CAMPAIGN_CARD: "Content ID promotion",
  // Does not appear in Google's current dimensions table at all (independent review round 4) --
  // this label is an unverified guess by analogy to CAMPAIGN_CARD, not checked against real docs.
  CAMPAIGN_CARD_EXTERNAL: "External Content ID promotion",
  // Independent review round 3 (2026-09-26): "Promoted content" dropped the documented "unpaid"
  // qualifier that distinguishes this from ADVERTISING (the actual paid-promotion source) sitting
  // right next to it in this same list -- the same "copied from the enum name's own surface
  // resemblance, not checked against the documented meaning" failure class as SUBSCRIBER/
  // CAMPAIGN_CARD above.
  PROMOTED: "YouTube-promoted (unpaid)",
  ADVERTISING: "Advertising",
  // Added independent review round 4 (2026-09-26) -- documented current values this map was
  // missing entirely (a real, if less common, input would have silently fallen through to the raw
  // API string). Labels below are this app's own plain-language gloss of each value's documented
  // meaning, not a verbatim Studio label.
  HASHTAGS: "Hashtag page",
  LIVE_REDIRECT: "Live stream redirect",
  NO_LINK_EMBEDDED: "Embedded player",
  PRODUCT_PAGE: "Product page",
  SOUND_PAGE: "Sound page",
  VIDEO_REMIXES: "Video remixes",
  // Independent review round 5 (2026-09-26): "Watch together" was a generic paraphrase -- Google's
  // docs name this a specific feature ("Watch With", a Creator Commentary stream), not co-viewing
  // in general; kept as the feature's own name rather than genericized.
  WATCH_WITH: "Watch With",
};

export function labelTrafficSource([value]: string[]): string {
  return TRAFFIC_SOURCE_LABELS[value] ?? value;
}

const DEVICE_TYPE_LABELS: Record<string, string> = {
  DESKTOP: "Computer",
  MOBILE: "Mobile phone",
  TABLET: "Tablet",
  TV: "TV",
  GAME_CONSOLE: "Game console",
  // Added independent review round 4 (2026-09-26) -- documented current values this map was
  // missing (see the same note on TRAFFIC_SOURCE_LABELS above).
  AUTOMOTIVE: "Car",
  WEARABLE: "Wearable device",
  UNKNOWN_PLATFORM: "Unknown device",
};

export function labelDeviceType([value]: string[]): string {
  return DEVICE_TYPE_LABELS[value] ?? value;
}

function formatAgeGroup(raw: string): string {
  // "age35-44" -> "35-44", "age65-" -> "65+"
  const match = /^age(\d+)-(\d*)$/.exec(raw);
  if (!match) return raw;
  const [, low, high] = match;
  return high ? `${low}-${high}` : `${low}+`;
}

export function labelAgeGender([ageGroup, gender]: string[]): string {
  const genderLabel = gender === "user_specified" ? "other" : gender;
  return `${formatAgeGroup(ageGroup)}, ${genderLabel}`;
}

const regionDisplayNames = typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

export function labelCountry([value]: string[]): string {
  return regionDisplayNames?.of(value) ?? value;
}

const SUBSCRIBED_STATUS_LABELS: Record<string, string> = {
  SUBSCRIBED: "Subscribed",
  UNSUBSCRIBED: "Not subscribed",
};

export function labelSubscribedStatus([value]: string[]): string {
  return SUBSCRIBED_STATUS_LABELS[value] ?? value;
}

// "videoOnDemand" (lowerCamelCase) is directly confirmed against a real API response body this
// session (BL-093/BL-094 probe, 2026-09-25 -- the literal JSON `"rows": [["videoOnDemand", ...]]`
// was observed, not inferred). An independent review round then found Google's own dimension docs
// state uppercase-snake-case values (`LIVE_STREAM`/`SHORTS`/`STORY`/`VIDEO_ON_DEMAND`) for this
// same dimension -- a genuine, unresolved discrepancy between a real observed response and the
// current published docs (docs can lag or describe a different report family). A live re-probe to
// settle it hit an unrelated OAuth refresh failure and could not be completed this session. Rather
// than pick one source over the other, both casings are mapped -- this channel has no Shorts/Live
// content to confirm either casing for those two values specifically, so `label` for them remains
// unconfirmed either way; the raw-string fallback below means a genuine mismatch degrades to a
// readable-enough raw value, never a crash or a wrong label.
const CONTENT_FORMAT_LABELS: Record<string, string> = {
  videoOnDemand: "Videos",
  VIDEO_ON_DEMAND: "Videos",
  shorts: "Shorts",
  SHORTS: "Shorts",
  liveStream: "Live",
  live: "Live",
  LIVE_STREAM: "Live",
  story: "Story",
  STORY: "Story",
};

export function labelContentFormat([value]: string[]): string {
  return CONTENT_FORMAT_LABELS[value] ?? value;
}
