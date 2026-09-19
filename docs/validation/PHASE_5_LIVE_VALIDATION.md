# PHASE_5_LIVE_VALIDATION.md

**Status: PLAN ONLY. No step in this document has been executed.** This document defines *how* the live-validation track required by `docs/acceptance/PHASE_5_ACCEPTANCE.md` §4 will be carried out, once the project owner separately and explicitly authorizes execution (`AGENTS.md` §K). Authoring this plan is not that authorization, and no OAuth login, no real API call, and no live-write-barrier change may be performed on the strength of this document alone.

This plan does not modify `docs/acceptance/PHASE_5_ACCEPTANCE.md`. It operationalizes the scenarios that document already marks "Live validation: required before Gate B" (§4's methodology, restated there). If anything here appears to conflict with that document, the acceptance document wins and this plan must be corrected.

---

## 1. Purpose

Close the one remaining Gate B blocker recorded in `docs/TECHNICAL_DEBT.md` and `docs/ROADMAP_STATUS.md`: every safety mechanism built in Phase 5 (backup, conflict detection, wrong-channel guardrail, execution ledger, crash recovery, audit trail, verification/reconciliation) has been proven only against mocked/fake adapters. This plan proves the same mechanisms against the real YouTube Data API v3, on a channel that cannot cause real-world harm if something goes wrong.

## 2. Non-negotiable boundaries for the eventual execution

- **Never a production or customer channel.** A channel created and owned solely for this purpose (§3).
- **The live-write barrier stays in place until this plan is executed.** Executing this plan requires the separate, explicitly-authorized source-code activation procedure described in `src/lib/batches/adapters/write-executor.youtube.ts` (removing/conditioning `assertLiveWritesAuthorized()`), performed as its own reviewable change — never as a side effect of running this plan.
- **No step here is bundled into `npm test` / CI**, per `AGENTS.md` §E/§L and the acceptance document's §4. This is a manual, one-time (or infrequently repeated) procedure run by the project owner or an explicitly designated person only.
- **Every real mutation is logged and independently reversible** via the immutable backup this same pipeline already produces (§7).
- Google OAuth login, real API calls, and the barrier removal itself are **out of scope for this document's authorship** and remain unauthorized until the project owner says otherwise, per the follow-up task's own instructions.

## 3. Dedicated test channel requirements

- A YouTube channel created specifically for Phase 5 live validation, owned by an account the project owner controls, never linked to any monetized/production/customer channel.
- Channel must already contain (or have uploaded for this purpose) at least **6 videos**, each in a state where `defaultLanguage` is resolvable (per AC-DEFAULTLANG-01/02) — this is a precondition for most scenarios and must not itself be something the test discovers as broken.
- At least one video must carry **pre-existing localizations in 2+ languages** (e.g. `es`, `de`, `fr`) with distinct, recognizable placeholder title/description text, so that "preserved vs. dropped" is unambiguous to a human reviewer (mirrors AC-MERGE-01's fixture shape, applied to a real video).
- At least one video must carry **no localizations at all**, to exercise the pure-addition case cleanly.
- Channel-level OAuth credentials (separate `credentialRef`) must be distinguishable in this app's local credential store from any real/production channel credential, so channel-context validation (`AGENTS.md` §F, `write-context.assertWriteChannel`) is exercised against a genuinely different second identity for AC-GUARD-01 (§9 below) rather than simulated.
- API quota for this channel/project should be confirmed sufficient for the full run (§13 estimates total call volume) before starting, to avoid a mid-run `quotaExceeded` systemic abort that is not the thing being tested.

## 4. OAuth / browser validation (read-only, precedes any write scenario)

1. Authenticate the app against the test channel's Google account through the existing OAuth flow (no code change; this exercises the already-implemented auth, not new code).
2. Confirm the resolved active channel identity (via `write_context`/`whoami`) matches the test channel's own id, not any other channel reachable from the same Google account.
3. Confirm no OAuth token (access, refresh) is ever visible in application logs, browser devtools network tab persisted values, or anywhere else `AGENTS.md` §F prohibits — a read-only check performable before any write scenario runs.
4. Run a read-only sync (`channel-sync`) against the test channel and confirm the 6+ videos from §3 appear locally with correct ids — this is the "no real write yet" baseline all later diffs are compared against.

This step produces zero mutations. It is a precondition check, not itself an acceptance scenario.

## 5. Test video selection

| Role | Selection criteria | Used by |
|---|---|---|
| `V-MULTI` | Has `es`/`de`/`fr` localizations with distinct placeholder text | AC-MERGE-01, AC-MERGE-05, AC-E2E-01 |
| `V-EMPTY` | No existing localizations | AC-E2E-01 secondary path (pure addition) |
| `V-GUARD` | Any valid video on the test channel | AC-GUARD-01 (never actually written — rejected before any call) |
| `V-CONFLICT` | Any valid video, metadata mutable outside the app during the test window | AC-CONFLICT-01 |
| `V-RESUME-*` (10-20 videos) | Ordinary videos, no special pre-existing state required | AC-RESUME-01 (scaled-down live subset, per §4's own text: "the live run needs only exercise the PENDING/SUCCESS happy path plus one interruption, not every state class") |

A scaled-down `AC-RESUME-01` video count (10-20, not the full mocked-track 100) is proposed for the live run — see §13's minimization rationale. The full 100-video, 5-state-class scenario remains the mocked/automated track's responsibility (already implemented and passing) and is not repeated live.

## 6. Initial metadata snapshot (before any write)

For every video selected in §5:

1. Run a fresh, direct `videos.list` read (not the local sync mirror) and save the full raw `snippet` + `localizations` response to a timestamped, append-only file under a validation-run-specific directory (outside `src/`, never committed to the repository — see §17).
2. Record the response alongside the video id, channel id, and UTC timestamp.

This snapshot is the independent, human-inspectable ground truth against which every later "preserved" claim (AC-MERGE-01/03/05) is checked — independent of whatever the app's own backup mechanism records, so a bug in the backup mechanism itself cannot hide a preservation failure.

## 7. Immutable backup verification

For each write scenario below, after the app's own pre-write backup step runs:

1. Confirm a backup record exists for the video **before** the corresponding `videos.update` call is sent (ordering check against the audit trail, AC-BACKUP-01).
2. Confirm the backup's captured content matches the §6 snapshot exactly.
3. Attempt to trigger a second backup capture for the same video within the same batch and confirm the original backup record is never overwritten (AC-BACKUP-03) — inspect the backup store directly, not just the API response.
4. These are read/inspection operations on data the app itself already wrote; they do not add any additional YouTube API calls.

## 8. Exact approved changes (fixtures for the live run)

Defined here explicitly, independent of whatever the implementation happens to produce, per `AGENTS.md` §L:

- **`V-MULTI`**: add `pt-BR.title = "Título PT (validação ao vivo)"`, `pt-BR.description = "Descrição PT (validação ao vivo)"`. Expected preserved: `es`, `de`, `fr` entries byte-for-byte unchanged (per the §6 snapshot).
- **`V-EMPTY`**: add `fr.title = "Titre FR (validation en direct)"`, `fr.description = "Description FR (validation en direct)"`. Expected: no other localizations appear (there were none), snippet-level fields (`categoryId`, `tags`, etc., per AC-MERGE-03) unchanged from the §6 snapshot.
- **`V-CONFLICT`**: approved baseline recorded from the §6 snapshot's `es.title`; the value is changed *outside the app* (e.g. via YouTube Studio directly) after approval but before the batch is sent, to genuinely reproduce AC-CONFLICT-01's precondition with a real external actor rather than a mock.
- **`V-RESUME-*`**: each gets one trivial, distinct, human-verifiable change (e.g. append a fixed marker string to an existing description) so success is visually confirmable in YouTube Studio without relying solely on the app's own report.
- **`V-GUARD`**: no change is ever defined for this scenario to actually reach a payload — the whole point is that the guardrail rejects the batch before any change is considered for sending.

## 9. Wrong-channel rejection (AC-GUARD-01, official test §55)

1. Authenticate as the test channel from §3.
2. Construct a batch whose `expectedChannelId` names a **different**, second real channel (a second throwaway test channel, or the project owner's own unrelated personal channel used only as an identity mismatch, never a customer/production channel) that the active OAuth session is *not* authenticated as.
3. Attempt to execute the batch (dry-run flag irrelevant here — the guardrail must fire before dry-run/live is even considered).
4. **Expected:** `WRITE_CHANNEL_MISMATCH`, naming both the active and expected channel ids; zero `videos.update` calls (confirm via the audit trail and, if feasible, API request logging); zero backup files created for `V-GUARD` (guardrail fires before backup, per AC-GUARD-01's own text).
5. This scenario produces **zero real mutations** regardless of dry-run/live mode and can be run first, safely, before any live-write authorization is even needed for the barrier itself — it only requires two distinguishable OAuth identities.

## 10. Dry-run procedure (still zero mutations, but exercises the real API's read side)

Before any live write is attempted for `V-MULTI`, `V-EMPTY`, `V-CONFLICT`, or `V-RESUME-*`:

1. Run the batch in `dryRun: true` mode against the real test channel (this already performs real, read-only `videos.list` calls for the mandatory per-video pre-write fetch — AC-QUOTA-01b — but never a `videos.update`).
2. Confirm the dry-run report's proposed payload matches this plan's §8 fixtures exactly.
3. Confirm zero `videos.update` calls occurred (network-level or API-log-level check, not just "the app said dry-run").
4. Confirm the dry-run artifact is not itself mistaken for a completed batch (AC-DRYRUN-03) — re-running the same batch in dry-run mode again produces the same report, not a "no-op, already done" result.

This is the first point at which the plan touches the real API with anything beyond an OAuth handshake, and it remains fully reversible/harmless by construction (INV-6: dry-run is structurally zero-mutation).

## 11. Live-write execution (the only steps that require the barrier removed)

**Everything before this point in the plan can be executed under the current, unmodified live-write barrier.** Only this section requires the separate activation procedure (§2) to have already been performed as its own authorized change.

1. Execute the batch containing `V-MULTI` and `V-EMPTY` with `dryRun: false`.
2. Immediately after, independently re-fetch both videos via a fresh, direct `videos.list` call (not the app's own verification read) and compare against §8's expected result and §6's preserved-field snapshot.
3. Confirm in YouTube Studio (human visual check) that the new localizations appear correctly and the pre-existing ones are untouched.

**Expected YouTube-side results:**
- `V-MULTI`: `videos.update` returns 200; the video's `localizations` map now contains `es`, `de`, `fr` (unchanged) plus `pt-BR` (new).
- `V-EMPTY`: `videos.update` returns 200; the video's `localizations` map now contains only `fr`; all snippet-level fields from the §6 snapshot otherwise unchanged.

## 12. Preservation checks for existing metadata (AC-MERGE-01/03/05, official test §57)

Performed immediately after §11, using the **independent** §6 snapshot (not the app's own report) as ground truth:

1. Byte-for-byte diff of `es`/`de`/`fr` entries (title + description) between the §6 snapshot and the post-write `videos.list` response for `V-MULTI`. Any difference is a FAIL, full stop — this is the single highest-priority check in this plan, mirroring AC-MERGE-02's status as "the single most important test" in the mocked track.
2. Diff of snippet-level fields (`categoryId`, `tags`, `defaultAudioLanguage`, etc.) for both `V-MULTI` and `V-EMPTY` against their respective §6 snapshots.
3. Record the diff output (even when empty) as part of the run's final report (§18).

## 13. Conflict detection (AC-CONFLICT-01, official test §56)

1. After approving a change for `V-CONFLICT` but before sending the batch, manually change the same field directly in YouTube Studio (a real, external, out-of-band mutation — this is what makes it a genuine live-validation scenario rather than a mock).
2. Send the batch containing `V-CONFLICT`.
3. **Expected:** the mandatory fresh per-video pre-write fetch (AC-QUOTA-01b) observes the externally-changed value, diverging from the approval baseline; the write is blocked with `CONFLICT`, not sent.
4. Confirm via a direct `videos.list` read that the externally-set value (from step 1) is what remains on YouTube — i.e. the app never overwrote the external change.

## 14. Interrupted-batch recovery (AC-RESUME-01, official test §54, scaled)

1. Start a batch of the `V-RESUME-*` videos (10-20 per §5) with `dryRun: false`.
2. Interrupt the process (kill the running process, not a clean shutdown) partway through — after a deliberately chosen number of videos have reached confirmed `SUCCESS` but before all have.
3. Restart the app/process and resume the same batch id.
4. **Expected:** already-`SUCCESS` videos are not re-attempted (confirm zero new `videos.update` calls for them via the audit trail and, where feasible, request-level logging); remaining `PENDING` videos proceed normally; if any video was mid-flight (`APPLYING`/durable `INTENDED`) at the moment of interruption, it goes through §0.F reconciliation exactly as the mocked track requires, never a blind retry.
5. This exercises the interruption/recovery machinery against a real, physically-interruptible process and real API latency, which the mocked track cannot fully reproduce (the mocked track's determinism is a feature there, but leaves genuine process-kill timing unverified).

## 15. Audit and reconciliation verification

For every scenario above:

1. Pull the complete audit trail for the batch (`getBatchErrorReport` / audit query) and confirm every stage (`PREPARATION`/`ATTEMPT`/`RESULT`/`CONFLICT`/`VERIFICATION`/`DRY_RUN`/`RECONCILIATION` as applicable) is present, correctly typed, and in the correct order — reconstructing "what happened" from the audit trail alone, without consulting the ledger table directly, per AC-AUDIT-04.
2. For any `SUCCESS` reached via reconciliation rather than the attempt's own observed response (relevant only if §14 produces such a case), confirm `ownResponseObserved` is `false` and the record does not overclaim causation (AC-AUDIT-05).
3. Confirm `dryRun` is correctly `true` for §10's runs and `false` for §11/§13/§14's runs in every corresponding audit record (AC-DRYRUN-02/AC-AUDIT-02).

## 16. Stop conditions

Abort the remainder of the run immediately, without proceeding to later scenarios, if any of the following occurs:

- Any preservation check (§12) finds an unrelated locale or snippet field altered or dropped.
- Any `videos.update` call is sent for a video whose approval was stale, invalid, or unselected (would indicate AC-MERGE-04/INV-4 failure against the real API).
- The wrong-channel guardrail (§9) fails to block, for any reason.
- A `quotaExceeded` response is received and the systemic-abort behavior does not halt the remaining batch (AC-QUOTA-02/AC-ISOLATION-02).
- Any discrepancy between the audit trail and what a direct, independent `videos.list` read shows actually happened on YouTube.
- Any OAuth token or credential material is observed anywhere it should not be (logs, error messages, audit records) per `AGENTS.md` §F.

On any stop condition: halt further live writes, leave the barrier-removal change in place only as long as needed to run the recovery procedure (§17), and escalate to the project owner with the full audit trail and diff output before any further action.

## 17. Recovery procedure (if a stop condition fires, or after a normal completed run)

1. For any video whose live state needs to be reverted, use the immutable backup (§7) captured before the write — construct a corrective `videos.update` restoring the exact pre-write `snippet`/`localizations` from the backup record, through the same reviewed write path (never a manual out-of-band fix that bypasses the audit trail).
2. Record the corrective write itself as its own fully-audited operation — it is not exempt from the same pipeline (identity check, backup-of-current-state-before-correcting, audit, verification) it is trying to fix.
3. Confirm via a fresh `videos.list` read that the correction restored the exact §6 snapshot values.

## 18. Cleanup and final reporting

1. Restore the live-write barrier (re-add/re-enable `assertLiveWritesAuthorized()`'s unconditional throw) as its own explicit, reviewed change immediately after the validation run concludes — the barrier is not left removed "just in case" between runs.
2. Store all snapshot files, diff outputs, and audit-trail exports from this run outside the repository (or in a clearly `.gitignore`d validation-artifacts directory) — they may contain real channel/video ids and are run records, not source code or documentation.
3. Produce a final report mapping every scenario in §19's traceability table to PASS/FAIL/BLOCKED, with the actual diff/audit evidence referenced (not just an assertion of success).
4. Update `docs/TECHNICAL_DEBT.md` (RISK-05, RISK-09 Gate B checklist) and `docs/ROADMAP_STATUS.md` to reflect the outcome — Gate B may only be marked satisfied if every "Live validation: required before Gate B" scenario in `docs/acceptance/PHASE_5_ACCEPTANCE.md` §5 reports PASS.
5. If any scenario reports FAIL, Gate B remains blocked and the underlying implementation defect must be fixed and re-validated (both mocked and live) before re-attempting — this plan does not authorize weakening any acceptance scenario to make a live run "pass" (`AGENTS.md` §L).

## 19. Traceability: plan steps to acceptance scenarios

| Plan section | Acceptance scenario(s) | Real mutation? |
|---|---|---|
| §4 OAuth/browser validation | (precondition, not a named AC) | No — read-only |
| §6 Initial snapshot | (precondition for AC-MERGE-01/03/05) | No — read-only |
| §7 Backup verification | AC-BACKUP-01, AC-BACKUP-03 | No — inspects app-created records |
| §9 Wrong-channel rejection | AC-GUARD-01 (official test §55) | No — rejected before any write |
| §10 Dry-run | AC-DRYRUN-01/02/03, AC-QUOTA-01a/01b (read side) | No — dry-run is structurally zero-mutation |
| §11 Live write, `V-MULTI`/`V-EMPTY` | AC-MERGE-05 (official test §57), part of AC-E2E-01 (official test §53) | **Yes — 2 videos** |
| §12 Preservation checks | AC-MERGE-01, AC-MERGE-03 | No — read-only diff against §11's result |
| §13 Conflict detection | AC-CONFLICT-01 (official test §56) | No — the write is blocked, never sent |
| §14 Interrupted-batch recovery | AC-RESUME-01 (official test §54, scaled), AC-CRASH-01, AC-TIMEOUT-01/02 (only if a genuine mid-flight interruption lands on one) | **Yes — up to 10-20 videos** (scaled from the mocked track's 100) |
| §15 Audit/reconciliation | AC-AUDIT-01..05, AC-VERIFY-01/02 | No — reads existing records |
| §17 Recovery procedure | (only if a stop condition fires) | Yes, if invoked — itself fully audited |

`AC-E2E-01` (official test §53) is satisfied once §9-§15 have all run in sequence against the same test channel in one coherent pass, per its own requirement that "both tracks independently confirm every sub-step" — the automated track already covers steps 3-23 with mocks; this plan's live pass covers the same steps against a real channel.

## 20. Minimum real-write footprint

Proposed minimum real `videos.update` calls to satisfy every "Live validation: required before Gate B" scenario:

- **2 calls** for §11 (`V-MULTI`, `V-EMPTY`) — covers AC-MERGE-01/03/05.
- **0 calls** for §9 (rejected before send) and §13 (blocked before send) — these validate that no call occurs.
- **10-20 calls** for §14 (scaled `AC-RESUME-01`) — this is the only scenario needing a nontrivial *count* of real writes, because the thing being tested is behavior *across* an interrupted batch, not a single video's payload; 10-20 is proposed as the smallest number still large enough to make "which videos completed before interruption" a meaningful, non-trivial partition (at least a handful confirmed-successful, at least a handful still pending at the interruption point).
- **Total: 12-22 real `videos.update` calls**, plus their corresponding real `videos.list` reads (pre-write fetch + independent verification, roughly 3-4 reads per write). This is the smallest footprint that exercises every distinct safety mechanism (merge/preserve, wrong-channel, conflict, interruption/recovery, audit) at least once against the real API, without repeating the mocked track's full combinatorial coverage (e.g. the full 100-video/5-state-class matrix, which stays a mocked-track responsibility per §4's own text in the acceptance document).

---

*This document will be updated with actual run results only after an execution is separately authorized and performed. Until then, every checkbox implied above is unchecked.*
