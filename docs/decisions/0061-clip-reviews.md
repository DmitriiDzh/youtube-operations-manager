# 0061. Clips for review: the Producer submits a channel-folder clip, only the owner approves or returns it

Status: Accepted (owner, Telegram 2026-11-03: msg 4010 the proposal, msg 4011 «Делай»). Amends ADR 0034 (the Producer's tools) for
these tools only; ADR 0051's shared-document pattern is reused.

**Date:** 2026-11-03.
- **Plan:** `docs/roadmap/plans/CLIP_REVIEWS_PLAN.md` (BL-241), acceptance AC-CR-01..16.

## Context

The Producer asks the owner to look at short scene-loop clips (15 s to a few minutes, often over 50 MB) the Factory Operator rendered into the
channel's folder, and today the owner answers in Telegram. The owner wants the queue in the app: watch the clip, approve or send
it back with a comment, on either of his two computers (the channel folder syncs to both by Syncthing).

## Decision

1. **A new feature module `src/lib/clip-reviews/`** (AGENTS.md §M: no other feature module, no Google client, no network) over a
   new sync family `clip_reviews`: one Automerge document per channel, a fixed genesis actor, flat maps `clips` (by clip id, written
   once at submit, never edited) and `decisions` (by a fresh id). Nothing else is stored; no schema change.
2. **The Producer** gets four `producer-only` tools on its own endpoint (Producer API 1.15.0): `producer_clip_review_submit` and
   `producer_clip_review_withdraw` (DRAFT -- a request the owner decides, like `producer_propose`), `producer_clip_review_list` and
   `producer_clip_review_get` (READ). Channel worker agents and the factory get none.
3. **The clip is a file already in the channel folder**, named relative to the workspace root and resolved with the shared
   `workspace-exchange.resolveWorkspaceFile` (no `..`, no absolute path, the real path strictly inside the real workspace, a regular
   file) at submit and again whenever it is served. Only `.mp4`, `.webm`; 5–300 s by ffprobe (±0.5 s), refused when it
   cannot be measured (fail closed); no size cap. The size and SHA-256 are stored: the owner approves exactly that file.
4. **Only the owner decides**, in Контент → «Клипы» (Web session, active channel): approve (comment optional) or return (comment
   required), confirmed in the row. Approval needs this computer's file to be the submitted one. A decision on a clip that is no
   longer pending here is refused. Each decision is audited on its computer. The owner's surface is reachable only from the
   clip-review routes (source-scan test); no MCP path reaches it.
5. **Two computers' answers merge by rule**: the earliest owner decision (by time, then id) is the clip's status; a Producer
   withdrawal counts only without an owner decision. Status is derived, never stored, so a merge never conflicts.
6. **Playback** is this computer's copy, streamed with HTTP Range by the shared `local-file-response` to a loopback request only
   (ADR 0029 decision 5); the time range is a media fragment. A missing or changed copy is shown, never fetched from elsewhere.

## Consequences

- Nothing reaches YouTube; the app writes nothing into the channel folder.
- A reworked clip is a new submission (same `sceneId`); the old one keeps its decision.
- Two computers deciding the same clip offline: the later decision is kept in the document but does not count (the earliest
  wins); the screen shows the counting one.

## Compatibility / migration impact

- New sync family (`clip_reviews`, its own Syncthing subfolder `clip-reviews`); a computer without this version ignores it.
- Producer API 1.15.0, additive. Agent API and Factory API unchanged. No database schema change.
