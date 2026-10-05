# PHASE_6_ACCEPTANCE.md

**Status: APPROVED for the scope below (2026-09-19, project owner's "Overnight Autonomous Development — Phase 6" assignment).** This is a first-round acceptance contract for the AI Localization vertical slice explicitly assigned in that message. Unlike `docs/acceptance/PHASE_5_ACCEPTANCE.md`, this document is not the product of multiple adversarial review rounds; it is written once, before implementation of the scenarios it defines, per `AGENTS.md` §L, and is scoped deliberately narrowly (one vertical feature, mock provider only) rather than the full future `docs/PROJECT_SPEC.md` §32 module.

This document is derived strictly from:

- `docs/PROJECT_SPEC.md` §32 ("Future AI Localization Module" — the `LocalizationProvider` extension point, the `Source metadata → brief → AI generation → validation → Draft → Diff → Human approval → Apply` workflow, "AI-generated copy should not be treated as literal translation only", "keep channel-specific editorial instructions out of application source code");
- `docs/PROJECT_SPEC.md` §8 ("blank cell never implies deletion"), §21 (preserve unrelated metadata), §27/§30 (channel identity, conflict detection) — all inherited unchanged, not reopened;
- `AGENTS.md` §B (dev/ops separation — no channel-specific editorial content in this repository), §D (one approval/batch system, no parallel implementations), §G (AI-generated metadata remains a draft until approved), §L (specification-driven, independent testing);
- the existing, unmodified `Change`/`ChangeSet` contracts (`src/lib/changesets/contracts.ts`) and Batch contracts (`src/lib/batches/contracts.ts`), which this feature is required to reuse rather than duplicate;
- the project owner's 2026-09-19 Phase 6 assignment message itself, which is the explicit authorization for this phase and states the target workflow and the mock-provider-only constraint verbatim.

**No new product requirement is introduced here beyond what §32 and the project owner's assignment message state.** This phase does not modify, weaken, or reopen any Phase 4/5 acceptance criterion — every scenario below either exercises the AI Localization module in isolation or proves that an AI-sourced `Change`/`ChangeSet` is indistinguishable from an XLSX-imported one once it enters the existing pipeline.

---

## 1. Scope boundary

**In scope:** generating localization proposals for existing, already-synchronized videos via a replaceable `LocalizationProvider`; validating that output with the same field-level rules as XLSX import; a human inspect/edit step; creating a `ChangeSet` (source `ai_localization`) from the edited proposals; a deterministic mock provider; provider-failure isolation; structural prevention of any real AI-API cost.

**Out of scope (not implemented, not claimed as implemented):**

- Any real, paid AI provider (OpenAI/Anthropic/DeepL/Google Translation/custom model). Only `"mock"` is resolvable (AC-PROVIDER-01). Selecting a real provider is an explicit, separate, future project-owner decision (`docs/PROJECT_SPEC.md` §32, this phase's own assignment §4/§8).
- Channel-specific localization briefs/editorial config (`channels/<channel-id>/localization/*.md` in §32's future example) — deliberately not built; would put channel-specific editorial content in this repository, which `AGENTS.md` §B prohibits regardless of phase.
- Any change to how a `Change`/`ChangeSet` is approved, batched, dry-run-previewed, or (still disabled) written for real — Phase 4/5's pipeline is reused entirely unmodified.
- CLI/MCP interfaces for AI Localization (mirrors RISK-04's existing deferral for Change Sets/Batches generally — out of scope until that risk is addressed).
- Real YouTube writes, live validation, Google OAuth, and Phase 6 completion sign-off beyond what this document's automated scenarios actually verify (`AGENTS.md` §K, this phase's assignment §8).

## 2. Traceability

| Requirement | Scenario(s) |
|---|---|
| §32 `LocalizationProvider` extension point | AC-PROVIDER-01, AC-COST-01 |
| §32 workflow: generate → validate | AC-GEN-01..09 |
| §32 "Channel localization brief" step / `AGENTS.md` §B | AC-CONTEXT-01, AC-CONTEXT-02 |
| Channel Editorial Profiles (persistent, per-channel) | AC-PROFILE-01..10 |
| §32 workflow: draft → diff → human approval | AC-APPROVAL-01, AC-APPROVAL-02, AC-CS-01..06 |
| §8 blank cell ≠ deletion | AC-CS-02 |
| §21 preserve unrelated metadata | AC-PRESERVE-01 |
| §27/§30 identity + conflict detection (reused, not reimplemented) | AC-CONFLICT-REUSE-01 |
| Reuse of Batch/dry-run pipeline (`AGENTS.md` §D) | AC-BATCH-REUSE-01, AC-PRESERVE-01 |
| No real write / no external cost (`AGENTS.md` §K, this phase's §8) | AC-SAFETY-01, AC-COST-01 |

## 3. Safety invariants restated (must hold for every scenario below)

- **INV-6.1** A generated or reviewed proposal is never automatically approved. Every persisted `Change`'s `approvalStatus` starts `pending`, with zero exceptions, regardless of provider confidence or validation outcome.
- **INV-6.2** A single video/language's provider failure or invalid output never blocks or corrupts sibling targets in the same generation request.
- **INV-6.3** Omitting a field from a reviewed proposal means "no proposed change for that field," never "delete the existing value" (inherits §8/INV-3 from Phase 4).
- **INV-6.4** No code path in this module can call a real, network-reaching AI provider or a real YouTube endpoint. Zero external cost is a structural property (no such implementation exists in this repository), not a runtime toggle.
- **INV-6.5** An AI-sourced `Change`/`ChangeSet` is processed by exactly the same approval, conflict-detection, and Batch/dry-run code paths as an XLSX-imported one — no parallel system exists for it.

---

## 4. Acceptance scenarios

### AC-GEN-01 — Generating a proposal for a video with no existing localization in the target language classifies as `add`

- **Requirement reference:** §32 (generate → validate).
- **Preconditions:** Video `v1`, synced, `title = "Cats of the world"`, `description = "A tour."`, no `es` localization.
- **Fixed test inputs:** `videoIds: ["v1"]`, `targetLanguages: ["es"]`, mock provider's default deterministic transform (`[ES] Cats of the world` / `[ES] A tour.`).
- **Expected result:** One `GeneratedTargetResult` for `(v1, es)`, `providerError: null`, two fields (`title`, `description`), both `changeType: "add"`, `validationStatus: "valid"`, `baselineValue: ""`.
- **Prohibited side effects:** No persistence of any kind (this is the generation/preview step).
- **Verification method:** Automated (mocked provider, fake channel store).
- **Pass/fail criteria:** PASS iff both fields are `add`/`valid` with the exact expected proposed text. FAIL on any other classification or a persisted record.

### AC-GEN-02 — Generating a proposal for a video with an existing, different localization in the target language classifies as `modify`

- **Requirement reference:** §32.
- **Preconditions:** Video `v2`, synced, `es` localization already exists: `{ title: "Gatos viejos", description: "Vieja desc." }`.
- **Fixed test inputs:** `videoIds: ["v2"]`, `targetLanguages: ["es"]`, provider returns `title: "Gatos del mundo"`, `description: "Una gira."` (a fixed, hand-specified provider output, not the default mock transform).
- **Expected result:** `changeType: "modify"` for both fields, `baselineValue` equal to the pre-existing `es` values above.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff both fields are `modify` with `baselineValue` matching the pre-existing localization exactly. FAIL if classified `add` or `unchanged`, or if baseline is wrong.

### AC-GEN-03 — A proposal identical to the current remote value classifies as `unchanged`

- **Requirement reference:** §32; mirrors XLSX import's own `unchanged` handling (`classifyFieldChange`).
- **Preconditions:** Video `v3`, `es.title = "Ya traducido"`.
- **Fixed test inputs:** provider returns `title: "Ya traducido"` (byte-identical), `description` differs.
- **Expected result:** `title` field `changeType: "unchanged"`, `validationStatus: "valid"`; `description` field classified normally (`add`/`modify` per its own baseline).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the identical field is `unchanged` and the differing field is not. FAIL if an identical value is classified `modify`.

### AC-GEN-04 — An invalid target language code is rejected before the provider is ever called, without blocking other targets

- **Requirement reference:** §32; reuses `isValidLanguageCode` (`src/lib/changesets/diff.ts`), the same rule XLSX import already enforces.
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** `videoIds: ["v1"]`, `targetLanguages: ["!!!", "es"]`.
- **Expected result:** One `GenerationRowError` naming `"!!!"` with a message identifying the malformed language code; the `es` target still generates normally with its own `GeneratedTargetResult`.
- **Prohibited side effects:** The provider is never invoked for `"!!!"` (assert call count).
- **Verification method:** Automated (spy on provider's `generate` call count/arguments).
- **Pass/fail criteria:** PASS iff exactly one row error is produced for the malformed code, the provider is called exactly once (for `es` only), and `es`'s result is unaffected. FAIL on any provider call for the malformed code, or on `es` being dropped.

### AC-GEN-05 — A `videoId` not belonging to this channel's synchronized data is rejected, without blocking other targets

- **Requirement reference:** §32; mirrors XLSX import's identical wrong-channel/not-synced row rejection.
- **Preconditions:** Video `v1` synced; `v-unknown` not present in synced data for this channel.
- **Fixed test inputs:** `videoIds: ["v1", "v-unknown"]`, `targetLanguages: ["es"]`.
- **Expected result:** One `GenerationRowError` for `v-unknown` explaining it is not synchronized data for this channel; `v1`'s `es` target still generates normally.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the error is produced for `v-unknown` only and `v1` is unaffected. FAIL if `v1` is also blocked, or if the provider is called for `v-unknown`.

### AC-GEN-06 — Duplicate `(videoId, language)` targets within one request are deduplicated, provider called once per distinct pair

- **Requirement reference:** explicit test requirement in this phase's assignment (§6 "duplicate proposals").
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** `videoIds: ["v1", "v1"]`, `targetLanguages: ["es"]` (duplicate arises from the cartesian product of a duplicated `videoIds` entry).
- **Expected result:** One `GenerationRowError` reporting the duplicate pair; exactly one `GeneratedTargetResult` for `(v1, es)`; the provider is called exactly once for that pair.
- **Verification method:** Automated (spy on provider call count).
- **Pass/fail criteria:** PASS iff the provider is called exactly once for `(v1, es)` and a duplicate is reported. FAIL on two calls or two results for the same pair.

### AC-GEN-07 — A provider failure for one target does not abort or corrupt sibling targets (INV-6.2)

- **Requirement reference:** explicit test requirement (§6 "provider failures"); INV-6.2.
- **Preconditions:** Videos `v1`, `v2` both synced and valid.
- **Fixed test inputs:** `videoIds: ["v1", "v2"]`, `targetLanguages: ["es"]`; mock provider configured to return `{ status: "error", message: "rate_limited" }` for `v1` only, and its normal deterministic output for `v2`.
- **Expected result:** `v1`'s `GeneratedTargetResult` has `providerError: "rate_limited"` and `fields: []`; `v2`'s result is generated normally with two valid fields.
- **Prohibited side effects:** The function does not throw; `v2` is not marked failed or skipped.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `v1` reports the provider error and `v2` succeeds independently in the same call. FAIL if the whole request throws, or if `v2` is affected by `v1`'s failure.

### AC-GEN-08 — Malformed AI output: an empty generated field is flagged invalid, never silently accepted or silently dropped

- **Requirement reference:** explicit test requirement (§6 "malformed AI output"); AGENTS.md §L (negative/boundary scenarios).
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** provider returns `title: ""` (empty), `description: "A valid tour."`.
- **Expected result:** `title` field `validationStatus: "invalid"`, `validationError` stating the field is empty; `description` field validated and classified normally.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the empty field is `invalid` with a specific error message and the other field is unaffected. FAIL if an empty value is accepted as `valid`, or if it silently disappears from the result instead of being reported as invalid.

### AC-GEN-09 — Malformed AI output: an oversized generated field is flagged invalid using the same length limits as XLSX import

- **Requirement reference:** explicit test requirement (§6 "malformed AI output"); reuses `YOUTUBE_TITLE_MAX_LENGTH`/`YOUTUBE_DESCRIPTION_MAX_LENGTH` (`src/lib/changesets/diff.ts`) — one source of truth, not a duplicated constant.
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** provider returns a `title` of 101 characters (one over the 100-character limit).
- **Expected result:** `title` field `validationStatus: "invalid"`, `validationError` naming the exact limit (100) and the actual length (101).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the field is `invalid` with the correct limit/length in the message. FAIL if accepted as valid, or if a different limit is used than XLSX import's.

### AC-CS-01 — Creating a Change Set from reviewed proposals persists only actionable fields, tagged `source: "ai_localization"`

- **Requirement reference:** §32 (draft → diff → human approval); `AGENTS.md` §D (reuse, not a parallel persistence path).
- **Preconditions:** Video `v1` as in AC-GEN-01; reviewed proposals for `(v1, es)`: `title: "Gatos del mundo"` (an add), and `description` omitted.
- **Fixed test inputs:** `proposals: [{ videoId: "v1", language: "es", title: "Gatos del mundo" }]`.
- **Expected result:** A `ChangeSet` is persisted with `source: "ai_localization"`, containing exactly one `Change` (the `title` field, `changeType: "add"`, `approvalStatus: "pending"`); no `description` change is created (it was omitted).
- **Verification method:** Automated (fake change-set store; assert the exact persisted `Change` shape and `source`).
- **Pass/fail criteria:** PASS iff exactly one `Change` is persisted with the expected field values and `source: "ai_localization"`, and the `ChangeSet`'s `source` matches. FAIL on a second, unrequested `description` change, or on the wrong `source` value.

### AC-CS-02 — Omitting a field from a reviewed proposal never deletes the existing value (INV-6.3 / §8)

- **Requirement reference:** §8 (inherited from Phase 4, must not regress); INV-6.3.
- **Preconditions:** Video `v2` with existing `es` localization as in AC-GEN-02.
- **Fixed test inputs:** `proposals: [{ videoId: "v2", language: "es", title: "Gatos del mundo" }]` (description field entirely omitted from the object, not sent as an empty string).
- **Expected result:** Only a `title` `Change` is created; no `Change` targeting `v2/es/description` exists in the persisted set, and nothing in this module ever issues an instruction that would clear or blank the existing `description` localization.
- **Verification method:** Automated (assert the persisted change list contains no `description` entry for this video/language).
- **Pass/fail criteria:** PASS iff no `description` change exists. FAIL if an empty-string `description` change is created (which downstream would be indistinguishable from "clear this field").

### AC-CS-03 — A human edit made during "inspect and edit" is what gets persisted, not the original AI-generated text

- **Requirement reference:** §32 workflow step "inspect and edit proposals" — must be an actual editable step, not cosmetic.
- **Preconditions:** Video `v1` as in AC-GEN-01. Generation step (AC-GEN-01) would have produced `title: "[ES] Cats of the world"`.
- **Fixed test inputs:** Reviewed proposal for `(v1, es)` submits a human-edited `title: "Los Gatos del Mundo"` (deliberately different from what generation would have produced) and does not re-invoke the provider.
- **Expected result:** The persisted `Change.proposedValue` is exactly `"Los Gatos del Mundo"` — the edited text — never the original generated string, and the provider's `generate` is not called during Change Set creation at all (assert zero provider calls in this step).
- **Verification method:** Automated (spy on provider; assert zero invocations during `createChangeSetFromGeneration`).
- **Pass/fail criteria:** PASS iff the persisted value is the edited text and the provider was never called in this step. FAIL if the original generated text is persisted instead, or if the provider is invoked again.

### AC-CS-04 — A duplicate `(videoId, language)` pair within submitted proposals is rejected before persistence

- **Requirement reference:** explicit test requirement (§6 "duplicate proposals"), applied to the persistence step as well as generation (AC-GEN-06).
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** `proposals` array containing two distinct objects both for `(v1, es)` with different `title` values.
- **Expected result:** The call throws a structured `DomainError`; nothing is persisted (assert zero `ChangeSet`/`Change` records created).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the call rejects and no partial persistence occurs. FAIL if either proposal is silently persisted or if a partial/corrupted `ChangeSet` results.

### AC-CS-05 — Submitting a proposal for a video outside this channel's synchronized data is rejected before persistence

- **Requirement reference:** mirrors AC-GEN-05 at the persistence boundary; `AGENTS.md` §F (a route/service taking a channel-scoped resource must itself verify ownership).
- **Preconditions:** `v-unknown` not present in this channel's synced videos.
- **Fixed test inputs:** `proposals: [{ videoId: "v-unknown", language: "es", title: "X" }]`.
- **Expected result:** The call throws `not_found`; nothing is persisted.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the call rejects with `not_found` and no `ChangeSet` is created. FAIL if a `ChangeSet` is created referencing a video outside the channel's synchronized data.

### AC-CS-06 — Submitting only unchanged/omitted proposals produces no Change Set

- **Requirement reference:** §32; consistent with XLSX import's own "unchanged rows are not persisted as changes" rule.
- **Preconditions:** Video `v3` as in AC-GEN-03, `es.title` already `"Ya traducido"`.
- **Fixed test inputs:** `proposals: [{ videoId: "v3", language: "es", title: "Ya traducido" }]` (identical to current remote value; no other fields).
- **Expected result:** The call throws `generation_no_proposals`; nothing is persisted.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the call rejects with `generation_no_proposals` and no `ChangeSet`/`Change` is created. FAIL if an empty or no-op `ChangeSet` is silently persisted.

### AC-CONTEXT-01 — Optional per-call editorial context is forwarded to the provider unchanged, never persisted, never sourced from this repository (added 2026-09-19, `docs/ai-localization/CHANNEL_CONTEXT_PROPOSAL.md` Part A)

- **Requirement reference:** §32's future workflow diagram names "Channel localization brief" as a step preceding "AI generation"; `AGENTS.md` §B (no channel-specific editorial content in this repository).
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** `generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"], editorialBrief: { targetAudience: "Beginners", toneNotes: "Playful" } })`.
- **Expected result:** The provider's `generate()` is called with `editorialBrief: { targetAudience: "Beginners", toneNotes: "Playful" }` present, exactly as submitted, in its request object.
- **Prohibited side effects:** Nothing is persisted anywhere as a result of supplying `editorialBrief` (this remains a preview-only call); no default/hardcoded content is substituted for a missing field.
- **Verification method:** Automated (spy on the provider's `generate` call arguments).
- **Pass/fail criteria:** PASS iff the exact submitted object reaches the provider unchanged. FAIL if it is dropped, mutated, or replaced with any repository-authored default.

### AC-CONTEXT-02 — Omitting editorial context entirely still generates normally (no hidden default content)

- **Requirement reference:** `AGENTS.md` §B — this repository must never author or default channel-specific editorial content.
- **Fixed test inputs:** `generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] })` (no `editorialBrief` field at all).
- **Expected result:** Generation succeeds exactly as AC-GEN-01; the provider's request object has no `editorialBrief` key (not an empty object, not a repository-authored default).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the provider's request has no `editorialBrief` property. FAIL if any default value is silently injected.

### AC-CS-07 — An invalid target language code submitted directly to Change Set creation is rejected before persistence (added post-implementation, independent review, 2026-09-19)

- **Requirement reference:** mirrors AC-GEN-04 at the persistence boundary; defense-in-depth requirement identified by an independent adversarial review, which found this exact check (`isValidLanguageCode` in `createChangeSetFromGeneration`) had no covering test and, when disabled, all other tests still passed.
- **Preconditions:** Video `v1` as in AC-GEN-01.
- **Fixed test inputs:** `proposals: [{ videoId: "v1", language: "!!!", title: "A" }]` submitted directly to `createChangeSetFromGeneration` (as if bypassing the UI's generate step).
- **Expected result:** The call throws `generation_invalid_target_language`; nothing is persisted.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the call rejects with that code and no `ChangeSet`/`Change` is created. FAIL if a malformed language code is silently persisted.

## 4a. Channel Editorial Profiles (added 2026-09-19, "Phase 6 — Channel Editorial Profiles" assignment)

Implements Part B of `docs/ai-localization/CHANNEL_CONTEXT_PROPOSAL.md`, approved by the project owner. Derived from that proposal's §3, `docs/PROJECT_SPEC.md` §32, and `AGENTS.md` §B/§F. An arbitrary number of channels must be supported; **no instructions for any specific real channel (e.g. "Tropico Jazz", "Rural Japan Music", or any music-niche content) are hardcoded anywhere in this feature** — every fixture below uses a placeholder channel id and placeholder text.

**Combination rule (documented once here, referenced by AC-PROFILE-05/06):** for each of the five fields (`targetAudience`, `toneNotes`, `terminologyNotes`, `titleConstraints`, `descriptionConstraints`), independently: if the per-request `editorialBrief` supplies a value for that field, it is used; otherwise the channel's saved profile's value for that field is used (if any); if neither supplies a value, the field is simply absent. This is a per-field override, not an all-or-nothing replacement, and it is a pure combination of already-validated text — it never invents content.

### AC-PROFILE-01 — A channel with no saved profile generates normally, with no invented default content

- **Requirement reference:** `AGENTS.md` §B (no default/invented channel-specific content).
- **Fixed test inputs:** `getEditorialProfile({ channelId: "UC_TEST" })` for a channel that has never saved a profile; then `generateProposals({ channelId: "UC_TEST", videoIds: ["v1"], targetLanguages: ["es"] })`.
- **Expected result:** `getEditorialProfile` returns `null`. Generation succeeds exactly as it would with no profile feature at all; the provider's request has no `editorialBrief` key.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `null` is returned and generation is unaffected. FAIL if any default profile is silently created or applied.

### AC-PROFILE-02 — Saving a profile for the first time creates version 1

- **Fixed test inputs:** `saveEditorialProfile({ channelId: "UC_TEST", targetAudience: "Beginners", toneNotes: "Playful" })` on a channel with no prior profile.
- **Expected result:** Returns `{ channelId: "UC_TEST", version: 1, targetAudience: "Beginners", toneNotes: "Playful", terminologyNotes: null, titleConstraints: null, descriptionConstraints: null, updatedAt: <ISO string> }`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff `version === 1` and unspecified fields are `null` (not omitted, not a default string).

### AC-PROFILE-03 — Editing an existing profile increments its version; an omitted field keeps its prior value, an explicit `null` clears it

- **Preconditions:** A profile already saved per AC-PROFILE-02 (version 1).
- **Fixed test inputs:** `saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Formal", targetAudience: null })` (omits `terminologyNotes`/`titleConstraints`/`descriptionConstraints` entirely; explicitly nulls `targetAudience`).
- **Expected result:** `version === 2`; `toneNotes === "Formal"`; `targetAudience === null`; `terminologyNotes`/`titleConstraints`/`descriptionConstraints` remain whatever they were before this call (unchanged, not cleared).
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff version increments and the omitted-vs-null distinction holds exactly. FAIL if an omitted field is cleared, or an explicit `null` is ignored.

### AC-PROFILE-04 — Two channels' profiles are fully isolated

- **Fixed test inputs:** Save distinct profiles for `UC_A` and `UC_B` with different placeholder text; then `getEditorialProfile` each.
- **Expected result:** Each channel's `getEditorialProfile` returns only its own saved values; `UC_A`'s profile never appears when querying `UC_B` and vice versa.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff no cross-channel leakage in either direction. FAIL on any field bleeding from one channel's profile into another's.

### AC-PROFILE-05 — A per-request `editorialBrief` field overrides the saved profile's same field

- **Preconditions:** Channel has a saved profile with `toneNotes: "Formal"`.
- **Fixed test inputs:** `generateProposals({ ..., editorialBrief: { toneNotes: "Playful" } })`.
- **Expected result:** The provider receives `editorialBrief.toneNotes === "Playful"` (the per-request value), not `"Formal"` (the profile's value).
- **Verification method:** Automated (spy on provider call arguments).
- **Pass/fail criteria:** PASS iff the per-request value wins for that field. FAIL if the profile's value is used instead.

### AC-PROFILE-06 — Fields merge independently: a field only in the profile survives even when the request overrides a different field

- **Preconditions:** Channel has a saved profile with `targetAudience: "Beginners"`, `toneNotes: "Formal"`.
- **Fixed test inputs:** `generateProposals({ ..., editorialBrief: { toneNotes: "Playful" } })` (only overrides `toneNotes`).
- **Expected result:** The provider receives `editorialBrief.targetAudience === "Beginners"` (from the profile, untouched) **and** `editorialBrief.toneNotes === "Playful"` (the override) in the same call.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff both fields are present with the correct source each. FAIL if the override clears the profile's other fields.

### AC-PROFILE-07 — Malformed profile data is rejected before persistence

- **Requirement reference:** `AGENTS.md` §L (negative/boundary scenarios).
- **Fixed test inputs:** `saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "" })` (empty string, below the schema's `.min(1)`) and `saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "x".repeat(2001) })` (over the 2000-character cap).
- **Expected result:** Both calls throw a structured `validation_failed` `DomainError`; no profile row is created or modified as a result of either call.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff both malformed calls are rejected and the profile (if any existed) is unchanged. FAIL if either is silently accepted or partially applied.

### AC-PROFILE-08 — Reproducibility: a Change Set's recorded provenance survives a later edit to the profile

- **Requirement reference:** this phase's assignment §4 ("the information must remain available after the profile is edited").
- **Preconditions:** Channel has a saved profile at version 1 (`toneNotes: "Formal"`).
- **Fixed test inputs:** `generateProposals(...)` (captures `generationContext` with `profileVersion: 1` and `effectiveContext.toneNotes: "Formal"`) → edit the reviewed proposal → `createChangeSetFromGeneration({ ..., provenance: <the echoed generationContext> })` → **then** `saveEditorialProfile({ channelId: "UC_TEST", toneNotes: "Playful" })` (bumps the live profile to version 2).
- **Expected result:** `getGenerationProvenance({ channelId, changeSetId })` still returns `profileVersion: 1` and `effectiveContext.toneNotes: "Formal"` — unaffected by the profile now being at version 2 with `toneNotes: "Playful"`.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff the provenance record is frozen at generation time regardless of later profile edits. FAIL if it reflects the live/current profile instead.

### AC-PROFILE-09 — Provenance retrieval is channel-scoped

- **Requirement reference:** `AGENTS.md` §F.
- **Fixed test inputs:** A provenance record exists for `changeSetId` under channel `UC_A`; call `getGenerationProvenance({ channelId: "UC_B", changeSetId })`.
- **Expected result:** Returns `null` (treated as not found), never the other channel's provenance data.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff cross-channel access returns `null`. FAIL if the record leaks across channels.

### AC-PROFILE-10 — Saving a profile never persists a Change, never creates a Change Set, and never approves anything

- **Requirement reference:** INV-6.1; `AGENTS.md` §D/§G.
- **Fixed test inputs:** `saveEditorialProfile({ channelId: "UC_TEST", targetAudience: "Beginners" })` in isolation, no generation call made.
- **Expected result:** No `ChangeSet`/`Change` is created as a side effect; `changeSetServices.createChangeSetFromProposals` is never invoked.
- **Verification method:** Automated (spy on `createChangeSetFromProposals` call count).
- **Pass/fail criteria:** PASS iff zero Change Set calls occur. FAIL if saving a profile has any persistence side effect beyond the profile table itself.

### AC-APPROVAL-01 — An AI-sourced Change goes through the exact same approve/reject pipeline as an XLSX-imported one

- **Requirement reference:** `AGENTS.md` §D (one approval system); §32 ("Human approval" step reused, not reimplemented).
- **Preconditions:** A `ChangeSet` with `source: "ai_localization"` created per AC-CS-01, containing one valid, non-conflicting `Change`.
- **Fixed test inputs:** Call the existing, unmodified `changesets.approveChange` on that `Change`'s id.
- **Expected result:** Identical behavior to approving an XLSX-imported change: `approvalStatus` transitions to `approved`, `approvedValue` is set to the exact `proposedValue`, the `ChangeSet`'s aggregate status recomputes via the same `computeChangeSetStatus` function.
- **Verification method:** Automated (reuse `changesets.approveChange` unmodified; assert on an `ai_localization`-sourced fixture).
- **Pass/fail criteria:** PASS iff approval behaves identically regardless of `source`. FAIL on any `source`-conditional branch anywhere in the approval code path (there must be none).

### AC-APPROVAL-02 — AI-generated metadata is never automatically approved (INV-6.1 / `AGENTS.md` §G)

- **Requirement reference:** `AGENTS.md` §G ("AI-generated metadata must remain a draft until it passes the project's approval workflow"); INV-6.1.
- **Preconditions:** Any successful `createChangeSetFromGeneration` call (e.g. AC-CS-01's fixture).
- **Fixed test inputs:** Same as AC-CS-01.
- **Expected result:** Every persisted `Change`'s `approvalStatus` is `"pending"` immediately after creation — never `"approved"`, regardless of how confidently-valid the generated text is.
- **Prohibited side effects:** No code path in `createChangeSetFromGeneration` or `generateProposals` sets `approvalStatus` to anything other than the default `pending` a newly-created `Change` always starts at.
- **Verification method:** Automated (assert `approvalStatus === "pending"` on every persisted change immediately after creation, before any explicit approval call).
- **Pass/fail criteria:** PASS iff every persisted change starts `pending`. FAIL if any change is created already `approved`.

### AC-CONFLICT-REUSE-01 — An `ai_localization` change is revalidated against the current remote state exactly like an `xlsx_import` change

- **Requirement reference:** §27/§30 (conflict detection), reused unchanged; `AGENTS.md` §D.
- **Preconditions:** A `ChangeSet` with an approved `ai_localization` change for `v1/es/title`, `baselineValue` = the remote value at generation time. The channel is re-synced and `v1`'s `es.title` changes externally (simulating a remote edit made outside this app).
- **Fixed test inputs:** Call the existing, unmodified `changesets.getChangeSet` (which internally runs `loadRevalidated`) after the simulated re-sync.
- **Expected result:** The change's `conflictStatus` becomes `conflict` and its prior approval is invalidated (`approvalStatus` reset to `pending`, `approvedValue` cleared) — the exact same behavior `docs/acceptance/PHASE_5_ACCEPTANCE.md`'s AC-LEDGER-04/`revalidateChangeAgainstCurrentRemote` already guarantees for any change, regardless of source.
- **Verification method:** Automated (reuse the existing revalidation function/service call unmodified against an `ai_localization`-sourced fixture).
- **Pass/fail criteria:** PASS iff the conflict/invalidation behavior is identical to the pre-existing (XLSX-covered) case. FAIL on any `source`-conditional exemption.

### AC-BATCH-REUSE-01 — Approved AI-generated changes can be selected into a Batch and dry-run previewed via the existing, unmodified Batch pipeline

- **Requirement reference:** §32 ("Apply" step, gated by Phase 5's existing dry-run-only Web UI/API); `AGENTS.md` §D; `docs/TECHNICAL_DEBT.md` Gate B (must not be reopened or weakened).
- **Preconditions:** One or more `Change`s from an `ai_localization` `ChangeSet`, approved per AC-APPROVAL-01.
- **Fixed test inputs:** Call the existing, unmodified `batches.createBatch({ channelId, changeIds: [...], dryRun: true })` with those approved change ids.
- **Expected result:** A `Batch` is created and its dry-run preview succeeds exactly as it would for XLSX-sourced change ids — `src/lib/batches/contracts.ts`'s `changeIds: string[]` accepts any approved change id regardless of its owning `ChangeSet`'s `source`; zero code in `src/lib/batches/**` inspects or branches on `ChangeSet.source` at all.
- **Prohibited side effects:** No real `videos.update` call (the existing live-write barrier, unchanged by this phase, still applies); the Web UI/API path used continues to be the dry-run-only one added in Phase 5 (`src/app/api/channels/[channelId]/batches/route.ts`, which unconditionally sends `dryRun: true`).
- **Verification method:** Automated (integration-style test spanning `ai-localization` → `changesets` approval → `batches.createBatch`, all against fakes/mocks).
- **Pass/fail criteria:** PASS iff the batch and its dry-run preview succeed with no source-based special-casing anywhere in the batch pipeline. FAIL if `batches/**` needs to know or care what produced the change.

### AC-PRESERVE-01 — End-to-end: AI-generated addition preserves all pre-existing, untargeted localizations through dry-run

- **Requirement reference:** §21 (preserve unrelated metadata); mirrors `docs/acceptance/PHASE_5_ACCEPTANCE.md`'s AC-MERGE-01, exercised through this phase's own entrypoint.
- **Preconditions:** Video `v1`'s current remote `existingLocalizations = { de: {...}, fr: {...} }` (both pre-existing, untouched by this scenario).
- **Fixed test inputs:** Generate + review + approve + batch-dry-run an AI proposal adding `pt-BR` to `v1` (title + description), through this phase's full pipeline.
- **Expected result:** The dry-run's constructed payload preview shows `de` and `fr` preserved byte-for-byte, plus the new `pt-BR` entry — identical guarantee to AC-MERGE-01, now proven reachable from the AI Localization entrypoint specifically (not just from XLSX import).
- **Verification method:** Automated (end-to-end through `ai-localization` → `changesets` → `batches`, mocked adapters throughout; zero real YouTube calls per INV-9, inherited from Phase 5).
- **Pass/fail criteria:** PASS iff `de`/`fr` are unchanged and `pt-BR` is added in the dry-run preview. FAIL on any drop or corruption of the untouched locales.

### AC-PROVIDER-01 — Only the mock provider is resolvable; any other name fails closed without any network attempt

- **Requirement reference:** explicit constraint (this phase's assignment §4/§8: "Do not select a paid provider or incur API costs"); §32 (`LocalizationProvider` is a named extension point, not yet filled by a real implementation).
- **Fixed test inputs:** `resolveLocalizationProvider("mock")` and `resolveLocalizationProvider("openai")` (or any other non-`"mock"` name).
- **Expected result:** `"mock"` returns a working `LocalizationProvider`; any other name throws a structured `DomainError` with `code: "provider_not_configured"`, naming the requested provider and stating that only `"mock"` is available.
- **Verification method:** Automated.
- **Pass/fail criteria:** PASS iff exactly this behavior holds for both cases. FAIL if any non-`"mock"` name silently resolves to something, or if the mock case fails.

### AC-COST-01 — Zero external AI API calls are structurally possible

- **Requirement reference:** explicit constraint (this phase's assignment §4/§8/§6: "zero external AI costs").
- **Verification method:** Automated repository inventory check (mirrors `src/lib/batches/write-path-inventory.test.ts`'s pattern for the live-write barrier): grep/import-graph assertion that `src/lib/ai-localization/**` contains no dependency on an HTTP/network client, no SDK for a real AI provider, and that `provider-registry.ts`'s only resolvable branch is `"mock"`.
- **Pass/fail criteria:** PASS iff the inventory check finds no real-provider network dependency anywhere reachable from this module. FAIL if any such dependency is introduced, now or by a future change (the automated check catches later regressions too, not just today's state).

### AC-SAFETY-01 — No code path in this module can reach a real YouTube mutation or bypass the Phase 5 live-write barrier

- **Requirement reference:** `docs/TECHNICAL_DEBT.md` Gate B (must not be reopened); this phase's assignment §8 ("do not activate or bypass the write barrier").
- **Verification method:** Automated — extend/re-run `src/lib/batches/write-path-inventory.test.ts` (or an equivalent grep-based check) to confirm `src/lib/ai-localization/**` does not construct a `WriteExecutor`, does not import `write-executor.youtube.ts`, and has no route/service reaching `attemptWrite`.
- **Pass/fail criteria:** PASS iff the inventory shows zero such references. FAIL if any are introduced.

---

## 5. Non-goals restated (not to be reopened during Phase 6 without a separate, explicit assignment)

- Real AI provider integration and its cost/vendor decision.
- Channel-specific editorial/SEO briefs or prompts (belongs outside this repository per `AGENTS.md` §B, permanently, not just for this phase).
- Any relaxation of Phase 5's Gate B requirements or live-write barrier.
- CLI/MCP surfaces for this feature (RISK-04 remains open, unaffected by this phase).
- Real YouTube writes, live validation, or Phase 6 "complete" sign-off beyond the scenarios in §4 actually passing.

## 6. Status

**APPROVED for implementation as of 2026-09-19**, scoped exactly as above, per the project owner's own Phase 6 assignment message (which itself constitutes the explicit phase authorization `AGENTS.md` §C requires — no phase-numbered entry naming "Phase 6" exists elsewhere in `docs/PROJECT_SPEC.md`; the assignment message is the authorization and this document operationalizes it). This approval covers only the scenarios in §4; it is not authorization for anything listed in §5, and it does not reopen Phase 5.
