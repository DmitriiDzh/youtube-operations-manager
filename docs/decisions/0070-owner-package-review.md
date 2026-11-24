# 0070. The owner reviews a channel's final release package before it counts as ready (WWE)

Status: Accepted (owner, Telegram 2026-11-15: TG 2298 via the Producer «видео WWE грузились сначала на проверку в медиа», msg 4514
«видео сначала придут на проверку в медиа и только потом попадут в ревью в плане», msg 4516 «пока что мне это нужно только для WWE …
надо проверять итоговое видео»).

**Date:** 2026-11-15.
- **Plan:** `docs/roadmap/plans/PACKAGE_REVIEW_PLAN.md`, acceptance AC-PR-01..14. Backlog BL-257.

## Context

A channel's release package (`V<n>_release.json`, yt-release-package/2) counts as ready as soon as the factory writes it without
problems: the automatic upload sends it to YouTube (private), the weekly plan offers its slot for approval. For WWE (explainer videos,
Shorts and 6–20 min episodes) the owner found defects only after upload (V7, V8, EP-0002). Clip approval does not cover the final
video: the format differs (a finished episode, not a 5–300 s scene clip).

## Decision

1. **A per-channel gate, owned by a new module `src/lib/package-reviews/`** with its own synced family `package_reviews` (one
   Automerge document per channel). The document holds `required` (the owner's switch; set only from the Web UI) and the owner's
   decisions. No document = not required. A document that exists but cannot be read = required and nothing approved (fail closed).
2. **The gate sits in the package scan** (`src/lib/publishing/package-scan.ts`, the one place every consumer reads: the weekly plan,
   the automatic upload, the Producer's queue add, the owner's upload approval). For a channel that requires review, a package that is
   not yet uploaded and has no other problem gets `owner_review_pending` (no decision for its manifest) or `owner_review_returned`
   (the owner returned it) as a problem, so it is `not_ready` everywhere. A channel without the gate scans exactly as before.
3. **What an approval covers.** One manifest: its SHA-256 (the texts, translations, file names and the video's sha256 the manifest
   states) plus the thumbnail file's SHA-256 at decision time. A package without the video `sha256` cannot be reviewed. At approval
   this computer's mp4 must hash to the manifest's `sha256`. A re-packaged manifest, or a changed thumbnail file, is pending again.
4. **Decisions.** Owner only, Web UI (session, remote allowed): «Одобрить» or «Вернуть» with a required comment. The latest owner
   decision for a manifest stands until the package is uploaded (he can change his mind before the upload). No MCP tool decides.
   Agents only read the state (calendar problem codes; the Producer's wake file `REVIEW-DECISION-package-…`).
   **Amendment (2026-11-16, owner TG 4584, BL-263 fix):** one copy path outside the owner's surface -- `factory_release_recode` (a
   local V → S rename of a Short: the manifest's SHA-256 changes, the mp4 and thumbnail bytes do not) copies the owner's LATEST
   existing decision on the old manifest to the new one (`carriedFrom` = the old SHA-256; kind, comment, thumbnail hash, device and
   original `at` unchanged). It never creates a decision of its own: nothing to copy, nothing written. Only
   `src/composition/release-recode.ts` calls `carryReviewDecisionForRecode` (boundaries test); a re-packaged manifest (new content)
   or a changed thumbnail is still pending as in §3.
5. **Order after approval (today's flow, unchanged):** the approved package becomes ready → the automatic upload sends it private
   without a date (when the channel's automatic upload is on) or the Producer queues it → the owner's slot approval gives the date.
   A manifest whose only upload rows were cancelled before reaching YouTube and that the owner approved counts as not tried, so the
   automatic upload takes it (the cancelled WWE V6–V11 of 15.11).
6. **The review screen.** Media → «Видео на проверку»: per package the player (the package's own mp4 streamed with Range, any length),
   the thumbnail, the title and description, the translation languages, the slot it names; the approve / return actions; the switch.
7. **Rollout:** turn the gate on for WWE, see V11 pending, then the owner lifts WWE's automatic-upload pause.

## Consequences

- New problem codes in the package scan and the calendar tools: Producer API and Agent/Factory API minor bumps (additive).
- The weekly plan shows «ждёт вашей проверки в Медиа» / «возвращено: …» for such slots.
- Comment attachments are a later stage.

## Compatibility / migration impact

No schema change (a sync family document). An older build ignores the family: it would not enforce the gate (both computers update
together).

**Amendment (2026-11-24, owner TG 4817, timed comments; PACKAGE_REVIEW_PLAN.md AC-TC-01..09):** the review screen uses the app's own
review player (`MediaVideoPlayer`, as the plan review of clips) instead of the native controls, and the owner may bind comments to moments of
the video. An approval or a return may carry `timedComments [{ atSeconds, text }]` in the synced decision (never a packaging comment); a
return without a general comment stores them as `m:ss text` lines in `comment`, so an older build still reads the return. The unsent
draft is device-local: SQLite schema 124 `package_review_drafts` (the first schema change of this feature). Agents read the batch in the
wake file («Timed comments») and as `reviewTimedComments` of the plan's package (Factory 1.55.0, Agent 4.26.0, Producer 1.28.0).
Still no YouTube write and no MCP path that decides.

**Amendment (2026-11-24, owner TG 4836):** an approval may carry a general comment as notes for future videos (non-blocking), also as
a new approval of an already approved video («одобрить ещё раз с замечаниями»; it stays approved). Agents read them as
`reviewCommentKind: approved_notes` on the plan package and the wake file line «Notes: Одобрено с замечаниями на будущее». No new
decision kind: older builds read it as an approval.

**Amendment (2026-11-24, owner TG 4846/4848, issues):** each timed comment is an issue (`<decisionId>.<n>`) keyed across package
versions by the channel's document plus the video code (or its recode alias). The factory answers in the re-packaged manifest
(`yt-release-package/2` `reviewReplies`, read leniently); the owner's next decision keeps the answers he saw (`repliesSeen`) and his
per-issue actions (`issueActions`: resolved / follow_up). Agents still only read (wake file «Issues», plan `reviewIssues`); no MCP path
writes the review document (§4 unchanged).
