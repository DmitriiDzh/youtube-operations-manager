# 0054. Music library and batch review: the factory owns rules and files, the Manager shows and records

Status: Accepted for building (owner, Telegram msg 3598, 2026-10-27). Plan: `docs/roadmap/plans/MUSIC_LIBRARY_PLAN.md` (BL-229).

## Context

FO-REQ-0043: the factory sorts music into genre profiles with their own playlists and briefs, and wants the owner's per-track
answers on a fixed, genre-specific form to improve the next batches. The owner's rule (TG 872): the system, not the person,
decides whether feedback is global or genre-only.

## Decision

1. **One factory snapshot per channel is the library's only source** (`Sent to YTM/music/library.json`). The Manager does not
   parse the factory's profiles, CSVs, ledger or durations and runs no factory script, so the factory can change its internals
   without breaking the Manager.
2. **Read-only toward the factory's files.** The Manager never edits a profile, a rule, a batch's genre or a track's place; it
   writes only its own answers (`From YTM/music-review/<batch>/answers.json`), as everywhere else (ADR 0019 amendment).
3. **Answers are strict.** Only field ids present in the track's form, with values of the field's type, plus verdict, free text,
   reviewer, device and time. No scope or rule field exists in the schema, so none can be saved.
4. **Answers sync like plan verdicts** (sync-gateway, newer per track wins); the factory reads them over MCP or the file.
5. **A new feature module** `src/lib/music-library/` (AGENTS.md §M); Media works without it.

## Consequences

- The card shows nothing until the factory writes the snapshot.
- Playback on a computer requires the channel workspace there.

## Amendment 1 (2026-10-27, owner msgs 3610–3614; DEV-MSG-0009, FO-RESP-0044)

Part B no longer has its own files or screen. Decisions 2–4 change as follows:

- **The batch review is the plan review.** A batch is a generation plan with one wave per batch. The plan carries the general
  form and chips, each wave its `genre` (id, title, colour, icon) and the genre's form and chips, all copied by the factory from
  its profile. `review.json` and `answers.json` are dropped; the Manager writes no file for the review.
- **Answers are strict, the definitions are lenient inside.** Unknown keys inside `genre`, `reviewForm` and a field are stripped
  (they are the factory's own rules), never stored; a verdict's `answers` may name only field ids of the attempt's effective form,
  with a value of the field's type; a required field must be answered for either verdict. Still no scope or rule field.
- **Answers travel with the verdict** (result row, verdict history, `owner_verdict` event, peer verdicts in plans report
  version 6). Applied from the other computer, an answer whose field no longer exists is dropped and the verdict is kept: the
  owner's verdict is never lost to a later form change.
- `listen` is not built. The rating stays 1–10; form scales are `scale_1_10`.
