# PHASE_5_ACCEPTANCE.md

**Status: APPROVED (fifth round, 2026-09-17) — acceptance contract for the start of Phase 5 preparation and implementation.** OQ-1..OQ-6 were answered by the project owner (2026-09-17, chat decision, recorded verbatim in §0) and the contract was amended with seven additional required scenarios (§0.B, items A-G) in a first review round. A second review round the same day added batch composition vs. approval integrity (AC-BATCH-03), a bounded reconciliation procedure (§0.F), and a durable attempt-intent model (§0.C, AC-ATTEMPT-03/04). A third review round corrected a remaining contradiction between AC-BATCH-02 and AC-BATCH-03, tightened §0.F/AC-TIMEOUT-01 so that no combination of reconciliation reads ever authorizes an automatic retry, added AC-TIMEOUT-02, and removed a leftover duplicated block from AC-TIMEOUT-01. A fourth review round, same day, fixed: (1) AC-ATTEMPT-01/02's fixture, which used a timeout as a retried failure — replaced with two definitively-known HTTP 503s to avoid implying a timeout can be retried directly; (2) `INTENDED`'s semantics, now explicit that it records durable intent only, never proof the request was actually sent (§0.C, AC-ATTEMPT-04 split into two sub-cases); (3) reconciliation/audit causation, now explicit that a matching remote-state read confirms the target state was reached but not that this specific attempt's own API call caused it, so audit records never attribute unconfirmed causation (§0.F, new AC-AUDIT-05, AC-CRASH-01 updated). A **fifth review round** (2026-09-17, project-owner-mandated editorial fixes, approved together with this status change) corrected three remaining defects: (1) a latent contradiction between AC-TIMEOUT-02 and AC-BATCH-03, where the §0.F Step 4 pipeline re-run scenario implied an edited-after-batch-creation change could be automatically picked up — AC-TIMEOUT-02 now blocks the write on the invalidated approval, exactly as AC-BATCH-03 requires, while still exercising the full re-run pipeline; (2) a fixture/count mismatch between AC-ATTEMPT-01 (3 attempts) and AC-AUDIT-01 (which expected 2 attempt events for `v5`) — AC-AUDIT-01 now cites its own explicitly-defined 2-attempt fixture (the same shape as AC-ATTEMPT-02's `v1`), independent of AC-ATTEMPT-01's 3-attempt fixture; (3) AC-RESUME-01 now explicitly enumerates every possible per-video state at interruption (`PENDING` may continue directly; `APPLYING`/`INTENDED`-with-no-result/`UNKNOWN` must be restored and routed through §0.F reconciliation, never blindly retried; `UNKNOWN` is never auto-resent) and requires that no video be silently omitted from the resume report — each must appear with either a final or an explicitly-pending-manual-decision status. **This approval, together with the concurrency range (§0.D) and retry parameters (§0.E) confirmed below, authorizes Phase 5 preparation and implementation work (including all automated/mocked tests in this document) to begin. It is not authorization to perform any real, non-dry-run YouTube write — that remains separately gated per `AGENTS.md` §K and this document's own Live-validation methodology (§4).**

This document is the acceptance contract for Phase 5 ("safe localization writes"), derived **strictly** from:

- `docs/PROJECT_SPEC.md` §19–30 (backup, dry-run, safe merge, idempotent batch execution, failure isolation, post-write verification, audit log, MCP/agent safety, channel-identity guardrails, quota awareness, retry policy, conflict detection);
- `docs/PROJECT_SPEC.md` §53–57 (the five official acceptance tests);
- `docs/PROJECT_SPEC.md` §64 (Fifth Agent Assignment — the Phase 5 scope statement);
- the current `Change`/`ChangeSet` contracts (`src/lib/changesets/contracts.ts`) and the current `write-context` guardrail contracts (`src/lib/write-context/contracts.ts`);
- current architecture (`docs/ARCHITECTURE.md` §6, §11, §12) and its documented limitations;
- the release gates in `docs/TECHNICAL_DEBT.md` (Gate B in particular);
- **the project owner's explicit decisions of 2026-09-17 answering OQ-1..OQ-6 and requiring scenarios A-G, quoted and formalized in §0.**

**No new product requirement is introduced here beyond what the cited spec sections or the project owner's own 2026-09-17 decisions state.** Per `AGENTS.md` §L / `docs/DEVELOPMENT_PLAYBOOK.md` §6.14, this matrix is written **before** any Phase 5 implementation, so that Phase 5's tests can be designed from it (Step 2–3 of that workflow) rather than from whatever gets built.

This document does not implement Phase 5. It does not modify any existing, already-approved acceptance criterion for Phases 0–4.5 — those remain exactly as documented in `docs/PROJECT_SPEC.md`, `docs/TECHNICAL_DEBT.md`, and `docs/ROADMAP_STATUS.md`.

---

## 0. Project-owner decisions of 2026-09-17

This section is the authoritative record of the decisions that close OQ-1..OQ-6 (originally raised in the first draft of this document) and the additional scenarios the project owner required before approval. Every later section that depends on one of these decisions cites it by tag (`DEC-OQ-1` .. `DEC-OQ-6`).

### 0.A — Answers to OQ-1..OQ-6

**DEC-OQ-1 (execution ledger granularity).** The execution unit is **one video**. If several approved changes target the same video, they are merged into a single, consistent `videos.update` payload and executed as one logical operation. The ledger row for a video records: `videoId`, `batchId`, the list of `Change` ids it bundles, its execution status, and its verification result. Distinct from the ledger row, the system separately records **every individual API attempt** for that video (so that a single logical operation executed via multiple retries is distinguishable from multiple logical operations). See §0.C for the resulting two-level data model (ledger row + attempt records) and AC-LEDGER-*/AC-ATTEMPT-* below.

**DEC-OQ-2 (default language).** A batch, automatic `defaultLanguage`-setting workflow (§14) remains out of scope for Phase 5, exactly as originally assumed. However, Phase 5 **must** detect, for every video it is about to write, whether the `defaultLanguage` required for a safe localization write is missing, and must **block** that video's write with a clear, specific error rather than attempting an unsafe write. The system never sets `defaultLanguage` automatically. See AC-DEFAULTLANG-01/02.

**DEC-OQ-3 (batch composition).** `Batch` is a **distinct entity**, not a 1:1 alias for `ChangeSet`. An operator selects a **subset** of currently-approved changes to include; unselected approved changes remain in the `ChangeSet`, untouched, available for a later batch. A batch's composition (its exact set of video/change targets) is **fixed at creation time** and must not change while the batch is executing — a change approved or revoked after batch creation does not retroactively alter that batch's membership. See AC-BATCH-01/02. **Fixed composition is not the same thing as a still-valid approval** (clarified 2026-09-17, second review round): membership (which videos/changes belong to this batch) is frozen at creation, but each member change's `approvalStatus`/`validationStatus` is still re-checked immediately before that video's write is sent. If the underlying approval was revoked, invalidated, or the change's content was edited after batch creation but before `videos.update` is sent, the write is blocked — a frozen batch membership must never be used to justify publishing a payload built from an approval that is no longer valid at send time. See AC-BATCH-03.

**DEC-OQ-4 (concurrency).** Default concurrency is **1** (fully sequential execution) for the initial Phase 5 release. The concurrency limit must be configurable (an implementation-level setting, not hard-coded), to allow raising it later once real quota/error-rate behavior is observed. §0.D below proposes and justifies the allowed configurable range before implementation, per the project owner's instruction. Two batches — or the same batch twice — must never execute concurrently against the same target; see AC-CONCURRENCY-01/02/03.

**DEC-OQ-5 (CLI/MCP).** Phase 5 is implemented through the Web UI and its backing API only. CLI and MCP interfaces for Change Sets and for triggering real writes are explicitly deferred to a later, separate phase, to be built before operational handoff to Codex (consistent with `docs/TECHNICAL_DEBT.md` RISK-04). No new MCP tool capable of performing a real localization write is introduced in Phase 5. See AC-SCOPE-01 (unchanged in substance, re-confirmed by this decision).

**DEC-OQ-6 (retry policy parameters).** §0.E below proposes and justifies conservative default retry parameters (max attempts, base delay, max delay, jitter) before implementation, per the project owner's instruction. The overriding requirement, stated by the project owner verbatim: *"если после timeout неизвестно, применил ли YouTube изменение, нельзя сразу повторять `videos.update`. Сначала необходимо проверить актуальное удалённое состояние и определить результат предыдущей попытки"* — i.e., an outcome-unknown condition (notably a timeout) **always** triggers a remote-reconciliation read before any retry attempt is made; a retry must never be issued blindly after a timeout. **A single reconciliation read that returns the pre-write value is not, by itself, sufficient proof that the write did not happen** (clarified 2026-09-17, second review round — read staleness/propagation lag on YouTube's side cannot be ruled out from one read). §0.F defines the bounded procedure that must be followed before a retry is authorized, and the explicit `UNKNOWN` state that results when the procedure cannot reach a confident conclusion. See AC-TIMEOUT-01 and the revised AC-RETRY-* scenarios.

### 0.B — Additional required scenarios (project owner, 2026-09-17)

The project owner required seven additional guarantees, quoted/paraphrased here and formalized as acceptance scenarios in §5:

- **A — Crash after a successful YouTube write, before the ledger records `SUCCESS`.** On restart, the system must detect the resulting indeterminate state, re-fetch actual remote state, determine whether the write was actually applied, correctly update the ledger, and **never** re-issue the write if the result was already achieved. → **AC-CRASH-01**.
- **B — Timeout with unknown write result.** A timeout after sending `videos.update` does not mean the operation did not happen. Remote reconciliation is required before any retry, and a single reconciliation read is not automatically conclusive (second review round, 2026-09-17): if the result cannot be reliably determined by the bounded procedure in §0.F, the operation must remain in an explicitly-labeled `UNKNOWN` state, never treated as success, and never auto-retried on insufficient evidence. → **AC-TIMEOUT-01**.
- **B2 (added 2026-09-17, second review round) — Durable attempt intent.** Before `videos.update` is sent, a durable record of the intent to attempt must exist; the actual result is recorded after the call returns, if a result is obtainable at all. If the process terminates between sending the request and durably recording its result, the attempt must be recovered on restart as `UNKNOWN` and routed through the same §0.F reconciliation procedure — never assumed to have failed, and never assumed to have succeeded. → **AC-ATTEMPT-03**, **AC-ATTEMPT-04**.
- **C — Audit model.** The audit trail must distinguish: operation-preparation event; actual API attempt; attempt result; pre-execution conflict; remote-verification result; dry-run. Exactly-one-audit-record-per-video is **not** required (this replaces INV-11 and AC-AUDIT-01 from the original draft, which assumed one record per item regardless of attempt count). The requirement instead is: no audit event is ever lost, and the full execution sequence for any video is reconstructable from the audit trail. → **AC-AUDIT-01 (revised)**, **AC-AUDIT-04**.
- **D — Dry-run semantics.** Dry-run may create local artifacts: a local report and necessary diagnostic records. Dry-run must never call `videos.update`, never mark a video as successfully published, and never allow a simulated run to be mistaken for, or silently convert into, a completed live batch. → **AC-DRYRUN-03**.
- **E — Backup failure classification.** Two distinct scenarios must be handled differently: (1) a single video's backup fails — that video's write is blocked, but the rest of the batch proceeds if the backup store itself is healthy; (2) the entire backup infrastructure is unavailable — the whole batch halts as a systemic condition. → **AC-BACKUP-02 (single-item)**, **AC-BACKUP-04 (infrastructure-wide)**.
- **F — Multiple changes for one video.** Simultaneous changes to several localizations of the same video must produce one consistent payload, execute as one logical update operation, and preserve every locale not targeted by the batch. → **AC-MULTI-01**.
- **G — Concurrent external modifications.** A fresh remote fetch reduces conflict risk but is **not** an atomic compare-and-swap on YouTube's side — the API offers no such guarantee. Post-write verification remains mandatory. This document must not claim absolute protection against concurrent external modification. → §3 invariant INV-5 is revised accordingly; see **AC-CONFLICT-02**.

### 0.C — Resulting data model implication (ledger vs. attempts vs. durable intent)

DEC-OQ-1 requires two distinct record types, both introduced by Phase 5; the second review round (2026-09-17, item 3) adds a durable two-phase write to the attempt record itself:

