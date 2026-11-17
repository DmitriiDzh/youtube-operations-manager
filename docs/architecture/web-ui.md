> Moved verbatim from ARCHITECTURE.md on 2026-11-17; index: ../ARCHITECTURE.md

## 32. Interface language (BL-152, `docs/roadmap/plans/UI_LANGUAGE_PLAN.md`)

The Web UI shows every text in the person's interface language: English or Russian today, any language later. MCP tool texts, API response bodies and CLI output stay English -- agents and scripts read them (AGENTS.md §B).

- **Module `src/lib/ui-text/`** (flat and pure, like `shared-formatting`; not the §6.2 five-piece layering). Not related to `localization`/`ai-localization`, which translate *video* metadata.
  - `locales/en/<area>.ts` -- the English source, one file per area of the app; `locales/en.ts` merges them into one flat map, and `UiTextKey` is its key type. `locales/ru/<area>.ts` -- each typed `Record<keyof typeof <en area>, string>`, so a missing or extra key fails `tsc` and the build. A new language = a new locale folder + `<lang>.ts` + one entry in `UI_LANGUAGES`.
  - `formatMessage`: `{param}` substitution and `{n, plural, one {…} few {…} many {…} other {…}}` via `Intl.PluralRules` (no ICU library). Number params and `formatNumber` use the language's own marks (`en-US`, `ru-RU`), never the browser's locale. Dates keep `DD.MM.YYYY` in every language (`shared-formatting`).
  - `UiMessage` (`{ key, params }` or `{ text }`) lets pure `.ts` helpers return display text without holding English.
  - `apiErrorText`: a failed API answer `{ error: <DomainErrorCode>, message }`. English shows the server's message exactly as before; another language shows `errors.<code>` in words with the server's message as the detail; an unknown code shows the server's text.
- **Choosing the language.** `requestUiLanguage()` (`ui-text/server.ts`) in the root layout: the `ui_language` cookie (set by `PUT /api/ui-language`, `{ language: null }` = system) wins; else the first supported language of `Accept-Language` (the browser on the same computer follows the system language); else English. A cookie and not `app_settings`: the root layout renders every page, the recovery page included, which must work while the database cannot open. The choice is per browser profile on a computer and never syncs between devices. The layout sets `<html lang>` and passes `language`, `source` and `systemLanguage` to `UiTextProvider`; components call `useT()` / `useUiText()`. A change calls `router.refresh()`, so the whole interface re-renders without a reload.
- **Keeping it complete.** `locales.test.ts` (every language has every key, same placeholders, unique keys across areas, well-formed plurals) and `literal-text.inventory.test.ts` (the scan in `src/test-support/ui-text-literals.ts` fails on English JSX text, text attributes and sentence-like strings in `src/components` / `src/app`; a non-interface string is marked `ui-text-ignore` with a reason).

## 33. Servers and Media, other channels' work, plan move, reviewing from two computers (BL-157, ADR 0031)

Plan: `docs/roadmap/plans/SERVERS_MEDIA_PLAN.md` (FO-REQ-0009, FO-MSG-0011). Branch `feature/servers-media`.

- **Sections.**
  - `/servers/<tab>` (`ServersPanel`) holds the shared infrastructure:
    - Sessions, every channel's, named via `useChannelNames`, with a channel filter;
    - Models and Templates;
    - Setup, with the capacity log.
  - `/media/<tab>` (`MediaPanel`) holds the active channel's Plans (and `/media/plans/<id>/review`) and Jobs, plus
    `NowRunningLine`. It remounts when the channel changes.
  - `production/[[...rest]]` redirects with `productionRedirectTarget`: plans and jobs go to Media, everything else to Servers.
  - The tab lists live in `section-tabs.ts` (`SERVERS_TABS`, `MEDIA_TABS`).
- **Active-channel scoping of Media (ADR 0004 (b)).**
  - `generation-plans/shared.ts` `planHandler` calls `core.assertPlanOfChannel(planId, activeChannelOf(userId))` first. The
    audition and reference handlers do the same check through `assertVisible`. The peer routes use `assertPeerPlanOfChannel`,
    with the channel named in the report.
  - The plans list and the peer plans list filter on the server. The peers list also filters the verdicts sent from here and
    the other devices' claims to the plans it shows. Jobs use `GET /api/media-generation/jobs?scope=active`.
  - With no active channel, everything is empty or `not_found`.
