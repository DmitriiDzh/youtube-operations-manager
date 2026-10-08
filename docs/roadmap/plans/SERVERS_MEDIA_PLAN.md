# Servers and Media, plan move, review by wave, two computers (BL-157, FO-REQ-0009)

**Requested** by the Factory Operator on the owner's proposal in FO-REQ-0009 (2026-10-08, §1–§7). The operator answered
DEV-MSG-0004 in FO-MSG-0011.

**Assigned** by the owner in Telegram on 2026-10-08. The decisions:
- msg 2119:
  - the bell lists only channels that are not active;
  - all of FO-REQ-0009 goes on one branch, `feature/servers-media`.
- msg 2121: a missing file during a move is an error that lists the missing files.
- msg 2125: "делай план и приступай к реализации".

The merge into `dev` still needs the owner's explicit yes.

## How it works today (from the code, 2026-10-08)

- **Production** is one section with these tabs: Sessions, Jobs, Plans, Models, Templates and Setup. Nothing in it is
  filtered by the active channel:
  - the plans list, the jobs list, the review queue and `GET /api/generation-plans/summary` (the menu badge) are device-wide;
  - `generation-plans/shared.ts` says so on purpose.
- **Factory spend** (day / month) is not in the UI. Only the factory tool reads it.
- **A plan's channel** (`generation_plans.channel_id`) and each job's channel (`media_jobs.channel_id`) are separate:
  - a job's output lives in its own channel's `From YTM/media/<jobId>`;
  - `resolveAudition` resolves both the reported `auditionFile` and a job's output under the plan's channel.
- **Progress, spend, ETA, notices and events** are derived by `plan_id` and do not depend on any channel.
- **The peer report** (`ytm-generation-plans`, version 1) is `.strict()` at every level. An older build therefore rejects a
  report that has any new field. That means the whole report, plans and verdicts included.
- **The owner device's queue** reads only local rows. A verdict given on the other device reaches the owner device in about
  1.5–3 minutes (report tick ≤ 30 s, push ≤ 60 s, Syncthing, pull ≤ 60 s) and is applied on the owner's next tick.
- **"Newer"** means the verdict's own time on the device clock (`at`), compared in whole seconds. A verdict dated more than
  5 minutes ahead is refused.
- **No verdict history.** A result row is replaced, and the `owner_verdict` events are derived from the current row, so
  only the latest verdict per attempt exists.
- **The review screen ignores `entry.groupId`.** The queue cannot be filtered by wave.
- **The factory's wave context and the owner's wave note share one field,** `group.note`. The factory writes it with
  `factory_plan_update upsertGroups`, the owner with `setGroupNote`.

## A. Move a plan to another channel (FO-REQ-0009 §4, FO-MSG-0011)

- **AC-MV-01: tool.** `factory_plan_move { planId, channelId, checkOnly? }`. It is a factory write tool, so the
  Factory Operator role can call it. Factory API 1.8.0.
- **AC-MV-02: refusals.** Nothing changes when any of these holds:
  - The plan is not active: `plan_closed`.
  - The target channel is the plan's current channel: `plan_invalid`.
  - The target channel is not connected on this device: `plan_invalid`.
  - The target channel has no workspace on this device: `plan_invalid`.
  - The plan has an unfinished job (queued, submitted, generating or transferring): `plan_invalid`, with the job count. Such a
    job would land its output in the old channel in the middle of a move.
- **AC-MV-03: file check.**
  - The check covers every distinct `auditionFile` on every result row of the plan (all stages, not only waiting ones) and
    every reference `file`.
  - Each path is resolved in the target channel's `99 Data Exchange/Sent to YTM/` with the same resolver that plays them
    (`resolveSentToYtmFile`: no symlinks, inside the folder, a regular file).
  - The answer is `{ planId, from, to, checked, missing[] }`. `checked` is the number of distinct paths checked, so an empty
    `missing` list cannot hide a check of nothing.
  - With `checkOnly: true`, the tool returns the answer and changes nothing, whether or not files are missing.
  - Without `checkOnly`, any missing file refuses the move with `plan_invalid`, and `details` carries `checked` and
    `missing`. Nothing is moved.
- **AC-MV-04: the move.**
  - The plan's channel changes through the plan's compare-and-swap.
  - An event `plan_moved { from, to, checked }` is recorded with the caller as actor.
  - Jobs, sessions, results, owner verdicts, peer verdicts, events, notices, progress and spend are not touched. They keep
    counting, because all of them are read by `plan_id`.
- **AC-MV-05: paths after a move.**
  - A reported `auditionFile` and a reference resolve in the plan's new channel.
  - A job's own output (an attempt with no `auditionFile`) resolves in the channel the job ran on (`media_jobs.channel_id`).
    This holds both on this device and on the other device (report v2, §B).
