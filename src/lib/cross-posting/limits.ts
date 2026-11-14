// BL-252 (CROSS_POSTING_PLAN.md R4): every network rule in one place, with its source and the date it was checked. A network
// that changes a rule changes this file only. Checked 2026-11-14 against Meta's official references.

/** developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media (REELS). */
export const INSTAGRAM_REEL = {
  minSeconds: 3,
  maxSeconds: 15 * 60,
  maxBytes: 300 * 1024 * 1024,
  captionMaxChars: 2200,
  maxHashtags: 30,
  maxMentions: 20,
  /** Meta: 100 API posts per 24 h; the carousel section of the same page says 50 -- budget the lower one. */
  postsPer24h: 50,
} as const;

/** developers.facebook.com/docs/video-api/guides/reels-publishing (Page Reels). */
export const FACEBOOK_REEL = {
  minSeconds: 3,
  maxSeconds: 90,
  titleMaxChars: 255,
  descriptionMaxChars: 2200,
  postsPer24h: 30,
} as const;

/** 9:16 within a small tolerance (1080×1920, 720×1280, 540×960 …). */
export const VERTICAL_RATIO = { width: 9, height: 16, tolerance: 0.02 } as const;
