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
