> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 4. Phase 2: Channel/Video Synchronization (`src/lib/channel-sync/`)

### 4.1 Purpose and scope

Adds a reliable, quota-conscious full-channel sync workflow and local persistence for videos, laying the groundwork for the future Localization Manager (`docs/PROJECT_SPEC.md` §9–10). **This phase is read-only with respect to YouTube**: it only ever calls `channels.list`, `playlistItems.list`, and `videos.list` (all read endpoints, `YOUTUBE_READ_SCOPE` only). No `videos.update` or any other mutating call exists in this module.

### 4.2 Sync data flow

```text
Web UI / API → core.syncChannel({ credentialRef, channelId? })
  1. authResolver.resolve(credentialRef, [YOUTUBE_READ_SCOPE])      — identity/credential check (read-only scope)
  2. youtubeApi.getChannelForSync({ credentials, channelId })       — channels.list(mine|id) → { channelId, title,
                                                                       thumbnailUrl, uploadsPlaylistId }
  3. channelStore.upsertChannel(...)                                — persist/update channel row immediately
  4. youtubeApi.listUploadsPlaylistVideoIds({ uploadsPlaylistId })  — playlistItems.list, paginated 50/page,
                                                                       contentDetails.videoId only (cheap enumeration)
  5. youtubeApi.getVideosMetadataBatch({ videoIds })                — videos.list in chunks of ≤50 ids
                                                                       (part: snippet, status, localizations)
  6. channelStore.upsertVideos(entries, syncedAt)                   — upsert every video row for this channel
                                                                       (clears removed_on_youtube_at)
  6a. channelStore.markVideosRemovedOnYoutube(channelId, playlistIds, syncedAt, listedAt)
                                                                     — owner 2026-10-14: stored videos missing from the
                                                                       step-4 ids and last synced before step 4 began get
                                                                       removed_on_youtube_at (a row an overlapping sync just
                                                                       saved is never marked); every listed id loses its mark;
                                                                       skipped when the list is empty or the reader is not
                                                                       the channel's recorded owner (connectedUserId)
  7. channelStore.markChannelSynced(channelId, syncedAt)
  8. return { channel, videoCount, syncedAt, hiddenRemovedVideoIds, removedCheck }
```

Hidden rows are never deleted: `listStoredVideosByChannel` (the one list every module reads) leaves out rows with
`removed_on_youtube_at` set, while `getStoredVideo` and the analytics raw-SQL reads still see them (foreign keys from
`video_metrics_daily` keep pointing at a real row). `docs/PROJECT_SPEC.md` §9.

Steps 4–5 are the two YouTube-quota-relevant calls. Step 4 uses the **uploads-playlist enumeration strategy** (never `search.list`), matching `docs/PROJECT_SPEC.md` §9. Step 5 batches up to 50 video IDs per `videos.list` call — for a channel with, say, 420 videos, this is **9 API calls total for full metadata**, not 420. See `src/lib/youtube-read-gateway/data-api.ts` (the single read-side child module for the YouTube Data API v3, reached only through the `@/lib/youtube-read-gateway` barrel — `docs/decisions/0007-youtube-read-gateway.md`; this file was `src/lib/youtube.ts` before that refactor):

- `listUploadsPlaylistVideoIds(youtube, uploadsPlaylistId)` — paginated enumeration, dedupes video IDs.
- `getVideosMetadataContextBatch(youtube, videoIds)` — chunks `videoIds` into groups of ≤50 and issues one `videos.list` call per chunk.

Both are unit-tested directly against a mocked `youtube_v3.Youtube`-shaped client in `src/lib/youtube-read-gateway/data-api.test.ts` (not just indirectly through the service layer), specifically to verify the chunking math (120 ids → 3 calls of 50/50/20) independent of any service-level mocking.

### 4.3 Why this phase has no write-context guardrail check

