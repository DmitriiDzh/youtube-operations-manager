# Owner review of the final release package (BL-257, ADR 0070)

Owner: TG 2298 (via the Producer), msgs 4514/4516 (2026-11-15). WWE only for now; Tropico/Japan keep clip approval.

## Stages (one branch, one merge)

1. **Module + family + gate.** `src/lib/sync-gateway/package-reviews/` (+ sync runner), `src/lib/package-reviews/` (contracts,
   model: status of a manifest from decisions; services: view, set required, decide; adapters), the scan port `ownerReview(channelId)`
   in `createPackageScanReads`, problem codes `owner_review_pending` / `owner_review_returned`, plan cache invalidation on a decision,
   tried-hash exception for approved + only-cancelled manifests.
2. **Routes + UI.** `GET/POST /api/channels/[channelId]/package-reviews` (list with state, switch), `POST …/decision`, `GET …/video` and
   `…/thumbnail` (stream the package's files, owner session, Range). Media tab «Видео на проверку» (player, thumbnail, texts, actions,
   switch). Week plan line for the two codes. Texts en/ru.
3. **Agents.** Wake file kind `package`; API bumps; docs (SYSTEM_MAP, ARCHITECTURE, interfaces, BACKLOG, AGENTS §F note: not a
   YouTube writer).

## Acceptance (written before the code)

- AC-PR-01 A channel without a review document scans exactly as before (same states and problems).
- AC-PR-02 Gate on, package ready otherwise, no decision → `not_ready` with `owner_review_pending`; not offered to the plan, not
  queued by the automatic upload, refused by the Producer's queue add and the owner's upload approval.
- AC-PR-03 Approved for manifest A (and its thumbnail hash) → ready; manifest B (re-packaged) → pending again; a changed thumbnail file
  → pending again.
- AC-PR-04 Returned (comment required) → `owner_review_returned`, stays out; a later approval of the same manifest → ready.
- AC-PR-05 Approval refused when the manifest has no video `sha256`, or this computer's mp4 does not hash to it.
- AC-PR-06 An uploaded package is not affected (no new problem after upload).
- AC-PR-07 A review document that cannot be read → every package pending (fail closed).
- AC-PR-08 Only the owner's Web UI routes decide or switch; no MCP tool, agent or factory path reaches them (boundaries test).
  Amendment (owner TG 4584, ADR 0070 §4 amendment): `factory_release_recode` copies the owner's latest existing decision to a recoded
  Short's new manifest (`carriedFrom`, original time) -- never a decision of its own; only `src/composition/release-recode.ts` calls it.
- AC-PR-09 The video route streams the package's own mp4 (Range 206), only for a package of that channel under `04 Videos/`.
- AC-PR-10 A decision invalidates the plan's package cache (the slot moves without waiting 60 s).
- AC-PR-11 An approved manifest whose upload rows are all cancelled without a video id is taken by the automatic upload; a manifest
  with any other row stays tried.
- AC-PR-12 The decision syncs to the other computer (family document).
- AC-PR-13 The Producer gets `REVIEW-DECISION-package-<video>-<decisionId>.md` once per decision.
- AC-PR-14 The weekly plan slot of a pending / returned package shows the review state.
- AC-PR-15 (owner msg 4519) The review screen works on a phone (remote access, < 768 px): the player fills the width with native
  controls, `playsInline`, the 16:9 or 9:16 frame kept, streaming by Range (no full download first); the actions stay reachable
  (sticky bar), the texts fold.
  **Amended (owner TG 4817, 2026-11-24, timed comments):** the screen's player is the app's own review player (`MediaVideoPlayer`,
  as in the plan review of clips), not the browser's native controls: sound on, no autoplay, no loop, `preload="metadata"` (Range,
  no full download), `playsInline`, the frame kept, a fullscreen button; page scroll still works over the frame on a phone.

## Timed comments (owner TG 4817, 2026-11-24; written before the code)

The owner pauses the video and writes what is wrong at that moment; the comments are flags on the timeline and go to the factory
together with his decision, as one batch. Modelled on the audio review screen (`plan-review-screen.tsx`: a mark at the playhead with
its own note, sent with the verdict). No YouTube call; the same routes, session and active-channel check as the rest of the screen.

- AC-TC-01 Writing a comment fixes the moment: focusing the comment box pauses the video and the comment is stored with that time in
  seconds (one decimal, 0 ≤ t ≤ 24 h) and its text (1–500 characters, no control characters; at most 200 comments per package).
- AC-TC-02 Every comment is a flag on the player's timeline at its time with its number; the list under the player shows number,
  m:ss (h:mm:ss past an hour) and the text; a click on a flag or a time seeks there, paused. Works at phone width (< 768 px).
- AC-TC-03 Until he sends, the comments are a server-side draft per (channel, manifest SHA-256) on this computer (device-local table,
  schema 124): a reload, another tab or his phone through remote access shows the same draft. Edit and delete work before sending.
  An empty draft is no row.
- AC-TC-04 The draft routes (`GET`/`PUT …/package-reviews/draft?manifest=`) need the Web session and the ACTIVE channel, and only
  accept a manifest of a package of that channel (else `package_review_not_found`); a draft of channel A is never read through B.