- **Other channels' work (exception to ADR 0004: counts and names -- plan, wave and stage titles and notice kinds; never
  tracks, files or verdicts).**
  - `core.channelSummary({ activeChannelId, connectedChannelIds })` returns, per connected channel:
    - waiting passed / rejected;
    - the plans with waiting tracks;
    - each wave's waiting count;
    - the plans' notices other than `review_waiting`. Another device's notices are read from its report with `sharedNotices`,
      which keeps only well-formed known kinds.
  - Other devices' plans count, minus the verdicts sent from here. A channel not connected here is never counted.
  - `GET /api/generation-plans/summary` puts the active channel's counts on top (the Media badge) and `channels` beside them.
    The layout polls it every 60 s and when the channel changes.
  - The channel switcher shows `waitingLabel`.
  - The bell (`device-sync-bell.tsx`) shows `otherChannelEntries`:
    - one entry per non-active channel and type of work, derived on every poll (no `stage_complete`/`plan_complete`
      entries since owner msg 4535);
    - entries cannot be dismissed, and the dot is sky blue;
    - an entry's button runs `activateStoredChannel`, waits until `channel.id` matches, then `router.push`es the place.
    - BL-262 (owner msgs 4541/4542/4545): no group headers. Each row is a group icon (`components/icons.tsx`: disk, media,
      translations, storyboards, publishing, live, sync), red for `severity: "action"` and sky for `"info"`, then the
      avatar/name, a short `text`, and the full text as the hover `detail`. The builders set `group`/`severity`/`detail`;
      this computer's live and disk notices are built in `components/bell-notices.ts`.
  - The pure rules are in `components/channel-work.ts`.
- **Plan move (`movePlan`, `factory_plan_move`).**
  - It is serialized per plan and uses the plan's compare-and-swap.
  - Refused (`plan_invalid`) when:
    - the plan is not active (`plan_closed`);
    - the target is the same channel;
    - the target is not connected;
    - the target has no workspace;
    - the plan has an unfinished job;
    - any file is missing.
  - The file check goes through the `files` port: `resolveSentToYtmFile` in the target workspace, the player's own rules. It
    covers every distinct `auditionFile` of every result row and every reference. The answer reports
    `{ checked, missing (≤ 500), missingCount, unfinishedJobs, moved }`. `checkOnly` writes nothing.
  - On success it records `plan_moved { from, to, checked }`.
  - A plan changed during the check (its revision moved) is refused, to be asked again. The factory's plan-linked
    `create_job` runs under the same lock (`withPlanLock`, on the trimmed plan id), so a move cannot pass between its check and
    the job's creation.
  - Only the factory links a job or a session to a plan. A channel agent's `agent_create_media_job` refuses a `plan` field and
    `agent_request_media_session` a `planId`. The operator's `POST /api/media-generation/jobs` and `/sessions` and the CLI
    `media job-create` drop them.
  - `PlanJobRow.channelId` (`media_jobs.channel_id`) makes `resolveAudition` of a job output use the job's channel. The report's
    `jobChannelId` does the same for the other device.
- **Plans report version 2** (`GENERATION_PLANS_REPORT_VERSION`; the reader accepts 1 and 2, and every level stays strict).
  - On a review entry: `jobChannelId` and `history` (≤ 10).
  - On a plan: `batches` (`reviewBatches`).
  - On a group: `ownerNote`.
  - On the report: `claims` (≤ 200).
- **Plans report version 3 (BL-162, FO-REQ-0013; the reader accepts 1–3).**
  - On a group: `ownerNoteAt` -- when the current owner note was written (`ownerNoteTimes`: the newest not-superseded owner
    `group_note` event, by `writtenAt` for one that came from another device).
  - On the report: `groupNotes` (≤ 200) -- the newest wave note per device, plan and wave written here on another device's plan
    (schema v73, `generation_plan_peer_group_notes`, kept 30 days).
  - `applyPeerGroupNotes` runs with `applyPeerVerdicts` before each report: a note written after the wave's last owner-note
    change is applied (`ownerNote` set, `group_note { noteId, fromDevice, writtenAt }`); an older one is recorded with
    `superseded: true`. A note id already in an event is passed over; a note dated > 5 min ahead, for an unknown wave or a
    closed plan is skipped.
  - `recordPeerGroupNote` refuses a device whose report is below version 3 (`plan_invalid`, `peer_update_required`).
