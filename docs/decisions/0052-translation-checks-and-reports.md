# 0052. Translation checks and agent check reports live with the change set; one check module for every path

Status: Accepted (owner, Telegram msg 3581, 2026-10-26; FO-MSG-0025 §2/§2a). Built on `feature/bl-227-languages-review`.

**Date:** 2026-10-26. **Plan:** `docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md` (BL-227), acceptance AC-LR-01..14.

## Context

The owner reviews translations before they are sent. He wants each translation to arrive with a check report, like the music
validator: the worker checks on its side (a script, then an independent AI review). The app shows that report next to its own
checks and keeps the owner's decision next to the verdict. The app's own field limits were also checked in two places, and both
counted the description in UTF-16 units, while YouTube counts it in bytes.

## Decision

1. **Reports, notes, authorship, original hashes and decision records live in the `change-drafts` Automerge document**, beside
   the change sets they describe, as optional, append-only maps (`checkReports`, `decisions`) and a write-once map `setDetails`
   (`notesJson`, `originalsJson`, `createdBy`).
   - Reason: change sets already sync between computers through this document. A report kept anywhere else would leave the other
     computer showing "not checked yet".
   - Not a SQLite table: the SQL projection mirrors `change_sets`/`changes` only.
2. **The newest report of a set is current; older ones are history.** "Not checked yet" is the absence of a report.
3. **The owner's decision is recorded, never derived from the verdict.** Approve/reject writes a decision record naming the
   report and verdict current at that moment. No code reads it to decide anything, and an agent's report can never approve or
   reject a change (AGENTS.md §G). Auto-approve is not part of this decision (stage 4, not assigned).
4. **One check module, `src/lib/shared-localization-checks/`** (AGENTS.md §M), used by XLSX import, `ai-localization`, the review
   screen and `changeset_get`.
   - Its fail results make a change invalid at creation; that replaces the two inline length rules.
   - Its warn results are shown, never blocking.
   - The limits come from `youtube-video-fields`: title 100 characters (code points), description 5000 UTF-8 bytes, no `<` `>`.
5. **Channel-template rules stay on the worker's side** (AGENTS.md §B: no channel editorial rules in this repository). They reach
   the app only as entries of the worker's report.
6. **Tools:**
   - `factory_localization_report_checks`;
   - the worker's `agent_localization_report_checks`, own channel only, the same tool over channel-pinned deps (BL-217);
   - an optional `note` per proposal on `ai_localization_create_change_set`.

## Consequences

- An older document without the new keys reads as "not checked yet" and without notes.
- Sets created before this change are not revalidated in storage. Their read-time fails show as warnings, and the write path
  (BL-226) and YouTube still refuse what is really invalid.
- The document grows by one JSON string per report. Retention's purge of a deleted set also removes its reports and decision
  records.
