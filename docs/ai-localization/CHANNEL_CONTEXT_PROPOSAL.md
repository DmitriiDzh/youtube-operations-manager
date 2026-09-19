# CHANNEL_CONTEXT_PROPOSAL.md

**Status: PROPOSAL, implementation partly blocked pending a project-owner decision.** This document is written per the project owner's explicit "Phase 6 — Autonomous Quality and Integration Pass" instruction: *"Изучи текущую архитектуру каналов... Определи минимальный способ передачи в генерацию: редакционных инструкций; целевой аудитории; языка и локали; ограничений на названия и описания; предпочтений по тону и терминологии... Если требуется новое продуктовое решение, подготовь конкретное предложение и оставь реализацию заблокированной."*

It splits the request into two parts with different authorization status:

- **Part A — per-call context passthrough (implemented this session, see §1-2):** a generic, structural, zero-content extension to the existing generation request, populated only by whoever calls `generateProposals` at the moment of the call, never stored anywhere, never containing anything channel-specific written by a coding agent. This does not require a new product decision — it is the same kind of plumbing `docs/PROJECT_SPEC.md` §32's own future workflow diagram already names ("Channel localization brief" appears as an explicit step before "AI generation").
- **Part B — persistent, per-channel, operator-editable brief storage (proposed, NOT implemented, blocked — see §3):** this requires a genuine product decision (new schema, new UI, an ownership/access model) and is left for the project owner to approve or decline.

## 1. Why this needs to be a per-call parameter, not stored content in this repository

`AGENTS.md` §B is explicit and permanent, not phase-scoped: *"Never add to this repository: ... channel-specific editorial guidelines or translation prompts ... channel operation playbooks."* `docs/PROJECT_SPEC.md` §32 itself gives an example of what NOT to do inside this repo's source tree: a `channels/<channel-id>/localization/es.md` file living in the codebase. Any implementation that hardcodes, commits, or otherwise ships channel-specific instructions as part of this repository's source would violate this rule regardless of which phase is active. This proposal's Part A therefore treats editorial context as **caller-supplied, per-request, structurally generic data** — the same way `credentialRef` or `expectedChannelId` already work elsewhere in this codebase — never as content this repository authors, stores as a committed file, or invents on a channel's behalf.

**No hardcoded rules for any real channel (e.g. "Tropico Jazz", "Rural Japan Music", or any music-niche-specific instruction) exist anywhere in this change**, per the explicit instruction not to invent them.

## 2. Part A — implemented: generic per-call editorial context passthrough

Extends the existing `LocalizationGenerationRequest`/`generateProposalsInputSchema` with one new, optional, entirely generic field:

```ts
export type GenerationContext = {
  targetAudience?: string;
  toneNotes?: string;
  terminologyNotes?: string;
  titleConstraints?: string;
  descriptionConstraints?: string;
};
```

- Supplied by the API caller in the `generateProposals` request body (`editorialBrief?: GenerationContext`), validated only structurally (each field a bounded-length string; no semantic validation of *content*, since this repository must not know or care what a channel's editorial policy says).
- Forwarded unchanged to `LocalizationProvider.generate()` as part of `LocalizationGenerationRequest`, so a real provider adapter can incorporate it into its prompt/request construction. The deterministic mock provider ignores it (it has no concept of tone/audience) but does not reject a request that includes it — this proves the plumbing is provider-agnostic.
- **Never persisted.** `generateProposals` remains a pure preview step (no DB write before this change, none after). Nothing about this field is written to `change_sets`/`changes` — only the resulting `title`/`description` text is, exactly as before.
- **Never a source of hardcoded content.** No default value, no per-channel lookup, no repository-committed file backs this field — it exists purely so a caller (the operator, or in the future an authorized ops-side system) can supply it at the moment of the call.

This is implemented and tested in this session (see the diff and `docs/acceptance/PHASE_6_ACCEPTANCE.md`'s new `AC-CONTEXT-01`/`AC-CONTEXT-02` scenarios).

## 3. Part B — proposed, NOT implemented: persistent per-channel brief storage

**What it would add:** a way for an operator to save a channel's editorial brief once (target audience, tone, terminology, title/description constraints) so it doesn't have to be retyped on every generation call, and have `generateProposals` look it up and merge it with any per-call override.

**Why this is blocked pending a decision, not implemented now:**

1. **Data model decision:** where does this live — a new `channel_localization_briefs` table (channel-scoped, like `channels`/`videos`), or something else? Who can read/write it (today there is no per-user ownership boundary at all — `docs/TECHNICAL_DEBT.md` RISK-02 — so "channel-scoped" currently means "any locally authenticated session," which may or may not be the intended access model for editorial policy specifically).
2. **UI/workflow decision:** does this get its own settings screen, or live inside the AI Localization tab? Is it versioned (so a past generation can be traced to the brief text that produced it, for audit purposes matching this project's general audit-trail philosophy), or just a single mutable row per channel?
3. **Scope-boundary risk:** even though the *data* would live in this app's own SQLite database (not committed to git, arguably not "the repository" in `AGENTS.md` §B's sense the way a source file would be), it is exactly the kind of "channel-specific editorial guideline" content §B is protecting against ending up entangled with this development repository's own codebase and, transitively, with a coding agent's context (`AGENTS.md` §B's deeper concern is that Claude Code's and Codex's knowledge bases must never be shared) if this repository's tooling starts routinely reading and reasoning about specific channels' editorial policies as part of ordinary development work. Whether that risk is acceptable is a call for the project owner, not something to resolve by implementing first and asking later.
4. **Not requested by the original Phase 6 assignment's own target workflow** ("Select video and target languages → generate → validate → edit → Change Set → approval → Batch → dry-run" — no brief-management step was named there; it only appears in `docs/PROJECT_SPEC.md` §32's *future* sketch).

**If approved**, the minimal version would be: one new table (`channelId`, `targetAudience`, `toneNotes`, `terminologyNotes`, `titleConstraints`, `descriptionConstraints`, `updatedAt`), a `GET`/`PUT` API route pair channel-scoped the same way every other channel resource already is (`AGENTS.md` §F), a small settings form in the UI, and `generateProposals` loading it as the default `editorialBrief` (still override-able per call). This would be a small, additive, well-precedented change given the patterns already in this codebase — the only blocker is the product/scope decision itself, not technical difficulty.

## 4. Decision requested

- **Approve Part B** (implement persistent per-channel brief storage as sketched in §3) — a follow-up task; or
- **Decline Part B** (per-call context, Part A, remains the only mechanism indefinitely) — no further action needed; or
- **Defer** — no decision needed now; revisit when a real AI provider is actually being integrated (§32's workflow suggests the brief matters most once generation quality with a real model is being tuned).

No implementation work on Part B will proceed without one of the above.
