# OVERNIGHT_SESSION.md — Phase 6, Slice 1 (AI Localization, mock provider)

**Session date:** 2026-09-19. **Authorization:** project owner's "Overnight Autonomous Development — Phase 6" assignment message (the explicit phase authorization `AGENTS.md` §C requires). **Scope:** implement the AI Localization vertical slice described in that message, using a mock AI provider only.

## 1. Verified starting state

- Read `AGENTS.md`, `docs/PROJECT_SPEC.md` §32, `docs/ROADMAP_STATUS.md`, `docs/ARCHITECTURE.md`, `docs/SYSTEM_MAP.md`, `docs/DEVELOPMENT_PLAYBOOK.md`, `docs/TECHNICAL_DEBT.md`, `docs/acceptance/PHASE_5_ACCEPTANCE.md`, `docs/validation/PHASE_5_LIVE_VALIDATION.md`.
- Verified (did not just trust the prior report) that commit `d38704e17bb154787b060e141a17ecaec51d44a7` exists on `main` and its diff matches the previously-reported 41-file Phase 5/RISK-12/13 change set exactly (`git show --stat d38704e`).
- Confirmed the only pending item at session start was the untracked `docs/validation/` directory (the live-validation plan) — preserved untouched throughout this session; nothing in it was read as instructions and nothing in it was modified.
- Confirmed the real-write barrier is unchanged and still unconditional: `assertLiveWritesAuthorized()` in `src/lib/batches/adapters/write-executor.youtube.ts` still throws `live_writes_disabled` with no parameter/env/dryRun dependency.
- No PROJECT_SPEC.md section is literally named "Phase 6" — this session's Phase 6 scope comes directly from §32 ("Future AI Localization Module") plus the project owner's own assignment message, which is itself the required explicit authorization.

## 2. Acceptance contract

Wrote `docs/acceptance/PHASE_6_ACCEPTANCE.md` before finalizing the implementation, deriving 21 scenarios from `docs/PROJECT_SPEC.md` §32, §8, §21, §27/§30, and `AGENTS.md` §B/§D/§G/§L. Scope is deliberately narrow: one vertical slice, mock provider only, no channel-specific editorial content (permanently out of scope in this repository per `AGENTS.md` §B). Every scenario has a corresponding passing automated test — see §5 below.

## 3. Implemented functionality

**New domain module `src/lib/ai-localization/`:**
- `contracts.ts` — `LocalizationProvider` interface (the extension point named by `docs/PROJECT_SPEC.md` §32), generation/proposal types.
- `provider-registry.ts` — resolves only `"mock"`; any other name fails closed with `provider_not_configured` (no fallback, no accidental real call).
- `adapters/mock-provider.ts` — deterministic, zero-network mock provider; test-overridable for failure/malformed-output scenarios.
- `services.ts` — `generateProposals` (generate + validate, no persistence) and `createChangeSetFromGeneration` (persist via the existing Change Set path).
- `schemas.ts`, `index.ts` — Zod validation and default wiring.

**Reused, not duplicated (`AGENTS.md` §D):**
- `src/lib/changesets/contracts.ts` — `ChangeSetSource` widened to `"xlsx_import" | "ai_localization"`.
- `src/lib/changesets/services.ts` — extracted the shared ChangeSet-persistence tail into `persistChangeSet` and exposed a new generic `createChangeSetFromProposals`, used by **both** XLSX import (refactored to call it) and AI Localization (new caller). No second persistence path was created.
- Field-level validation constants/functions (`YOUTUBE_TITLE_MAX_LENGTH`, `YOUTUBE_DESCRIPTION_MAX_LENGTH`, `classifyFieldChange`, `isValidLanguageCode` from `src/lib/changesets/diff.ts`) — reused, not reimplemented, so an AI-generated proposal is held to the exact same bar as a spreadsheet row.
- Approval (`approveChange`/`rejectChange`/`approveAllValid`), conflict revalidation (`loadRevalidated`), and the entire Batch/dry-run pipeline (`src/lib/batches/**`) — **zero code changes**, zero `ChangeSet.source` branches anywhere in `batches/**` (verified by inventory test and by direct code reading).

**New Web API/UI (dry-run-safe, mirrors the Phase 5 Batches UI pattern):**
- `POST /api/channels/[channelId]/ai-localization/generate` — preview only, persists nothing.
- `POST /api/channels/[channelId]/ai-localization/change-sets` — creates the Change Set.
- `src/components/ai-localization-panel.tsx` — video/language selection, generate, per-proposal inspect/edit (checkboxes + editable text areas, provider never re-invoked here), "Create Change Set" action. New "AI Localization" tab in `src/app/dashboard/page.tsx`. Approval and Batch/dry-run happen in the existing Localizations/Batches tabs, unchanged.

