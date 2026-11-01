# 0059. The Producer controls the upload queue: order, add under the owner's switch, cancel what has not started

Status: Accepted (owner, Telegram 2026-11-01: msg 3928 the request, msg 3930 the clarifications, «Приступай» on the plan in msg
3929). Amends ADR 0037 §1 and ADR 0034 for these tools only; ADR 0046 and ADR 0051 stand and are reused.

**Date:** 2026-11-01.
- **Plan:** `docs/roadmap/plans/UPLOAD_QUEUE_CONTROL_PLAN.md` (BL-239), acceptance AC-UQ-01..13.

## Context

Each computer has one upload queue for every channel (`publishing_uploads`): the runner sends one file at a time and starts the
oldest queued row first. The owner wants the Producer -- one agent over every channel worker -- to decide the order, to add a
release to the queue when needed, and to cancel an upload that has not started; and he wants ↑↓ arrows himself.

ADR 0037 §1 kept uploads and scheduling away from agents and the Producer (AC-UP-14), and ADR 0034 made the Producer read-only
plus proposals. ADR 0046 made the owner's automatic-upload switch a standing approval of private, undated uploads; ADR 0051 lets
the owner's approval of a weekly-plan slot be the approval of that slot's date.

## Decision

1. **Order.** The queued rows start by a new place `queue_rank` (schema v117, backfilled from `created_at`), then age, then id. A
   new row joins the end. The order only picks the next start: a row being sent, processed or finished is never interrupted or
   overtaken (the runner's existing rule).
2. **The Producer gets four `producer-only` tools** on its own endpoint (Producer API 1.14.0, permission `UPLOAD_QUEUE`):
   `producer_upload_queue_list`, `_add`, `_move`, `_cancel`. It may act on rows of any channel, across channels. Channel worker agents
   and the factory endpoint get none of them, and no MCP or agent endpoint code reaches the approval, the runner, the automatic
   queue or the owner's cancel; the queue control is wired only from the Producer session and the owner's move route.
3. **Cancel** only a `queued` row (compare-and-set from `queued`). A row that started sending is never cancelled by the Producer.
4. **Add** is the automatic upload under the owner's switch, triggered by the Producer:
   - only on the computer whose automatic-upload switch is on; elsewhere it is refused (`upload_auto_switch_off`). The switch is
     the standing approval of private uploads from that computer, and it marks the one computer that uploads and schedules
     (ADR 0046 §8, ADR 0051);
   - the same per-package check as the automatic upload (one function, extracted from `auto-upload.ts`), then the approval's own
     queue step. The video is private; a date comes only from a weekly-plan slot the owner approved, more than 15 minutes ahead.
     The Producer never gives a date and never approves a slot; a slot no longer approved when the runner reaches the date step
     withholds the date, as for an automatic row;
   - the video's SHA-256 is frozen with the row and checked again by the runner before its session starts;
   - one try per manifest version, except a version whose rows the Producer itself queued and cancelled. A version the owner approved or
     cancelled, an automatic try, a failure or a done upload stays the owner's.
5. **Audit.** Every move, add and cancel is an audit event with who did it: `by: "producer"` with the token id, or `by: "owner"`
   with the Google user. Each row records who queued it (`queued_by`).
6. **The owner** moves a queued row one place in the shared queue with ↑↓ in Content → «Публикация»; the row shows its place.

## Rationale

The order of uploads that are already approved changes nothing about what reaches YouTube, only when. An add reuses a standing
approval the owner already gave, through the same checks and the same runner, so no new kind of upload exists: private, no date
unless the owner approved the slot. Gating the add on the switch keeps one uploading computer, so two computers never queue the
same release.

## Consequences

- PROJECT_SPEC §58's lifted non-goal: the Producer may now queue a private upload under the owner's switch. Agents still never
  publish, schedule or approve.
- A Producer row with a frozen hash is re-hashed by the runner like an automatic row; the runner's check now keys on the frozen
  hash, not on the `automatic` flag (approval rows never freeze one, so they are unchanged).
- A move renumbers only the `queued` rows. A row paused before it started keeps its old place and rejoins after the renumbered
  rows when it resumes.

## Compatibility / migration impact

- Schema v117: `publishing_uploads.queue_rank INTEGER NOT NULL DEFAULT 0` (backfilled from `created_at`) and `queued_by TEXT`
  (backfilled `automatic` / `owner`). Additive (ADR 0001).
- Producer API 1.14.0: four new tools; `producer_get_capabilities` reports `permissions: ["READ", "DRAFT", "UPLOAD_QUEUE"]` and
  `uploadQueueTools`. Agent API and Factory API unchanged.
