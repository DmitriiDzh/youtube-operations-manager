# Research module: data sources beyond the current YouTube APIs (as of 2026-10-01)

## 0. The quota assumption is out of date (this changes the plan)
- Since **June 1, 2026**, `search.list` and `videos.insert` each have **their own quota bucket**. The official quota page says the default is "100 `search.list` calls, 100 `videos.insert` calls, and 10,000 units per day combined for all other endpoints". It lists search as "100 quota per day. Each call costs 1 quota." ([quota page, updated 2026-09-15](https://developers.google.com/youtube/v3/determine_quota_cost), [revision history](https://developers.google.com/youtube/v3/revision_history)). Some blogs still say "100 units per call". The official page is what counts.
  → Discovery is now capped at **about 100 searches a day**. Searches no longer eat into the 10k pool. Cutting other calls will not free up more searches. Only a Quota Extension request can.
- Since **June 3, 2026** there is **`videos.batchGetStats`**. It costs 1 unit, has **its own 10k/day bucket**, and needs no auth for public videos. It returns viewCount, likeCount, commentCount, publishTime and duration ([docs](https://developers.google.com/youtube/v3/docs/videos/batchGetStats)). The maximum number of IDs per call is **not documented**.
- Since July 2025, `videos.list?chart=mostPopular` returns only the Trending **Music, Movies and Gaming** charts ([revision history, 2025-07-10](https://developers.google.com/youtube/v3/revision_history)). YouTube's Trending page was shut down on July 21, 2025 ([9to5Google](https://9to5google.com/2025/07/10/youtube-trending-page-removal/)). For a music niche, `chart=mostPopular&videoCategoryId=10&regionCode=XX` is still a cheap (1 unit) trending-music signal per region.
- On **Aug 27, 2026**, public view counting changed: a view now counts "the moment a video begins to play" for long-form, Live and Shorts ([revision history](https://developers.google.com/youtube/v3/revision_history)). Snapshot series have a **break at that date**, and spike detection should treat it as a discontinuity.
- Existing cheap paths still apply: `channels.list`/`videos.list` take 50 IDs for 1 unit, and `playlistItems.list` on the uploads playlist (UC→UU) costs 1 unit ([quota page](https://developers.google.com/youtube/v3/determine_quota_cost)).

## 1. Official Google/YouTube sources

| Source | Data | Cost / limits | Auth | ToS risk | Value |
|---|---|---|---|---|---|
| **RSS** `youtube.com/feeds/videos.xml?channel_id=` | **15 newest** uploads: videoId, title, published/updated, thumbnail, description, `media:statistics views`, `starRating count` (verified by a live fetch today) | Free, no quota, rate not documented | None | Same data and same rules as the API (see §2). The WebSub guide uses it as the official topic URL ([guide](https://developers.google.com/youtube/v3/guides/push_notifications)) | **High**: new-upload detection for the watchlist without spending quota |
| **WebSub/PubSubHubbub** | Push on upload, title update, description update ([guide](https://developers.google.com/youtube/v3/guides/push_notifications)) | Free; leases are set by the hub and must be renewed (about 10 days reported, [3rd-party](https://rapidevelopers.com/api-automations/how-to-automate-youtube-upload-webhooks-and-cross-channel-alerts-using-the-api)) | None, but needs a **public HTTPS callback** | Low | Medium. A local-first app needs a tunnel or relay, so RSS polling is simpler |
| **oEmbed** | Title, author, thumbnail, embed HTML. **No stats** (verified today) | Free | None | Low | Low |
| **YouTube Reporting API** | Bulk daily CSV reports. **Only for the authenticated channel or linked content owner.** Reports are kept for 60 days (historical: 30) ([docs](https://developers.google.com/youtube/reporting/v1/reports)) | Free | OAuth | Low | Own channels only: a cheaper bulk alternative to Analytics API calls, not useful for competitors |
| **Google Trends API (alpha)** | Consistently scaled search interest, 5-year rolling window, daily/weekly/monthly, region and sub-region ([announcement 2025-07-24](https://developers.google.com/search/blog/2025/07/trends-api), [apply](https://developers.google.com/search/apis/trends)) | Gated alpha, no GA or pricing found | Application | Low | Medium-high **if accepted**. Covers Google **Web Search**; YouTube Search is not documented as included |
| **Keyword Planner (Google Ads API)** | Google Search volume (ranges unless the account spends on ads) | Free, but needs a manager account, a developer token with **Basic access**, and real ad spend for exact volumes ([3rd-party guide](https://habr.com/en/articles/869386)) | OAuth + dev token | Low | Low-medium. Not YouTube-specific |
| **YouTube search suggest** `suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=` | Autocomplete phrases | Free | None | **Undocumented, unofficial** endpoint ([ref](https://apiserpent.com/blog/scrape-google-autocomplete-free)); automated use conflicts with the ToS automated-access clause | Medium signal, but not policy-clean |

## 2. Compliance: what the YouTube API Developer Policies imply ([source](https://developers.google.com/youtube/terms/developer-policies))
- **Definitions:** *Authorized Data* is data a user authorizes via their credentials. *Non-Authorized Data* is "API Data accessible by an API Client without User Credentials". Public stats of competitor channels are Non-Authorized Data.
- **III.E.4.d:** Non-Authorized Data may be stored "not longer than **30 calendar days**", after which it must be deleted or refreshed. **III.E.4.a/b:** statistics and analytics may be kept "as long as necessary" only when they are **Authorized** (your own channels), with re-authorization checked every 30 days.
- **III.E.4.h:** you must not "access or use API Data to create new or derived data or metrics."
- **III.E.2:** aggregation is allowed only across channels of the same content owner, and not "to gain insights into YouTube's usage…".
- **III.E.4.f:** historical data may be shown if "presented accurately in context of time".
- **III.E.6:** you must not "scrape YouTube Applications… or **obtain scraped YouTube data**."

**What this means for us:** keeping **long-term competitor snapshots past 30 days is not compliant** under III.E.4.d. Our own channels' stats are fine. Spike and trend scores computed from competitor view counts plausibly count as "derived metrics" under III.E.4.h. Options:
- Keep competitor raw data on a rolling 30-day window, or refresh it within that window rather than archiving it.
- Keep long-term history only for our own channels.
- Treat derived scores as ephemeral (computed for display, not stored).

RSS is **not a loophole**: it is the documented feed URL, so treat its stats under the same rules. These are policies for API clients and our app is one; a solo, non-public tool lowers the enforcement risk but does not change what is permitted.

## 3. Third-party providers (pricing mostly from secondary sources; confirm with the vendor)
- **Social Blade Business API**: same public stats as the site, plus rankings and top lists. Credit-based, from $0.50 down to about $0.06 per credit with volume, and Premium plans include 5–50 credits a month ([business-api](https://socialblade.com/business-api)). The **cheapest way to get long-term competitor history**, because the history is theirs and is not stored from our API calls.
- **HypeAuditor**: from about $299/month billed annually; API on higher tiers ([pricing](https://www.hypeauditor.com/pricing), [review](https://outlierkit.com/blog/hypeauditor-review-alternatives)).
- **NoxInfluencer**: memberships from about $239/month; API data service billed on demand ([Capterra](https://www.capterra.com/p/187786/NoxInfluencer/pricing/)).
- **Modash**: influencer API covering 250M+ creators; price on request ([modash](https://modash.io/pl/influencer-marketing-api)).
- **Tubular Labs**: enterprise, unpublished pricing, reported from about $1k/month ([creatorstackclub](https://www.creatorstackclub.com/software/tubular)).
- **Viewstats**: UI tool. Pro $49.99/month, Business from $249; no public API found ([pricing](https://viewstats.com/pricing)).
- **vling**: "Custom API" under Enterprise only ([pricing](https://vling.net/en/pricing)).
- **Playboard**: no pricing page or public API could be verified.
- **Fit:** they are useful for manual research. Pulling their data, which is likely scraped, into the same API client is a **risk under III.E.6**. Keep it in a separate module and source, labelled as third-party.

## 4. Adjacent and early trend signals
- **Wikipedia Pageviews API**: free, no auth, daily per-article views since 2015, plus top-articles lists. Verified with `Ambient_music`, which gets about 450 views a day ([docs](https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html)). Wikimedia asks for a descriptive User-Agent. **High value and zero risk** for topic trend lines (genres, moods, artists).
- **Last.fm API**: tag and chart data, useful for ambient/lo-fi genres. Free for **non-commercial** use, needs attribution, and caps storage at 100 MB ([ToS](https://www.last.fm/api/tos)). Medium value.
- **Spotify Web API**: since the February 2026 Development Mode changes, the app owner needs Premium; **popularity and followers fields were removed**; artist top-tracks and browse/new-releases were removed; search is limited to 10 results ([migration guide](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)). Low value now.
- **TikTok**: the Research API is for academics and non-profits only, with no commercial use ([datashake](https://www.datashake.com/blog/tiktok-data-coverage-in-2026-what-social-intelligence-teams-need-to-know)). Not available to us. Browsing Creative Center manually is fine.
- **Reddit**: free for non-commercial use at 100 QPM with OAuth. Commercial use is about $0.24 per 1k calls. New apps go through manual review since late 2025 ([octolens](https://octolens.com/blog/reddit-api-pricing)). Low-medium value.
- **X**: pay-per-use since February 2026, about $0.005 per post read, and no free tier for new signups ([postproxy](https://www.postproxy.dev/blog/x-api-pricing-2026/)). Low value for this niche.
- **Unofficial Google Trends libraries**: pytrends was **archived on April 17, 2025** and returns 429 errors ([apiserpent](https://apiserpent.com/blog/pytrends-dead-google-trends-data-2026)). Fragile and against Google's terms. Avoid.

## 5. Scraping (yt-dlp, Innertube/youtubei)
These can reach almost anything: full upload lists, comments, search results and recommendations. However, the YouTube ToS forbid accessing "the Service using any automated means (such as robots, botnets or scrapers)" except for public search engines following robots.txt or with written permission ([ToS](https://www.youtube.com/static?template=terms&hl=en&gl=US)). Developer Policy III.E.6 separately bans scraping or obtaining scraped data. Using them **violates the YouTube ToS** and puts at risk the OAuth project our write features depend on. **Avoid.**

## 6. Recommendation
1. **Now: RSS polling for the watchlist** to detect uploads, with no quota, plus **`videos.batchGetStats`** for snapshots (separate 10k bucket). This frees the main 10k pool.
2. **Now (compliance):** apply a 30-day retention or refresh to competitor (Non-Authorized) data, keep long-term history only for our own channels, and stop persisting derived scores computed from competitor data. Document this in TECHNICAL_DEBT.
3. **Next: Wikipedia Pageviews** as a free topic-trend source, plus `chart=mostPopular` with music category per region.
4. **Apply** to the Google Trends API alpha. Consider a Quota Extension for search if 100 searches a day is not enough.
5. **Optional (paid):** Social Blade credits for long competitor history, kept as a separate third-party source.
6. **Later:** WebSub, only if there is a public relay; Last.fm for niche genre tags.
7. **Avoid:** scraping (yt-dlp/Innertube), pytrends, the TikTok Research API, X, and Spotify for popularity data.
