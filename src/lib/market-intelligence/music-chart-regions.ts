/** Phase 13 slice 13.9 (review round 8): the only regions the Music chart is fetched for. Enforced by
 * the service, so its unledgered cost stays bounded by this list and the 30-minute cache. A leaf with
 * no imports, so the client panel can share it. */
export const MUSIC_CHART_REGIONS = ["US", "GB", "DE", "FR", "JP", "KR", "BR", "IN", "RU", "ES", "IT", "CA", "AU", "MX"] as const;
