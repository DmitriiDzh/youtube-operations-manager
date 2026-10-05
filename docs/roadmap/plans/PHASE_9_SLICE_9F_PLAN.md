# Phase 9 slice 9F — niche discovery (fixture-only, no real caller yet)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_PLAN.md` §14's
own 9F definition ("Depends on 9C-9E having accumulated enough real data to be meaningful —
explicitly the least-ready slice; do not start it before that data exists") and owner spec §30's
"Opportunities" section (niche concept, representative channels/videos, evidence, unknowns).

## 1. Why fixture-only, not a real service/API/UI slice

The plan's own precondition ("9C-9E have accumulated enough real data") cannot be satisfied on this
branch before merge: `dev`/`main` cannot run against this machine's real database at all until Phase
9 merges (RISK-63 — the real DB is already ahead of `dev`/`main`'s own schema version), and running
this branch's own dev server against that same real database would migrate it further still, with no
real 9C/9E collection ever actually having accumulated multi-day history. Building a real service
action, API route, or UI panel now would mean shipping an unexercised, unverifiable-against-real-data
feature — exactly what `docs/roadmap/plans/PHASE_9_PLAN.md` §15's own acceptance-criteria split
warns against for this class of Phase 9 work.

**Chosen instead (mirrors 9D's own precedent — `historical-intelligence.ts` shipped as pure
functions with zero real callers, gaining its first caller two slices later in 9H part A):** a new
`niche-discovery.ts`, pure functions only, hand-tested against fixed, spec-derived fixtures
(`AGENTS.md` §L). No new table, no new service action, no new route, no new UI. A real caller (a
service action wrapping these functions over genuinely-accumulated `market_topics`/
`market_trend_candidates`/`market_discovery_candidates` data) is its own, later, separately-assigned
slice — the same "Opportunities" tab this unblocks in 9H is deferred with it.

## 2. What the pure functions cover (owner spec §30 "Opportunities" fields)

A "niche" here is deliberately **not** a new entity/table — it is a computed *grouping* over
already-existing 9C/9E entities (discovery candidates, topics, trend candidates), never a fabricated
new opinion:

- `groupCandidatesByTopic(candidates, assignments)` — partitions `market_discovery_candidates`/
  `market_trend_candidates` rows by their existing `market_topic_assignments`, producing one group
  per topic with 2+ members (a "niche concept" is only surfaced when at least 2 independent
  discovery/trend entries already share a topic — never a single data point dressed up as a trend,
  per spec §10's "do not assume one universal baseline formula" applied here: no minimum-group-size
  claim is invented without this same discipline).
- `describeNicheEvidence(group)` — returns the group's own representative channels/videos (the
  underlying candidates/trend-candidate ids themselves, never a fabricated title or url) and an
  explicit `unknowns` list (e.g. "no trend evidence beyond initial discovery" when a group has
  candidates but no linked `market_trend_evidence` rows) — spec §30's own "unknowns" field, honestly
  computed, not omitted.
- No scoring, no "opportunity score" — owner spec's own repeated prohibition on opaque scores
  (already enforced the same way in 9D's `assessBreakout`) applies here identically: a niche is
  reported with its raw member list and evidence, never a single ranked number.

## 3. Test plan

Hand-computed fixtures only (`AGENTS.md` §L): a set of discovery candidates and trend candidates with
known topic assignments, asserting the exact expected groupings by hand; a boundary case (exactly 1
member — must NOT be reported as a niche); a case with zero shared-topic members at all (empty
result, no crash); a group with candidates but no trend evidence (asserts the specific `unknowns`
entry, not a generic "no data").

## 4. Documentation

`docs/SYSTEM_MAP.md` §2.9v gains a one-line 9F bullet (code-complete, zero callers, same as 9D/9I at
their own equivalent stage) once implemented. No `docs/interfaces.md` change (no new contract).
