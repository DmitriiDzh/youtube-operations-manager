# 0066. The owner's review decisions wake the Producer: one file per decision in its Inbox

Status: Accepted (owner, Telegram 2026-11-08, msg 4094 «да на оба», on DEV-RESP-0048 and its Update: item (c), weekly-plan slots,
included).

**Date:** 2026-11-08.
- **Requirement:** FO-REQ-0052 (Operator; owner TG 3412), PRD-REQ-0063 (Producer; owner TG 1748).
- **Plan:** `docs/roadmap/plans/REVIEW_NOTIFY_PLAN.md` (BL-248), acceptance AC-RN-01..17.

## Context

The Producer decides which agent acts on the owner's review feedback. Its only wake signal is a new non-dot file in
`00 YT Producer/Inbox/` (`tools/wait_inbox.sh` polls every 20 s, ignores dotfiles). The owner's decisions live only inside YTM:
clip decisions and storyboard decisions in synced Automerge documents, generation-plan verdicts in device-local tables (the other
computer's arrive through the plans report), weekly-plan slot decisions in a synced document. On 2026-11-08 two returned clips
waited three hours until the owner asked.

## Decision

1. **A shared module `src/lib/review-notify/`** (AGENTS.md §M) writes one Markdown file per owner decision into the Producer's
   Inbox: `REVIEW-DECISION-<kind>-<itemId>-<decisionId>.md`, kinds `clip`, `storyboard` (version decisions, owner comments and
   replies), `render` (the verdict on «Ролик целиком»), `plan` (one file per review pass of a generation plan), `slot` (every slot
   decision: approved / revoked / vetoed / restored). The module imports no feature module and no database; its sources, settings
   and ledger are composed in `src/composition/review-notify.ts`. The feature modules (clip-reviews, storyboards, publishing-plans)
   only get an optional `notifyOwnerDecision` port in their own index.ts, wired to `nudgeReviewNotify` (run the writer in 2 s).
2. **A periodic writer, not a write inside the decision.** The server's loop (production servers only, every 30 s, behind the device
   mutation gate) scans every source for owner decisions not yet written. Reasons: decisions made on the other computer arrive by
   sync (documents, plans report) and never pass through this server's routes; and the owner's decision must never fail or wait
   because the Inbox is missing (T9 not mounted) or the writer is broken. The nudge only makes the next run sooner.
3. **Exactly once, by a ledger.** File names are deterministic from the decision's own id (a plan pass: the SHA-256 prefix of its
   sorted entry ids), the file is written once (`.tmp-<random>` in the same folder, then published with a hard link that fails on
   an existing name -- a checked rename only where the volume has no hard links; an existing file is never replaced; `.tmp-*` older
   than 1 h are swept), and the decision's key goes into a new device-local table `review_notify_ledger` (schema v120). A cursor by time would
   miss a decision synced late with its own older time, and the Producer may move files out of its Inbox, so "the file exists" is not
   enough either. Rows are kept 90 days; decisions older than 30 days are never scanned.
4. **One writer, a per-computer switch «Будить Продюсера»** (Settings → AI agent). Never set: ON only on macOS
   (`process.platform === "darwin"`) when the workspace's `00 YT Producer` folder exists there -- the Mac the Producer runs on;
   OFF everywhere else (review B1: the folder carries a `.stfolder`, Syncthing creates it on the other computer too, so the folder
   alone would make two writers). Once on by default it stays on while the folder is away (the folder and the Inbox are on the same
   disk: a disconnected disk is "Inbox missing, retry", never "off", which would skip the decisions made meanwhile); a computer whose
   default was never on never becomes sticky. The card shows the effective state. The owner's choice overrides the default either way. The Inbox folder is a
   setting (an absolute path); empty: `<workspace root>/00 YT Producer/Inbox`, where the workspace root is the one parent folder of
   every channel workspace set on this computer (there is no separate workspace-root setting; with no single parent the owner sets
   the path).
5. **Backfill.** The first time the switch is on (the default included), clip / storyboard / render / slot decisions since
   2026-11-08T00:00:00Z are written; plan entries only from that moment. A later enable starts from then for every kind.
6. **The same bytes on any computer.** The file carries the decision's own time and device, never the writer's name or the write
   time, so two writers produce the same name with the same content.
7. **Plans: one file per review pass.** The owner gives up to 25 verdicts an hour in one plan; a pass collects every not yet written
   verdict (result, rating, reasons, marks with region, note), pick and «ни один не подходит» of the plan and is written when a wave
   finished (`group_reviewed` at or after its earliest entry) or after 5 quiet minutes. The other computer's plans are read from its
   plans report (review entries' verdict history, active picks and «ни один не подходит», last 50 events).

## Consequences

- No YouTube call, no paid call, no MCP tool or API contract change: the Producer only reads files. Schema v120 (additive).
- **Two writers only by the owner's own choice.** The default is on only on the Mac; a second Mac with the folder, or the owner
  turning it on on the other computer, would make two writers. Single decisions are harmless (same name, same bytes, the hard link
  refuses an existing name), but plan passes are grouped by each writer's own timing and would differ (RISK-152).
- The other computer's plan verdicts are seen only as far as its report carries them (the last 10 verdicts of an attempt, entries
  still in its review list, the last 50 events). Reasons and marks are known only for an attempt's current verdict there.
- A plan pass's entry ids are stored before its file is written and dropped after its ledger rows, so a crash in between is finished
  as exactly that pass on the next run. This computer's own verdicts and picks on the other computer's plans are a source too; entry
  times are whole seconds, so the same verdict read here and later in that computer's report is one entry.
- A late-synced entry with an old `at` joins the next pass of its plan, so one wave can be split across two files.
- Moving the writer to the other computer starts its own ledger: the backfill there repeats files the Producer already had (it dedupes
  by decisionId).