## 4. User-visible workflow

1. Dashboard → "AI Localization" tab → pick a synced channel, select one or more videos, enter target language codes.
2. "Generate proposals" → mock provider produces title/description text per (video, language) pair; malformed/invalid/duplicate targets are reported separately and never silently dropped or block sibling targets.
3. Review each proposal; edit the text freely; uncheck a field to exclude it entirely (never "clear the existing value" — an unchecked/omitted field is simply not proposed).
4. "Create Change Set from reviewed proposals" → persists a `ChangeSet` (`source: "ai_localization"`), every `Change` starting `approvalStatus: "pending"`.
5. Operator switches to the existing "Localizations" tab to approve/reject exactly as for an XLSX import.
6. Operator switches to the existing "Batches" tab to select approved changes into a Batch and run the existing dry-run preview. No "Apply"/live-write action exists anywhere in this flow, same as Phase 5.

## 5. Acceptance coverage and test results

All 21 scenarios in `docs/acceptance/PHASE_6_ACCEPTANCE.md` §4 have a passing automated test (24 test cases total across 4 new files, some scenarios combined into one integration test):

- `services.test.ts` — AC-GEN-01..09, AC-CS-01..06, AC-APPROVAL-02 (13 tests).
- `provider-registry.test.ts` — AC-PROVIDER-01 (3 tests).
- `integration.acceptance.test.ts` — AC-APPROVAL-01, AC-BATCH-REUSE-01, AC-PRESERVE-01 (combined into one end-to-end test), AC-CONFLICT-REUSE-01 (2 tests).
- `write-path-inventory.test.ts` — AC-SAFETY-01, AC-COST-01, and a structural check on the provider registry (3 tests).

**Validation run (this session, after all implementation):**
- `npm test`: **345/345 passed** (321 pre-existing + 24 new), 0 failed.
- `npm run lint`: clean, 0 warnings/errors (one warning found and fixed mid-session — an unused import in the integration test).
- `npm run build`: production build succeeds; new routes (`/api/channels/[channelId]/ai-localization/generate`, `.../change-sets`) appear correctly in the route manifest.
- `npm audit`: unchanged — 20 pre-existing, non-critical findings (`RISK-06`); no new dependency was added by this work.
- `git diff --check`: clean (only pre-existing CRLF/LF line-ending warnings, no whitespace errors).

## 6. Independent adversarial review

A fresh (non-fork) subagent reviewed the implementation against the acceptance contract, hunted specifically for auto-approval bugs, deletion-via-omission bugs, real-network-call paths, validation bypasses, `batches/**` source-branching, and doc/test drift. It deliberately injected two temporary regressions (an auto-approval and a disabled validation check) to confirm the relevant tests actually fail rather than passing vacuously, then reverted both (confirmed via `git diff`, repo left clean).