- **AC-MV-06: future runs.** `factory_plan_run_stage`, `factory_plan_rerun`, `factory_media_create_job` with plan fields and
  `factory_media_start_session` with `planId` require the new channel. This follows from the existing checks against the
  plan's channel. A test proves that a session of the old channel is refused after the move.
- **AC-MV-07: the event in the UI.** The plan's event log names the move with a real interface-text key in every language.
  Channel agents see a moved plan under the new channel only, through the existing channel filter.

## B. Peer report version 2 (one bump for the whole branch)

- **AC-RP-01.** This build writes version 2 and reads versions 1 and 2, following `media-sessions` (BL-148). The new
  fields are optional when reading, and a version 1 report reads exactly as before.
  - A review entry gains `jobChannelId`, `history` and `pendingVerdict`.
  - A plan gains `batches` and the groups' `ownerNote`.
  - The report gains `claims`.
- **AC-RP-02.** A version 2 report that a version 1 build rejects is the known cost. Until both computers run this build,
  each one keeps showing the other's last version 1 report, then shows it as stale. Both computers must update together. The
  release note and the owner are told.
- **AC-RP-03.** A peer's job audition resolves in the entry's `jobChannelId` when present, else in the plan's channel.

## C. Servers and Media (FO-REQ-0009 §1, §2)

- **AC-SM-01: two sections replace Production.** The left menu shows "Media" right after Content, then "Servers".
  - **Servers** has the tabs Sessions, Models and Templates on the left and Setup on the right. Setup keeps compute, storage
    (the volume), limits, the GPU fallback list, factory limits and the capacity log. The balance header stays at the top.
  - **Media** has the tabs Plans and Jobs. The review lives at `/media/plans/<id>/review`.
- **AC-SM-02: old addresses.** Every `/production/...` address redirects:
  - `plans...` and `jobs` go to `/media/...`;
  - everything else goes to `/servers/...`.
  A remembered sidebar path from before the change therefore still works.
- **AC-SM-03: Media is the active channel's.** The server resolves the active channel; the client never supplies it
  (ADR 0004 (b)).
  - The plans list and the other devices' plans show only plans whose `channelId` is the active channel.
  - The jobs list shows only that channel's jobs.
  - A plan of another channel is `not_found` through every owner route under `/api/generation-plans/[planId]/...`. The same
    holds for the peer routes, judged by the report's channel. This covers the review queue, a verdict, the audition, the
    reference, a group note, the review-rejected switch, a rerun request and closing.
  - Without an active channel, Media is empty (fail-closed, like ADR 0004).
- **AC-SM-04: the channel switch.** Switching the active channel switches Media: the section remounts on the channel,
  as Production already does.
- **AC-SM-05: sessions in Servers.**
  - The open table and the recent table show each session's channel by name. A channel not connected here shows its id.
  - A filter offers "All channels" plus each channel that has sessions.
  - Other devices' sessions show the channel by name too.
- **AC-SM-06: "now running" in Media.** When a session of the active channel is starting or running, Media shows one line:
  the session, its GPU and its state, with a link to Servers → Sessions.
- **AC-SM-07: review header.** The review screen's header shows "<channel name> · <plan id> · <wave title>". The wave is the
  current entry's group; with no group, it is left out.
- **AC-SM-08: texts.** Every new or moved text is a key in every interface language. User-facing server messages that say
  "Production → X" now say "Servers → X" or "Media → X".

## D. Other channels' work: switcher counts and the bell (FO-REQ-0009 §3, §3a)

**Owner decision (msg 2119):** the bell lists only channels that are not active. This is a deliberate exception to ADR 0004 and
is recorded in ADR 0031. It shows counts and notice names of the owner's own connected channels, never their tracks, files or
plan contents.

- **AC-BL-01: summary per channel.** `GET /api/generation-plans/summary` returns:
  - `waitingReview`, `waitingPassed` and `waitingRejected` for the **active** channel only (this is the Media badge);
  - `channels[]`, one row per channel connected on this device, each with:
    - `channelId`;
    - `waitingReview`, `waitingPassed` and `waitingRejected`;
    - `batches[]` with `{ planId, groupId, title, waiting }` for the waves that have tracks waiting;
    - `notices[]` with `{ planId, kind, ... }` for each plan of that channel.
  The counts include other devices' plans of that channel, minus the verdicts already sent from here, as the badge does
  today.
- **AC-BL-02: Media badge.** It counts the active channel only. The tooltip keeps the passed / rejected split.
- **AC-BL-03: switcher.** Each channel in the switcher with tracks waiting shows "N waiting (P passed, R rejected)". A channel
  with nothing waiting shows nothing.
