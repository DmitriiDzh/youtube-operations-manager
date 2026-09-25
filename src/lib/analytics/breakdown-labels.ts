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
  NO_LINK_OTHER: "Direct or unknown",
  SUBSCRIBER: "Subscription feed",
  YT_CHANNEL: "Channel page",
  YT_SEARCH: "YouTube search",
  RELATED_VIDEO: "Suggested videos",
  YT_OTHER_PAGE: "Other YouTube features",
  EXT_URL: "External website/app",
  PLAYLIST: "Playlist",
  NOTIFICATION: "Notification",
  YT_PLAYLIST_PAGE: "Playlist page",
  SHORTS: "Shorts feed",
  END_SCREEN: "End screen",
  ANNOTATION: "Annotation",
  CAMPAIGN_CARD: "Campaign card",
  CAMPAIGN_CARD_EXTERNAL: "External campaign",
  PROMOTED: "Promoted content",
  ADVERTISING: "Advertising",
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