- **Ledger row** (one per video per batch): `batchId`, `videoId`, `changeIds[]`, execution `status`, verification result, timestamps. This is the resumable unit referenced throughout §5 (e.g. AC-RESUME-01's "43 of 100 videos").
- **Attempt record** (one per intended `videos.update` call, zero-to-many per ledger row), written in **two durable phases**:
  1. **Intent phase** — written and durably committed **before** the `videos.update` network call is issued: `batchId`, `videoId`, `attemptNumber`, request timestamp, payload snapshot, status `INTENDED`. **`INTENDED` records only that the decision to send this request was made and durably saved — it is not evidence that the network call was actually issued, let alone that YouTube received or applied it** (clarified 2026-09-17, fourth review round). The durable write of `INTENDED` and the actual issuance of the network call are two separate steps; a crash can occur between them, before the call ever reaches the network.
  2. **Result phase** — written after the call returns (or after the reconciliation procedure in §0.F concludes, for a call that never cleanly returns): outcome (`SUCCESS` / `FAILED:<reason>` / `UNKNOWN`), transport-level detail, result timestamp.

  A ledger row that required 3 retries before succeeding has 1 ledger row and up to 4 attempt records (or fewer if reconciliation short-circuits a retry — see AC-TIMEOUT-01). An attempt record found on restart in the `INTENDED` phase with no result phase ever recorded means only that intent was durably saved; it carries **no information about whether the `videos.update` network call was ever actually sent**, was sent but never reached YouTube, reached YouTube but the response never reached this process, or was fully applied and confirmed by YouTube — all of these are indistinguishable from the `INTENDED`-with-no-result record alone. It is never treated as `FAILED` (which would wrongly imply the call is known to have failed or not been sent) or `SUCCESS` (which would wrongly imply the call is known to have succeeded) by default — it is uniformly recovered as `UNKNOWN` and passed through §0.F, which determines the actual remote state without assuming either that the call happened or that it didn't. See AC-ATTEMPT-03/04.

### 0.D — Proposed concurrency limits (for approval alongside this document)

Per DEC-OQ-4, the following was proposed for the project owner's review as part of this document's approval, per the instruction "предложи и обоснуй допустимые пределы", and is **confirmed/approved** as part of the 2026-09-17 fifth-round approval of this document:

- **Default: `concurrency = 1`** (sequential), as instructed.
- **Configurable range: 1–5.** Rationale: (a) Phase 5's own quota-awareness requirement (§28) already forces batched *read* calls (≤50 ids per `videos.list`), so concurrency's main effect is on the number of simultaneous `videos.update`/verification round-trips, not on read-call count; (b) YouTube Data API v3's per-project and per-user rate limiting is undocumented in exact numbers in this repository and must not be hard-coded without a citation (§28: "Do not hard-code quota costs without documentation and tests"), so a small ceiling keeps burst risk low without asserting a specific undocumented number; (c) a low ceiling keeps failure diagnosis tractable — with sequential-by-default execution, an operator can correlate a failure with an exact attempt order, which matters for a single-operator tool where debuggability outweighs throughput; (d) 5 is small enough that even a worst-case simultaneous burst stays well inside any plausible short-window quota bucket for a single-operator/local-first deployment (`docs/PROJECT_SPEC.md` §37), while still giving a meaningful speed-up over strictly serial execution once the project owner is ready to raise it above 1.
- The hard ceiling of 5 is itself configurable only by a code change (not a runtime/user-facing setting) unless the project owner later asks for a higher number backed by observed real quota behavior.
- This proposal governs the numeric fixture `K` used in AC-CONCURRENCY-01 but does not itself require the project owner's separate sign-off beyond approving this document, since DEC-OQ-4 delegated exactly this proposal to the acceptance contract.

### 0.E — Proposed retry parameters (for approval alongside this document)

Per DEC-OQ-6, proposed for review together with this document and **confirmed/approved** as part of the 2026-09-17 fifth-round approval of this document — including the non-negotiable prohibition on any automatic retry following an `UNKNOWN` outcome (§0.F), which the project owner explicitly reaffirmed when approving this contract:

| Parameter | Proposed value | Rationale |
|---|---|---|
| Max attempts (transient-class errors only) | 4 total (1 initial + 3 retries) | §29 requires bounded retry of transient failures only; 3 retries is enough to ride out a brief network blip or a single transient 5xx without turning a stuck dependency into a long stall that blocks the rest of a sequential (concurrency=1) batch. |
| Base delay | 2000 ms | Conservative enough to avoid hammering a transiently-overloaded endpoint (§28's "do not repeatedly retry" spirit), short enough not to stall a single-operator interactive batch noticeably. |
| Backoff multiplier | ×2 (exponential) | Standard bounded-exponential-backoff shape, as §29 explicitly names ("bounded exponential backoff"). |
| Max delay (cap) | 30000 ms (30 s) | Prevents the exponential curve from producing impractically long waits on later attempts within a 4-attempt budget (2s → 4s → 8s → capped growth stays ≤30s). |
| Jitter | Full jitter (uniform random in `[0, computedDelay]`) | Avoids synchronized retry bursts if concurrency is later raised above 1 (§0.D); standard mitigation for the "thundering herd" failure mode. |
| Reconciliation-before-retry | Mandatory, non-negotiable, for **any** attempt whose outcome is not definitively known (timeout, connection reset, ambiguous transport error) | Direct requirement from DEC-OQ-6 / scenario B: a retry must never be issued after an outcome-unknown failure without first re-fetching remote state and determining whether the prior attempt already succeeded. This reconciliation step does **not** consume one of the 4 attempt slots above — it is a read, not a write attempt. |
| Non-retryable (permanent) classes | `invalid metadata`, `invalid language`, `wrong channel`, `insufficient permissions`, `video not found`, `default language missing`, `quota exhausted` | Verbatim from §29's own list; zero retries for these regardless of the parameters above. |

These are ordinary conservative implementation defaults, not requirements independently derivable from `docs/PROJECT_SPEC.md`'s text (which specifies no numbers) — they are presented for the project owner's awareness as part of approving this contract, consistent with `AGENTS.md`'s allowance for the coding agent to make ordinary implementation-detail decisions once the qualitative requirement (bounded exponential backoff; mandatory reconciliation before retry) is fixed by spec/decision.

### 0.F — Reconciliation procedure for an outcome-unknown attempt (added 2026-09-17, second review round)

This procedure is the concrete answer to the project owner's instruction: *"Определи безопасную процедуру reconciliation. Если результат нельзя достоверно определить, оставляй операцию в UNKNOWN. Не разрешай автоматический retry на основании недостаточных доказательств."*, sharpened in a third review round (2026-09-17): *"Два чтения, возвращающие исходное значение, не являются доказательством того, что предыдущий videos.update не выполнялся. Не разрешай автоматический retry исключительно на основании этих двух чтений."*, and sharpened again in a fourth review round (same date) on what a *positive* match actually proves: *"Совпадение remote state с requested value подтверждает достижение требуемого состояния и позволяет завершить логическую операцию без повторной записи. Но оно не всегда доказывает, что именно наша предыдущая API-попытка вызвала это изменение. Audit не должен приписывать неподтверждённое действие нашему API-вызову."* It governs every case where an attempt's outcome is not known with confidence — a timeout, a connection reset, or an attempt record recovered on restart in the `INTENDED` phase (§0.C) with no result ever durably recorded.

**On what a matching read does and does not establish (fourth review round).** Throughout this procedure, "the fetched value matches the requested value" is **goal-state evidence**, not **causation evidence**. It reliably tells the system that the desired end state has been reached and that no further write is needed for this change — that is sufficient to close the logical operation. It does **not** reliably tell the system that *this specific attempt's* `videos.update` call is what produced that state: the match is equally consistent with an earlier attempt of the same logical operation having actually applied it while its own result was lost (e.g. the AC-CRASH-01/AC-ATTEMPT-04 scenario), or, in principle, a coincidental external edit that happens to match. The ledger row may close as `SUCCESS` on this basis (the outcome the operation was pursuing has been achieved), but the **audit trail for this specific attempt** must record only what is actually known — "reconciliation confirmed the target state at this timestamp" — and must not assert or imply "this attempt's API call is confirmed to have caused the change" unless that attempt's own transport response was itself observed to confirm it (i.e. a normal, non-reconciled success). See AC-AUDIT-05.

**Step 1 — First reconciliation read.** Perform one fresh (non-cached) remote fetch of the affected video's relevant fields.

- If the fetched value **matches the requested value** → the target state is achieved; close the ledger row as `SUCCESS` via reconciliation and record the remote confirmation, without asserting that this attempt's own call caused it (see the note above and AC-AUDIT-05). No retry needed. Stop.
- If the fetched value **matches neither the pre-write baseline nor the requested value** → this is a third-party change, not an outcome-unknown condition proper; route to conflict handling (`CONFLICT`, see AC-CONFLICT-02), not to Step 2. Stop.
- If the fetched value **still matches the pre-write baseline** → this is evidence, but it is **not conclusive by itself** (possible causes other than "write never applied": read-path propagation lag, a stale replica, or a race between the write and this very read). Proceed to Step 2.

**Step 2 — Bounded confirmatory re-check.** Wait one short, bounded delay (the same base delay used for retries, §0.E — 2000 ms), then perform exactly one additional fresh reconciliation read.

- If this second read now shows the requested value → the target state is achieved (the first read was stale/lagged); close as `SUCCESS` via reconciliation, subject to the same causation caveat as Step 1. No retry. Stop.
- **If this second read again shows the pre-write baseline, consistently with the first read → this still does not constitute proof that the prior `videos.update` did not apply** (revised 2026-09-17, third review round — two consistent negative reads reduce uncertainty but do not eliminate it: e.g. a longer-than-2-read propagation delay, a read served from a differently-lagged replica on both attempts, or an indexing delay specific to the `localizations`/`snippet` field being checked, are all still possible). This procedure **never authorizes an automatic retry on the strength of these two reads alone.** Proceed to Step 3.
- If the second read errors, times out itself, or otherwise fails to produce a usable result, or if the two reads are mutually inconsistent in any other way → the evidence is even weaker. Proceed to Step 3.

**Step 3 — Insufficient evidence → `UNKNOWN`, no automatic retry.** In every case that reaches this step (two consistent baseline reads, or inconsistent/failed reads), the attempt is left in an explicit, durable `UNKNOWN` status, distinct from `PENDING`, `FAILED`, `SUCCESS`, and `CONFLICT`. It is **not** automatically retried under any circumstance — this procedure's two reads can raise or lower confidence but can never, by themselves, license a new `videos.update` call for this attempt. It surfaces to the operator (error/status report, AC-ISOLATION-03) for manual review, and is treated as a systemic-adjacent condition for the purpose of *that video only* — the rest of the batch is not blocked by one video's `UNKNOWN` state. Resolution requires one of:
  - a **separate, independent reconciliation pass**, run later (e.g. after a longer delay, or once a suspected transient read/propagation problem has cleared), which is its own fresh invocation of this procedure — not a continuation of the same two-read count — and may itself resolve to `SUCCESS`, `CONFLICT`, or remain `UNKNOWN`; or
  - an **explicit operator decision** to authorize a new attempt for this video.

**Step 4 — Any new attempt for a video leaving `UNKNOWN` re-runs the full write pipeline from scratch.** Whichever path resolves an `UNKNOWN` item toward a new `videos.update` call — a later independent reconciliation pass that itself times out again, or an operator's explicit authorization — that new attempt is a **full new execution**, not a resend of the stored payload from the original attempt. It must independently re-run, in order: approval/validation re-check (AC-BATCH-03), a fresh remote-state fetch, merge/payload construction (§21), conflict detection against that fresh fetch (§30), and every other mandatory safeguard in this document (backup, identity check, etc.) exactly as a first-time attempt would. An `UNKNOWN` resolution must never shortcut any of these steps on the theory that "we already built this payload once."

This procedure caps the *evidence-gathering* cost at 2 reads per outcome-unknown attempt, but — revised 2026-09-17, third review round — those 2 reads can only ever confirm `SUCCESS` (a positive match) or surface `CONFLICT` (a third-party value); they can **never**, by themselves, authorize a retry. Two consistent negative reads are treated as insufficient evidence, exactly like inconsistent or failed reads, and route to the same `UNKNOWN` outcome. `UNKNOWN` is not a temporary waypoint toward an automatic retry — it is a terminal state for this procedure that requires a separate reconciliation pass or an explicit operator decision to move past, and any subsequent write attempt re-runs the entire safety pipeline (Step 4), never a bare resend. This is intentionally conservative: it does not claim certainty of non-application even after two clean reads, consistent with revised INV-5/INV-12's refusal to treat a bounded number of reads as proof.

---

## 1. Scope boundary (from §64, restated, amended by §0.A)

In scope for Phase 5: immutable backup; expected-channel identity validation; dry-run by default; safe merge with all existing localizations; controlled concurrency (default 1, configurable per DEC-OQ-4/§0.D); per-video execution ledger with separately-recorded attempts (DEC-OQ-1/§0.C); failure isolation; idempotent resume; post-write verification; audit log (revised model, §0.B item C); comprehensive tests — applied to a subset of the existing `changesets/` module's `approvalStatus: "approved"` `Change` rows, selected into a distinct `Batch` entity at creation time (DEC-OQ-3), as the write pipeline's input (`docs/ARCHITECTURE.md` §11).

Also in scope, newly added by §0.A: detection and blocking of writes for videos missing a required `defaultLanguage`, with a clear error (DEC-OQ-2) — without any automatic `defaultLanguage`-setting.

**Explicitly out of scope for Phase 5** (§64's own words, plus scope boundaries already established elsewhere, plus the 2026-09-17 decisions, none reopened here):

- AI generation of any kind ("Do not add AI generation yet" — §64, verbatim).
- Everything already listed as a non-goal for the localization MVP in `docs/PROJECT_SPEC.md` §58 (Analytics, autonomous optimization, publishing/upload, thumbnails, multi-user SaaS/RBAC, billing, cloud deployment, complex RBAC).
- CLI/MCP parity for Change Set operations and for triggering real writes (DEC-OQ-5, confirms `docs/TECHNICAL_DEBT.md` RISK-04's deferral to before Gate C, not Gate B).
- Automatic default-language batch-setting (`docs/PROJECT_SPEC.md` §14) — deferred per DEC-OQ-2; only *detection and blocking* is in scope.
- Any dashboard/UI cosmetics beyond what is needed to trigger and observe a write batch (`docs/PROJECT_SPEC.md` §31's "do not prioritize dashboard cosmetics over core safety/workflow functionality").

---

## 2. Traceability matrix

| Source clause | Requirement (paraphrased) | Scenario IDs |
|---|---|---|
| §19 | Immutable backup before first write of a batch; refuse to proceed if backup fails; never overwrite a backup | AC-BACKUP-01, AC-BACKUP-02, AC-BACKUP-03, AC-BACKUP-04 |
| §20 | Dry-run by default; dry-run performs every step except the actual write | AC-DRYRUN-01, AC-DRYRUN-02, AC-DRYRUN-03 |
| §21 | Fetch fresh remote state; merge approved changes into the complete localization object; preserve untargeted locales and unrelated snippet fields; validate before submit; verify after | AC-MERGE-01, AC-MERGE-02, AC-MERGE-03, AC-MERGE-04, AC-MERGE-05 (= official test §57), AC-MULTI-01 |
| §14 + DEC-OQ-2 | Detect and block writes for videos missing a required `defaultLanguage`; never set it automatically | AC-DEFAULTLANG-01, AC-DEFAULTLANG-02 |
| §22 + DEC-OQ-1 | Per-video execution ledger; separately recorded per-attempt records, written in a durable two-phase (intent → result) sequence; interrupted batch is resumable without duplicate effects | AC-LEDGER-01..04, AC-ATTEMPT-01, AC-ATTEMPT-02, AC-ATTEMPT-03, AC-ATTEMPT-04, AC-RESUME-01 (= official test §54) |
| §22 + DEC-OQ-3 | Batch is a distinct entity; operator selects a subset of approved changes; composition fixed at creation; a member change's approval/validation is still re-checked at send time regardless of frozen membership | AC-BATCH-01, AC-BATCH-02, AC-BATCH-03 |
| §23 | One item's failure does not abort the batch, unless systemic; error report available | AC-ISOLATION-01, AC-ISOLATION-02, AC-ISOLATION-03 |
| §24 | Success requires verified remote state, not just a non-error transport response | AC-VERIFY-01, AC-VERIFY-02 |
| §24 + Decision B (§0.B) | Crash after a successful write but before ledger update is reconciled on restart, never re-written | AC-CRASH-01 |
| §24/§29 + Decision B/B2 (§0.B), §0.F | Timeout/outcome-unknown attempts follow the bounded two-read reconciliation procedure; no combination of reconciliation reads — not even two consistent negative reads — ever authorizes an automatic retry; unresolved cases yield an explicit `UNKNOWN` state requiring a separate reconciliation pass or operator decision; any subsequent attempt re-runs the full safety pipeline from scratch | AC-TIMEOUT-01, AC-TIMEOUT-02 |
| §25 + Decision C (§0.B), §0.F causation note | Audit trail distinguishes preparation/attempt/result/conflict/verification/dry-run events; no lost events; sequence reconstructable; a reconciliation-confirmed `SUCCESS` is never recorded as if this attempt's own API call was observed to succeed | AC-AUDIT-01, AC-AUDIT-02, AC-AUDIT-03, AC-AUDIT-04, AC-AUDIT-05 |
| §26 | AI may propose, human approves, system applies; no unrestricted autonomous write tool | AC-SCOPE-01 |
| §27 | Every write path validates channel identity; mismatch aborts the write, no partial send | AC-GUARD-01 (= official test §55) |
| §28 | Batched/centralized API calls; recognize and do not blindly retry quota exhaustion | AC-QUOTA-01, AC-QUOTA-02 |
| §29 + DEC-OQ-6/§0.E | Retry transient failures only, with bounded backoff and mandatory reconciliation before any post-timeout retry; never retry permanent failures | AC-RETRY-01, AC-RETRY-02, AC-RETRY-03 |
| §30 + Decision G (§0.B) | Conflict detected against a fresh remote fetch (not a stale local mirror); never silently overwritten; fresh fetch is not an atomic CAS, verification remains mandatory | AC-CONFLICT-01 (= official test §56), AC-CONFLICT-02 |
| §53 | Full happy-path workflow, end to end | AC-E2E-01 |
| §54 | Interrupted 100-video batch resumes correctly | AC-RESUME-01 |
| §55 | Wrong-channel write is blocked, clearly explained | AC-GUARD-01 |
| §56 | Conflict is detected, not silently overwritten | AC-CONFLICT-01 |
| §57 | Importing one new locale preserves all pre-existing locales | AC-MERGE-05 |
| §64 + DEC-OQ-4/§0.D | "Controlled concurrency", default 1, configurable, no double-run of the same batch | AC-CONCURRENCY-01, AC-CONCURRENCY-02, AC-CONCURRENCY-03 |

---

## 3. Safety invariants (stated independently of any implementation)

These must hold for **every** scenario below, not only the ones that name them explicitly. They are restated from `docs/DEVELOPMENT_PLAYBOOK.md` §6.14's standing invariant list (itself derived from `docs/PROJECT_SPEC.md`, not from `changesets/`'s code) and must not be weakened here to fit whatever Phase 5 eventually builds. **INV-5 and INV-11 were revised in the first review round per the project owner's 2026-09-17 decisions (items G and C respectively, §0.B); INV-4 and INV-12 are further sharpened in this second review round (same date) per items 1-3 of the project owner's follow-up.**

- **INV-1** Existing unrelated localizations remain unchanged by any write.
- **INV-2** Wrong-channel writes are impossible — the guardrail fails closed, never open.
- **INV-3** Blank spreadsheet cells never cause deletion (inherited from Phase 4, must not regress).
- **INV-4 (sharpened)** Approval applies only to the exact approved payload — if the underlying proposal or remote state changed after approval, the write must not proceed against the stale approval. This holds **regardless of batch membership**: a batch's frozen composition (DEC-OQ-3) fixes *which* video/change pairs belong to it, but never overrides a fresh approval/validation re-check performed immediately before that pair's write is sent (see AC-BATCH-03). A frozen batch is not a license to publish a payload whose approval has since been revoked, invalidated, or edited.
- **INV-5 (revised)** A fresh remote fetch immediately before write reduces, but does not eliminate, the risk of a conflicting concurrent external change, because the YouTube Data API v3 offers no atomic compare-and-swap primitive for `videos.update`. This document must never claim (and no test may assert) absolute protection against a race between the fresh fetch and the actual write. Post-write verification (§24) is the backstop that makes such a race *detectable* after the fact, even though it cannot make the write itself atomic.
- **INV-6** Dry-run produces zero remote mutations — structurally, not just "didn't happen to write this time." Local report/diagnostic artifacts are permitted (§0.B item D) but must never be mistaken for, or silently promoted into, a live write.
- **INV-7** Retried operations do not duplicate completed work.
- **INV-8** Failed operations preserve recovery information (the backup exists and is intact, even for the video that failed).
- **INV-9** No automated test performs a real YouTube mutation, ever, under any circumstance.
- **INV-10** A write is never marked successful without independently confirmed post-write remote state — an HTTP 200 alone is not success, and a timeout is never treated as failure-therefore-safe-to-retry without reconciliation (§0.B item B).
- **INV-11 (revised)** Every stage of a video's write lifecycle — preparation, each individual API attempt, each attempt's result, any pre-execution conflict, remote-verification outcome, dry-run — produces a durable audit event; no such event is ever lost, and no event is fabricated for something that did not occur. Unlike the first draft, this does **not** require exactly one audit record per video: a video that required retries legitimately produces multiple attempt-level audit events, and the full sequence must remain reconstructable in order.
- **INV-12 (sharpened, third review round)** An operation whose outcome cannot be reliably determined is left in an explicit, distinct `UNKNOWN` state — never silently coerced into `SUCCESS`, `FAILED`, or a retry. This explicitly includes: (a) a timeout for which the bounded reconciliation procedure (§0.F) does not reach a confident positive/conflict conclusion within its 2-read budget — **including the case where both reads consistently show the pre-write value**, which is evidence but never proof of non-application; (b) an attempt record recovered on restart in the durable `INTENDED` phase (§0.C) with no result phase ever recorded, regardless of whether the underlying `videos.update` call actually reached YouTube. No number of reconciliation reads performed by §0.F, on their own, ever authorizes an automatic retry — leaving `UNKNOWN` and requiring a separate reconciliation pass or an explicit operator decision is always the outcome of insufficient evidence, never a retry decision made on a guess.

---

## 4. Verification methodology — automated vs. live

Every scenario below states one or both of:

- **Automated (mocked):** runs as part of `npm test`, against a mocked `youtube_v3`-shaped client (per `docs/DEVELOPMENT_PLAYBOOK.md` §6.11) and, where applicable, a fake/in-memory persistence adapter. **Required for Phase 5 to be considered code-complete.** Per `AGENTS.md` §E/§L and `docs/DEVELOPMENT_PLAYBOOK.md` §6.11, this is the **only** form of verification that may run unattended or as part of CI/regression — it must never, under any circumstance, call a real YouTube endpoint.
- **Live validation:** a manual, one-time run against a real test channel with real Google OAuth credentials, performed only by the project owner or an explicitly designated person, **separately authorized** and never bundled into `npm test`. This corresponds to `docs/TECHNICAL_DEBT.md` RISK-05 and is the mechanism by which `docs/PROJECT_SPEC.md` §53's "against a real test/production channel" requirement is ultimately satisfied — it is **not** a substitute for the automated verification, and the automated verification is not a substitute for it either. A scenario marked "Live validation: required before Gate B" means: Phase 5 code may be complete and merged without this having been run, but real production writes must not be enabled for general use until it has been.

No scenario in this document may be marked "PASS" on the strength of live validation alone if its automated counterpart does not also pass, and vice versa for scenarios that require both.

---

## 5. Acceptance scenarios

Each scenario is complete and self-contained; none of it should require reading the (not-yet-written) implementation to understand what is being asserted, per `AGENTS.md` §L.

### AC-BACKUP-01 — Backup is captured before the first write of a batch

- **Requirement reference:** §19.
- **Preconditions:** A Batch (per DEC-OQ-3) with 2 selected changes across 2 distinct videos (`v1`/`es`/`title`, `v2`/`de`/`description`), both channels synced.
- **Fixed test inputs:** `videoId: "v1"`, current remote `es.title = "Titulo Original"`; `videoId: "v2"`, current remote `de.description = "Alte Beschreibung"`. Selected proposed values: `v1/es/title -> "Titulo Nuevo"`, `v2/de/description -> "Neue Beschreibung"`.
- **Expected result:** Before any `videos.update` call is made for either video, a backup artifact exists capturing each video's pre-write remote state (at minimum, the full `existingLocalizations` map and `defaultLanguage` for that video, per §19's `metadata_before.json` example).
- **Prohibited side effects:** No `videos.update` call occurs before the backup for the corresponding video exists on durable storage.
- **Verification method:** Automated (mocked YouTube client + a fake/real filesystem or DB-backed backup store; assert backup-write call ordering precedes the write-call for the same video).
- **Pass/fail criteria:** PASS iff, for both videos, the backup artifact's captured content exactly matches the pre-write fixture values above and its creation is provably ordered before that video's write attempt. FAIL if a write is attempted with no corresponding backup, or if the backup content does not match the actual pre-write remote state.

### AC-BACKUP-02 — Single-video backup failure blocks only that video (item-level, §0.B item E)

- **Requirement reference:** §19 ("A write operation should refuse to proceed if required backup creation fails"); Decision E (§0.B).
- **Preconditions:** Same batch as AC-BACKUP-01. The backup storage adapter is healthy overall but is mocked to fail (e.g. a simulated disk-write error, or a corrupt fixture) for `v1` only — the store itself remains reachable and successfully backs up `v2`.
- **Fixed test inputs:** Same as AC-BACKUP-01.
- **Expected result:** `v1`'s write is not attempted; its ledger entry (§22, DEC-OQ-1) is marked `FAILED` with an error identifying the backup failure. `v2` (whose backup succeeds, and whose backup store call succeeds) proceeds and completes normally — this is explicitly an item-level failure, not systemic, because the backup store itself is healthy.
- **Prohibited side effects:** No `videos.update` call for `v1` occurs under any circumstance when its backup failed. `v2` is not blocked by `v1`'s unrelated failure.
- **Verification method:** Automated (mocked backup adapter forced to throw for a specific video, while remaining healthy for others).
- **Pass/fail criteria:** PASS iff `v1` shows zero write attempts and a `FAILED` ledger entry citing the backup failure, and `v2` completes normally. FAIL if `v1` is written despite the backup failure, or if `v2` is also blocked (would indicate the failure was wrongly treated as systemic).

### AC-BACKUP-03 — Backups are never overwritten

- **Requirement reference:** §19 ("Backups should not be overwritten").
- **Preconditions:** A backup already exists for `v1` from a prior batch run (distinct timestamp/batch id).
- **Fixed test inputs:** A new batch also targeting `v1`, with a different proposed value.
- **Expected result:** The new batch's backup for `v1` is written to a new, distinct location (e.g. a new `<timestamp>`/batch-id-scoped path per §19's suggested layout) — the prior backup's content is unchanged and independently retrievable.
- **Prohibited side effects:** The prior backup's file/record is not modified, truncated, or deleted.
- **Verification method:** Automated (assert the prior backup's stored content is byte-for-byte identical before and after the second batch runs).
- **Pass/fail criteria:** PASS iff both backups exist independently with their own correct content. FAIL if the first backup's content changed or disappeared.

### AC-BACKUP-04 — Backup infrastructure unavailability halts the whole batch as a systemic condition (§0.B item E)

- **Requirement reference:** §19; §23's systemic-condition list ("backup system unavailable"); Decision E (§0.B).
- **Preconditions:** A 3-video batch (`v1`, `v2`, `v3`). The backup storage adapter itself is unreachable for **every** video (e.g. simulated connection refused to the backup store, distinct from a per-item write error).
- **Fixed test inputs:** Same 3-video batch shape as AC-LEDGER-01, backup adapter mocked to fail its health/connectivity check (or fail uniformly for all 3 videos in a way indistinguishable from an infrastructure outage) before any per-video attempt.
- **Expected result:** The batch halts entirely before any write is attempted for any video; all 3 ledger rows are left in a "not attempted — systemic abort" state distinct from the item-level `FAILED` used in AC-BACKUP-02, with an error identifying the backup infrastructure as unavailable.
- **Prohibited side effects:** No `videos.update` call for any of the 3 videos. The batch does not proceed video-by-video treating each as an independent item-level backup failure.
- **Verification method:** Automated (mock the backup adapter's connectivity/health signal, not a per-item throw).
- **Pass/fail criteria:** PASS iff the whole batch aborts before any write, with all videos marked as a systemic (not item-level) abort. FAIL if any write is attempted, or if the videos are marked individually `FAILED` as though each had an independent backup problem.

### AC-DRYRUN-01 — Dry-run performs every step except the actual write, and produces zero remote mutations

- **Requirement reference:** §20; INV-6.
- **Preconditions:** Same 2-video batch as AC-BACKUP-01. `dryRun: true` explicitly passed.
- **Fixed test inputs:** Same as AC-BACKUP-01.
- **Expected result:** The response/ledger shows: identity check performed, fresh remote-state fetch performed, payload constructed, diff generated — all present and correct — but the mocked YouTube client's write method (`videos.update`) recorded **zero** invocations for either video.
- **Prohibited side effects:** No `videos.update` call; no ledger entry transitions to `SUCCESS` (a dry-run entry uses a distinct, clearly-dry-run-labeled terminal state, never `SUCCESS`, so a report can never conflate a dry-run with a real write).
- **Verification method:** Automated (assert call count on the mocked write method is exactly 0; assert every other expected read/compute step's mock was invoked).
- **Pass/fail criteria:** PASS iff the write-method call count is exactly 0 and every non-write step ran and produced a correct diff. FAIL on any non-zero write-call count, regardless of whether the written value happened to match the proposal.

### AC-DRYRUN-02 — Omitting `dryRun` defaults to dry-run, not to a live write

- **Requirement reference:** §20 ("`dryRun = true` until the user explicitly confirms a live operation").
- **Preconditions:** Same batch as AC-BACKUP-01. The batch-apply request/call omits the `dryRun` field entirely.
- **Fixed test inputs:** Same as AC-BACKUP-01, with `dryRun` field absent from the input.
- **Expected result:** The system behaves identically to AC-DRYRUN-01 — zero live writes — purely because the field was omitted, not because it was explicitly set to `true`.
- **Prohibited side effects:** Same as AC-DRYRUN-01.
- **Verification method:** Automated (input schema/service-level test asserting the fail-safe default).
- **Pass/fail criteria:** PASS iff omitting the field produces the same zero-write outcome as explicitly passing `true`. FAIL if omission is treated as `false`/live.

### AC-DRYRUN-03 — Permitted dry-run artifacts never become, or are mistaken for, a completed live batch (§0.B item D)

- **Requirement reference:** §20; Decision D (§0.B); INV-6.
- **Preconditions:** Same batch as AC-BACKUP-01, run with `dryRun: true`. The implementation produces a local dry-run report and diagnostic records as permitted by Decision D.
- **Fixed test inputs:** Same as AC-DRYRUN-01.
- **Expected result:** The dry-run report/diagnostic records are clearly and structurally tagged as dry-run artifacts (e.g. a `dryRun: true` field, a distinct storage namespace, or both — implementation's choice, but it must be unambiguous). No API, UI view, or audit query that asks "was this batch actually applied?" can return an affirmative answer for this batch based on these artifacts. Re-submitting the *same* batch id later with `dryRun: false` is treated as a new, independent execution — it does not "promote" the dry-run artifacts into a live result, and does not skip any step (backup, identity check, merge, verification) on the theory that the dry-run already did the work.
- **Prohibited side effects:** Any code path that reads a dry-run artifact and reports it as a completed live write; any code path that lets a live run skip its own backup/identity/merge/verify steps because a same-batch-id dry-run already produced that data.
- **Verification method:** Automated (assert dry-run artifacts carry an unambiguous dry-run marker; assert a subsequent live run of the same batch id independently performs every step rather than reusing dry-run outputs as if they were live results).
- **Pass/fail criteria:** PASS iff dry-run artifacts are unambiguously marked and a later live run of the same batch id is a fully independent execution. FAIL if any surface reports the dry-run as applied, or if a live run silently short-circuits using dry-run data.

### AC-MERGE-01 — Merge preserves all locales not targeted by the batch

- **Requirement reference:** §21 ("preserve localization entries not targeted by the operation"); INV-1.
- **Preconditions:** `v1`'s current remote `existingLocalizations` = `{ es: {...}, de: {...}, fr: {...} }`. The selected batch targets only `v1/pt-BR/title` and `v1/pt-BR/description` (an ADD for a locale not present before).
- **Fixed test inputs:** `es.title = "Titulo ES"`, `de.title = "Titel DE"`, `fr.title = "Titre FR"` (each with matching descriptions), all pre-existing and none targeted. Proposed: `pt-BR.title = "Titulo PT"`, `pt-BR.description = "Descricao PT"`.
- **Expected result:** The constructed write payload's `localizations` object contains `es`, `de`, `fr` **exactly as they were** (byte-for-byte, both fields), plus the new `pt-BR` entry. This is scenario §57 verbatim (Spanish/German/French preserved, Portuguese added).
- **Prohibited side effects:** No existing locale entry is dropped, reordered in a lossy way, or has either of its fields altered.
- **Verification method:** Automated (build the payload via the pure merge function against a fixture and assert deep equality on the untouched locales); **Live validation: required before Gate B** (this is official test §57 and must also be confirmed against a real channel at least once).
- **Pass/fail criteria:** PASS iff all three untouched locales are present and unchanged and `pt-BR` is added correctly. FAIL on any drop, corruption, or unintended modification of `es`/`de`/`fr`.

### AC-MERGE-02 — Merge uses freshly-fetched remote state, not the (possibly stale) local sync mirror

- **Requirement reference:** §21 ("obtain current remote metadata if local state may be stale"); closes `docs/TECHNICAL_DEBT.md` RISK-03.
- **Preconditions:** The local `channel-sync` mirror for `v1` shows `es.title = "Local Stale Titulo"` (out of date). The mocked YouTube API returns `es.title = "Actually Current Titulo"` when freshly queried.
- **Fixed test inputs:** Selected change: `v1/es/description -> "Nueva Descripcion"` (title untouched by this change).
- **Expected result:** The payload's preserved `es.title` field equals `"Actually Current Titulo"` (the fresh fetch), never `"Local Stale Titulo"` (the local mirror).
- **Prohibited side effects:** The write payload is never constructed solely from `channel-sync`'s SQLite mirror without an intervening fresh fetch.
- **Verification method:** Automated (mock the fresh-fetch call to return a value deliberately different from the fake local-store fixture; assert the payload reflects the fresh value).
- **Pass/fail criteria:** PASS iff the preserved field matches the fresh-fetch mock, not the local-mirror fixture. FAIL if it matches the stale local value (this is the single most important test in this document for closing RISK-03).

### AC-MERGE-03 — Unrelated snippet metadata is preserved

- **Requirement reference:** §21 ("preserve unrelated metadata required by the relevant YouTube `part`").
- **Preconditions:** `v1`'s fresh-fetched snippet includes `categoryId`, `tags`, `defaultAudioLanguage` alongside `title`/`description`/`localizations`.
- **Fixed test inputs:** Fresh snippet fixture with `categoryId: "10"`, `tags: ["jazz", "cuba"]`, `defaultAudioLanguage: "es"`. Selected change targets only a `localizations` entry, no snippet-level title/description change.
- **Expected result:** The constructed payload's snippet-level fields (`categoryId`, `tags`, `defaultAudioLanguage`) are present and unchanged from the fresh fetch.
- **Prohibited side effects:** The payload builder does not silently drop fields it didn't explicitly set.
- **Verification method:** Automated (fixture-based deep-equality check on untouched snippet fields).
- **Pass/fail criteria:** PASS iff all untouched snippet fields survive unchanged. FAIL on any silent field loss.

### AC-MERGE-04 — Invalid/unapproved/unselected changes never reach payload construction

- **Requirement reference:** §21 ("submit only after validation"); mirrors Phase 4's `change_not_approvable` guard, extended to the write boundary; DEC-OQ-3 (batch is a subset).
- **Preconditions:** A Change Set contains one change with `approvalStatus: "pending"`, one with `validationStatus: "invalid"`, and one that is `approved`+`valid` but **not selected** into this batch.
- **Fixed test inputs:** Same channel/video fixtures as AC-BACKUP-01, with one additional un-approved change, one additional invalid change, and one additional approved-but-unselected change added.
- **Expected result:** Only changes that are `approvalStatus: "approved"` **and** `conflictStatus: "none"` **and** `validationStatus: "valid"` **and** explicitly selected into this batch (DEC-OQ-3) are included in any constructed payload. The pending, invalid, and unselected changes produce no payload at all and are excluded from this batch's write attempts (not silently marked successful, not silently applied) — the unselected change remains `approved` in the `ChangeSet`, available for a future batch.
- **Prohibited side effects:** No payload is ever constructed that includes a pending, invalid, or unselected change's value.
- **Verification method:** Automated (assert the set of videos/fields actually written matches exactly the batch's selected, approved-valid-non-conflicting subset of the fixture).
- **Pass/fail criteria:** PASS iff the pending, invalid, and unselected changes are excluded from every write attempt. FAIL if any of the three reaches a `videos.update` call.

### AC-MERGE-05 — Official test §57: import one new locale, all pre-existing locales preserved (end-to-end)

- **Requirement reference:** §57 (official acceptance test); §21.
- **Preconditions:** As AC-MERGE-01, but exercised through the full pipeline (import → change set → batch creation → apply), not just the pure merge function in isolation.
- **Fixed test inputs:** Same as AC-MERGE-01.
- **Expected result:** Identical outcome to AC-MERGE-01, verified end-to-end through the actual service/API layer rather than a unit-level call to the merge function alone.
- **Prohibited side effects:** Same as AC-MERGE-01.
- **Verification method:** Automated (integration test through `changesets`/Phase-5-write-pipeline services, mocked YouTube adapter); **Live validation: required before Gate B.**
- **Pass/fail criteria:** Same as AC-MERGE-01, at the integration level.

### AC-MULTI-01 — Multiple simultaneous changes to one video produce one consistent payload and one logical operation (§0.B item F)

- **Requirement reference:** §21; Decision F (§0.B); DEC-OQ-1 (ledger is per-video, bundling change ids).
- **Preconditions:** `v1`'s current remote `existingLocalizations` = `{ es: {...}, de: {...}, fr: {...} }`. The selected batch targets **three** distinct approved changes, all on `v1`: `v1/es/title`, `v1/de/description`, and `v1/fr/title`.
- **Fixed test inputs:** Existing: `es.title = "Antiguo ES"`, `es.description = "Desc ES"`; `de.title = "Titel DE"`, `de.description = "Alte DE"`; `fr.title = "Ancien FR"`, `fr.description = "Desc FR"`. Proposed: `es.title -> "Nuevo ES"`, `de.description -> "Neue DE"`, `fr.title -> "Nouveau FR"`.
- **Expected result:** Exactly one ledger row exists for `v1`, bundling all three change ids (per DEC-OQ-1). Exactly one `videos.update` attempt (barring retries) is made for `v1`, carrying a single payload where `es.title`, `de.description`, and `fr.title` all reflect the three proposed values simultaneously, while `es.description`, `de.title`, and `fr.description` (untouched fields) retain their original values.
- **Prohibited side effects:** No more than one write-attempt sequence for `v1` per batch execution (excluding legitimate retries of the *same* logical attempt); no field silently dropped or reverted; no separate, independent `videos.update` call per individual change.
- **Verification method:** Automated (assert exactly one ledger row for `v1` referencing all three change ids; assert the mocked write method is called once per attempt-cycle with a payload containing all three proposed values and all three untouched values correctly preserved).
- **Pass/fail criteria:** PASS iff one ledger row, one logical write operation, correct merged payload. FAIL if changes are applied via multiple separate write calls, if any field is lost, or if a second change silently overwrites the first's already-merged field.

### AC-DEFAULTLANG-01 — Missing required `defaultLanguage` blocks the write with a clear, specific error (DEC-OQ-2)

- **Requirement reference:** `docs/PROJECT_SPEC.md` §14; §29's "default language missing" as a non-retryable permanent-failure class; DEC-OQ-2.
- **Preconditions:** `v1`'s fresh-fetched remote state has no `defaultLanguage` set (or has one that does not cover the locale set being written, per whatever §14 defines as "required" for a safe localization write). A selected change targets `v1/es/title`.
- **Fixed test inputs:** Fresh-fetch fixture for `v1` with `defaultLanguage: null` (or absent). Proposed change: `v1/es/title -> "Titulo Nuevo"`.
- **Expected result:** `v1`'s write is not attempted. Its ledger row is marked `FAILED` (item-level, not systemic — this is a per-video precondition, not a global failure) with an error explicitly naming the missing-`defaultLanguage` condition, distinct from other failure reasons, so the operator understands exactly what to fix.
- **Prohibited side effects:** No `videos.update` call for `v1`. No automatic `defaultLanguage` value is set, guessed, or defaulted by the system under any circumstance.
- **Verification method:** Automated (fixture with missing `defaultLanguage`; assert zero write calls and a specifically-labeled error).
- **Pass/fail criteria:** PASS iff `v1` is blocked pre-write with the specific error and no `defaultLanguage` is set automatically. FAIL if the write proceeds anyway, or if the system silently assigns a `defaultLanguage`.

### AC-DEFAULTLANG-02 — A video with a valid `defaultLanguage` is unaffected by the check

- **Requirement reference:** §14; DEC-OQ-2 (the check must not produce false positives that block otherwise-safe writes).
- **Preconditions:** `v2`'s fresh-fetched remote state has `defaultLanguage: "en"` set. A selected change targets `v2/es/title`.
- **Fixed test inputs:** Fresh-fetch fixture for `v2` with `defaultLanguage: "en"`. Proposed change: `v2/es/title -> "Titulo Nuevo"`.
- **Expected result:** `v2` proceeds through the normal write pipeline; the `defaultLanguage` check does not block it.
- **Prohibited side effects:** No spurious `FAILED` ledger entry for a video that has a valid `defaultLanguage`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `v2` is not blocked by the `defaultLanguage` check. FAIL on any false-positive block.

### AC-BATCH-01 — Batch composition is an explicit operator-selected subset, fixed at creation (DEC-OQ-3)

- **Requirement reference:** DEC-OQ-3; §22 (conceptually, "Batch ID" as distinct from the full Change Set).
- **Preconditions:** A `ChangeSet` with 5 approved, valid, non-conflicting changes across 5 videos. The operator selects only 3 of the 5 to include in a new `Batch`.
- **Fixed test inputs:** `v1`..`v5`, each with one approved change; batch-creation request includes only `v1`, `v2`, `v3`.
- **Expected result:** The created `Batch` entity references exactly `v1`, `v2`, `v3`'s changes. `v4` and `v5`'s changes remain `approved` in the `ChangeSet`, untouched, and are not included in any ledger row or write attempt for this batch.
- **Prohibited side effects:** `v4`/`v5` never appear in this batch's ledger, backup, or audit records. Creating this batch does not alter `v4`/`v5`'s `approvalStatus`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the batch contains exactly the 3 selected videos/changes and the other 2 remain untouched in the `ChangeSet`. FAIL if the batch silently includes all 5, or if it mutates the unselected changes' state.

### AC-BATCH-02 — A batch's membership does not change once execution has begun, independently of each member's approval validity at send time (revised 2026-09-17, third review round, to remove a contradiction with AC-BATCH-03)

- **Requirement reference:** DEC-OQ-3 ("Состав Batch фиксируется при его создании и не должен изменяться во время выполнения"); INV-4 (sharpened) — membership-freezing and approval-validity-at-send-time are two distinct guarantees and must not be conflated.
- **Preconditions:** A batch created with `v1`, `v2`, `v3` as in AC-BATCH-01, now `APPLYING`. While it is mid-execution, a new change is approved for `v4` in the same `ChangeSet` — this scenario tests **membership** only; what happens to `v2` when *its own* approval is edited/revoked/invalidated after batch creation is AC-BATCH-03's concern, not this scenario's, and the two must not be read as competing answers to the same question.
- **Fixed test inputs:** As AC-BATCH-01, plus: a new approval for `v4` submitted after batch-start.
- **Expected result:** The in-flight batch continues to target exactly `v1`, `v2`, `v3` — its membership set never grows or shrinks once execution has begun. `v4` is never pulled into this batch, regardless of how soon after batch-start it becomes approved. For `v1`, `v2`, `v3` individually, whether each one's *frozen-at-creation* payload is actually sent is governed separately by AC-BATCH-03's approval/validation re-check at send time — this scenario makes no claim that a frozen member is written unconditionally; it claims only that the *set of candidates* `{v1, v2, v3}` cannot be altered by anything that happens after creation.
- **Prohibited side effects:** Any write attempt for `v4` within this batch, under any circumstance, at any point during its execution. Any code path that treats a batch's membership as re-evaluated against the `ChangeSet`'s current approved set at any point after creation (i.e. re-deriving `{v1, v2, v3, ...}` instead of using the frozen list).
- **Verification method:** Automated (simulate a late approval event for an unrelated video firing while the batch's execution is in progress via a controllable mock; assert the batch's targeted-video set is unaffected).
- **Pass/fail criteria:** PASS iff the batch's target set remains exactly `{v1, v2, v3}` throughout execution. FAIL if `v4` is written or otherwise included, or if the batch's candidate set is observed to change at any point after creation.

### AC-BATCH-03 — A member change whose approval was revoked/invalidated/edited after batch creation blocks that video's write, despite fixed batch membership (added 2026-09-17, second review round)

- **Requirement reference:** DEC-OQ-3, as sharpened by the project owner's follow-up instruction: *"если approval соответствующего Change был отозван, инвалидирован или изменён после создания Batch, но до отправки videos.update, запись должна быть заблокирована. Не допускай публикации старого payload на основании недействительного approval."*; INV-4 (sharpened). This scenario is the complement of AC-BATCH-02: AC-BATCH-02 asserts the batch's *membership* (which videos are candidates) never changes; this scenario asserts that a frozen candidate is not written unconditionally — its approval must still be valid at the moment of send.
- **Preconditions:** A batch is created with `v1`, `v2`, `v3` (as AC-BATCH-01), each backed by one approved, valid change frozen into the batch at creation time. Before the batch reaches `v2`'s write step (batch is still sequential/early in execution), `v2`'s underlying change is, in three independently-tested sub-cases: (a) its approval is revoked (`approvalStatus` reverts to `pending` or an explicit `revoked` state); (b) it is invalidated by the existing Phase 4 validation mechanism (`validationStatus` becomes `invalid`, e.g. because the target video/locale became unreachable); (c) its proposed value is edited in the `ChangeSet` (a new value is saved against the same `Change` id after batch creation).
- **Fixed test inputs:** `v2`'s change frozen into the batch at creation: `es.title -> "Original Batch Value"`. Before `v2`'s send step, depending on sub-case: (a) approval revoked; (b) validation flips to invalid; (c) the change's proposed value is edited to `"Edited After Batch Creation"` (still nominally approved).
- **Expected result:** In all three sub-cases, `v2`'s write is blocked immediately before send — `v2`'s ledger row transitions to `FAILED` (item-level, citing "approval no longer valid at send time"), not `CONFLICT` (which is reserved for a *remote-state* divergence, §30) and not `SUCCESS`. `v1` and `v3`, whose approvals remain valid and unchanged, are unaffected and proceed normally. Critically, in sub-case (c), the system never sends `"Original Batch Value"` (the value frozen at batch creation) **nor** `"Edited After Batch Creation"` (the new, differently-approved value) — the write for `v2` simply does not happen in this batch run at all, because neither payload has a currently-valid approval backing it exactly as sent.
- **Prohibited side effects:** Any `videos.update` call for `v2` in any of the three sub-cases. Any code path that treats "batch membership is frozen" as sufficient license to skip the approval/validation re-check immediately before send. `v1`/`v3` being blocked or delayed by `v2`'s per-item block.
- **Verification method:** Automated (controllable mock that flips `v2`'s approval/validation/content state after batch creation but before its scheduled send step in a deterministic sequential run; assert zero write calls for `v2` in all three sub-cases and unaffected outcomes for `v1`/`v3`).
- **Pass/fail criteria:** PASS iff `v2` is blocked pre-send in all three sub-cases with no write call issued for either the frozen or the edited value, and `v1`/`v3` are unaffected. FAIL if `v2` is written using any payload, in any sub-case, or if `v1`/`v3` are incorrectly blocked as well.

### AC-LEDGER-01 — A ledger row is created for every video in the batch, initial state PENDING (DEC-OQ-1)

- **Requirement reference:** §22; DEC-OQ-1.
- **Preconditions:** A batch (per DEC-OQ-3) selecting changes across 3 videos.
- **Fixed test inputs:** `v1`, `v2`, `v3`, each with at least one selected change.
- **Expected result:** Immediately upon batch creation (before any write attempt), 3 ledger rows exist, one per video (not one per change — per DEC-OQ-1), each `status: PENDING`, each recording `batchId`, `videoId`, and the full list of change ids it bundles.
- **Prohibited side effects:** No ledger row is created for a video with zero selected changes. No ledger row is created per-change (that would contradict DEC-OQ-1's "one row per video").
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff exactly 3 `PENDING` rows exist, one per targeted video, before any write attempt. FAIL on missing/extra rows, an incorrect initial status, or a per-change row granularity.

### AC-LEDGER-02 — Successful write transitions PENDING → APPLYING → SUCCESS

- **Requirement reference:** §22.
- **Preconditions:** As AC-LEDGER-01, mocked YouTube client configured to succeed for all 3 videos, with post-write verification (§24) also mocked to confirm the expected state.
- **Fixed test inputs:** Same as AC-LEDGER-01.
- **Expected result:** Each ledger row's status is observed to pass through `APPLYING` before landing on `SUCCESS`; the `SUCCESS` state additionally records a remote confirmation and a timestamp (§22's ledger field list).
- **Prohibited side effects:** No row reaches `SUCCESS` without having passed through `APPLYING` first (no skipping straight from `PENDING`).
- **Verification method:** Automated (assert the full status-transition sequence was observed, not just the final state).
- **Pass/fail criteria:** PASS iff all 3 rows show the full `PENDING → APPLYING → SUCCESS` sequence with a remote confirmation recorded. FAIL on a skipped transition or a missing remote confirmation.

### AC-LEDGER-03 — A failed write transitions to FAILED with the error captured

- **Requirement reference:** §22, §23.
- **Preconditions:** As AC-LEDGER-01, mocked YouTube client configured to return a permanent error (e.g. HTTP 403 insufficient-permissions) for `v2` only.
- **Fixed test inputs:** Same as AC-LEDGER-01.
- **Expected result:** `v2`'s ledger row reaches `FAILED` with the error captured verbatim (matching §22's `Error` field); `v1` and `v3` are unaffected (ties to AC-ISOLATION-01).
- **Prohibited side effects:** `v2`'s failure does not prevent `v1`/`v3` from reaching `SUCCESS`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `v2` is `FAILED` with the correct error and `v1`/`v3` are `SUCCESS`. FAIL if the batch aborts entirely or if the error is lost/altered.

### AC-LEDGER-04 — A change that becomes conflicted at apply time transitions to CONFLICT, not SUCCESS or FAILED

- **Requirement reference:** §22, §30.
- **Preconditions:** As AC-LEDGER-01. Between approval and apply-time, `v3`'s remote state (per a fresh fetch at apply time) has diverged from the baseline the approval was based on.
- **Fixed test inputs:** `v3`'s approval baseline `es.title = "Baseline"`; fresh fetch at apply time returns `es.title = "Changed Externally"`.
- **Expected result:** `v3`'s ledger row is marked `CONFLICT`, no write is attempted for `v3`, and its `Change` record is revalidated/invalidated per the existing Phase 4 mechanism (`docs/ARCHITECTURE.md` §6.7) so the change set correctly reflects it needs re-review.
- **Prohibited side effects:** `v3` is never written while in a `CONFLICT` state, and is never marked `SUCCESS`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `v3` is `CONFLICT`, unwritten, and its change is flagged for re-review. FAIL if `v3` is written despite the conflict, or silently dropped without being surfaced.

### AC-ATTEMPT-01 — Every actual API call produces its own attempt record, distinct from the video-level ledger row (DEC-OQ-1/§0.C)

- **Requirement reference:** §22; DEC-OQ-1; §0.C's two-level data model.
- **Preconditions:** `v1`'s write fails with two **definitively-known** transient errors (HTTP 503, a confirmed non-success response, not an outcome-unknown condition) before succeeding on the 3rd call. Revised 2026-09-17 (fourth review round): the original fixture used a timeout for the first failure, which is an *outcome-unknown* condition and, per §0.F/AC-TIMEOUT-01, must never be followed by an automatic retry — using it here would have implied that a timeout can be retried like an ordinary transient failure, contradicting the `UNKNOWN` policy. This scenario now exercises only ordinary bounded-retry behavior (§0.E/AC-RETRY-01) on a known-outcome error; timeout/outcome-unknown handling is exclusively AC-TIMEOUT-01/AC-TIMEOUT-02/AC-ATTEMPT-04's concern.
- **Fixed test inputs:** Mocked write method: call 1 → HTTP 503; call 2 → HTTP 503; call 3 → success.
- **Expected result:** Exactly one ledger row exists for `v1` (final status `SUCCESS`), and exactly 3 attempt records exist for `v1`, each with its own `attemptNumber` (1, 2, 3), timestamp, and outcome (`FAILED:503`, `FAILED:503`, `SUCCESS` respectively). No reconciliation read appears in this sequence, since a definitive HTTP 503 is a known outcome and never triggers §0.F.
- **Prohibited side effects:** No second ledger row created for the retries; no attempt record silently merged/overwritten by a later one (all 3 remain independently queryable); no reconciliation-read call inserted between attempts (that would only be correct for an outcome-unknown failure, not a definitive 503).
- **Verification method:** Automated (assert ledger-row count = 1 for `v1`; assert attempt-record count = 3 with correct per-attempt outcomes and ordering; assert no reconciliation-read mock is invoked).
- **Pass/fail criteria:** PASS iff exactly 1 ledger row and exactly 3 attempt records exist with correct outcomes in order and no reconciliation read occurs. FAIL on any collapsing of attempts into the ledger row, any missing/duplicated attempt record, or any reconciliation read appearing for a definitive-error retry sequence.

### AC-ATTEMPT-02 — Attempt records are queryable independently to distinguish "one operation, several retries" from "several operations"

- **Requirement reference:** DEC-OQ-1 ("Отдельно необходимо хранить фактические попытки API, чтобы можно было отличать одну операцию от нескольких retry").
- **Preconditions:** Two videos in the same batch: `v1` succeeds on its 2nd attempt after one **definitively-known** transient failure (e.g. HTTP 503, not a timeout — see AC-ATTEMPT-01's note on keeping outcome-unknown handling exclusively within §0.F/AC-TIMEOUT-01); `v2` succeeds on its 1st attempt.
- **Fixed test inputs:** `v1`: attempt 1 fails with HTTP 503, attempt 2 succeeds. `v2`: attempt 1 succeeds.
- **Expected result:** A query for "all attempts for this batch" returns 3 total attempt records (2 for `v1`, 1 for `v2`), each correctly attributed to its `videoId`; a query for "ledger rows for this batch" returns exactly 2 (one per video), and nothing in the ledger-row view implies `v1` required 2 *logical* operations — only its attempt history shows the retry.
- **Prohibited side effects:** The ledger view conflating retries with distinct logical write operations (e.g. inflating a "videos written" count based on attempt count rather than ledger-row count).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff ledger-row and attempt-record counts are both correct and independently queryable as described. FAIL if either is miscounted or conflated with the other.

### AC-ATTEMPT-03 — A durable attempt-intent record is committed before `videos.update` is sent (added 2026-09-17, second review round)

- **Requirement reference:** §0.C (two-phase attempt record); §0.B item B2 — *"До отправки videos.update необходимо сохранить durable attempt intent."*
- **Preconditions:** `v1`'s write is about to be sent for the first time in this batch. The persistence layer and the mocked YouTube client are separately instrumented so call ordering between "durable write of the intent record" and "network call to `videos.update`" can be observed.
- **Fixed test inputs:** `v1`, attempt 1, requested `es.title = "New Title"`.
- **Expected result:** An attempt record in phase `INTENDED` (carrying `batchId`, `videoId`, `attemptNumber: 1`, a request timestamp, and the payload snapshot to be sent) is durably committed to storage **before** the mocked `videos.update` network call is invoked. Only after that commit succeeds does the network call fire.
- **Prohibited side effects:** The `videos.update` network call being invoked before the `INTENDED` record's durable commit has completed or been confirmed. A `videos.update` call ever being sent with no corresponding `INTENDED` record on durable storage.
- **Verification method:** Automated (assert call ordering: durable-store-write call for the `INTENDED` record is observed strictly before the mocked network call for the same attempt).
- **Pass/fail criteria:** PASS iff the `INTENDED` record is durably committed strictly before the network call for every attempt. FAIL if any network call is observed with no prior durable `INTENDED` record, or if ordering is reversed.

### AC-ATTEMPT-04 — An `INTENDED`-with-no-result attempt is restored as UNKNOWN regardless of whether the network call was ever actually issued, and never asserted as having occurred (revised 2026-09-17, fourth review round)

- **Requirement reference:** §0.C; §0.F; §0.B item B2 — *"Если процесс завершился между отправкой запроса и сохранением результата, attempt должен быть восстановлен как outcome-unknown и пройти reconciliation."*; INV-12 (sharpened). Sharpened further in the fourth review round: *"INTENDED означает, что намерение отправить запрос надёжно сохранено, но не доказывает фактическую отправку. При аварии между сохранением intent и отправкой запроса восстановление должно использовать UNKNOWN/reconciliation, не утверждая, что API-вызов действительно состоялся."*
- **Preconditions:** `v1`'s attempt 1 has a durably-committed `INTENDED` record (per AC-ATTEMPT-03). Two sub-cases cover the two points at which a crash can occur relative to the network call, both of which must converge on the identical `UNKNOWN`/§0.F handling: (a) the process terminates **after** the `INTENDED` record is durably committed but **before** the `videos.update` network call is ever issued (the call may never have left this process at all); (b) the process terminates **after** the network call has been issued but **before** any result phase is durably recorded (the call may have reached YouTube and been applied, reached YouTube and failed, or never reached YouTube at all — genuinely unknown).
- **Fixed test inputs (sub-case a):** `v1`, attempt 1, `INTENDED` record committed with requested `es.title = "New Title"`; process terminates immediately after the durable commit, strictly before the mocked network-call function is ever invoked (asserted via a call-count of 0 on the network mock at crash time).
  **Fixed test inputs (sub-case b):** `v1`, attempt 1, `INTENDED` record committed; the mocked network-call function is invoked; process terminates immediately after that invocation, before any result is recorded. On restart in either sub-case, the reconciliation procedure's mocked reads are configured per §0.F's own sub-cases (this scenario asserts the *routing and the non-assertion of an unverified fact*, not re-testing §0.F's read-outcome logic, which AC-TIMEOUT-01 already covers).
- **Expected result:** In **both** sub-cases, on restart the system finds `v1`'s attempt 1 in phase `INTENDED` with no result ever recorded and classifies it as `UNKNOWN` — identically in both sub-cases, because an `INTENDED`-with-no-result record does not by itself distinguish "call never sent" (sub-case a) from "call sent, outcome unrecorded" (sub-case b); the system does not attempt to guess which occurred, and does not need to in order to proceed correctly. It routes the attempt into the §0.F reconciliation procedure exactly as a live timeout would be routed — the crash-recovery path and the live-timeout path converge on the same reconciliation logic rather than being handled by separate, potentially inconsistent code. Critically, the recovery logic and any resulting audit/status text must **never assert or imply that the `videos.update` call was actually sent** in sub-case (a), nor that it was **not** sent in either sub-case — reconciliation determines the *remote state*, not a claim about which local code path executed.
- **Prohibited side effects:** Treating a restart-recovered `INTENDED`-with-no-result attempt as `FAILED` (which would wrongly imply the call is known to have failed or not been sent) or as `SUCCESS` (which would wrongly imply the call is known to have succeeded) without first running §0.F, in either sub-case. Issuing a second `videos.update` call before reconciliation completes. Any recovery log, status text, or audit event that states or implies "the API call was sent" for sub-case (a), or "the API call was/was not sent" for either sub-case, when the system has no basis for that specific claim.
- **Verification method:** Automated (deterministic crash-simulation harness for each sub-case: sub-case (a) interrupts before the network mock is ever called and asserts zero network-mock invocations at crash time; sub-case (b) interrupts after the network mock is called but before any result-phase write; both assert the restart path classifies the attempt as `UNKNOWN` and invokes the same reconciliation routine exercised by AC-TIMEOUT-01, and that no recovery-generated text asserts whether the network call occurred).
- **Pass/fail criteria:** PASS iff both sub-cases classify the recovered attempt as `UNKNOWN`, route it through §0.F identically, and produce no claim about whether the network call was actually issued beyond what reconciliation itself establishes. FAIL if either sub-case assumes failure, assumes success, retries without reconciliation, or asserts the call was/was not sent without evidence.

### AC-ISOLATION-01 — A single video's failure does not abort the rest of the batch

- **Requirement reference:** §23.
- **Preconditions:** As AC-LEDGER-03 (one of several videos fails for a non-systemic reason, e.g. "video not found").
- **Fixed test inputs:** Same as AC-LEDGER-03.
- **Expected result:** The batch completes with a summary matching §23's example shape: counts of successful/skipped/failed/conflicted, and the unaffected videos reach `SUCCESS`.
- **Prohibited side effects:** The batch does not stop processing remaining videos after the first item-level failure.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff all non-failing videos still reach `SUCCESS` in the same batch run. FAIL if the batch halts after the first failure.

### AC-ISOLATION-02 — A systemic condition aborts the entire remaining batch

- **Requirement reference:** §23 ("wrong authenticated channel; credentials invalid globally; quota exhausted; malformed common payload logic; backup system unavailable").
- **Preconditions:** As AC-LEDGER-01, but the mocked credential resolver is configured to report globally invalid credentials starting at the 2nd video.
- **Fixed test inputs:** Same 3-video batch; credential failure simulated before `v2`'s attempt.
- **Expected result:** `v2` and `v3` (everything after the systemic failure is detected) are not attempted and are left in a clearly-labeled "not attempted due to systemic abort" state, distinct from `FAILED` (which implies an attempt was made and failed) — the batch stops rather than continuing to hammer a globally broken credential.
- **Prohibited side effects:** The batch does not continue attempting further videos once a systemic condition is detected.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the batch halts at the systemic failure and clearly distinguishes "not attempted" from "attempted and failed." FAIL if it keeps attempting remaining videos, or if `v1` (already completed before the systemic failure) is retroactively marked as failed.

### AC-ISOLATION-03 — A downloadable/exportable error report is available after a mixed-result batch

- **Requirement reference:** §23 ("Allow export/download of the error report").
- **Preconditions:** A completed batch with a mix of `SUCCESS`, `FAILED`, and `CONFLICT` outcomes.
- **Fixed test inputs:** As AC-LEDGER-03/04 combined (one success, one failure, one conflict).
- **Expected result:** An API/service call returns a report enumerating every non-`SUCCESS` item with its video id, status, and error/conflict detail, in a format suitable for download (matching the existing project convention of structured JSON, not bare prose — `docs/DEVELOPMENT_PLAYBOOK.md` §6.6).
- **Prohibited side effects:** None (this is a read operation).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the report includes every non-successful item with correct status/detail. FAIL if any failed/conflicted item is missing from the report.

### AC-VERIFY-01 — Success requires a confirmed post-write remote state, not just a non-error API response

- **Requirement reference:** §24; INV-10.
- **Preconditions:** Mocked YouTube client's `videos.update` call returns HTTP 200 for `v1`, but a subsequent fresh fetch shows the remote `es.title` does **not** match what was requested (simulating a partial-apply or silently-ignored-field scenario).
- **Fixed test inputs:** Requested `es.title = "Requested Value"`; post-write fetch returns `es.title = "Different Value"`.
- **Expected result:** `v1` is **not** marked `SUCCESS` despite the 200 response — it is marked `FAILED` (or a distinct `VERIFICATION_FAILED` state, see the ledger-state list is not exhaustively fixed by spec — use `FAILED` unless a more specific state is later agreed) with the mismatch recorded.
- **Prohibited side effects:** The system never reports success to the user/audit log based on transport status alone.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the mismatched write is not marked `SUCCESS`. FAIL if a 200 response alone is treated as sufficient.

### AC-VERIFY-02 — Requested state, confirmed state, and verification timestamp are all stored

- **Requirement reference:** §24 ("Store: requested state, confirmed remote state, verification timestamp").
- **Preconditions:** A successful write for `v1`.
- **Fixed test inputs:** Requested `es.title = "New Title"`; post-write fetch confirms `es.title = "New Title"`.
- **Expected result:** The stored record (ledger and/or audit, per §22/§25) includes all three: the requested value, the confirmed value, and a verification timestamp distinct from the write-attempt timestamp.
- **Prohibited side effects:** None.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff all three fields are present and correct. FAIL if any is missing or if requested/confirmed are conflated into a single field.

### AC-CRASH-01 — Crash after a successful YouTube write but before the ledger records SUCCESS is reconciled on restart, never re-written (§0.B item A)

- **Requirement reference:** §22, §24; Decision A (§0.B); INV-7, INV-10, INV-12; §0.F (this scenario is the specific case of AC-ATTEMPT-04's general recovery rule where reconciliation happens to conclude the write did apply).
- **Preconditions:** `v1`'s `videos.update` call has been sent and YouTube has actually applied it (the mocked remote state now reflects the new value), but the process is simulated to terminate before the ledger row transitions out of `APPLYING` (i.e. before `SUCCESS` and its remote confirmation are durably recorded), leaving the attempt record in the durable `INTENDED` phase with no result recorded (§0.C).
- **Fixed test inputs:** Requested `es.title = "New Title"`; mocked remote state after the (unrecorded) write is `es.title = "New Title"` (i.e. it really did apply). Simulated crash occurs immediately after the write call returns, before either the attempt's result phase or the ledger update commits. On restart, §0.F's Step 1 reconciliation read returns the requested value directly (no ambiguity in this fixture — that ambiguous case is AC-TIMEOUT-01's sub-case 2 / AC-ATTEMPT-04).
- **Expected result:** On restart/resume, the system finds `v1`'s attempt record in `INTENDED` with no result, classifies it `UNKNOWN` (per AC-ATTEMPT-04), and runs §0.F: Step 1's reconciliation read observes the remote state already matches the requested value, so the attempt's result phase and the ledger row are both durably updated to `SUCCESS` with a remote confirmation and verification timestamp — **without** issuing a new `videos.update` call. Per §0.F's causation note and AC-AUDIT-05: the audit event for this attempt records that reconciliation confirmed the target state, and must not claim that this attempt's own `videos.update` call was observed to succeed (its response was never received by this process) — the fixture stipulating "YouTube actually applied it" is a test-harness fact used to make the scenario deterministic, not something the system itself is ever in a position to assert.
- **Prohibited side effects:** Any `videos.update` call for `v1` during the restart/resume/reconciliation flow. Any permanent stuck state that never resolves out of `APPLYING`/`UNKNOWN`.
- **Verification method:** Automated (deterministic crash-simulation harness: interrupt after the mocked write call returns but before the ledger-commit call; assert the resume path calls the fresh-fetch mock and not the write mock; assert final state is `SUCCESS` with confirmation).
- **Pass/fail criteria:** PASS iff `v1` resolves to `SUCCESS` via reconciliation with zero additional write calls. FAIL if a duplicate write is issued, or if `v1` remains indefinitely stuck in `APPLYING`/`UNKNOWN`, or if it is incorrectly marked `FAILED` despite the write having actually succeeded.

### AC-TIMEOUT-01 — A timeout with unknown write result follows the bounded §0.F reconciliation procedure; no combination of reconciliation reads ever authorizes an automatic retry (§0.B item B, DEC-OQ-6, revised 2026-09-17 third review round)

- **Requirement reference:** §24, §29; Decision B (§0.B); DEC-OQ-6; §0.F; INV-10, INV-12 (sharpened).
- **Preconditions:** `v1`'s `videos.update` call times out (the mocked client raises a timeout/no-response error). Four sub-cases exercise §0.F's full decision tree.
- **Fixed test inputs (sub-case 1, applied — resolved at Step 1):** Timeout raised; §0.F Step 1's reconciliation read shows `es.title` already equals the requested value.
  **Fixed test inputs (sub-case 2, two consistent negative reads — resolved as UNKNOWN, not retry):** Timeout raised; §0.F Step 1's read shows `es.title` still equals the pre-write baseline; Step 2's confirmatory read (after the bounded delay), taken independently, **also** shows the baseline value, consistently with Step 1.
  **Fixed test inputs (sub-case 3, stale-first-read — resolved at Step 2 as applied):** Timeout raised; Step 1's read shows the pre-write baseline (a stale/lagged read); Step 2's confirmatory read shows the requested value has since appeared.
  **Fixed test inputs (sub-case 4, inconsistent/failed second read — resolved as UNKNOWN):** Timeout raised; Step 1's read shows the pre-write baseline; Step 2's confirmatory read itself times out / errors / returns a value inconsistent with a clean baseline-vs-requested comparison.
- **Expected result (sub-case 1):** `v1` is marked `SUCCESS` with a remote confirmation after exactly one reconciliation read; no `videos.update` retry is issued; Step 2 is never reached.
  **Expected result (sub-case 2):** After Step 1's single ambiguous read, the system does **not** authorize a retry (one stale-value read is insufficient proof) and performs Step 2's bounded confirmatory read. Step 2 **also** shows the baseline — but, per the project owner's explicit instruction, **two consistent negative reads are still not proof that the prior `videos.update` did not apply.** `v1`'s attempt is left in the explicit `UNKNOWN` state; **no retry is issued by this procedure at all**, immediately or otherwise. Resolution requires a later, independent reconciliation pass or an explicit operator decision (§0.F Step 3), and any resulting new attempt re-runs the full pipeline from scratch (§0.F Step 4) rather than resending this attempt's payload.
  **Expected result (sub-case 3):** `v1` is marked `SUCCESS` once Step 2's read shows the requested value; no retry is issued for this attempt; this demonstrates that a single Step-1 baseline read alone must never have been treated as proof of non-application.
  **Expected result (sub-case 4):** `v1`'s attempt is left in the explicit `UNKNOWN` state (INV-12) after Step 2 fails to produce a clean confirmatory reading — the same terminal outcome as sub-case 2, reached for a different reason (inconclusive rather than consistently-negative evidence); no retry is authorized; the item surfaces for manual operator review (AC-ISOLATION-03) rather than being resolved by assumption; the rest of the batch is not blocked by `v1`'s `UNKNOWN` state.
- **Prohibited side effects:** A `videos.update` retry call issued for `v1` (a) before Step 2 completes, in any sub-case, or (b) at any point afterward in sub-cases 2 and 4, on the strength of the reconciliation reads alone — this procedure must never issue or schedule a retry by itself; the only way `v1` receives a new `videos.update` call after landing in `UNKNOWN` is via §0.F Step 4's full pipeline re-run, triggered by a separate reconciliation pass or an operator decision, never as a direct continuation of this procedure. A timeout ever treated as equivalent to a confirmed failure (licensing an immediate retry) or a confirmed success without at least the applicable step(s) of §0.F.
- **Verification method:** Automated (mock call-ordering assertion across all four sub-cases: for a timeout outcome, the next call recorded for `v1` must be a reconciliation read; in sub-case 2, a *second* reconciliation read must be observed and no `videos.update` call of any kind may follow within this procedure's execution).
- **Pass/fail criteria:** PASS iff all four sub-cases resolve exactly as described — sub-cases 1 and 3 reach `SUCCESS` via reconciliation alone, sub-cases 2 and 4 both reach `UNKNOWN` with zero retries issued by the procedure. FAIL if any retry is issued by this procedure in any sub-case, or if sub-case 2 is resolved to anything other than `UNKNOWN` (in particular, FAIL if two consistent negative reads are treated as grounds for an automatic retry).

### AC-TIMEOUT-02 — Resolving an UNKNOWN attempt always re-runs the full write pipeline; an edited-after-batch-creation approval blocks the write exactly as AC-BATCH-03 requires, never an automatic pickup of the new value (revised 2026-09-17, fifth review round — see §7 for the contradiction this replaces)

- **Requirement reference:** §0.F Step 4; §21, §27, §30 (approval validation, identity check, fresh remote check, conflict detection are all mandatory for every write attempt, with no carve-out for a "retry"); AC-BATCH-03/INV-4 (an edited/revoked/invalidated approval blocks the write outright, regardless of batch membership or of how the retry was authorized); the project owner's instructions: *"Любое последующее выполнение должно повторно проходить approval validation, fresh remote check, conflict detection и остальные обязательные защитные механизмы"* and (fifth review round) *"Если Change был отредактирован после создания Batch, повторная проверка approval должна заблокировать запись. Нельзя автоматически подхватывать новое значение в существующий Batch."*
- **Preconditions:** `v1` is left `UNKNOWN` per AC-TIMEOUT-01 sub-case 2 (two consistent negative reconciliation reads after a timeout). Between that outcome and the next attempt, `v1`'s underlying `Change` is edited in the `ChangeSet` (a new proposed value is saved against the same `Change` id, still nominally `approved` — this is the same sub-case (c) condition as AC-BATCH-03). An operator explicitly authorizes a new attempt for `v1`.
- **Fixed test inputs:** Original attempt: requested `es.title = "New Title"`, left `UNKNOWN`. Before the operator-authorized new attempt: `v1`'s change is edited to request `es.title = "Newer Title"` (content edited after the batch that produced the `UNKNOWN` attempt was created).
- **Expected result:** The new attempt re-runs the full pipeline in order (§0.F Step 4): approval/validation re-check first, then (only if that check passes) fresh remote-state fetch, merge, and conflict detection. The approval/validation re-check applies the identical rule as AC-BATCH-03 sub-case (c) — a change edited after its batch was created is never published either as the stale frozen value or as the newly-edited value — and blocks the write immediately: `v1`'s ledger row transitions to `FAILED`, citing "approval no longer valid at send time" (item-level, not `CONFLICT`, which is reserved for a remote-state divergence detected during conflict detection, §30). Because the block occurs at the approval-recheck step, the fresh remote fetch and conflict detection are never reached for this attempt in this fixture — which is itself the correct behavior: an invalidated approval must stop the pipeline before a payload is ever constructed from it, not merely be caught later by conflict detection.
- **Prohibited side effects:** Any `videos.update` call for `v1` carrying either the stale `"New Title"` payload from the original `UNKNOWN` attempt or the newly-edited `"Newer Title"` value. Any code path that treats an operator's "retry this video" authorization as bypassing, weakening, or reordering the approval/validation re-check ahead of the other pipeline steps. Any code path that silently folds an edited-after-batch-creation change into the batch being resumed instead of requiring it to be selected into a new batch after re-approval.
- **Verification method:** Automated (assert the approval/validation re-check step runs first and independently blocks the write when the change was edited after batch creation; assert zero `videos.update` calls with any payload; assert the fresh-fetch and conflict-detection mocks are never invoked for this attempt, since the pipeline must stop at the approval-recheck failure).
- **Pass/fail criteria:** PASS iff `v1` is blocked at the approval-recheck step with `FAILED` (not `CONFLICT`, not `SUCCESS`) and zero write calls occur with either payload, consistent with AC-BATCH-03. FAIL if the write proceeds with either payload, if the outcome is `CONFLICT`/`SUCCESS` instead of `FAILED`, or if the edited value is treated as automatically adopted into the resumed batch.
- **Pass/fail criteria:** PASS iff the new attempt is built entirely from freshly re-run safeguards and correctly lands on `CONFLICT` given the fixture's interim third-party edit. FAIL if any stale payload is sent, or if any safeguard is skipped because the video was "already prepared" by the prior `UNKNOWN` attempt.

### AC-AUDIT-01 (revised) — Every stage of a video's write lifecycle produces a durable, correctly-typed audit event; no event is lost (§0.B item C)

- **Requirement reference:** §25; Decision C (§0.B); INV-11 (revised).
- **Preconditions:** A batch covering: one straightforward success (`v1`), one failure (`v2`), one pre-execution conflict (`v3`), one dry-run item (`v4`), and one item that required a retry after a transient failure before succeeding (`v5`, exactly 2 attempts — see fixture note below, revised 2026-09-17 fifth review round).
- **Fixed test inputs:** As the combined fixtures from AC-LEDGER-02/03/04 and AC-DRYRUN-01, applied to `v1`..`v4`. For `v5`, this scenario uses its own explicitly-defined 2-attempt fixture — the same shape as AC-ATTEMPT-02's `v1` (attempt 1 fails with a definitively-known transient error, HTTP 503; attempt 2 succeeds) — deliberately **not** AC-ATTEMPT-01's fixture, which now exercises 3 attempts (two HTTP 503s then success, per its own fourth-review-round revision). Keeping `v5`'s fixture independently defined at 2 attempts avoids the two scenarios' attempt counts drifting out of sync if either is revised again in the future.
- **Expected result:** The audit trail contains, at minimum and distinctly typed: a preparation/prepared-to-write event for each of `v1`, `v2`, `v3`, `v5` (not `v4`, whose preparation event is separately tagged dry-run per AC-AUDIT-02); one attempt event per actual API call (1 for `v1`, 1 for `v2`, 0 for `v3` since it never reaches an attempt, 2 for `v5`); one result event per attempt; one conflict event for `v3`; one verification-result event for each of `v1` and `v5` (the ones that reach a real write); one dry-run event for `v4`. **Exactly-one-record-per-video is explicitly not required** — `v5` legitimately has more audit events than `v1`.
- **Prohibited side effects:** Any gap in the sequence (e.g. a result event with no corresponding attempt event); any fabricated event for a call that did not occur (e.g. an attempt event for `v3`, which never reaches an attempt due to the pre-execution conflict).
- **Verification method:** Automated (query the audit store after the batch; assert event-type counts per video match the description above, and that each video's full lifecycle can be reconstructed in correct chronological order from its events alone).
- **Pass/fail criteria:** PASS iff every described event exists, no extra/fabricated events exist, and each video's sequence is reconstructable in order. FAIL on any missing, duplicated, or fabricated event, or on a sequence that cannot be unambiguously reordered from stored timestamps/sequence numbers.

### AC-AUDIT-02 — `dryRun` flag in the audit record correctly reflects whether it was a dry run

- **Requirement reference:** §25.
- **Preconditions:** Two otherwise-identical batches, one with `dryRun: true`, one live.
- **Fixed test inputs:** Same video/change fixtures, run twice, once per mode.
- **Expected result:** The dry-run batch's audit records all have `dryRun: true` and `result` reflecting a simulated (non-applied) outcome; the live batch's records have `dryRun: false` and a real `result`.
- **Prohibited side effects:** A dry-run's audit record is never indistinguishable from a live write's audit record.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the flag and result are correct and clearly distinguishable in both cases. FAIL on any ambiguity.

### AC-AUDIT-03 — `actorType` is recorded correctly for the interfaces Phase 5 actually exposes

- **Requirement reference:** §25; DEC-OQ-5 (Web UI/API only).
- **Preconditions:** A batch triggered through the Web UI/API (the only interface Phase 5 exposes, per DEC-OQ-5).
- **Fixed test inputs:** A batch triggered by an authenticated NextAuth session.
- **Expected result:** `actorType: "HUMAN"` (per §25's actor-type list) is recorded for every audit record in that batch, with the session's identifiable `actorId` where available.
- **Prohibited side effects:** None.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `actorType`/`actorId` are correct. FAIL if `actorType` is missing, wrong, or hard-coded incorrectly (e.g. `SYSTEM` for a human-triggered batch).

### AC-AUDIT-04 — The audit trail alone is sufficient to reconstruct what actually happened, without consulting the ledger (§0.B item C)

- **Requirement reference:** §25; Decision C (§0.B, "возможность восстановить последовательность выполнения").
- **Preconditions:** The same 5-video batch as AC-AUDIT-01, fully executed.
- **Fixed test inputs:** Same as AC-AUDIT-01.
- **Expected result:** Querying the audit store alone (without reading the ledger table) for `v5` reproduces the correct story: prepared → attempt 1 → transient-failure result → attempt 2 → success result → verification-confirmed, in that order, with no external context needed to make sense of it.
- **Prohibited side effects:** Any audit event whose meaning depends on out-of-band information not itself present in the audit store (e.g. an attempt event with no video id, or a result event that doesn't reference which attempt it resulted from).
- **Verification method:** Automated (reconstruct `v5`'s narrative purely from queried audit rows and assert it matches the expected sequence).
- **Pass/fail criteria:** PASS iff the audit-only reconstruction is complete and correct. FAIL if reconstruction requires the ledger or any other table to make sense.

### AC-AUDIT-05 — A reconciliation-based SUCCESS never attributes unconfirmed causation to this attempt's own API call (added 2026-09-17, fourth review round)

- **Requirement reference:** §0.F's causation note; §24, §25; the project owner's instruction: *"Совпадение remote state с requested value подтверждает достижение требуемого состояния и позволяет завершить логическую операцию без повторной записи. Но оно не всегда доказывает, что именно наша предыдущая API-попытка вызвала это изменение. Audit не должен приписывать неподтверждённое действие нашему API-вызову."*
- **Preconditions:** Two videos reach `SUCCESS` by two different evidentiary routes: `v1` reaches it the ordinary way — its `videos.update` call itself returns HTTP 200, and a normal post-write verification fetch (§24) confirms the requested value. `v5` reaches it via §0.F reconciliation after an outcome-unknown attempt (as in AC-CRASH-01/AC-TIMEOUT-01 sub-case 1/3) — its own attempt's transport response was never observed by this process; only a later reconciliation read confirmed the target state.
- **Fixed test inputs:** `v1`: `videos.update` returns 200; verification fetch confirms `es.title = "New Title"`. `v5`: `videos.update` times out (transport response never observed); a §0.F reconciliation read subsequently confirms `es.title = "New Title"`.
- **Expected result:** Both `v1` and `v5` reach ledger status `SUCCESS`. Their audit/result records are **not** identical in what they claim: `v1`'s attempt-result event records that this attempt's own API call was observed to succeed and the state was independently verified (two independent confirmations: transport response + verification fetch). `v5`'s attempt-result event records only that reconciliation confirmed the target state at a given timestamp — it does **not** state or imply that `v5`'s own `videos.update` call was observed to succeed, since that was never actually observed. A query for "which attempts had their own API response confirmed as successful" correctly includes `v1` and excludes `v5`, even though both videos show ledger status `SUCCESS`.
- **Prohibited side effects:** `v5`'s audit trail containing any field or text asserting "API call succeeded" or "attempt confirmed successful via transport response" when no transport response was ever received for that attempt. Any downstream report treating `v1` and `v5`'s success bases as evidentially equivalent when queried at the attempt level (they are equivalent only at the ledger/outcome level — "the target state was reached" — not at the attempt-causation level).
- **Verification method:** Automated (assert the two videos' attempt-result audit records use distinguishable fields/values for "own-response-confirmed" vs. "reconciliation-confirmed," and that no reconciliation-derived record claims own-response confirmation).
- **Pass/fail criteria:** PASS iff both videos reach `SUCCESS` at the ledger level while their attempt-level audit records correctly and distinguishably reflect the actual evidentiary basis for each. FAIL if `v5`'s audit record claims its own API call was confirmed successful, or if the two evidentiary bases become indistinguishable in the audit trail.

### AC-SCOPE-01 — No unrestricted autonomous-apply tool exists; AI/CLI/MCP write access remains out of scope (DEC-OQ-5)

- **Requirement reference:** §26; §64 ("Do not add AI generation yet"); `docs/TECHNICAL_DEBT.md` RISK-04; DEC-OQ-5.
- **Preconditions:** Phase 5's write pipeline is implemented.
- **Fixed test inputs:** N/A — this is a scope/inventory check, not a functional test with data.
- **Expected result:** No new MCP tool or CLI command capable of triggering a real localization write exists (DEC-OQ-5 resolves this definitively — no conditional carve-out remains). No AI-generation code path exists anywhere in the write pipeline.
- **Prohibited side effects:** A live-write-capable MCP tool or CLI command being introduced without a separate, explicit future assignment (per DEC-OQ-5, this is planned for a later phase, before operations handoff, not Phase 5).
- **Verification method:** Automated (an inventory/grep-style check can assert no new MCP `registerTool` call reaches the write pipeline; primarily enforced by code review against this document, per `docs/DEVELOPMENT_PLAYBOOK.md` §6.14's independent-review step).
- **Pass/fail criteria:** PASS iff the write pipeline is reachable only from the Web UI/API. FAIL if any write-capable MCP tool or CLI command is introduced in Phase 5.

### AC-GUARD-01 — Official test §55: wrong-channel write is blocked, clearly explained, nothing sent

- **Requirement reference:** §27; §55 (official acceptance test); INV-2.
- **Preconditions:** The active OAuth-resolved channel identity does not match the batch's `channelId` (simulating "connect/authenticate with a different channel than expected").
- **Fixed test inputs:** `expectedChannelId: "UC_TARGET"`; resolved active channel `"UC_DIFFERENT"`.
- **Expected result:** `write-context.assertWriteChannel` (reused unchanged, per `docs/ARCHITECTURE.md` §11) rejects the batch before any video's write is attempted, with a `WRITE_CHANNEL_MISMATCH` error naming both the authenticated channel and the expected channel.
- **Prohibited side effects:** Zero `videos.update` calls for any video in the batch; zero backup files created (the guardrail check happens before backup creation, since backup is itself scoped by channel).
- **Verification method:** Automated; **Live validation: required before Gate B** (this is official test §55).
- **Pass/fail criteria:** PASS iff the entire batch is rejected before any write or backup occurs, with both channel ids named in the error. FAIL on any partial write, or on an error message that doesn't name both channels.

### AC-QUOTA-01 — Fresh remote-state fetches are batched, not one call per video

- **Requirement reference:** §28.
- **Preconditions:** A batch covering 75 distinct videos.
- **Fixed test inputs:** 75 video ids across 2 batches of the existing `getVideosMetadataContextBatch`-style chunking (≤50 per call, matching the established Phase 2 pattern).
- **Expected result:** The fresh-fetch step issues at most `ceil(75/50) = 2` `videos.list` calls, not 75.
- **Prohibited side effects:** No per-video individual fetch loop.
- **Verification method:** Automated (assert call count on the mocked batched-fetch function).
- **Pass/fail criteria:** PASS iff exactly 2 batched calls occur. FAIL on 75 (or any number implying a per-video loop).

### AC-QUOTA-02 — Quota-exhausted errors are recognized and not retried

- **Requirement reference:** §28, §29.
- **Preconditions:** Mocked YouTube client returns a quota-exceeded error (matching the real API's `quotaExceeded`/403 reason) for one video's write attempt.
- **Fixed test inputs:** A single video whose write attempt returns the quota-exceeded error shape.
- **Expected result:** The item is marked `FAILED` with a quota-specific, human-understandable error; no retry attempt occurs (ties to AC-RETRY-02); depending on how many other items remain, a quota-exhausted condition should be treated as systemic per §23's list, aborting the rest of the batch (see AC-ISOLATION-02).
- **Prohibited side effects:** No retry loop consuming further quota against an already-exhausted quota.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff zero retries occur and the batch treats it as a systemic-abort condition. FAIL on any retry attempt after a quota-exhausted response.

### AC-RETRY-01 — Transient failures are retried with bounded backoff per the approved default parameters (§0.E)

- **Requirement reference:** §29; DEC-OQ-6; §0.E's proposed parameters (max 4 attempts, base delay 2000ms, ×2 backoff, 30000ms cap, full jitter).
- **Preconditions:** Mocked YouTube client fails with a simulated transient error (network timeout, or HTTP 503) on the first attempt for `v1`, then succeeds on a subsequent attempt.
- **Fixed test inputs:** `v1`'s write attempt: 1st call throws HTTP 503 (a definitively-failed, not outcome-unknown, transient error — distinct from AC-TIMEOUT-01's ambiguous case, so no reconciliation fetch is required before this retry), 2nd call succeeds.
- **Expected result:** `v1` is retried and reaches `SUCCESS`; the delay before the 2nd attempt falls within `[0, 2000ms]` (base delay with full jitter applied to attempt 1's computed delay); attempt count for this run stays within the 4-attempt budget.
- **Prohibited side effects:** No unbounded retry loop; no busy-loop with zero possible delay; no retry beyond the 4-attempt budget for a persistently-failing item (covered further by a boundary check in this same scenario's extended fixture, or a dedicated boundary variant if the team chooses to split it).
- **Verification method:** Automated (mock a fixed number of transient failures then success; assert bounded attempt count and a delay within the documented jittered range between attempts).
- **Pass/fail criteria:** PASS iff `v1` succeeds after a bounded number of retries with a delay inside the documented jittered range. FAIL if it gives up on the first transient failure, retries unboundedly, exceeds the 4-attempt budget, or uses a delay outside the specified range.

### AC-RETRY-02 — Permanent failures are never retried

- **Requirement reference:** §29 ("Do not blindly retry: invalid metadata; invalid language; wrong channel; insufficient permissions; video not found; default language missing; quota exhausted").
- **Preconditions:** Mocked YouTube client returns a permanent error (e.g. `videoNotFound`) for `v1`.
- **Fixed test inputs:** `v1`'s write attempt returns `videoNotFound` on every call.
- **Expected result:** Exactly one attempt is made; `v1` is marked `FAILED` immediately with the `videoNotFound` reason.
- **Prohibited side effects:** No second attempt.
- **Verification method:** Automated (assert exactly 1 call to the mocked write method).
- **Pass/fail criteria:** PASS iff exactly one attempt occurs. FAIL on any retry of a permanent-class error.

### AC-RETRY-03 — The retry budget is exhausted gracefully and the item is marked FAILED, not left retrying forever (§0.E)

- **Requirement reference:** §29; DEC-OQ-6; §0.E (max 4 attempts).
- **Preconditions:** Mocked YouTube client fails with a transient error (HTTP 503) on **every** attempt for `v1`, exceeding the 4-attempt budget.
- **Fixed test inputs:** `v1`'s write attempt: all calls return HTTP 503.
- **Expected result:** After exactly 4 attempts (1 initial + 3 retries per §0.E), `v1` is marked `FAILED` with an error indicating retry-budget exhaustion on a transient-class error, and no 5th attempt is made.
- **Prohibited side effects:** A 5th or later attempt for `v1`; `v1` left indefinitely in `APPLYING` with no terminal state.
- **Verification method:** Automated (assert exactly 4 calls to the mocked write method, then a terminal `FAILED` state).
- **Pass/fail criteria:** PASS iff exactly 4 attempts occur and `v1` reaches `FAILED`. FAIL on a 5th attempt or an unresolved terminal state.

### AC-CONFLICT-01 — Official test §56: fresh-state conflict is detected and blocks the write

- **Requirement reference:** §30; §56 (official acceptance test); INV-5 (revised, §0.B item G).
- **Preconditions:** Matches AC-LEDGER-04's setup, restated at the official-test level: sync video → create draft (Phase 4) → change the same remote metadata outside the app (simulated via the mocked fresh-fetch returning a divergent value) → attempt apply.
- **Fixed test inputs:** Approval baseline `es.title = "Cuban Jazz"`; fresh fetch at apply time returns `es.title = "Changed In Studio"`.
- **Expected result:** `CONFLICT`, exactly as in AC-LEDGER-04, verified end-to-end through the full apply pipeline (not just the ledger-entity unit test).
- **Prohibited side effects:** The remote value is never overwritten while a conflict exists.
- **Verification method:** Automated; **Live validation: required before Gate B** (this is official test §56).
- **Pass/fail criteria:** Same as AC-LEDGER-04, at the integration level.

### AC-CONFLICT-02 — A fresh fetch is not an atomic guarantee; post-write verification is what actually catches a same-instant external change (§0.B item G)

- **Requirement reference:** §21, §24, §30; INV-5 (revised); Decision G (§0.B).
- **Preconditions:** `v1`'s fresh fetch at apply time shows no conflict (baseline matches). Immediately after the fresh fetch but before/concurrently with the `videos.update` call, an external actor changes the same field on YouTube (simulated: the mocked write call "succeeds" against the payload built from the now-stale-by-microseconds fresh fetch, but the mocked post-write verification fetch reveals a value that matches neither the pre-write baseline nor the requested value — i.e. a third party's change won the race).
- **Fixed test inputs:** Fresh-fetch-at-apply-time: `es.title = "Cuban Jazz"` (matches baseline, no pre-write conflict detected). Requested: `es.title = "Nuevo Titulo"`. Mocked `videos.update` returns 200. Post-write verification fetch returns `es.title = "Someone Else's Edit"` (neither the baseline nor the requested value).
- **Expected result:** The system does **not** claim to have prevented this race (per revised INV-5, it cannot). It does, however, **detect** it via mandatory post-write verification (§24): `v1` is not marked `SUCCESS` (the confirmed remote state doesn't match the requested state), and is instead marked `FAILED`/`VERIFICATION_FAILED` with the mismatch recorded, exactly as AC-VERIFY-01 already requires for any post-write mismatch, whatever its cause.
- **Prohibited side effects:** Any test or documentation claim that the fresh-fetch-before-write step by itself guarantees no concurrent external write can occur. `v1` being marked `SUCCESS` despite the post-write mismatch.
- **Verification method:** Automated (fixture where the pre-write conflict check passes but the post-write verification fetch deliberately disagrees with the requested value).
- **Pass/fail criteria:** PASS iff the race is not claimed to be prevented pre-write but is caught by mandatory post-write verification, with `v1` correctly left un-`SUCCESS`. FAIL if any test or code path treats the pre-write fresh-fetch as sufficient on its own to guarantee no conflicting write occurred.

### AC-CONCURRENCY-01 — Batch execution respects a bounded, configurable concurrency limit, default 1 (DEC-OQ-4/§0.D)

- **Requirement reference:** §64 ("controlled concurrency"); DEC-OQ-4 (default 1, configurable); §0.D's proposed 1–5 range.
- **Preconditions:** A batch of 10 videos.
- **Fixed test inputs (default-config run):** 10 videos, concurrency left at its default. The mocked write call is instrumented to report how many concurrent in-flight calls exist at any instant.
- **Fixed test inputs (configured run):** Same 10 videos, concurrency explicitly configured to `K = 3` (within the proposed 1–5 range from §0.D), same instrumentation.
- **Expected result (default run):** At no point does the instrumented in-flight count exceed 1 — execution is strictly sequential by default, as DEC-OQ-4 requires.
  **Expected result (configured run):** At no point does the instrumented in-flight count exceed `K = 3`.
- **Prohibited side effects:** The default run showing any concurrency greater than 1. The configured run either exceeding `K` or degrading to strictly-serial execution in a way that would also fail a differently-configured `K` (i.e. the mechanism must be provably bounded-parallel, not accidentally hard-coded to 1 regardless of configuration).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the default run never exceeds concurrency 1 and the configured run never exceeds the configured `K`. FAIL on any overshoot in either run, or on the configured run failing to actually parallelize.

### AC-CONCURRENCY-02 — A batch cannot be applied twice concurrently

- **Requirement reference:** DEC-OQ-4 ("Одновременное выполнение одного и того же Batch должно быть запрещено"); §22's idempotency requirement.
- **Preconditions:** A batch is already `APPLYING`. A second "apply" request for the same batch id arrives while the first is still in progress.
- **Fixed test inputs:** Same batch id submitted twice, second submission while the first is mid-flight (simulated via a controllable mock that delays completion).
- **Expected result:** The second request is rejected (or safely no-ops) rather than starting a second concurrent execution of the same batch.
- **Prohibited side effects:** Duplicate write attempts for the same video from two concurrently-running executions of the same batch.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff no video is written twice as a result of the double-submission. FAIL on any duplicate write.

### AC-CONCURRENCY-03 — Two distinct batches targeting the same video are not applied concurrently (extends DEC-OQ-4's intent to overlapping batches)

- **Requirement reference:** DEC-OQ-4; INV-1, INV-5 (revised) — overlapping concurrent batches on the same video would defeat the conflict-detection/backup ordering this document otherwise guarantees per-video.
- **Preconditions:** Two distinct batches, `batchA` and `batchB`, both include a change targeting `v1` (from two different, non-overlapping change ids — e.g. approved in sequence, each independently valid). `batchA` begins executing.
- **Fixed test inputs:** `batchA` starts applying `v1`; while `batchA`'s `v1` write is in flight, `batchB` (also targeting `v1`) is submitted.
- **Expected result:** `batchB`'s attempt on `v1` either waits until `batchA`'s `v1` write (backup → merge → write → verify) fully completes, or is rejected/deferred with a clear reason — it must not race `batchA`'s write for the same video.
- **Prohibited side effects:** Two simultaneous `videos.update` calls for `v1` from two different batches.
- **Verification method:** Automated (controllable mock delaying `batchA`'s `v1` completion; assert `batchB`'s `v1` write does not fire concurrently).
- **Pass/fail criteria:** PASS iff `v1` is never written concurrently by two batches. FAIL on any overlapping write for the same video from different batches.

### AC-RESUME-01 — Official test §54: an interrupted 100-video batch resumes without duplicating completed work, and every remaining video's per-state handling is explicit (revised 2026-09-17, fifth review round)

- **Requirement reference:** §22; §54 (official acceptance test); INV-7, INV-12; DEC-OQ-1 (per-video ledger granularity); §0.C, §0.F (durable attempt intent and reconciliation); the project owner's fifth-review-round instruction: *"PENDING-видео могут продолжить выполнение. APPLYING/INTENDED/UNKNOWN требуют восстановления состояния и reconciliation. UNKNOWN не должен автоматически повторно отправляться. Ни одно видео не должно быть молча пропущено."*
- **Preconditions:** A batch of 100 selected videos begins executing sequentially; execution is interrupted (simulated process termination) after exactly 43 videos have reached confirmed `SUCCESS`. At the moment of interruption, the remaining 57 videos are deliberately distributed across every other state this document defines, so the resume path is exercised for each one distinctly:
  - **54 videos (`v44`..`v97`) — `PENDING`:** never attempted before the interruption.
  - **1 video (`v98`) — `APPLYING`, attempt record durably `INTENDED` with no result, and the write actually reached YouTube:** the `videos.update` call was sent and applied, but the process terminated before the attempt's result phase or the ledger row's `SUCCESS` transition was durably recorded (same shape as AC-CRASH-01).
  - **1 video (`v99`) — `APPLYING`, attempt record durably `INTENDED` with no result, and the write's fate is genuinely undeterminable:** the process terminated with the same durable state as `v98`, but on restart §0.F's two-read reconciliation procedure produces two consistent baseline reads (same shape as AC-TIMEOUT-01 sub-case 2).
  - **1 video (`v100`) — already `FAILED` for a definitive, non-systemic, non-retryable reason (e.g. `invalid metadata`) before the interruption occurred:** its ledger row was already terminal at interruption time, unrelated to the interruption itself.
- **Fixed test inputs:** 100 distinct video ids, each with one selected change; a controllable execution harness that halts after the 43rd confirmed success and durably records the per-video states listed above before terminating; on restart, the mocked reconciliation reads for `v98` and `v99` are configured exactly as described.
- **Expected result:** On restart (re-invoking the same batch id):
  - The 43 already-`SUCCESS` videos are **not** re-attempted — no new `videos.update` call for them, no duplicate audit/ledger record.
  - The 54 `PENDING` videos (`v44`..`v97`) proceed directly through the normal write pipeline from `PENDING`, exactly as a first-time attempt would (no restoration/reconciliation step applies to a video that was never attempted).
  - `v98` and `v99`, both recovered from `INTENDED`-with-no-result, are **not** blindly retried. Each is first restored to the explicit `UNKNOWN` status (per AC-ATTEMPT-04) and routed through §0.F reconciliation before any further action: `v98`'s reconciliation read confirms the requested value, so it resolves to `SUCCESS` via reconciliation (per AC-CRASH-01) with **zero** additional `videos.update` calls; `v99`'s reconciliation reads are both consistently negative, so it remains in the explicit `UNKNOWN` status — **no automatic retry is issued for it during this resume**, and it requires either a later independent reconciliation pass or an explicit operator decision (§0.F Step 3) to move further.
  - `v100` remains `FAILED` and is **not** automatically retried on resume — a definitive, non-retryable `FAILED` item requires a fresh, explicit batch selection (a new `Batch`, per DEC-OQ-3), not an automatic resume-time retry of the same batch.
  - The final resume report/summary enumerates all 100 videos with no omissions: 44 `SUCCESS` (the original 43 plus `v98`), 54 `SUCCESS` (the resumed `PENDING` videos, assuming their own writes succeed per their own fixtures — any of these that fail or conflict on resume must appear under their own resulting status instead, per AC-ISOLATION-01/AC-LEDGER-03/04), 1 `FAILED` (`v100`), and 1 `UNKNOWN` (`v99`, explicitly flagged as pending manual operator review, per AC-ISOLATION-03). No video is absent from this report, and no video's status is silently left implicit.
- **Prohibited side effects:** Any `videos.update` call for one of the original 43 already-successful videos, or a duplicate audit/ledger record for them; any `videos.update` call for `v98` or `v99` issued without first going through §0.F reconciliation; any automatic retry of `v99` (or of `v100`) during this resume; any video — of any of the five state classes above — missing from the final resume report, or present without a status that is either terminal or explicitly flagged as pending a manual decision.
- **Verification method:** Automated (deterministic interruption harness — no timing-dependent flakiness — with explicit per-video state seeding for `v98`/`v99`/`v100` as described); **Live validation: required before Gate B** (this is official test §54; the live run needs only exercise the `PENDING`/`SUCCESS` happy path plus one interruption, not every state class — the state-class enumeration above is specifically an automated/mocked-track requirement).
- **Pass/fail criteria:** PASS iff exactly 0 of the 43 completed videos are re-attempted; the 54 `PENDING` videos are processed normally; `v98` resolves to `SUCCESS` via reconciliation with zero additional write calls; `v99` remains `UNKNOWN` with zero automatic retries; `v100` remains `FAILED` and untouched; and the final report lists all 100 videos with a correct, non-omitted status for each. FAIL on any re-application of the 43, any blind retry of `v98`/`v99`/`v100`, or any video silently missing from the resume report.

### AC-E2E-01 — Official test §53: full happy-path workflow

- **Requirement reference:** §53 (official acceptance test, all 23 sub-steps).
- **Preconditions:** A fully synced test channel with at least one video having a resolvable default language and existing English metadata.
- **Fixed test inputs:** Live validation track: a real, dedicated test channel (never a production/customer channel) with one or more videos prepared for a Spanish localization addition, per §53's steps 6-9. Automated track: the equivalent fixture-driven walk through every step using mocked adapters (steps 1-2, "launch"/"authenticate", are necessarily live-only or boot-smoke-test-only; steps 3-23 all have a mocked equivalent).
- **Expected result:** Every one of §53's 23 sub-steps is observably true, in order, ending with: unrelated existing localizations intact (step 19), verified remote state (step 20), a success/failure summary shown (step 21), a complete audit trail (step 22), and no duplicate/unnecessary updates on re-running the same batch (step 23, which is AC-RESUME-01's no-op-on-already-successful-item guarantee applied to a non-interrupted, fully-successful batch).
- **Prohibited side effects:** Any step producing a result inconsistent with the safety invariants in §3 of this document.
- **Verification method:** **Both** — Automated (steps 3-23, mocked); **Live validation: required before Gate B and explicitly required by §53's own text** ("only when the following workflow works against a real test/production channel").
- **Pass/fail criteria:** PASS iff both tracks independently confirm every sub-step. Neither track alone is sufficient to declare AC-E2E-01 passed, per §53's own wording and this document's §4 methodology.

---

## 6. Non-goals restated (not to be reopened during Phase 5 without a separate, explicit assignment)

- AI-generated localization content of any kind.
- Automatic default-language batch-setting workflow (§14) — DEC-OQ-2 confirms only detection-and-block is in scope; setting a value automatically is never in scope for Phase 5.
- CLI/MCP tools capable of triggering a real write — DEC-OQ-5 confirms these are deferred to a separate phase before operations handoff, not part of Phase 5 under any condition.
- Any change to the existing Phase 0-4.5 acceptance criteria, gates, or documented limitations — this document adds Phase 5's contract, it does not revise anything already accepted.
- Publishing, upload, thumbnails, analytics, multi-user/RBAC, billing, cloud deployment (§58, unchanged).
- Any claim of atomic/CAS-level protection against concurrent external YouTube-side edits (INV-5, revised) — Phase 5's protection is detect-and-report via fresh-fetch-plus-verification, not prevention-by-construction.

---

## 7. Consistency check across scenarios (first performed 2026-09-17; re-verified same day after the second review round covering batch/approval integrity, reconciliation, and durable attempt intent)

- **Ledger granularity vs. attempts vs. durable intent:** AC-LEDGER-01..04 consistently describe one row per video; AC-ATTEMPT-01/02 describe a separate, unbounded-count attempt record set per ledger row; AC-ATTEMPT-03/04 add the two-phase (`INTENDED` → result) durable write within each attempt record without changing the row/attempt cardinality already established. AC-RESUME-01 and AC-AUDIT-01 both build on this same model without redefining it. No scenario asserts a per-change ledger row.
- **Retry vs. reconciliation vs. durable-intent recovery:** AC-RETRY-01/03 govern *definitively-failed* transient errors (e.g. HTTP 503), where the outcome is known and a normal backoff-then-retry applies directly, counted against the same 4-attempt budget. AC-TIMEOUT-01 governs *outcome-unknown* errors (timeout) via the §0.F bounded two-read procedure; AC-ATTEMPT-04 governs the crash-recovery path (an `INTENDED` record with no result) and explicitly converges on the *same* §0.F procedure rather than a separate rule, so a live timeout and a post-crash recovery cannot diverge in behavior. AC-CRASH-01 is now stated as the specific case of AC-ATTEMPT-04 where §0.F's Step 1 alone resolves to `SUCCESS`. No scenario allows a retry to be issued on the strength of a single reconciliation read (this was the exact defect the project owner flagged in the second review round, and AC-TIMEOUT-01's sub-case 2 tests specifically that a retry is *not* issued between Step 1 and Step 2).
- **Audit "no lost events" vs. former "exactly one record":** The original draft's AC-AUDIT-01 (exactly one record per item) has been fully replaced by the revised AC-AUDIT-01 plus AC-AUDIT-04; no remaining scenario in this document asserts a fixed one-record-per-video count, avoiding the contradiction the project owner flagged.
- **INV-5 (revised) vs. AC-CONFLICT-01/AC-GUARD-01:** AC-CONFLICT-01 and AC-GUARD-01 both still require blocking a *detected* conflict/mismatch — that is unaffected by the INV-5 revision. What changed is only the claim about the *fresh-fetch step's own guarantee*; AC-CONFLICT-02 makes explicit that detection ultimately relies on post-write verification (§24), not on the fresh fetch being atomic. No scenario claims the fresh fetch alone prevents a race.
- **Batch-as-subset (DEC-OQ-3) vs. frozen-membership-vs-approval-validity (second review round):** AC-BATCH-01/02 establish that *which* video/change pairs belong to a batch is frozen at creation. AC-BATCH-03 adds that this freeze governs membership only, not the standing validity of each member's approval at send time — these two claims do not conflict because they answer different questions ("is this pair still in the batch?" vs. "is this pair's approval still good enough to publish right now?"). INV-4 (sharpened) states the reconciling principle explicitly so the two scenarios cannot be read as contradictory.
- **Batch-as-subset (DEC-OQ-3) vs. all other scenarios' "batch" language:** Scenarios written before the first revision (e.g. AC-BACKUP-01, AC-MERGE-01/04/05) have been reworded from "Change Set" to "batch"/"selected changes" wherever they described the write pipeline's input, so they are consistent with AC-BATCH-01/02/03's definition of `Batch` as a distinct, subset-selecting entity. No scenario still assumes a batch = the entire Change Set.
- **Concurrency default vs. configurability:** AC-CONCURRENCY-01's two sub-runs (default and configured) are consistent with DEC-OQ-4: default proven to be 1, configurability proven separately by a `K > 1` run, matching "default 1, configurable" rather than "hard-coded 1."
- **Dry-run artifacts (Decision D) vs. INV-6:** AC-DRYRUN-03 permits local report/diagnostic artifacts while INV-6 still requires zero *remote* mutations; these are consistent because INV-6 was always scoped to remote mutations, not local record-keeping, and AC-DRYRUN-03 makes the local-artifact allowance explicit without touching INV-6's remote-mutation guarantee.
- **Backup failure classification (Decision E) vs. §23's systemic list:** §23 already lists "backup system unavailable" as a systemic condition; AC-BACKUP-04 formalizes exactly that clause, while AC-BACKUP-02 formalizes the item-level case that §19 implies but §23 does not itself enumerate as systemic (a single video's backup failing is not on §23's systemic list). No contradiction between the two scenarios or with §19/§23's text.
- **`UNKNOWN` as a genuinely terminal-for-now state vs. batch progress:** AC-TIMEOUT-01 sub-cases 2 and 4, and AC-ATTEMPT-04, all leave a video in `UNKNOWN` without further automatic action, while AC-ISOLATION-01/02 require the rest of the batch to keep progressing past a single item's non-systemic problem. These are consistent: §0.F Step 3 explicitly scopes the "no further automatic attempts" rule to *that video only*, treating it as neither a batch-wide systemic abort nor a normal `FAILED` (which would be eligible for a later, fresh batch retry without the same evidentiary caution) — it is surfaced via AC-ISOLATION-03's error report for manual resolution instead.
- **AC-BATCH-02 vs. AC-BATCH-03 (fixed, third review round):** the first draft of AC-BATCH-02 implied a late-invalidated member (`v2`) still gets written using its frozen payload, merely "flagged for later re-review" — this directly contradicted AC-BATCH-03's requirement that an invalidated/revoked/edited approval blocks the write outright, before send. AC-BATCH-02 is rewritten to claim only membership-freezing (the candidate set `{v1, v2, v3}` cannot grow or shrink after creation); it now explicitly defers to AC-BATCH-03 for whether any given frozen candidate is actually written, so the two scenarios answer different questions and no longer conflict. INV-4 (sharpened) states this division of concerns explicitly.
- **Two consistent negative reconciliation reads vs. retry authorization (fixed, third review round):** the first draft of §0.F/AC-TIMEOUT-01 treated two consistent baseline reads as sufficient to authorize a retry. This has been removed: §0.F Step 2/3 and AC-TIMEOUT-01 sub-case 2 now both state that two consistent negative reads are insufficient proof and route to `UNKNOWN`, identically to the inconclusive-evidence sub-case (4) — the two sub-cases reach the same terminal state for different evidentiary reasons, which is intentional and not a duplication (they remain separately tested because a future change to the evidence threshold might treat them differently, and each documents a distinct real-world cause). §0.F Step 4 and AC-TIMEOUT-02 then close the loop: whatever later resolves an `UNKNOWN` attempt into a new send always re-runs approval validation, fresh remote fetch, merge, and conflict detection — it is never a bare retry of the stored payload, addressing the concern that a permissive retry path could bypass those safeguards.
- **Duplicate Verification method/Pass-fail criteria in AC-TIMEOUT-01 (fixed, third review round):** the first draft accidentally left two trailing `Verification method`/`Pass/fail criteria` pairs at the end of AC-TIMEOUT-01 (a leftover from an earlier edit). The scenario now has exactly one of each, covering all four sub-cases.
- **AC-ATTEMPT-01's fixture vs. the UNKNOWN/no-auto-retry policy (fixed, fourth review round):** the first draft of AC-ATTEMPT-01 used `timeout → HTTP 503 → success` as its retry-sequence fixture. A timeout is an *outcome-unknown* condition and, per §0.F/AC-TIMEOUT-01, must never be followed by an automatic retry on the strength of reconciliation reads alone — using it as the first call in an "ordinary retry succeeds" fixture implicitly modeled a timeout being retried like a definitively-known transient failure, which contradicts the policy this document otherwise enforces. AC-ATTEMPT-01 (and AC-ATTEMPT-02, which had the same latent ambiguity) now use only definitively-known transient errors (`HTTP 503 → HTTP 503 → success`), leaving all outcome-unknown/timeout handling exclusively to AC-TIMEOUT-01/AC-TIMEOUT-02/AC-ATTEMPT-04, so no scenario in this document any longer models a timeout being retried directly.
- **Durable `INTENDED` phase vs. asserting the call was sent (fixed, fourth review round):** the first draft's §0.C and AC-ATTEMPT-04 described the crash-recovery case as "a process crash between sending the request and recording its outcome," which implicitly asserted the request had definitely been sent. This has been corrected: §0.C now states explicitly that `INTENDED` records only a durably-saved *intent*, not proof of transmission, and AC-ATTEMPT-04 now covers two sub-cases — crash before the network call is ever issued, and crash after it is issued but before its result is recorded — both of which converge on the identical `UNKNOWN`/§0.F handling without the recovery logic ever asserting whether the call was actually sent.
- **Reconciliation-confirmed `SUCCESS` vs. audit causation claims (fixed, fourth review round):** the first draft's §0.F described a matching reconciliation read as proof the write "succeeded," which could be read as attributing the change to this specific attempt's own API call. This is corrected: §0.F's new causation note and AC-AUDIT-05 make explicit that a matching read only confirms the *target state* was reached (sufficient to close the logical operation as `SUCCESS` at the ledger level) — it does not license an audit claim that this attempt's own `videos.update` call is confirmed to have caused it, unless that attempt's own transport response was independently observed. AC-CRASH-01's expected result and AC-VERIFY-01/02 (which describe an *ordinary*, non-reconciled success where the attempt's own 200 response plus a verification fetch both exist) are unaffected and remain the case where full causation attribution is warranted; AC-AUDIT-05 draws this line explicitly so the two cases cannot be conflated.

No unresolved contradiction remains between the fourth-review-round changes (AC-ATTEMPT-01/02's fixture correction, §0.C/AC-ATTEMPT-04's intent-vs-transmission clarification, and §0.F/AC-AUDIT-05's causation-vs-goal-state distinction) and the rest of the document. AC-VERIFY-01/02 were re-checked against AC-AUDIT-05 and found consistent: they describe the ordinary case where an attempt's own response is observed, which is exactly the case AC-AUDIT-05 treats as warranting full causation attribution, so no scenario in this document over- or under-claims what a given piece of evidence establishes.

- **AC-TIMEOUT-02 vs. AC-BATCH-03 (fixed, fifth review round):** the third-review-round draft of AC-TIMEOUT-02 had its §0.F Step 4 pipeline re-run "pick up" an edited-after-`UNKNOWN` change's new value as part of the approval re-check, then rely on conflict detection alone to catch the resulting mismatch against a since-changed remote state. This implicitly modeled an edited approval being automatically incorporated into a resumed/re-run attempt, which contradicts AC-BATCH-03's/INV-4's requirement that an approval edited (or revoked, or invalidated) after its batch was created blocks the write outright, before any payload is built from it — neither the stale nor the new value may be published automatically. AC-TIMEOUT-02 is now aligned with AC-BATCH-03: the approval/validation re-check runs first in the re-run pipeline and blocks the write immediately (`FAILED`, not `CONFLICT`) whenever the change was edited after its originating batch was created, exactly as AC-BATCH-03 sub-case (c) already requires; the fresh-fetch/conflict-detection steps are consequently never reached in this fixture. Both scenarios now agree that no combination of "batch re-run" and "edited approval" can result in an automatic write of either the old or the new value.
- **AC-ATTEMPT-01's 3-attempt fixture vs. AC-AUDIT-01's attempt count (fixed, fifth review round):** the fourth-review-round revision of AC-ATTEMPT-01 changed its retry fixture from `timeout → 503 → success` (2 failures... actually 1 timeout + 1 failure, ambiguous) to `503 → 503 → success` (3 attempts total), but left AC-AUDIT-01's `v5` still citing "AC-ATTEMPT-01" while separately stating "2 attempts" — an unresolved mismatch. AC-AUDIT-01 now defines its own explicit 2-attempt fixture for `v5` (mirroring AC-ATTEMPT-02's `v1`: one HTTP 503 then success) instead of citing AC-ATTEMPT-01, so the two scenarios' attempt counts no longer need to track each other and cannot silently drift out of sync again.
- **AC-RESUME-01's per-state resume handling (sharpened, fifth review round):** the third/fourth-review-round draft of AC-RESUME-01 described the 57 non-`SUCCESS` videos only in aggregate ("retrying any that were `FAILED` or still `PENDING`/`APPLYING`"), without distinguishing `PENDING` (safe to continue directly) from `APPLYING`/`INTENDED`-with-no-result/`UNKNOWN` (which must be restored and routed through §0.F reconciliation, never blindly retried) or stating that an already-`UNKNOWN`/already-terminal-`FAILED` video must still appear in the final report rather than being silently absorbed into "the remaining 57." AC-RESUME-01 now enumerates five distinct state classes at interruption (`SUCCESS`, `PENDING`, `APPLYING`/`INTENDED` resolving to `SUCCESS` via reconciliation, `APPLYING`/`INTENDED` resolving to `UNKNOWN`, and pre-existing terminal `FAILED`) and requires the final resume report to list all 100 videos with a status for each — consistent with AC-ATTEMPT-04/§0.F's existing rule that `UNKNOWN` is never auto-retried and with AC-ISOLATION-03's existing requirement that no non-`SUCCESS` item go unreported.

---

## 8. Status

**APPROVED (2026-09-17, fifth review round) as the acceptance contract for the start of Phase 5 preparation and implementation.** It incorporates: the project owner's 2026-09-17 answers to OQ-1..OQ-6 and seven additionally required scenarios from the first review round (A-G); the second review round's batch/approval-integrity fix (AC-BATCH-03), bounded reconciliation procedure (§0.F), and durable two-phase attempt-intent model (§0.C, AC-ATTEMPT-03/04); the third review round's fixes — the AC-BATCH-02/AC-BATCH-03 contradiction removed, §0.F/AC-TIMEOUT-01 corrected so that no combination of reconciliation reads ever authorizes an automatic retry, and the duplicated Verification method/Pass-fail text removed from AC-TIMEOUT-01; the fourth review round's fixes — AC-ATTEMPT-01/02's fixture corrected to use two definitively-known transient errors instead of a timeout (avoiding any implication that a timeout may be retried directly), `INTENDED`'s semantics clarified as durable intent only, never proof of transmission (§0.C, AC-ATTEMPT-04's two sub-cases), and reconciliation's causation limits made explicit so audit records never attribute an unconfirmed cause to a specific attempt's own API call (§0.F's causation note, AC-AUDIT-05, AC-CRASH-01 updated accordingly); and this fifth review round's three project-owner-mandated editorial fixes — the AC-TIMEOUT-02/AC-BATCH-03 contradiction removed (an edited-after-batch-creation approval now blocks the write in AC-TIMEOUT-02's re-run pipeline exactly as AC-BATCH-03 requires, never an automatic pickup of the new value), AC-AUDIT-01's `v5` fixture decoupled from AC-ATTEMPT-01's (now its own explicit 2-attempt fixture, avoiding drift against AC-ATTEMPT-01's 3-attempt fixture), and AC-RESUME-01 sharpened to enumerate every per-video state at interruption (`PENDING` continues directly; `APPLYING`/`INTENDED`/`UNKNOWN` are restored and routed through §0.F reconciliation, never blindly retried; `UNKNOWN` is never auto-resent; no video is silently omitted from the resume report).

**Confirmed alongside this approval:** the concurrency range proposed in §0.D (configurable 1–5, default 1) and the retry parameters proposed in §0.E (§0.E's table, including the non-negotiable prohibition on any automatic retry following an outcome-unknown/`UNKNOWN` condition, per §0.F) are both approved as-is, with no changes requested to either.

**Scope of this approval:** this is authorization to begin Phase 5 **preparation and implementation** work — writing the acceptance tests derived from this document, then the implementation that satisfies them — per `AGENTS.md` §C/§L. It is explicitly **not** authorization to execute any real, non-dry-run YouTube write; that remains gated separately, per `AGENTS.md` §K and this document's own automated-vs-live-validation methodology (§4), and requires its own explicit authorization when the time comes. No application code was changed in the course of producing any revision round (including this one), and no scope beyond Phase 5's existing boundary (§1) was added.