**Verdict: no safety-critical bugs found.** Every invariant it specifically checked held:
- No code path in `services.ts` ever sets `approvalStatus` — confirmed both by reading and by injecting `approvalStatus: "approved"`, which correctly made AC-APPROVAL-02 fail (not a vacuous test).
- Omitted fields never become deletions (`continue` on `undefined`, plus `reviewedProposalSchema`'s `.min(1)` blocking an empty-string smuggle-through).
- Zero `source`/`ai_localization` references anywhere in `src/lib/batches/**` (grep-confirmed) — AC-BATCH-REUSE-01's "no special-casing" claim holds.
- No network/HTTP/AI-SDK import anywhere in `src/lib/ai-localization/**`; `provider-registry.ts` resolves only `"mock"`.
- The two new API routes follow the exact same auth/channel-scoping convention as the pre-existing Change Set routes (`channelId` from URL path params, spread after the request body so it cannot be overridden by a spoofed body field) — not a new gap.
- `createChangeSetFromProposals` is a genuine shared tail, not a second persistence path; validation constants/functions are genuinely reused from `changesets/diff.ts`, not duplicated.
- The mock provider is deterministic; test fixtures compute expected values by hand, not by running the implementation first.

**One real gap found (low/medium severity, coverage gap, not a live bug):** `createChangeSetFromGeneration`'s `isValidLanguageCode` check at the persistence boundary had no dedicated test — disabling it left all 24 then-existing tests passing. **Fixed in this session**: added `AC-CS-07` to `docs/acceptance/PHASE_6_ACCEPTANCE.md` and a corresponding test in `services.test.ts`, confirmed passing (25/25 ai-localization tests now).

## 7. Open questions for the project owner (recorded, not fabricated as decided)

1. **Real AI provider selection** — which vendor (if any), who bears the cost, and when. `src/lib/ai-localization/provider-registry.ts` is the only file that would need a new branch.
2. **Channel-specific localization briefs/editorial config** (`docs/PROJECT_SPEC.md` §32's own future example, `channels/<id>/localization/*.md`) — deliberately not built; per `AGENTS.md` §B this content must live outside this repository regardless of who builds the feature that consumes it, so this is a permanent architectural constraint, not a temporary gap.
3. **CLI/MCP interfaces for AI Localization** — deferred alongside the pre-existing RISK-04 (Change Sets/Batches CLI/MCP parity).

## 8. Phase 5 status (unchanged by this session)

- **Code-complete** against mocked adapters — unchanged.
- **Live validation** — still pending; nothing in this session touched, executed, or referenced live-validation steps.
- **Gate B** — still pending; not reopened, not weakened, not reassessed as closed.
- The live-write barrier was not touched, activated, or bypassed.
- No Google OAuth login was performed. No real YouTube API call was made. No real, paid AI provider was called (structurally impossible in the code that exists — see AC-COST-01).

## 9. Git status at end of session

Nothing was committed or pushed (not authorized for this session — `AGENTS.md` §K, and the assignment's own §8 explicitly excludes commit/push/tag/release/deploy). All new/modified files remain in the working tree for the project owner's review.

## 10a. Follow-up: "Autonomous Quality and Integration Pass" (2026-09-19, same day)

A second independent (fresh, non-fork) reviewer re-derived expectations from `docs/PROJECT_SPEC.md` §32 and `docs/acceptance/PHASE_6_ACCEPTANCE.md` before reading the code, specifically checking for circularity (acceptance criteria written to match the implementation rather than the spec) and tracing 6 areas end-to-end: preservation, language-code validation, generated/validated/approved separation, no-auto-approval, provider error handling, hidden side effects.

**Result: no circularity found; 5 of 6 areas fully sound.** One real bug found and fixed: `generateProposals`'s per-target loop did not wrap `provider.generate()` in its own try/catch, so a provider that *throws* (rather than returning `{status:"error"}`) aborted the entire call and silently discarded every other target's already-computed result — a genuine violation of INV-6.2 ("a single video/language's provider failure never blocks or corrupts sibling targets," which is worded in terms of failure generally, not only the returned-error shape). Fixed in `src/lib/ai-localization/services.ts` with a per-target try/catch; regression test added to `services.test.ts` (verified failing before the fix, passing after). No acceptance-doc scenario needed changing — INV-6.2 already stated the requirement; only a code-level gap and a new test were needed.

A minor non-issue was noted and deliberately not treated as a bug: `isValidLanguageCode`'s regex has no overall length cap (only an 8-character-per-subtag cap), so a pathologically long, many-subtag string could pass. No spec requirement clearly demands an overall cap, so fixing this would have been unrequested scope expansion; left as-is.

**Browser smoke testing:** no browser-automation tool is available in this environment, and `WebFetch` explicitly cannot reach `localhost`. A partial, non-UI smoke check was run instead: the dev server was started, and both new routes (`POST .../ai-localization/generate`, `POST .../ai-localization/change-sets`) were confirmed to return `401 Unauthorized` without a session (auth gate works), then the server was stopped. **The actual browser workflow (video/language selection → generate → edit → Change Set → approve → Batch → dry-run) was NOT exercised in a real browser and must not be treated as verified** — this remains an open, explicitly-acknowledged gap, consistent with `AGENTS.md`'s UI-testing expectation and this task's own instruction not to claim UI verification from `npm test` alone. Google OAuth was not performed (as required); the dev server run left an unrelated auto-generated diff in `AGENTS.md` (written by `next dev` itself, not by this session's own work), which was identified and reverted before finishing.

**Channel-specific generation context:** split into two parts per `docs/ai-localization/CHANNEL_CONTEXT_PROPOSAL.md`. Part A (a generic, structurally-validated, per-call `editorialBrief` field on `generateProposals`, forwarded to the provider, never persisted, never defaulted/invented by this repository) was implemented and tested (`AC-CONTEXT-01`/`AC-CONTEXT-02`). Part B (persistent, per-channel, operator-editable brief storage) is a proposed, **not implemented**, product decision — see that document's §3-4 for the exact data-model/UI/access-boundary questions requiring your decision.

**Provider integration readiness:** `docs/ai-localization/PROVIDER_INTEGRATION_PLAN.md` documents the interface (unchanged), structured-response validation approach, error handling (including the same throw-isolation principle just fixed above, called out explicitly as a requirement for any real adapter), request-volume/cost controls, secret-free configuration (env vars, no committed content), and the model-switching seam (`provider-registry.ts`). No provider selected, no dependency added, no network call made.

**Verification (this pass):** `npm test` 349/349 passed (345 + 1 review-added INV-6.2 regression + 2 AC-CONTEXT tests + 1 AC-CS-07 accounting difference from the prior round's count); `npm run lint` clean; `npm run build` clean (all routes compile); `git diff --check` clean (only pre-existing CRLF/LF warnings). `git status`: same file set as the original Phase 6 Slice 1 session plus `docs/ai-localization/` (two new plan/proposal documents) — nothing else.

## 10b. Follow-up: "Channel Editorial Profiles" (Part B, 2026-09-19)

Implemented Part B of `docs/ai-localization/CHANNEL_CONTEXT_PROPOSAL.md`, per the project owner's explicit authorization: a persistent, per-channel, versioned editorial profile (`targetAudience`, `toneNotes`, `terminologyNotes`, `titleConstraints`, `descriptionConstraints`), automatically merged per-field with an optional per-request `editorialBrief` override, and recorded as immutable provenance against each Change Set it produces so the record survives later profile edits.

**Storage:** two new, purely additive tables (`channel_editorial_profiles`, `ai_localization_generation_provenance`, `src/lib/db.ts`), following the existing `CREATE TABLE IF NOT EXISTS` idempotent-schema pattern (ADR 0001). No existing table/column changed.

**Combination rule:** per field, independently — a per-request value wins if supplied; otherwise the saved profile's value; otherwise the field is absent. Documented once in `docs/acceptance/PHASE_6_ACCEPTANCE.md` §4a and referenced from the relevant scenarios.

**Reproducibility:** `generateProposals` returns `generationContext` (profile version + effective merged context); the client echoes this back as `provenance` when calling `createChangeSetFromGeneration`, which persists it verbatim — never re-derived from the live profile. This is an explicit, documented trust boundary: nothing in approval, conflict detection, or the Batch/write pipeline ever reads this table, so it is purely an audit/informational record, not a safety-relevant one.

**Scope discipline:** supports an arbitrary number of channels; no instructions for any real channel (Tropico Jazz, Rural Japan Music, or any other) are hardcoded anywhere. Existing channel-ownership/auth patterns reused (session check + channel-scoped queries, same as every other route); no separate auth system created. Existing Change Set/Batch/approval workflows untouched.

**New surface:** `GET/PUT /api/channels/[channelId]/ai-localization/profile`, `GET /api/channels/[channelId]/ai-localization/change-sets/[changeSetId]/provenance`, a collapsible profile editor added to the existing AI Localization tab (not a new tab).

**Tests:** 10 new (`src/lib/ai-localization/profiles.test.ts`, `docs/acceptance/PHASE_6_ACCEPTANCE.md` AC-PROFILE-01..10) covering channel isolation, missing/empty profile, edit/persist semantics (omitted vs. explicit `null`), version/reproducibility across edits, per-field merge with a per-request override, malformed data rejection, and absence of auto-approval side effects.

**Independent adversarial review:** a fresh (non-fork) subagent read the acceptance scenarios first, then the code, then mutation-tested the channel-scoping check in `getGenerationProvenance` (removed it, confirmed `AC-PROFILE-09` failed, reverted, confirmed clean). **Result: no bugs found; no fix needed.** It explicitly confirmed the provenance trust boundary (client can omit/fabricate provenance, but nothing safety-relevant reads it) matches the module's own documented design rather than being an overlooked gap. It also flagged, for awareness only and out of this task's scope, that "Tropico Jazz" appears as a pre-existing test-fixture channel title in two files from the earlier Phase 6 session (not new, not editorial-instruction content, not touched by this task).

**Verification:** `npm test` 359/359 (349 + 10 new); `npm run lint` clean; `npm run build` clean (both new routes compile); `git diff --check` clean (only pre-existing CRLF/LF warnings).

## 10c. Follow-up: "Provider-Agnostic AI Connections" (2026-09-19, same day)

Implemented a provider-agnostic "AI Connections" system per the project owner's explicit revision of the earlier OpenAI-specific plan: no vendor/model/API-key/endpoint hardcoded anywhere; users configure connections through a new Settings UI tab.

**Architecture:** `src/lib/ai-connections/` — a connection entity (id, display name, adapter type, base URL, model id, optional encrypted credential, enabled/status, capability metadata, task assignment), a small fixed adapter registry (`mock`, reusing the existing deterministic provider; `openai_compatible`, the one real protocol adapter). `src/lib/ai-localization/services.ts` gained exactly one optional dependency and one optional input field (`connectionId`) — its own domain logic is otherwise untouched, so a future second real adapter (e.g. Anthropic-native) requires no change there.

**Credential storage decision (recorded in `docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md` §2):** OS-keychain was considered and deferred (native-dependency/cross-platform risk); plaintext was rejected outright per explicit instruction. Implemented: AES-256-GCM, key from `AI_CONNECTIONS_ENCRYPTION_KEY` (env var, never committed), ciphertext in a separate table from the connection's public fields, fail-closed with no plaintext fallback if the key is missing.

**Endpoint security (SSRF):** `validateEndpointUrl` requires HTTPS for remote endpoints, blocks IP-literal and DNS-resolved private/loopback/link-local/reserved/cloud-metadata addresses unless a connection's `localInferenceMode` is explicitly enabled, and re-validates immediately before every real outbound call.

**Independent reviews (two, both fresh non-fork subagents):**
1. **Requirements/general adversarial review** found and fixed one real bug: creating (and, symmetrically, editing) a connection with a credential when no encryption key was configured left an orphaned connection row before the key check ran — fixed by resolving the key requirement before any write, making the operation atomic.
2. **Security-focused review** (credential handling + SSRF specifically, per explicit instruction) found and fixed two real, exploitable gaps: (a) the outbound HTTP client followed redirects by default, so an already-validated public HTTPS endpoint could redirect to an internal/metadata address and bypass SSRF validation entirely — fixed with `redirect: "manual"`; (b) IPv6 literal URLs were never actually hitting the direct-IP fast path (a bracket-stripping bug), so their blocking depended on an undocumented DNS-resolver quirk rather than validated logic — fixed by stripping brackets before the IP check. Also added a DNS-lookup timeout as hardening. Confirmed as not exploitable/already-accepted: decimal/hex/octal IP obfuscation (canonicalized away by `URL` itself), the underlying DNS-rebinding TOCTOU (already documented, see below), credential handling (fresh IV per encryption, fail-closed, never logged/returned), and API route authorization (identical pattern to every existing route).

**Documented residual risks:** `docs/TECHNICAL_DEBT.md` RISK-14 (DNS-rebinding TOCTOU — narrowed after the redirect fix closed the more severe redirect-based variant; the pure-DNS-timing variant remains open and accepted for the single-operator model) and RISK-15 (no encryption-key rotation tooling — low severity, operator-inconvenience only).

**Tests:** 37 new (`docs/acceptance/PHASE_6_AI_CONNECTIONS_ACCEPTANCE.md` AC-CONN-01..17): CRUD, credential non-exposure/encryption/atomic-fail-closed, SSRF blocking (IP literals, DNS-resolved private addresses, IPv6, redirects, DNS timeout), capability rejection before any network call, malformed-JSON/timeout isolation, unknown usage/pricing reported as `null` never `0`, and a full connection-backed generation → Change Set → approve → Batch dry-run integration test proving the mock-provider guarantees hold identically for a real (fake-HTTP-backed) connection.

**Verification:** `npm test` 396/396 passed; `npm run lint` clean; `npm run build` clean (three new `/api/ai-connections/**` routes compile); `git diff --check` clean; `src/lib/batches/**` diff confirmed empty (Phase 5 barrier untouched) throughout.

## 10. Next recommended step

Project owner reviews this session's diff and `docs/acceptance/PHASE_6_ACCEPTANCE.md`, then decides: (a) authorize a commit of this Phase 6 Slice 1 work; (b) request changes; (c) address the open questions in §7 before any further Phase 6 slice; Phase 5's live-validation track (`docs/validation/PHASE_5_LIVE_VALIDATION.md`) remains the largest item before Gate B and is entirely independent of this session's work.
