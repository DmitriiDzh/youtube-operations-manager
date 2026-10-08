// Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4/§4.4)
// -- human-readable labels for each breakdown card's raw API dimension values. Pure, no I/O, safe
// to import from a client component (mirrors `period.ts`'s own existing client-safe pattern).
//
// Traffic sources deliberately shows the RAW `insightTrafficSourceType` enum values (one row per
// value YouTube's API returns), not Studio's own bucketed groups (e.g. its "Suggested videos" tab
// appears to fold several raw values together) -- that exact grouping was never confirmed against
// a real response in this session's research and is not guessed at here; each label below states
// what that specific enum value means, per the API's own documented semantics.
//
// BL-152: the maps hold interface-text keys; the words are in `src/lib/ui-text/locales/<language>/analyticsLabels.ts`
// (English there is exactly the wording reviewed below). `t` defaults to English, so non-UI callers and tests are unchanged.
import { createTranslator, type Translate, type UiTextKey } from "@/lib/ui-text";

const EN = createTranslator("en");

const TRAFFIC_SOURCE_LABELS: Record<string, UiTextKey> = {
  // NO_LINK_OTHER covers direct traffic AND mobile-app traffic with no referrer, per Google's own
  // docs -- deliberately does not say "or app" the way EXT_URL used to (independent review round 4,
  // 2026-09-26, found that wording had actually been borrowed from THIS value's own documented
  // scope, not EXT_URL's).
  NO_LINK_OTHER: "breakdown.traffic.NO_LINK_OTHER",
  // Independent review round 2 (2026-09-26) found the original "Subscription feed" label was too
  // narrow: Google's own dimension docs describe SUBSCRIBER as views referred from either the
  // YouTube homepage feed OR subscription features -- homepage-feed views are commonly the larger
  // share of this bucket, so a pure "subscription" label would materially mislead a channel owner.
  SUBSCRIBER: "breakdown.traffic.SUBSCRIBER",
  YT_CHANNEL: "breakdown.traffic.YT_CHANNEL",
  YT_SEARCH: "breakdown.traffic.YT_SEARCH",
  RELATED_VIDEO: "breakdown.traffic.RELATED_VIDEO",
  YT_OTHER_PAGE: "breakdown.traffic.YT_OTHER_PAGE",
  // Independent review round 4 (2026-09-26): the previous "External website/app" wording actually
  // described NO_LINK_OTHER's own documented scope (see above), not this value's -- Google's docs
  // scope EXT_URL to websites specifically (a link on another website, including Google Search
  // results), not apps.
  EXT_URL: "breakdown.traffic.EXT_URL",
  PLAYLIST: "breakdown.traffic.PLAYLIST",
  NOTIFICATION: "breakdown.traffic.NOTIFICATION",
  // Independent review round 4 (2026-09-26): confirmed via Google's own revision history (Dec 4,
  // 2023 entry) that this value was merged into PLAYLIST project-wide -- "both types of views will
  // be associated with the PLAYLIST dimension value" going forward. The current live API can never
  // return this value; kept mapped only in case an older/cached report ever surfaces it, never
  // expected to be exercised.
  YT_PLAYLIST_PAGE: "breakdown.traffic.YT_PLAYLIST_PAGE",
  SHORTS: "breakdown.traffic.SHORTS",
  END_SCREEN: "breakdown.traffic.END_SCREEN",
  ANNOTATION: "breakdown.traffic.ANNOTATION",
  // Same review: Google's docs describe this as views from a claimed, user-uploaded video the
  // content owner used to promote the viewed content (a Content ID promotion mechanism), not a
  // literal UI "card" -- relabeled to match that documented meaning, not the enum name's own
  // surface resemblance to "cardImpressions"/"cardClicks" (an unrelated, legacy end-screen metric).
  // Independent review round 4 (2026-09-26): also confirmed this value is documented as valid only
  // for content-owner reports -- this app only ever issues channel-scoped queries (`AGENTS.md` §G),
  // so it can never actually appear in a real response here; the label is accurate but moot.
  CAMPAIGN_CARD: "breakdown.traffic.CAMPAIGN_CARD",
  // Does not appear in Google's current dimensions table at all (independent review round 4) --
  // this label is an unverified guess by analogy to CAMPAIGN_CARD, not checked against real docs.
  CAMPAIGN_CARD_EXTERNAL: "breakdown.traffic.CAMPAIGN_CARD_EXTERNAL",
  // Independent review round 3 (2026-09-26): "Promoted content" dropped the documented "unpaid"
  // qualifier that distinguishes this from ADVERTISING (the actual paid-promotion source) sitting
  // right next to it in this same list -- the same "copied from the enum name's own surface
  // resemblance, not checked against the documented meaning" failure class as SUBSCRIBER/
  // CAMPAIGN_CARD above.
  PROMOTED: "breakdown.traffic.PROMOTED",
  ADVERTISING: "breakdown.traffic.ADVERTISING",
  // Added independent review round 4 (2026-09-26) -- documented current values this map was
  // missing entirely (a real, if less common, input would have silently fallen through to the raw
  // API string). Labels below are this app's own plain-language gloss of each value's documented
  // meaning, not a verbatim Studio label.
  HASHTAGS: "breakdown.traffic.HASHTAGS",
  LIVE_REDIRECT: "breakdown.traffic.LIVE_REDIRECT",
  NO_LINK_EMBEDDED: "breakdown.traffic.NO_LINK_EMBEDDED",
  PRODUCT_PAGE: "breakdown.traffic.PRODUCT_PAGE",
  SOUND_PAGE: "breakdown.traffic.SOUND_PAGE",
  VIDEO_REMIXES: "breakdown.traffic.VIDEO_REMIXES",
  // Independent review round 5 (2026-09-26): "Watch together" was a generic paraphrase -- Google's
  // docs name this a specific feature ("Watch With", a Creator Commentary stream), not co-viewing
  // in general; kept as the feature's own name rather than genericized.
  WATCH_WITH: "breakdown.traffic.WATCH_WITH",
};

