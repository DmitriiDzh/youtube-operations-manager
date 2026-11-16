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
