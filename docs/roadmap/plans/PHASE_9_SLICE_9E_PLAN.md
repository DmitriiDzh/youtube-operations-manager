# Phase 9 slice 9E — topics & trends (manual/structural, AI-assisted deferred)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§13-16 and `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9E definition ("gated on owner decision 3
for anything beyond manual/keyword-based topic tagging"), per `AGENTS.md` §L.

## 1. Scope boundary — two parts, both manual/structural, no AI call in this slice

**Part A — topic model (spec §13).** A flat, operator-defined list of topic labels
(`market_topics`), manually assigned to a watchlisted channel or a specific video
(`market_topic_assignments`). Explicitly the part decision 3 exempts from AI-gating ("manual/
keyword-based topic tagging" needs no AI Connection at all).

**Part B — trend candidates, manual/structural only (spec §14-16).** A `TrendCandidate` entity with
lifecycle states and its own evidence rows, following the exact shape 9A's own `research_evidence`/
9C's own `DiscoveryCandidate` already established: the operator creates a candidate, tags it to a
topic, and manually records supporting evidence (which channels/videos support it, and why) --
mirrors `research_evidence`'s own "a raw, sourced observation, never a value judgment invented by
this app" discipline.

**Deliberately deferred, named here rather than silently dropped:**

- **AI-assisted topic classification** -- needs a real AI Connection call (decision 3: reuse
  whichever connection the operator has selected in that UI context, per direct inspection of
  `ai-localization`'s own resolution mechanism: `connectionId` is a plain, caller-supplied,
  per-call field -- there is no backend "this channel's own connection" concept to look up, so 9E
  mirrors that exact pattern rather than inventing a new one). A real paid AI call needs its own
  separate authorization (`AGENTS.md` §K.4) regardless of decision 3 answering WHICH connection to
  use -- this slice ships code-complete against a mock provider only (mirrors
  `ai-localization/adapters/mock-provider.ts`'s own "connection-optional, mock is clearly labeled"
  rule), never a real call.
- **Automatic/computed trend detection** (cross-referencing 9D's breakout/emerging signals across
  channels sharing a topic to surface a trend candidate on its own) -- needs real accumulated,
  multi-channel history this codebase does not have yet (the same BL-105 limitation 9D's own plan
  already named). This slice's trend candidates are entirely operator-created and evidenced by
  hand, exactly like `research_evidence` already is; nothing here infers a trend automatically.
- Creative/visual analysis (spec §17, thumbnail composition etc.) -- not assigned to any slice in
  `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9A-9I list; out of scope for the current phase.

## 2. Schema additions (SCHEMA_MIGRATIONS v26 — v24/v25 already committed to this branch; even
though v25 has not yet reached the real local database, per the same discipline as RISK-63, never
edit an already-committed migration in place)

```sql
CREATE TABLE IF NOT EXISTS market_topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_via TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS market_topic_assignments (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES market_topics(id),
  subject_type TEXT NOT NULL,           -- 'channel' | 'video'
  subject_id TEXT NOT NULL,             -- research_channels.id, or a bare YouTube video id
  source TEXT NOT NULL,                 -- 'manual' | 'ai_assisted' (always 'manual' this slice)
  created_via TEXT NOT NULL,
  assigned_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX ... ON market_topic_assignments(topic_id);
CREATE INDEX ... ON market_topic_assignments(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS market_trend_candidates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  topic_id TEXT REFERENCES market_topics(id),   -- nullable -- a trend need not be topic-tagged yet
  status TEXT NOT NULL,                          -- emerging|growing|established|declining|stale
  first_observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_observed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  created_via TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_trend_evidence (
  id TEXT PRIMARY KEY,
  trend_candidate_id TEXT NOT NULL REFERENCES market_trend_candidates(id),
  evidence_type TEXT NOT NULL,          -- 'supporting_channel' | 'supporting_video' | 'signal'
  reference_id TEXT,                    -- a channelId/videoId when evidence_type needs one
  description TEXT NOT NULL,            -- the observation itself (spec §16: channel/video counts,
                                         -- breakout counts, persistence across dates, etc.)
  created_via TEXT NOT NULL,
  recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`market_topic_assignments.subject_id` is intentionally NOT a foreign key when `subject_type =
"video"` -- `market_video_snapshots` has no single canonical one-row-per-video table (it's an
append-only observation series, 9A's own design), so a video is identified by its bare id, the same
way `research_evidence`/9A's own tables already reference videos informally. **Not a dedicated
`EvidenceReference`/`evidenceReferenceSchema` reuse** (`shared-provenance`) -- that shape is for
citing an EXTERNAL url-based source (owner spec §13's original context: an agent's own outside
research), a mismatch for "this trend is supported by these N of our own already-tracked channels" --
`market_trend_evidence` is its own, purpose-built shape instead.

## 3. Module additions (`src/lib/market-intelligence/`)

Topic actions: `createTopic`, `listTopics`, `assignTopic({ topicId, subjectType, subjectId })`,
`removeTopicAssignment`, `listAssignmentsForTopic`, `listTopicsForSubject({ subjectType,
subjectId })`.

Trend actions: `createTrendCandidate({ title, description?, topicId? })`,
`listTrendCandidates`, `updateTrendCandidateStatus({ trendCandidateId, status })` (touches
`lastObservedAt`), `recordTrendEvidence({ trendCandidateId, evidenceType, referenceId?,
description })`, `listTrendEvidence({ trendCandidateId })`.

No YouTube API call anywhere in this slice -- purely local structured/manual data, same as 9A's
`recordChannelSnapshot`/`recordVideoSnapshot`. No new read-gateway function, no new quota spend.

## 4. API routes (Web UI only, mirrors 9C's own route shape) + minimal Research-tab UI

- `GET/POST /api/market-intelligence/topics`
- `POST/DELETE /api/market-intelligence/topics/[topicId]/assignments`
- `GET /api/market-intelligence/trend-candidates`, `POST` to create
- `PATCH /api/market-intelligence/trend-candidates/[trendCandidateId]` (`{ status }`)
- `GET/POST /api/market-intelligence/trend-candidates/[trendCandidateId]/evidence`

A minimal "Topics & trends" section on the Research tab (create a topic, tag a watchlisted channel
with it, create/list trend candidates with their evidence) -- shipped now, not deferred to 9H, per
the same "an API-only slice with no caller is dead code" reasoning 9C's own plan already stated.

## 5. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- A topic name must be unique; creating a duplicate is rejected, never silently creating a second
  row or silently overwriting.
- `assignTopic` rejects an unknown `topicId` before storage; `subjectType` is one of exactly
  `"channel"`/`"video"`, never a caller-supplied arbitrary string.
- `updateTrendCandidateStatus` accepts only the 5 named lifecycle states; an unknown value is
  rejected before storage, never silently accepted.
- `recordTrendEvidence` rejects an unknown `trendCandidateId` before storage.
- Every trend-candidate/topic-assignment write is server-stamped `createdVia` from `callOrigin`,
  never caller-supplied (mirrors every other action in this module).
- Schema initialization succeeds against both a fresh empty database and the pre-migration re-apply
  path.
- `PHASE9-INV-02` catches a raw-SQL reference to any of the 4 new tables from outside the module
  (verified by probe file, per 9B/9C's own precedent).

## 6. Explicitly out of scope for 9E

- AI-assisted topic classification (needs its own separate real-AI-call authorization, `AGENTS.md`
  §K.4) -- code-complete against a mock provider only, if built at all this slice; may be deferred
  entirely to a later, explicitly-assigned follow-up if time does not allow it in this pass.
- Automatic/computed trend detection from 9D's own signals -- needs real multi-day, multi-channel
  history (BL-105).
- Cross-channel trend evidence AGGREGATION (spec §16's own "number of independent channels"-style
  computed rollups) -- this slice records evidence rows manually; computing/displaying an aggregate
  count from them is a thin read-side convenience that can be added later without a schema change.
- Creative/visual analysis (spec §17) -- not assigned to any slice in the current plan.
