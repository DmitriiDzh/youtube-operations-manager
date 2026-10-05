# Phase 10 slice 4 — AI-generated hypothesis drafts

Continues on `feature/phase-10-decision-experiment-engine` (`AGENTS.md` §K.1, owner: "Делаем
целиком" — do the whole phase, not a split Part I/II, after slices 1-3 were reported done).

**Mandatory reading for this slice** (`AGENTS.md` §A — extends an existing pattern into a second
module, a design fork worth getting right): `docs/roadmap/plans/PHASE_10_PLAN.md` §4,
`docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md`/`_SLICE_3_PLAN.md` in full (continuity), and —
because this slice's whole point is reusing an already-shipped pattern rather than inventing one —
`src/lib/ai-localization/{contracts,services,provider-registry,index}.ts` and
`src/lib/ai-connections/{contracts,services}.ts` plus `adapters/openai-compatible.ts`, all read in
full. `advisor()` was consulted before writing this plan; its design decision is what §1-§5 below
record.

## 1. The transport-vs-shape split (advisor's decision, not guessed)

`openai-compatible.ts`'s `callOnce` — SSRF validation (`validateEndpointUrl`), timeout/abort,
`redirect: "manual"` (prevents an SSRF bypass via redirect), retry/backoff, credential header
injection — is security-critical, protocol-transport code with **zero localization-specific
content**. `buildInstructionPrompt`/`buildResponseFormat` (the actual translate-this-video prompt,
the `{title, description}` JSON schema) are the localization-*shaped* part.

**Decision: extract `callOnce` into a shared internal helper inside `ai-connections/adapters/
openai-compatible.ts`, keep the existing `generate()` method rebuilt on top of it (zero behavior
change, proven by every existing ai-connections/ai-localization test passing unmodified), and add
a second, additive method to `ConnectionProtocolAdapter` for hypothesis generation** — not a
refactor of the public interface, not a parallel copy of the transport code. This is an *additive*
widening of `ai-connections` (already this repo's shared AI-provider infrastructure, imported
directly by `ai-localization/index.ts` today — not a "feature module" `decision-engine` would be
violating `AGENTS.md` §M by depending on) to serve a second real caller, exactly the pattern §M
itself describes: shared logic used by more than one feature module lives in its own module.

## 2. Scope boundary

**In scope:**
- `ConnectionProtocolAdapter` gains `generateHypothesis(args): Promise<{outcome, usage}>` —
  additive, both adapters (`mock`, `openai_compatible`) implement it.
- `ai-connections` gains `resolveHypothesisGenerationProvider(connectionId)`, a sibling to
  `resolveConnectionProvider` sharing its `requireConnection` → enabled-check → decrypt-once logic
  via a small shared helper (not copy-pasted).
- `decision-engine` gains one new service action, `generateHypothesisDraft`, and a route +
  minimal UI affordance ("Generate with AI" next to the existing manual "New hypothesis" form).
- A new provenance table (migration v31) recording AI authorship, mirroring
  `aiLocalizationGenerationProvenance`.
- `decisions-manager.tsx` shows AI-drafted hypotheses editable before saving (mirrors AI
  Localization's "human inspect/edit step").

**Explicitly out of scope (per owner spec/plan's own non-goals, unchanged):**
- MCP/CLI exposure of generation — slice 2's agent surface stays read + `create_experiment_proposal`
  only; the AI-generation entry point is Web-UI-only for now, an explicit, deliberate narrowing
  (agent-initiated *AI-authored* hypotheses raise a distinct, unasked question — who approves an
  agent asking an AI to draft something an agent then also gets to read — left for a future slice).
- Automatic execution of anything — unaffected, still entirely separate, unscoped work.
- A real, non-mock AI provider call in this session — `AGENTS.md` §K.2 gates a real paid AI API
  call separately from Git/merge authorization; this slice is validated only against the mock
  adapter and an injected `fetchImpl`-driven fake for `openai_compatible`, never a live connection.

## 3. Evidence: the model never invents a reference (advisor's point 3)

The model does not choose which real Phase 8/9 rows back a hypothesis — the **operator** does,
before generation, by selecting from already-real evidence the same way slice 3's evidence-attach
flow already lets them browse. Concretely:
- `EvidenceReferenceResolver` (slice 3, `src/app/api/decision-engine/evidence-reference-resolver.ts`)
  gains a `describe(ref): Promise<string>` method — a short, human/model-readable summary of one
  already-validated reference (e.g. "Video X: 12,400 views, +18% 7-day velocity" for a
  `phase8_metric` ref) — reusing the exact same resolver, same channel-authorization checks, no
  second evidence-fetch path.
- The generation request the provider receives carries: the hypothesis's `channelId` (optional),
  the operator's own free-text prompt/notes, and the `describe()`-summarized text of every
  operator-selected evidence reference — never raw DB rows, never something the model could later
  claim as "its own" discovery.
- The provider's output is `{statement: string, rationale: string}` only — never an evidence
  reference. On save, the flow is: `createHypothesis` (existing, unmodified) with the AI's
  (human-reviewed/edited) `statement`, then `addHypothesisEvidence` (existing, unmodified) once per
  operator-selected reference the operator confirms — re-validated exactly as a manually-attached
  reference already is. The model's `rationale` is stored only in the new provenance row (§4), not
  as a `hypotheses` column — it is generation metadata, not part of the hypothesis itself.

## 4. AI-authorship provenance (advisor's point 4)

`decision-engine`'s existing `createdVia` (mcp/cli/web_ui — transport) cannot represent "AI wrote
the first draft of this text, a human may have then edited it" — that is a different axis,
exactly why Phase 6 has its own separate `aiLocalizationGenerationProvenance` table rather than
overloading `createdVia`. New table, **migration v31** (confirmed: this branch's
`SCHEMA_CURRENT_VERSION` is 30 as of slice 3, `src/lib/db.ts`):

```sql
CREATE TABLE IF NOT EXISTS hypothesis_generation_provenance (
  id TEXT PRIMARY KEY,
  hypothesis_id TEXT NOT NULL REFERENCES hypotheses(id),
  connection_id TEXT,                    -- NULL for the mock provider
  provider_name TEXT NOT NULL,           -- adapter's own display name ("mock", or the connection's displayName)
  model_id TEXT,                         -- NULL for mock
  generated_statement TEXT NOT NULL,     -- the AI's own raw output, before any human edit
  final_statement TEXT NOT NULL,         -- what was actually saved (may equal generated_statement)
  rationale TEXT,                        -- the model's own stated reasoning, informational only
  evidence_ref_count INTEGER NOT NULL,   -- how many operator-selected refs were fed in
  edited_before_save INTEGER NOT NULL,   -- 0/1 -- final_statement !== generated_statement
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```
Added to `src/lib/snapshot/contracts.ts`'s `SNAPSHOT_TRANSFERRED_TABLES` by hand (RISK-79: no
structural guard catches a missed table yet) alongside this branch's other 3 decision-engine
tables.

## 5. Gates (advisor's point 5)

- `assertDeviceAvailable` (the RISK-30 precedent) is called before any real-connection generation
  call, identically to `ai-localization`'s own `generateProposals`.
- `src/proxy.ts`: the new generation route is classified deliberately (it makes an outbound call
  but writes nothing locally until the separate, existing `createHypothesis`/`addHypothesisEvidence`
  calls happen) — a dedicated test proves which classification it got and why, not left implicit.
- Real-connection path: capped at 1 draft per call (there is only one hypothesis being drafted at a
  time here, unlike localization's N-targets-per-call shape) but still runs through
  `assertDeviceAvailable` and reports `usage: null` (never fabricated `0`) when a provider does not
  report it.
- Module boundary: `decision-engine/index.ts` wires `createAiConnectionCore()` directly, mirroring
  `ai-localization/index.ts`'s own precedent exactly (ai-connections is shared infrastructure, not
  a feature-module peer `AGENTS.md` §M would forbid depending on) — `PHASE10-INV-03` (decision-
  engine never imports `@/lib/analytics`/`@/lib/market-intelligence`) is unaffected, since it never
  named `ai-connections`. The **service layer** still takes `resolveConnectionProvider` as an
  optional injected dependency (exact same shape as `ai-localization/services.ts`), so every
  existing decision-engine test fixture that never exercises generation keeps working unmodified,
  and mock-only tests need no `ai-connections` import at all.
- `assignedTasks` on an `AiConnection`: confirmed (read `ai-connections/services.ts`) this is
  free-text, informational-only metadata not enforced by `resolveConnectionProvider` or anywhere
  else in this codebase today — this slice does not enforce it either (matches the one existing
  precedent, `ai-localization`, exactly; inventing enforcement here alone would be a new,
  undiscussed policy, not a bug fix).

## 6. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- Generating with the mock provider and zero selected evidence produces a `{statement, rationale}`
  outcome; saving it creates exactly one `hypotheses` row and one `hypothesis_generation_
  provenance` row, zero `hypothesis_evidence` rows.
- Generating with 2 selected evidence references, editing the returned statement before saving,
  then saving: `final_statement !== generated_statement`, `edited_before_save = 1`,
  `evidence_ref_count = 2`, and exactly 2 `hypothesis_evidence` rows exist afterward, each
  independently re-validated by the existing `addHypothesisEvidence` path (an evidence reference
  that would fail creation-time validation there must still fail here, not bypass it).
- A provider that throws (not just returns `{status:"error"}`) does not crash the whole generation
  call (mirrors AI Localization's own per-target isolation, `INV-6.2`).
- `resolveHypothesisGenerationProvider` on a disabled connection throws `connection_disabled` —
  same code AI Localization's own `resolveConnectionProvider` already uses for this, not a new one.
- A negative test: `generateHypothesisDraft` called with a `channelId` the caller isn't authorized
  for is rejected before any provider call is made (channel-context validation, `AGENTS.md` §F,
  same as every other channel-scoped decision-engine action since slice 1).
- Every existing `ai-connections`/`ai-localization` test passes completely unmodified — the actual
  proof `callOnce`'s extraction changed zero behavior.

## 7. Where this is recorded

This plan; `docs/roadmap/BACKLOG.md` BL-107 (already tracks Phase 10's overall progress, updated
in place rather than a new row per slice, matching how BL-102/103 tracked Phase 9 Part II).
