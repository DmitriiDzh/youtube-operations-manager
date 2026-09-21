# Architectural Decision Records (ADR) — Policy

Lightweight ADR policy for this repository, introduced in Phase 4.5 (`docs/DEVELOPMENT_PLAYBOOK.md` §6.12 references this).

## When an ADR is required

Write an ADR **before** (or, for a retrospectively reconstructed one, immediately after discovering an undocumented decision already made) any of the following:

- replacing authentication (NextAuth, OAuth flow, credential storage model);
- changing the database migration strategy (e.g. moving off the current idempotent `CREATE TABLE IF NOT EXISTS` pattern to Drizzle Kit migrations — see `docs/ARCHITECTURE.md` §7.2 for the threshold condition);
- replacing the database engine;
- breaking an existing API or MCP tool contract (not just adding a new one);
- replacing a major subsystem (e.g. the YouTube client layer in `src/lib/youtube.ts`, the YouTube write gateway in `src/lib/youtube-write-gateway/`, the `write-context` guardrail);
- changing the YouTube write-safety architecture (`docs/PROJECT_SPEC.md` §21, §61–65);
- a significant framework migration (Next.js major version, moving off Drizzle/libSQL, etc.).

**Do not** write an ADR for trivial implementation details — a new domain module following the existing `contracts/schemas/services/adapters` pattern, a new API route, a new CLI command, or a new test does not need one. Those are covered by `docs/DEVELOPMENT_PLAYBOOK.md`'s established patterns instead.

## Format

Each ADR is a numbered Markdown file, `NNNN-short-title.md`, with these sections:

```markdown
# NNNN. Short title

Status: Proposed | Accepted | Superseded by NNNN

## Context
What situation makes this decision necessary?

## Problem
What specifically needs to be decided?

## Alternatives
What options were considered, with real tradeoffs (not a strawman list)?

## Decision
What was actually decided?

## Rationale
Why this option over the alternatives?

## Consequences
What does this make easier or harder going forward?

## Compatibility / migration impact
Does this break an existing contract? Is there a migration path for existing local data (`data/playlist-manager.db`)?
```

## Retrospective ADRs

A decision made before this policy existed (e.g. the Phase 2 choice to keep additive idempotent schema initialization instead of introducing Drizzle Kit migrations, documented inline in `docs/ARCHITECTURE.md` §7.2) may be captured as a retrospective ADR. Such a document must say so explicitly at the top — do not present a reconstructed rationale as if it were written at decision time. `docs/decisions/0001-additive-idempotent-schema-strategy.md` is the first example of this.

## Index

| # | Title | Status |
|---|---|---|
| [0001](0001-additive-idempotent-schema-strategy.md) | Keep additive idempotent schema initialization instead of Drizzle Kit migrations | Accepted (retrospective) |
| [0002](0002-additive-schema-versioning.md) | Layer explicit schema versioning on top of the additive idempotent boot pattern | Accepted |
| [0003](0003-published-release-snapshots.md) | In-repo `published/<version>/` release snapshots, committed directly on `main` | Accepted |
| [0004](0004-active-channel-read-scoping.md) | Every channel-scoped read is filtered to the session's active channel | Accepted |
| [0005](0005-youtube-write-gateway.md) | A single gateway module is the only path any code may use to write to YouTube | Accepted |