- **AC-BL-04: bell entries.** The bell gets an "Other channels" part, built from the same summary.
  - Each channel that is not active gets one entry per type of work:
    - **review:** "Media: N tracks waiting for review (P passed, R rejected)", plus the waiting count of each wave, for
      example "C13 47 · C14 38";
    - one entry per plan and notice kind: `stage_complete`, `plan_complete`, `attempts_exhausted`, `budget_80` and
      `budget_100`.
  - Each entry shows the channel's avatar and name.
  - The counts update in place on every poll. Nothing is posted per track or per event.
- **AC-BL-05: open the place.**
  - An entry's button switches the active channel, waits until the switch has landed, and opens the place:
    - for review, that plan's review when one plan waits, otherwise Media → Plans;
    - for a notice, Media → Plans.
  - The button reuses the switcher's activation, with its overlay.
- **AC-BL-06: lifetime.**
  - Entries are derived on every poll and cannot be dismissed. An entry goes away when its count reaches zero or its notice is
    no longer derived.
  - The bell's dot shows while any entry exists.
  - The active channel's work is never listed: its own menu badge covers it.
- **AC-BL-07: no Servers entries.** Shared infrastructure (sessions, pulls, capacity waits) is not added to the bell. The
  bell's device-sync part stays as it is.

## E. Review by wave (FO-REQ-0009 §7)

A wave is the plan's group.

- **AC-WV-01: wave list.** The review screen lists the plan's waves that have review entries. Each wave shows:
  - its title;
  - its waiting count, split passed / rejected;
  - its progress, "X of Y reviewed", where Y is that wave's review entries and X the ones with an owner verdict.
  "All waves" stays available. With no groups, there is no list.
- **AC-WV-02: walking a wave.**
  - With a wave chosen, the arrows, the keys, "next waiting" and the passed / rejected filter stay inside that wave.
  - When the wave has nothing waiting, the screen offers the next wave that has entries waiting.
- **AC-WV-03: context card.** At the top of a chosen wave:
  - the wave's title and note (the factory's context);
  - the owner's wave note, when there is one;
  - the date: the earliest attempt of the wave;
  - the template(s);
  - the item params whose values differ between the wave's items, each with its values;
  - the validator pass rate at the stage before the owner's review: passed of passed + rejected over the wave's attempts that
    have a row there.
  These are computed on the device that owns the plan (`reviewBatches`, pure) and carried to the other device in report v2.
- **AC-WV-04: the owner's wave note.**
  - The owner's note becomes a field of its own on the group, `ownerNote` (the definition JSON, no migration).
  - `setGroupNote` from the owner writes `ownerNote`. The factory's `upsertGroups` keeps writing `note` and never clears
    `ownerNote`.
  - An existing `note` stays where it is and shows as the wave's context.
  - The `group_note` event is unchanged.
  - Factory API 1.8.0 returns `ownerNote` with the groups.