- **Waves.**
  - `reviewBatches` (pure, in `progress.ts`) returns per group: title, `note`, `ownerNote`, earliest attempt, templates, the
    params that differ between the group's items, and passed / rejected at the stage before `owner_review`.
  - `setGroupNote` from the owner writes `ownerNote`; from the factory it writes `note`. An upsert keeps `ownerNote`.
  - `recordGroupsReviewed` compares the review entries before and after an owner verdict, given here or applied from a peer. A
    wave that goes from waiting to none records `group_reviewed { groupId, accepted, rejected, overridesValidator }`.
  - The review screen:
    - lists the waves (`waveSummaries`);
    - walks one wave together with the validator filter (`visibleEntries`);
    - shows the wave's context card, its "done" summary and the next wave;
    - heads the screen with "<channel> · Review · <plan> · <wave>".
- **Two computers.**
  - **History (schema v69, `generation_plan_verdict_history`, device-local on the owning device).**
    - `recordOwnerVerdict` appends a row with `deviceLabel`, the host name.
    - `applyPeerVerdicts` appends a row with the sending device and the verdict's own note. A peer verdict older than the
      stored one is not applied but is still appended, and is recorded once as `peer_verdict { superseded: true }`.
    - `seedHistory`: before the first history row of an attempt, a current verdict stored before v69 goes in first. Its device
      is read from the note's ` (from <device>)` suffix only when a `peer_verdict` event from that device on that item proves the
      relay. Otherwise it is this device, and the note is kept whole. A replacement or an older peer verdict therefore never hides
      it. History rows are clamped to the report's bounds when they are shared.
    - `planEvents(..., history)` emits one `owner_verdict` per history row, with `device`. A key with no history row gets one
      event from the result row.
  - **Claims (schema v70, `generation_plan_review_claims`, this device's own).**
    - `claimReview` takes `{ deviceId?, planId, scope: attempt|group, itemKey/attemptRef | groupId, release? }`.
    - The claim id is a sha256 of (scope, owning device, plan[, group]). That gives one track claim per plan, which moves with
      the track, and one claim per wave.
    - A claim lasts 90 s (BL-162; was 10 minutes). `since` is kept while the same track is renewed. A verdict here ends this
      device's claim on that track.
    - The claim routes (`[planId]/claim`, `peers/[deviceId]/[planId]/claim`) publish the report at once.
    - `claimReview` runs under the plan's lock, so a release and the next claim sent together keep the new claim. A release
      removes only this device's own claim (the same track) and needs no plan or channel, so it works after a channel switch.
    - `claimsOn` and `peerClaims` read the peers' live claims. A claim that reaches more than 15 minutes ahead is ignored.
    - The screen (BL-162):
      - renews its claims every 30 s and releases them on leaving (`keepalive`);
      - reads the others' claims every 3 s from `GET .../claim` (not the whole queue);
      - passes over claimed tracks (`claimOf`, `stepIndex`, `nextWaitingIndex(skip)`); the queue column still opens one on a
        click ("show them too" and "take this wave" were removed: what is in work follows what is open, owner msg 2263);
      - when two computers opened the same track within the sync delay, the later opener moves on to the next free track,
        but only while its verdict draft is untouched.
  - **Presence files (BL-162, `sync-gateway/generation-plans/presence.ts`).** Each device writes its live claims into
    `<sync folder>/generation-plans/global/<deviceId>.presence.json` (`ytm-review-presence` v1, strict, ≤ 256 KB read)
    the moment a claim changes; `peerClaims` reads the others' files straight from disk and, for a device that has one,
    ignores the claims in its (older) report. A file must name the device it is named after. The sync runner only reads
    `*.automerge`, so it never sees these files.
  - **Pending verdicts.**
    - On the owning device, `pendingPeerVerdicts` uses the same rules as `applyPeerVerdicts`.
    - `withPending` overlays a not-yet-applied verdict from another device as given (`pendingFrom`), in the queue, `summary` and
      `channelSummary` (`ownerQueue`). The owner's plan list and plan card (`listPlans` / `getPlan` with `ownerView`) adjust the
      items' and waves' waiting counts and the `review_waiting` notice the same way (`ownerProgress`). The factory's reads do not.
  - **Replace guard.**
    - `recordOwnerVerdict` and `recordPeerVerdict` refuse an existing verdict without `replace`: one here, relayed, sent from
      here, or pending from a peer. The error is `plan_verdict_exists` (409, `planVerdictExists`) with
      `{ existing: { result, rating, device, at } }`.
    - The screen asks first (`ConfirmDialog`) and asks again on a 409.
- **Limits** (RISK-114, RISK-119):
  - claims are advisory and arrive within the sync delay (seconds with the presence files and a 1 s Syncthing watch delay);
  - both computers must run the same report version (3 since BL-162; 4 since BL-173, §42).
- **Screens (BL-162, `docs/roadmap/plans/MEDIA_UX_REDESIGN_PLAN.md`).** The review screen is a window-high workstation:
  a toolbar (back, plan, wave picker, progress, validator filter, "About the wave", "View") and three columns -- the player
  with the verdict under it, the auto-check, the queue. The Plans list holds this device's and the other devices' plans of
  the channel; one card (`plan-card-model.ts` adapts another device's report defensively) with KPI tiles, a stage funnel and
  a waves table; actions that change the plan are shown disabled "on <computer>" for another device's plan.

## BL-221 — the Content section redesign (CONTENT_UX_PLAN.md)

Owner msgs 3439/3444/3449/3451/3453. On branch `feature/content-ux-redesign`. No schema change; no new YouTube call.

- **Vn ↔ YouTube video.** `buildVideoList` gives each number `youtubeVideoId`: the folder's `Vn_youtube.json` (read by the
  workspace adapter through `resolveWorkspaceFile`, only for a number whose folder the list knows), else this computer's upload
  (`publishing_uploads.video_id`), else the registry row; and `hasVideoFile` (`isVideoFileName` + `isNamedAfterRelease`).
  `uploading` (an upload of the number queued or running here). `factory_video_list` / `agent_video_list` carry all three
  (Factory API 1.31.0, Agent API 4.5.0).
- **«Привязать к видео».** For a number uploaded outside the app. `linkSuggestions` (pure, `video-projects/linking.ts`): unlinked
  regular synced videos (not `live`/`upcoming`) published, or scheduled, on the folder's MMDD (the year nearest to now) UTC day; the
  rest by the nearest date. Never by title (AGENTS.md §F). `linkVideo` (under the module lock): the number needs a folder, no video, no upload under way here (`video_upload_in_progress`) and not to be cancelled;
  the video must be a synced, not removed video of the channel and not another number's (`video_already_linked`, 409); writes
  `{ schema: "yt-release-upload/1", channelId, video, videoId, linkedAt, linkedBy: "owner", device, result: "linked" }` with
  `workspace-videos.writeUploadRecordFile(..., { exclusive: true })` -- real folder inside the workspace, temp file + rename, never
  over an existing record. Publishing's upload runner now writes its record through the same function. A local file only.
- **Video insights.** `src/lib/video-insights` (pure `buildVideoInsights` + `loadVideoInsights` over `db.ts`): kind = `live`
  (`liveBroadcastContent` live), `broadcast` (upcoming), `recording` (a broadcast in `live_stream_segments` or
  `live_viewer_samples`), else `video`; views over the 7 days ending on the newest `video_metrics_daily` day; impressions and
  CTR (clicks / rated impressions) over the 7 days ending on the newest `channel_reach_daily` day. `GET .../videos/insights`.
- **Board.** `video-pipeline.ts` derives the display phase (prep / edit / package / youtube / published) from `state`,
  `hasVideoFile`, `youtubeVideoId` and the synced video's privacy; `VideoState` is unchanged.
- **Live viewers.** `summarise.ts` `viewersOf`: a sample with `lifeCycleStatus` live and no count is 0 viewers (YouTube omits
  `concurrentViewers` when nobody watches; owner msg 3453); otherwise no count stays unknown. Producer API 1.12.0.
- **Tab badges.** `content-tab-badges.ts`: video-projects (edit + package phases), the calendar's `coverage.due`, the live overview's
  health (bad / noData / revoked while live); local reads once a minute.