- AC-TC-05 Sending is one action: «Одобрить» or «Вернуть» sends the decision with all draft comments as one batch (`timedComments` in
  the decision, sorted by time). The draft is cleared only after the decision is stored; a refused decision keeps it.
- AC-TC-06 A packaging comment never carries timed comments (`validation_failed`). A return needs a general comment OR at least one
  timed comment; without a general comment the stored `comment` is the timed comments as lines `m:ss text` (so an older build, which
  drops a return without a comment, and `reviewComment` still read it).
- AC-TC-07 A decision read from the other computer keeps its well-formed timed comments; a malformed comment is dropped, never the
  decision (and never makes a return or approval count differently).
- AC-TC-08 The Producer reads the batch: the wake file `REVIEW-DECISION-package-…` gains a section «Timed comments» with one line per
  comment `<seconds> s (<m:ss>): <text>` (absent when there are none, so older notices stay byte-identical), and the weekly plan's
  package (`factory_/agent_/producer_publishing_plan_get`) gains `reviewTimedComments: [{ atSeconds, time, text }]` of the standing
  decision (approved or returned; absent when none). Factory 1.55.0, Agent 4.26.0, Producer 1.28.0 (additive).
- AC-TC-09 The card shows the standing decision's timed comments (time and text) after it is sent.
- AC-TC-10 (owner TG 4836) An approval carries an optional general comment — notes for future videos — together with the timed
  comments, in one action. An approved video offers «Одобрить ещё раз с замечаниями» (a new approval; it needs a comment or a timed
  comment; the state stays approved). The card says «одобрили с замечаниями на будущее». An older build reads such an approval as an
  approval (the comment is allowed since BL-257; `timedComments` is an unknown field it ignores).
- AC-TC-11 (owner TG 4836) Agents see the notes as non-blocking: the wake file line «Notes: Одобрено с замечаниями на будущее …»; the
  plan package `reviewComment` with `reviewCommentKind: approved_notes` (`returned`, or `returned_timed` when a return's comment is only
  its timed comments written out; then the wake file shows them once, not as a fenced copy too).
- AC-TC-12 (independent review) A decision deletes only the draft it was made from (`draftUpdatedAt` = the stored stamp, else
  `package_review_draft_changed` and nothing decided; absent: the draft stays); a draft save names its base (`baseUpdatedAt`) and a stale
  one is refused; the screen writes nothing and offers no decision until the draft has loaded; playing on or seeking drops a taken
  moment; full screen holds the whole player (frame, flags, timeline, controls) with Space / click to play and pause; drafts of gone
  packages are pruned when the list is read; a failed draft removal is audited.

## Issues across package versions (owner TG 4846/4848; written before the code)

Each timed comment is an ISSUE that outlives the package version it was made on: the factory fixes, re-packages (new manifest, new
mp4, same video code), answers each issue in the new manifest, and the owner sees the old flags with the answers on the next review.

- AC-IS-01 Key across versions: the channel's review document plus the video code (or its BL-263 recode alias), the rule packaging
  comments already use -- never the manifest or the mp4 (a fix changes both) and never the slot (it can change or be absent).
- AC-IS-02 Issue id: stored on each timed comment at decide time, `<decisionId>.<n>` (n = 1.. in time order), so two offline
  computers never mint the same one; a timed comment without an id (stage 1) reads with the same derived id. A carried copy of a
  decision (recode) adds no second issue: issues and thread turns are deduplicated by id and content.
- AC-IS-03 Agent replies: `yt-release-package/2` gains optional `reviewReplies: [{ issueId, status: fixed | not_fixed | partly, text
  (1-2000), atSeconds? (the moment after the edit) }]`, written by whoever re-packages. Read leniently: a malformed entry or a reply to
  an unknown issue is ignored, never a package problem. The replies the owner saw are snapshotted into his next decision
  (`repliesSeen`), so the thread survives the next re-package and syncs. No MCP tool writes the review document (AC-PR-08 holds).
- AC-IS-04 Owner actions per issue, in the draft and sent with the next approve / return: «Исправлено, принимаю» (`resolved`) or a
  follow-up text (`follow_up`, the issue stays open). An action naming an issue that is not this channel's for this video is refused
  (`package_review_issue_unknown`), nothing decided. New timed comments are new issues.
- AC-IS-05 State: `open` (made with a return, or followed up), `resolved` (the owner's last action), `noted` (made with an approval:
  notes for the future, not counted as open). Its time: the agent's latest `atSeconds`, else the original.
- AC-IS-06 Re-review: issues are violet flags at their current time; each shows the thread (owner and agent turns, the agent's
  status). The card shows the open / resolved counts.
- AC-IS-07 Agents read per issue id, time, state and thread: the wake file section «Issues» (as of that decision, the same bytes on
  either computer; absent without issues) and the plan package `reviewIssues` + `reviewIssueCounts` (Factory 1.55.0 / Agent 4.26.0 /
  Producer 1.28.0, unreleased).
- AC-IS-08 Old builds: additive fields only (`timedComments[].id`, `issueActions`, `repliesSeen`, `reviewReplies`); a decision carrying
  them reads exactly as before.