- **AC-WV-05: wave done.**
  - When an owner verdict takes a wave's waiting count from above zero to zero, `group_reviewed { groupId, accepted, rejected,
    overridesValidator }` is recorded once. The verdict may be given here or applied from the other device.
  - `accepted` and `rejected` count the owner verdicts in the wave. `overridesValidator` counts those accepted that the
    validator rejected.
  - The screen shows the same summary when the chosen wave is done.
  - A wave that gets new waiting attempts and is finished again records the event again.
- **AC-WV-06: wave claim.** The owner can take a wave on this computer ("Take this wave"). The other computer then shows that
  wave as "being reviewed on <computer>" and skips it in navigation. This uses the claim mechanism of §F at wave level.
- **AC-WV-07.** The bell's review entry lists the waiting count per wave (AC-BL-04).

## F. Reviewing from two computers (FO-REQ-0009 §6)

Claims travel in the peer report, so they reach the other computer within the sync delay of 1.5–3 minutes. **They are
advisory, not a lock:** a track opened on both computers within that window can still be rated on both. That case is caught
by the confirmation in AC-TC-04 and by the history in AC-TC-05.

- **AC-TC-01: track claim.**
  - When the owner opens a track on the review screen, this device claims it for 10 minutes. A screen heartbeat every minute
    extends the claim while the track stays open.
  - Moving to another track moves the claim. A verdict or closing the screen ends it.
  - Claims are stored on this device (schema v70) and published in this device's report at once. The report is also written
    on the next tick, as before.
- **AC-TC-02: claims on the other computer.**
  - A track or wave claimed by another device, with the claim not expired, is shown as "Being reviewed on <computer> since
    <time>".
  - The arrows, the keys and "next waiting" skip it. "Show claimed" brings such tracks back into the walk.
  - This holds both on the owner device (claims from peer reports for its own plans) and on a non-owner device (claims of
    the owner device and of any third device).
- **AC-TC-03: a verdict leaves the queue at once.**
  - On the device that gives it, the track stops waiting immediately. On a non-owner device this already holds through the
    "sent, waiting for <computer>" verdict.
  - New: on the **owner** device, a verdict that another device sent for its plan and that is not yet applied shows as
    "rated on <computer>, being applied". It no longer counts as waiting in the queue, the badge or the summary.
- **AC-TC-04: confirm before replacing.**
  - A verdict on an attempt that already has one asks first: "Already rated on <computer> at <time>: <Accept|Reject> <n>/10.
    Replace?". The existing verdict can be this device's, the owner's, one sent from here and not yet applied, or one another
    device sent and not yet applied.
  - The server enforces it too. `recordOwnerVerdict` and `recordPeerVerdict` refuse with `plan_verdict_exists` (409) and the
    existing verdict in `details`, unless the request says `replace: true`. The confirmation therefore also holds when the
    screen's data is stale.
  - Applying another device's verdict on the owner device keeps "newest wins" (AC-TC-06).
- **AC-TC-05: history.**
  - Every owner verdict, given here or applied from another device, is appended to `generation_plan_verdict_history`
    (schema v69, device-local, on the owner device) with its device, time, result, rating, reasons, markers and note.
  - The current verdict stays the newest.
  - The review screen shows an attempt's history with the device and time. The other device gets it in report v2 (up to 10
    per entry).
  - `owner_verdict` events are derived from the history rows. An attempt that has a current owner verdict and no history row
    (a verdict from before v69) still gets one event from the row, as today, so nothing is counted twice.
- **AC-TC-06: which time decides "newer" (FO-REQ-0009 §6.5).** It stays the time the owner gave the verdict, on that device's
  clock. That is the owner's intent, and both computers keep their clocks in sync.
  - The 5-minute guard against a clock that runs ahead stays.
  - A skew of a few seconds can only matter for two verdicts given within those seconds. The claim (AC-TC-01) and the
    confirmation (AC-TC-04) make that rare, and the history keeps both.

## G. Contract and records

- **Factory API 1.8.0** (additive):
  - `factory_plan_move`;
  - the `plan_moved` and `group_reviewed` events;
  - `ownerNote` on groups;
  - `owner_verdict` events from the history, now one per verdict, with `device`.
- **Peer report:** version 2.
- **Schema:**
  - v69: `generation_plan_verdict_history`;
  - v70: `generation_plan_review_claims`.
  Both are additive.
- **ADR 0031** records:
  - the split;
  - the counts-not-content exception to ADR 0004;
  - the move and its path rules;
  - report v2;
  - claims as advisory;
  - the verdict history.
- **New error:** `plan_verdict_exists` (409), with `errors.*` words in every interface language.

## Slices (one branch `feature/servers-media`)

1. Plan move: the tool, the service, the file-check port, `PlanJobRow.channelId` and the job audition in the job's channel.
2. Report v2: `jobChannelId`, plus a reader that accepts versions 1 and 2.
3. Servers / Media: routes, redirects, the active-channel scoping of the Media routes, the sessions channel column and
   filter, "now running" and the review header.
4. Per-channel summary, the switcher counts and the bell.
5. Review by wave: `reviewBatches`, `ownerNote`, the wave list and card, and `group_reviewed`.
6. Two computers: the history (v69), claims (v70), pending peer verdicts on the owner device, and the replace guard and its
   confirmation.
7. Docs (ARCHITECTURE, SYSTEM_MAP, interfaces, ADR 0031, BACKLOG, ROADMAP_STATUS), then the independent review cycle, then the
   merge request to the owner, then a release note to the Factory Operator.

## Tests whose expected value changes (AGENTS.md §L)

The requirement changed: FO-REQ-0009 §1–§2, assigned by the owner in msgs 2119/2125.

- `production-panel.test.ts`:
  - the exact Production tab list becomes the Servers and Media lists;
  - "Production right after Content" becomes "Media right after Content, then Servers".
- The `SETTINGS_SUB_TABS` slice that asserts there is no `"media"` sub-tab checks a requirement that does not change: Settings
  still has no Media sub-tab. Only its slice boundary moves, if the new tab lists sit inside it.
- `section-tabs.test.ts`: its `/production` fixtures become `/media` and `/servers`, and the remembered paths follow.

## Not done (scope)

- No factory spend card. It is not in the UI today. §1 asked for it only "if shown".
- No Servers entries in the bell (AC-BL-07).
- No owner UI to move a plan. The operator moves plans through the Factory API (FO-MSG-0011).
- Claims are not a lock (§F).
