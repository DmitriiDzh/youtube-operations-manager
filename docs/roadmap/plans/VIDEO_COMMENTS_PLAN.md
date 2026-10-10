# Own-video comments (BL-171, FO-REQ-0015 item 7)

**Status: IN PROGRESS** on `feature/fo-req-0015-video-comments`. Owner, Telegram 2026-10-10 (msg 2491, «да»): FO-REQ-0015 step 6 in the
order of DEV-RESP-0018.

## 1. Facts (checked 2026-10-10)

- **Access:** both channels' Google sign-in already has `youtube.force-ssl` and `youtube.readonly`, so `commentThreads.list` needs no new
  sign-in.
- **The query** (checked live, read-only, on 4 videos of both channels): `commentThreads.list` with `part=snippet`, `videoId`,
  `maxResults=100`, `order=time` and `textFormat=plainText` returns the top-level comments, newest first. Each comment has:
  - `topLevelComment.id`;
  - `textDisplay` (plain text; equal to `textOriginal`);
  - `authorChannelId`, `authorDisplayName`;
  - `likeCount`, `publishedAt`, `updatedAt`;
  - `totalReplyCount`, `isPublic`.

  No reply exists yet on either channel. The call costs 1 Data API unit (10,000 a day).
- **How many comments there are:** the stored `comment_count` (synced from `videos.list` statistics) is 2 on Rural Japan Music's 44 public
  videos and 5 on Tropico Jazz's 51. Reading every video every day would spend some 95 units a day to find a handful of comments.
- **Policy:**
  - Comments on our own videos are Authorized Data that is neither analytics nor statistics, so they may be kept **at most 30 days, then
    deleted or refreshed** (III.E.4.c).
  - The retention job today purges only Non-Authorized tables; III.E.4.c data with a clock is new.
  - Comment authors are other people: their names, photos and channel ids are not needed for "audience reaction" and are not stored.

## 2. Design

### What is read, and when

- **Which videos:** an own video is read only when its synced `comment_count` is above 0, or when it had comments stored.
- **When it is due:**
  - it was never read;
  - its synced `comment_count` differs from the one at its last read (a comment came or went);
  - or its last read is 7 or more days old.

  The weekly reread keeps every stored text younger than 30 days, and a video whose count dropped to 0 is read once more, which clears it.
- **The read:** one `commentThreads.list` per video, the 100 newest top-level threads, top-level comments only (`totalReplyCount` is kept).
  Each read replaces that video's stored comments.
- **Limits and order:** at most 50 videos per channel per run, least recently read first (never read first).
- **When it runs:** in the background with the dashboard's collection, after the analytics steps, for each channel collected
  (`/api/analytics/auto-collect-all`).
- **Gates:** the Data API reads switch (inside the client), the Data API quota reserve (`isBackgroundReadAllowed("data")`) and the
  quota-history label "Comment collection".
- **Failures:** the shared read-failure rules. `stop` ends the run with nothing written; `defer` puts the video back 24 h and ends the run;
  `attempt` counts one try, retry after 24 h, `failed` after 3.
  - A 403 `commentsDisabled` is not a failure: the video is stored as `disabled` with no comments, and read again only when its count
    changes.
  - The rules move from `analytics/query-failure.ts` to the read gateway (`youtube-read-gateway`), shared by analytics and comments, and
    `data_api_reads_disabled` stops a run like `analytics_reads_disabled`.

### Storage (schema v80, device-local)

- **`video_comments`:** key `comment_id`, plus `video_id`, `channel_id`, `published_at`, `updated_at`, `text`, `like_count`, `reply_count`,
  `by_channel_owner` (the author is the channel itself) and `fetched_at`.
  - No author name, photo or id.
  - New classification kind `authorized_expiring` (III.E.4.c, clock `fetched_at`). The retention job deletes rows older than 30 days,
    in the live database, on import and in backups, exactly like Non-Authorized rows.
- **`video_comment_state`:** key `video_id`, plus `channel_id`, `read_at`, `read_comment_count`, `status` (collected | disabled | retry |
  failed), `attempts`, `last_error`, `next_attempt_at`.
  - Bookkeeping and a statistic, so classified `authorized`.
- Both tables stay on the computer that collected them, like the milestones.

### Read tool `agent_get_video_comments`

