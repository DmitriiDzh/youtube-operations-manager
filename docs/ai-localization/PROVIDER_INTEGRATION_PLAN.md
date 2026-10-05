# AI_PROVIDER_INTEGRATION_PLAN.md

**Status: PLAN ONLY. No real provider is implemented, selected, or called by anything in this repository.** This document exists so that when the project owner picks a real `LocalizationProvider` (OpenAI/Anthropic/DeepL/Google Translation/custom model — `docs/PROJECT_SPEC.md` §32), the work is a contained, previously-thought-through change rather than an improvised one. Writing this plan is not authorization to start it (`AGENTS.md` §K: provider selection is a cost-bearing, product-level decision reserved for the project owner).

This plan does not choose a provider, does not add a provider SDK dependency, and does not make any network call. It describes the shape a real implementation of the existing `src/lib/ai-localization/contracts.ts` `LocalizationProvider` interface would take, and the surrounding controls it would need.

---

## 1. Provider interface (already exists, does not need to change)

```ts
export type LocalizationProvider = {
  readonly name: string;
  generate(request: LocalizationGenerationRequest): Promise<LocalizationGenerationOutcome>;
};
```

A real provider is a new file under `src/lib/ai-localization/adapters/` (e.g. `openai-provider.ts`), registered in `provider-registry.ts` alongside `"mock"`. **No other file in this module needs to change** — `services.ts` depends only on the interface, never on `"mock"`'s identity (already proven by `AC-PROVIDER-01`/`AC-COST-01` in `docs/acceptance/PHASE_6_ACCEPTANCE.md`). This is the reason the interface was built as a narrow seam rather than something wider.