`write-context`'s `assertWriteChannel` exists to fail-close **write** operations against the wrong channel. `syncChannel` never writes to YouTube — it only reads whatever channel the resolved credentials can see (`mine`) or an explicitly-requested `channelId` the credentials have read access to. Adding a write-channel guardrail to a read path would be scope creep with no safety benefit; the guardrail will be reused as-is (not re-implemented) once Phase 4+ introduces the first localization **write** path, per `docs/PROJECT_SPEC.md` §27 ("generalize, don't remove").

### 4.4 Persisted fields per video

Matches `docs/PROJECT_SPEC.md` §9 minimum field list:

```text
videoId, channelId, title, description, publishedAt, privacyStatus,
defaultLanguage, defaultAudioLanguage, thumbnails, existingLocalizations,
lastSyncedAt, etag
```

Later additive columns (each NULL = unknown until the video's next sync, never a fabricated value): `viewCount`/`commentCount`/`likeCount`, `durationSeconds`, `liveBroadcastContent`, `publishAt`, and `tags` (FO-REQ-0056 part 2, schema v125 `videos.tags_json`, a JSON array: YouTube's `snippet.tags` in YouTube's order, `[]` when the video has none). Tags come from the `snippet` part the sync already requests, so they add no quota. `upsertVideos` writes `tags_json` only when the entry carries `tags`: a targeted re-upsert without them keeps the stored tags instead of blanking them. video-details' local cache refresh after a write passes the verified read-back's tags, so a tags write (video_details_update, «Применить упаковку», producer_video_metadata_update) shows at once; otherwise the next real sync replaces them. Exposed read-only as `channel_video_list`'s `tags` field and `agent_get_video_context`'s `metadata.tags` (`docs/interfaces.md`).

`existingLocalizations` stores the full `{ [locale]: { title, description } }` map fetched via `videos.list(part: localizations)` — not just language codes — because the Localization Manager (Phase 3, `src/lib/localization/`) needs the actual remote title/description per locale, not only which locales exist. `existingLocalizationLanguages` (a derived, sorted array of the map's keys) is exposed alongside it purely for cheap UI rendering (badges) without every consumer having to re-derive it.

### 4.5 Re-sync semantics (no draft/remote distinction yet)

A re-sync **replaces** each video's persisted remote-mirror fields (title, description, localizations, etc.) with the freshly fetched values — there is currently no draft or change-set concept for this phase to protect (per `docs/PROJECT_SPEC.md` §58, the localization draft/apply workflow is an explicit non-goal until Phase 4+). Once drafts exist, sync must be revisited to detect and flag conflicts (`docs/PROJECT_SPEC.md` §30) rather than silently overwriting — **this is a known, intentional limitation of Phase 2, still true after Phase 3** (which adds no draft state either), not an oversight; see §10 (Extension points) below.

---

## 8. API Routes (Phase 2/3, additive)

Following the existing `src/app/api/video-metadata/*` route-handler + shared `error-status.ts` + `parse-json-body.ts` pattern — no parallel API surface was introduced.

```text
GET  /api/channels                                       — list locally synced channels
POST /api/channels/sync                                  — trigger a sync ({ channelId? } body; omitted = the
                                                             authenticated account's own channel)
GET  /api/channels/[channelId]/videos                     — list synced videos + existing localization languages

GET  /api/channels/[channelId]/localizations              — localization overview table (Phase 3)
GET  /api/channels/[channelId]/localizations/[videoId]    — per-video localization detail (Phase 3)
GET  /api/channels/[channelId]/localizations/export       — XLSX download, optional ?videoIds=a,b,c (Phase 3)
```

All routes require an authenticated NextAuth session (`getServerSession`), matching every existing route handler, and reuse `getVideoMetadataErrorStatus` for `DomainError` → HTTP status mapping (the error codes are shared across domain modules via the common `DomainErrorCode` type). The export route returns raw XLSX bytes with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and a `Content-Disposition: attachment` header instead of JSON.
