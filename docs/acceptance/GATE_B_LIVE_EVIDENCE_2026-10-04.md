# Gate B — what the real writes already prove, and what is still open (read-only evidence, 2026-10-04)

Source: the owner's real database on this Mac (`playlist-manager.db`, read-only queries; counts only, no content). Everything below is **evidence from stored records, not a new live run** — nothing was written to YouTube for this report. The live writes were made earlier (the database was carried over from another computer: batch backups for the Japan channel are not on this machine).

## Real batches in the database

| Batch (id prefix) | When (local) | Mode | Result |
|---|---|---|---|
| `917a1194` | 2026-10-02 00:37 | dry-run | 45 rows, stays `PENDING` (dry-run never sends) |
| `e57b1453` | 2026-10-02 00:38 | live | 45 rows: 41 rejected by YouTube («The request metadata is invalid»), 4 sent but **post-write verification mismatch** → `FAILED` |
| `0696d51e` | 2026-10-02 16:05 | live | 41 rows: 25 rejected by YouTube («localized details without the default language of the video»), 16 sent but verification mismatch → `FAILED` |
| `e205e730` | 2026-10-03 15:15 | live | 25 of 25 rows `SUCCESS`, each with a recorded post-write verification (`resolvedVia: own_response`) |

Audit trail totals: 111 attempts (all `attempt 1`, no retries), 111 PREPARATION / ATTEMPT / RESULT events and 45 VERIFICATION events in `audit_events`; no batch is left `RUNNING`/`APPLYING`; no ledger row is stuck.

## Gate B mechanisms against this evidence

| # | Mechanism | Evidence | Verdict |
|---|---|---|---|
| 1 | Identity verification | Every live batch ran on the owner's connected channel; no wrong-channel attempt exists in the records, so the **refusal** path was not exercised live | Works in the normal path; refusal path not live-proven |
| 2 | Fresh remote conflict detection | No conflict was ever detected (all PREPARATION events are plain `{"dryRun":false}`); the case «someone edited the video on YouTube between approval and write» was not exercised live | **Not live-proven** (AC-CONFLICT-01) |
| 3 | Immutable backup before write | Backups are files per batch/video on the computer that ran the writes; not visible here, and `audit_events` has no BACKUP type (video-edit audit has 131 BACKUP events, a different subsystem) | **Cannot be confirmed from this machine** — check the backup folder of the computer that ran the live writes |
| 4 | Approval integrity | Attempts carry a payload snapshot; all 111 attempts came from approved changes (batches cannot be created from unapproved ones) | Consistent |
| 5 | Dry-run | One dry-run batch with 45 rows sent nothing; 470 `DRY_RUN` video-edit events | Proven live |
| 6 | Durable audit log | 378 batch audit events + 851 video-edit audit events | Proven live |
| 7 | Per-item ledger / idempotent resume | Ledger works per row; **resume after an interruption never happened** (no `RUNNING` leftovers, no attempt 2) | Ledger proven; **resume not live-proven** (AC-RESUME-01) |
| 8 | Post-write verification | 45 verifications recorded; 25 matched, 20 reported a mismatch and were correctly marked `FAILED` instead of `SUCCESS` | Proven live (fails safe) |

## Open items before the owner can sign Gate B

1. **The 20 verification mismatches — CLOSED 2026-10-04 (checked, read-only + browser).** After the latest channel sync (2026-10-04 02:09, Languages tab «Last synced») every one of the 20 videos carries the intended `ja` title and description, all 45 videos of the channel have a `ja` localization, and all 45 have default language `en` — i.e. the state the batches asked for. The mismatches belonged to the batches run before the default-language baseline fix.
2. **Backup evidence**: look at the backup folder of the computer that ran the live writes and confirm one `metadata_before.json` per video of `e205e730` (25) exists and matches.
3. **Scenarios not exercised live** (cannot be proven after the fact, only by doing them once on a spare video/channel): conflict with a live edit (AC-CONFLICT-01), resume after interruption (AC-RESUME-01), wrong-channel refusal (AC-GUARD-01). Decision for the owner: run them once deliberately, or accept them as residual risk with an explicit written decision — note that `docs/TECHNICAL_DEBT.md` says the eight mechanisms may not be waived by risk acceptance.
4. **Owner sign-off wording** (to be recorded in `docs/TECHNICAL_DEBT.md` Gate B and `docs/ROADMAP_STATUS.md` only after 1–3): «Gate B satisfied on <date>: live evidence = batch `e205e730` (25/25 verified) + dry-run; scenarios X, Y live-tested on <date> / accepted by the owner as …».

Tracked tails around writing, not Gate B items: RISK-90 (unfinished Batches the UI cannot finish), RISK-94 (hard kill in the middle of a long write).