If channel-specific generation context is later approved (see this session's separate proposal), `LocalizationGenerationRequest` would gain one additional, optional, structurally-generic field (e.g. `editorialBrief`) — still provider-agnostic, still populated only from caller input, never from anything stored in this repository (`AGENTS.md` §B).

## 2. Structured response format

A real provider must not return free-form prose it then has to be parsed out of by regex. Two viable shapes, in order of preference:

1. **Native structured output / JSON mode**, if the chosen provider's API supports constraining output to a schema (OpenAI's `response_format: json_schema`, Anthropic's tool-use-as-structured-output pattern, etc.). The provider adapter validates the raw JSON against a fixed shape (`{ title: string, description: string }`) with `zod` (already a project dependency) before returning `{ status: "ok", title, description }`. Any schema-validation failure becomes `{ status: "error", message }` — never a best-effort guess at extracting text.
2. **Plain text with a strict extraction contract**, only if structured output isn't available for the chosen provider/model: a fixed, versioned prompt template requiring the model to emit two clearly delimited sections, parsed with an explicit, testable parser (not a hopeful regex) — and any parse failure is `{ status: "error" }`, never an empty/partial result silently returned as `"ok"`.

Either way, the parsing/validation step lives entirely inside the new adapter file — `services.ts`'s existing per-field validation (`classifyAndValidateField`, reusing `YOUTUBE_TITLE_MAX_LENGTH`/`YOUTUBE_DESCRIPTION_MAX_LENGTH`/emptiness checks) already re-validates whatever the adapter returns, so a provider bug that slips past adapter-level validation still cannot produce an invalid persisted proposal. This two-layer validation (adapter-level structural check + existing services-level field validation) should be preserved, not collapsed into one.

## 3. Result validation (beyond structure)

Already implemented and reusable unchanged for a real provider:

- Non-empty check (`AC-GEN-08`).
- Length limits, the exact same ones XLSX import enforces (`AC-GEN-09`).
- `changeType` classification against the current synced remote value.

New checks a real provider adapter should add, specific to real-model output risk:
- **Language-match sanity check** (optional, defensive): flag (not silently accept) an output that appears to still be in the source language, e.g. via a lightweight heuristic or an explicit "detected language" field from the provider's own response, if available. This is a quality signal for the human reviewer, not a hard validation gate — the human "inspect and edit" step (`AGENTS.md` §G) remains the actual gate, and no output should ever be silently rejected or rewritten based on this heuristic.
- **Prompt-injection resistance in source text**: since `sourceTitle`/`sourceDescription` come from already-synced YouTube metadata (which could in principle contain adversarial text aimed at the model), the adapter should treat the model's response as untrusted output only — it already is, structurally, since it goes through the same validation as any other proposal and is never auto-approved.

## 4. Error handling

`LocalizationGenerationOutcome`'s existing two-variant shape (`{ status: "ok", ... }` / `{ status: "error", message }`) already covers this; a real adapter's `generate()` must:

- Catch every exception the provider SDK can throw (network failure, timeout, rate limit, content-policy rejection, malformed response) and convert it to `{ status: "error", message }` — **never let an exception escape `generate()`**, since `services.ts`'s `generateProposals` loop calls each target sequentially and does not currently wrap each call in its own try/catch (it relies on the provider never throwing, per the interface contract). This is a **required change alongside any real provider adapter**: either (a) the adapter guarantees it never throws (document this as the adapter's own contract, enforced with a wrapping try/catch inside the adapter itself), or (b) `services.ts`'s per-target loop gets its own try/catch as defense-in-depth. Recommendation: do both — the adapter should be defensive on its own, and `services.ts` should not trust that guarantee blindly. This is a genuine gap to close as part of, not deferred past, the real-provider work (see §7).
- Classify errors the same way `src/lib/batches/adapters/write-executor.youtube.ts`'s `classifyYoutubeWriteError` does for the YouTube API, adapted to the provider's own documented error taxonomy: rate-limited/quota vs. content-policy-rejected vs. transient-network vs. permanent/misconfigured. This classification is for **operator-facing error messages only** — this module has no retry logic today and none is proposed here; a failed generation is simply reported per-target (`AC-GEN-07`'s isolation guarantee already covers this) and the operator can re-run generation for that target.

## 5. Request volume and cost control

None of this exists yet and all of it is required before any real provider is wired in:

- **Per-request cap** — `generateProposalsInputSchema` already bounds `videoIds` (≤200) and `targetLanguages` (≤50), so a single call is bounded at 10,000 provider calls in the worst case; this is far too high for a paid API and must be tightened (a real-provider config should add its own, stricter per-call cap, e.g. tens, not thousands).
- **A visible cost estimate before generation runs** — the UI (`ai-localization-panel.tsx`) should show "this will make N provider calls" before the operator clicks "Generate," using the already-deduplicated target count `generateProposals` itself computes.
- **A server-side rate limiter / concurrency cap** on outbound provider calls, analogous to Phase 5's `AC-CONCURRENCY-01` bounded concurrency for YouTube writes — sequential-with-a-cap is simplest and matches the current sequential loop in `services.ts`.
- **Optional daily/monthly budget guard** — out of scope to design in detail here (it depends on the chosen provider's own billing/usage API), but the adapter interface should expose a way to check remaining budget before generating, returning `{ status: "error", message: "budget_exceeded" }` rather than proceeding.

## 6. Secret-free configuration

Per `AGENTS.md` §F (never expose credentials to logs/browser/AI providers) and the existing pattern for OAuth (`.env.local`, gitignored):

- Provider API key(s) via environment variable(s) only (e.g. `AI_LOCALIZATION_PROVIDER_API_KEY`), read server-side only, in the new adapter file — never passed to the browser, never logged (mirrors how `GOOGLE_CLIENT_SECRET` is already handled).
- Provider selection (`"mock"` vs. a real name) via environment variable (e.g. `AI_LOCALIZATION_PROVIDER=openai`), read once in `src/lib/ai-localization/index.ts`'s `defaultProviderName`, not hardcoded — this already matches the existing `resolveLocalizationProvider(providerName)` seam; only the default source changes from a literal `"mock"` to `process.env.AI_LOCALIZATION_PROVIDER ?? "mock"`.
- Model name/version as a separate env var (e.g. `AI_LOCALIZATION_MODEL`) so switching models doesn't require a code change — the adapter reads it at construction time, never hardcodes a model string.
- **No channel-specific editorial content or prompts stored in this repository, ever** (`AGENTS.md` §B) — if/when channel-specific generation context is approved (see the separate proposal from this session), it must be supplied at call time from outside this repository's source tree, not as a committed file.

## 7. Model/provider switching

Already structurally supported: `resolveLocalizationProvider(providerName)` is the single seam. Adding a second real provider means adding a second `if` branch (or a small registry map) there, each pointing to its own adapter file. No consumer of `LocalizationProvider` needs to know which one is active. Switching models within one provider is a configuration change (§6), not a code change.

## 8. What this plan does NOT do

- Does not select a vendor.
- Does not add `openai`/`@anthropic-ai/sdk`/`deepl-node` or any other paid-provider dependency to `package.json`.
- Does not call any real network endpoint.
- Does not implement channel-specific editorial briefs (separate, currently-blocked proposal).
- Does not change `provider-registry.ts`'s behavior — it still resolves only `"mock"` today (`AC-PROVIDER-01`), verified by the existing structural test (`write-path-inventory.test.ts`).

## 9. Trigger for starting this work

An explicit project-owner decision naming: (a) the provider, (b) who bears the API cost, (c) the model/version, (d) the per-call and budget caps from §5. Until all four are decided, this remains a plan, not a task.