export function labelTrafficSource([value]: string[], t: Translate = EN): string {
  const key = TRAFFIC_SOURCE_LABELS[value];
  return key ? t(key) : value;
}

const DEVICE_TYPE_LABELS: Record<string, UiTextKey> = {
  DESKTOP: "breakdown.device.DESKTOP",
  MOBILE: "breakdown.device.MOBILE",
  TABLET: "breakdown.device.TABLET",
  TV: "breakdown.device.TV",
  GAME_CONSOLE: "breakdown.device.GAME_CONSOLE",
  // Added independent review round 4 (2026-09-26) -- documented current values this map was
  // missing (see the same note on TRAFFIC_SOURCE_LABELS above).
  AUTOMOTIVE: "breakdown.device.AUTOMOTIVE",
  WEARABLE: "breakdown.device.WEARABLE",
  UNKNOWN_PLATFORM: "breakdown.device.UNKNOWN_PLATFORM",
};

export function labelDeviceType([value]: string[], t: Translate = EN): string {
  const key = DEVICE_TYPE_LABELS[value];
  return key ? t(key) : value;
}

function formatAgeGroup(raw: string): string {
  // "age35-44" -> "35-44", "age65-" -> "65+"
  const match = /^age(\d+)-(\d*)$/.exec(raw);
  if (!match) return raw;
  const [, low, high] = match;
  return high ? `${low}-${high}` : `${low}+`;
}

const GENDER_LABELS: Record<string, UiTextKey> = {
  male: "breakdown.gender.male",
  female: "breakdown.gender.female",
  user_specified: "breakdown.gender.other",
};

export function labelAgeGender([ageGroup, gender]: string[], t: Translate = EN): string {
  const genderKey = GENDER_LABELS[gender];
  return t("breakdown.ageGender", { age: formatAgeGroup(ageGroup), gender: genderKey ? t(genderKey) : gender });
}

// Country names in the interface language (BL-152), from the runtime's own region names.
const regionDisplayNames = new Map<string, Intl.DisplayNames | null>();

export function labelCountry([value]: string[], t: Translate = EN): string {
  if (!regionDisplayNames.has(t.language)) {
    regionDisplayNames.set(t.language, typeof Intl.DisplayNames === "function" ? new Intl.DisplayNames([t.language], { type: "region" }) : null);
  }
  try {
    return regionDisplayNames.get(t.language)?.of(value) ?? value;
  } catch {
    return value;
  }
}

const SUBSCRIBED_STATUS_LABELS: Record<string, UiTextKey> = {
  SUBSCRIBED: "breakdown.subscribed.SUBSCRIBED",
  UNSUBSCRIBED: "breakdown.subscribed.UNSUBSCRIBED",
};

export function labelSubscribedStatus([value]: string[], t: Translate = EN): string {
  const key = SUBSCRIBED_STATUS_LABELS[value];
  return key ? t(key) : value;
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
const CONTENT_FORMAT_LABELS: Record<string, UiTextKey> = {
  videoOnDemand: "breakdown.format.videoOnDemand",
  VIDEO_ON_DEMAND: "breakdown.format.VIDEO_ON_DEMAND",
  shorts: "breakdown.format.shorts",
  SHORTS: "breakdown.format.SHORTS",
  liveStream: "breakdown.format.liveStream",
  live: "breakdown.format.live",
  LIVE_STREAM: "breakdown.format.LIVE_STREAM",
  story: "breakdown.format.story",
  STORY: "breakdown.format.STORY",
};

export function labelContentFormat([value]: string[], t: Translate = EN): string {
  const key = CONTENT_FORMAT_LABELS[value];
  return key ? t(key) : value;
}