- **Input:** `{ channelId, videoIds (1–20), limit? (1–100, default 20) }`.
- **Output per video:** `{ videoId, title, commentCount (synced), status (collected | disabled | retry | failed | not_collected), readAt,
  lastError, comments }`.
  - `comments`: `[{ commentId, publishedAt, updatedAt, text, likeCount, replyCount, byChannelOwner }]`, newest first, at most `limit`.
- A video of another channel is not listed.
- The description says:
  - comments are read when the synced count changes, and at least weekly;
  - text is kept at most 30 days;
  - author names are not kept.
- **Versions and permission:** a READ, local-only tool. Agent API 3.12.0 → **3.13.0**, capability `video_context.query_video_comments`.
  Producer: on its closed list, Producer API 1.5.0 → **1.6.0** (ADR 0034 Amendment 6).

### Not in this step

- Replies, comment authors and live reads of comments.
- Videos with no comment counted by the sync.
- Writing comments: never through this feature.
- No UI.

## 3. Acceptance criteria (fixed before the code)

The clock is 2026-10-10T18:00:00Z unless said otherwise.

- **AC-VC-01 (who is read).** Videos with synced `comment_count`: `a` 2, `b` 0, `c` null, `d` 1 (private). Only `a` and `d` are read; `b`
  and `c` are not. *The plan reads by count, whatever the visibility: a private video's comments still exist.*
- **AC-VC-02 (the query).** The read of `a` is one `commentThreads.list` with `part=["snippet"]`, `videoId=a`, `maxResults=100`,
  `order=time` and `textFormat=plainText`.
- **AC-VC-03 (stored shape).** A thread with this top-level comment:
  - id `c1`, `textDisplay` "Beautiful music!";
  - `likeCount` 3, `publishedAt` 2026-09-27T19:16:28Z, `updatedAt` 2026-09-28T08:00:00Z;
  - `totalReplyCount` 2;
  - `authorChannelId` equal to the channel.

  It is stored as text "Beautiful music!", likeCount 3, replyCount 2, byChannelOwner true, with those times, and `fetched_at` = now.
  Another author gives byChannelOwner false. No author name is stored.
- **AC-VC-04 (when due).**
  - `a` read on 10-10 with count 2 is not due on 10-11 .. 10-16 while its count stays 2.
  - It is due on 10-11 when its count becomes 3.
  - It is due on 10-17 (7 days) with count 2.
  - A video read with comments whose count becomes 0 is due, and its read clears its comments.
- **AC-VC-05 (replace).** A reread replaces the video's comments: one the new answer lacks is gone, and other videos' comments stay.
- **AC-VC-06 (cap and order).**
  - With 60 due videos never read, a run reads 50, and the next run reads the other 10.
  - Never-read videos come first, then the least recently read.
- **AC-VC-07 (failures).**
  - A 403 `commentsDisabled` stores `disabled` with no comments, counts no attempt, and is not read again while the count stays the same.
  - A 404 counts an attempt: retry after 24 h, `failed` after 3.
  - A 503, a 429 or no answer puts the video back 24 h and ends the run.
  - `youtube_quota_exceeded`, `data_api_reads_disabled`, a 401 and a 403 `quotaExceeded` stop the run with nothing written.
- **AC-VC-08 (reserve).** While the Data API background reserve is not allowed, a run makes no call.
- **AC-VC-09 (retention).**
  - A `video_comments` row fetched 31 days ago is deleted by the retention job; one fetched 29 days ago stays.
  - The table is classified `authorized_expiring`, so the import purge and the backup scrub cover it too.
- **AC-VC-10 (reads).**
  - `agent_get_video_comments` for `a`, `b` and a video of another channel returns `a` (newest first, `limit` respected) and `b` with
    `not_collected`; the other channel's video is not listed.
  - `limit` 0 or 101 is refused, and so are 0 or 21 `videoIds`.
  - Through the Producer, the call runs in the named channel's scope.
- **AC-VC-11 (independence).** A comment run that throws does not stop the next channel's run; the same channel's analytics steps ran
  before it.
- **AC-VC-12 (contract).**
  - Agent API 3.13.0 with `video_context.query_video_comments`.
  - Producer API 1.6.0 with the tool on its list.
  - Both tables are device-local.
  - The shared failure rules live in the read gateway and still give the same answers for the analytics steps (their tests pass
    unchanged).
