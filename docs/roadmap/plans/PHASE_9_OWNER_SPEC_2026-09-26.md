# Phase 9 Owner Spec — 2026-09-26 (verbatim)

Received over Telegram (chat_id `331110302`, message_id `898`, 2026-09-26T16:37:44Z), preceded by
the instruction: *"Дополнительное описание фазы 9. Сделай анализ и составь новый план выполнения."*
("Additional description of Phase 9. Do an analysis and produce a new execution plan.")

This file is the **verbatim source text** the owner sent, stored here because Telegram's Bot API
keeps no message history and this session's own context can be compacted or lost — without a
durable copy, nothing would trace `docs/roadmap/plans/PHASE_9_PLAN.md`'s acceptance criteria (per
`AGENTS.md` §L) back to the actual requirement they were derived from. **Never edited** — if the
requirement changes, record the change where it happened (a new dated instruction, or an update to
`PHASE_9_PLAN.md` citing this file plus what changed), not by rewriting this file in place.

This text is **not** currently reflected in `docs/PROJECT_SPEC.md` — that file has zero mentions of
"Phase 9," "market," or "competitor" as of this writing. `docs/roadmap/FUTURE_PHASES.md` §5 has a
much shorter strategic summary that predates and is consistent with this spec, but this is the
first time the detailed technical/architectural requirement has been recorded anywhere. See
`docs/roadmap/plans/PHASE_9_PLAN.md` for the analysis and execution plan built from this spec.

---

# Phase 9 — Market Discovery & Trend Intelligence

## Goal

Extend YouTube Operations Manager from owned-channel analytics into external market intelligence.

Phase 8 answers:

"What is happening on our own channels?"

Phase 9 must answer:

"What is happening in the surrounding YouTube market, which channels/videos/topics/formats are gaining momentum, and what public evidence supports that conclusion?"

The system must provide structured, historical, explainable market intelligence to operational agents through the existing Agent Operations Interface.

Do not reduce this phase to a static competitor list.

Do not treat AI summaries as ground truth.

The core value of Phase 9 is:

- discovery;
- historical public observations;
- trend detection;
- evidence/provenance;
- agent-readable market context.

---

## 1. Core principles

### 1.1 Separate owned analytics from public market data

Owned/private analytics may contain metrics such as:

- impressions;
- CTR;
- retention;
- watch time;
- traffic sources;
- geography;
- subscriber impact.

Competitor/public market data must only contain metrics actually observable from public sources or explicitly marked third-party estimates.

Never fabricate or infer competitor:

- CTR;
- retention;
- watch time;
- traffic sources;
- revenue;
- subscriber conversion.

If a third-party provider later supplies estimated metrics, mark them clearly as estimates and keep them separate from official/public facts.

### 1.2 Preserve evidence and freshness

Every important market observation or derived insight must carry:

- source;
- observedAt / retrievedAt;
- freshness;
- provenance;
- relevant entity IDs;
- data window where applicable.

Every trend or market candidate must be explainable through underlying observations.

### 1.3 Facts and interpretation are different

Maintain explicit separation between:

FACT
observed public data.

DERIVED
computed deltas, velocity, baselines.

INFERENCE
interpretation such as "topic may be gaining momentum".

HYPOTHESIS
proposal for future testing.

Phase 9 may generate inference.

Phase 10 will own controlled decision and experiment logic.

---

## 2. Market data model

Create a provider-agnostic market intelligence model.

At minimum support entities equivalent to:

- MarketChannel
- MarketVideo
- MarketObservation
- DiscoveryCandidate
- Watchlist
- Topic
- TrendCandidate
- NicheCandidate / MarketOpportunityCandidate
- EvidenceReference

Do not overfit the schema to music channels.

The model must support arbitrary YouTube niches and formats.

---

## 3. Discovery

Implement a discovery subsystem capable of finding previously unknown:

- channels;
- videos;
- topics;
- formats;
- niches.

Discovery should begin from configurable seeds such as:

- search queries;
- known channels;
- topics;
- language/region constraints.

But seed configuration must not become a permanent market boundary.

The system should be able to expand discovery through newly observed channels, videos and topic patterns.

Do not create unbounded recursive crawling.

Use explicit budgets and limits.

Conceptually support a Market Discovery Profile:

- related owned channel, if any;
- seedQueries;
- seedChannels;
- seedTopics;
- languages;
- regions where applicable;
- excluded terms;
- discovery budget;
- refresh policy.

---

## 4. Discovery candidates

Do not automatically classify every discovered object as a competitor.

Create candidate states such as:

- new;
- watching;
- promoted;
- ignored;
- archived.

A candidate should preserve:

- discovery source;
- reason discovered;
- related seed/query/channel;
- relevance signals;
- firstSeenAt;
- lastSeenAt.

Allow future operator or agent promotion into active watchlists.

---

## 5. Watchlists

Support dynamic watchlists for:

- channels;
- videos;
- topics;
- queries.

Watchlist membership may originate from:

- operator choice;
- discovery rules;
- agent draft proposals.

Do not assume a fixed maximum number of competitors.

Use priority and collection budgets instead.

---

## 6. Observation engine

Discovery finds objects.

Observation tracks them over time.

Persist historical public observations rather than only latest state.

For public videos, capture only data actually available, such as:

- title;
- description where available;
- publication date;
- duration;
- public views;
- public likes/comments where available;
- thumbnail reference;
- availability/status;
- channel association.

For public channels, capture only observable fields such as:

- channel identity;
- public subscriber count where available;
- public video count;
- public view count where available;
- recent upload activity;
- latest observation time.

Use append-only or history-preserving observations where practical.

Do not overwrite history in a way that prevents later trend analysis.

---

## 7. Historical snapshots

Historical snapshots are a core requirement.

The system must be able to answer questions such as:

"How many public views did this video have on each observation date?"

Example:

Sep 1: 10,000
Sep 2: 35,000
Sep 3: 82,000
Sep 5: 175,000

Do not store only the current 175,000 value.

This history is required for meaningful public growth analysis.

---

## 8. Derived public performance

Build derived metrics on top of raw observations.

Examples:

- views gained since previous observation;
- views velocity over configurable windows;
- upload cadence;
- age-normalized performance;
- channel baseline;
- relative performance against channel baseline.

Prefer retaining raw observations so formulas can evolve later.

Do not make derived metrics the only stored representation.

---

## 9. Age-normalized comparison

Avoid comparing old and new videos only by total views.

Support age-relative analysis such as:

- views at day 1;
- views at day 3;
- views at day 7;
- views at day 30;

where observation history makes this possible.

Expose limitations when history is incomplete.

---

## 10. Channel baselines

Compute useful public baselines per observed channel.

Examples:

- median recent video views;
- median age-normalized views;
- median recent velocity;
- recent upload frequency.

Do not assume one universal baseline formula.

Store enough raw data to change the methodology later.

---

## 11. Breakout detection

Detect videos that materially outperform the normal recent baseline of their own channel.

This is important for identifying early signals from smaller channels.

Example logic:

Channel typical 7-day performance: 10k views
New video 7-day performance: 90k views

This is potentially more interesting than a large channel performing only slightly above its usual baseline.

Breakout detection must expose the underlying comparison.

Do not provide opaque "viral scores" without components.

---

## 12. Emerging channel detection

Identify channels showing unusual recent momentum.

Possible signals:

- multiple recent breakout videos;
- sustained acceleration;
- increased upload success;
- unusual relative performance;
- new successful format adoption.

Do not label a channel "promising" without observable supporting data.

Expose why it was surfaced.

---

## 13. Topic model

Support market topics independently from channels.

Examples may include:

- japanese countryside rain;
- night jazz bar;
- train ambience;
- retro cocktail lounge.

Do not hard-code these examples.

Initial topic grouping may use:

- normalized keywords;
- search-query relationships;
- manual associations;
- AI-assisted classification.

Do not require embeddings or a vector database unless actual use cases justify it.

---

## 14. Trend candidates

Create structured TrendCandidate objects.

A trend candidate should be able to contain:

- title;
- description;
- related topic IDs;
- firstObservedAt;
- lastObservedAt;
- supporting channels;
- supporting videos;
- evidence references;
- observed signals;
- freshness;
- lifecycle state.

Potential lifecycle states:

- emerging;
- growing;
- established;
- declining;
- stale.

Do not allow lifecycle labels to exist without supporting observable rules or evidence.

---

## 15. Trend != popularity

Explicitly distinguish:

- popularity;
- momentum;
- novelty;
- persistence.

A large evergreen topic is not automatically a current trend.

A trend should reflect changing behavior over time.

---

## 16. Cross-channel trend evidence

A strong trend signal should be able to show that similar behavior appears across multiple independent channels.

Expose signals such as:

- number of independent channels;
- number of related recent videos;
- number of breakout examples;
- persistence across multiple observation dates.

Avoid treating one viral video as sufficient evidence for a broad trend unless clearly marked as weak evidence.

---

## 17. Creative intelligence

Support public creative analysis for market videos.

Potential attributes include:

- thumbnail composition;
- text/no text;
- human/no human;
- landscape/close-up;
- architecture/nature;
- visual mood;
- color/palette descriptors;
- title structure;
- duration/format;
- packaging patterns.

AI-derived visual/title attributes must be marked as model-derived observations.

Never translate public view performance into claims about competitor CTR.

Use wording equivalent to:

"Videos with this observed visual pattern show stronger public view velocity in this sample"

not:

"This thumbnail has better CTR."

---

## 18. Thumbnail handling

Do not permanently download everything by default.

A market video may store:

- thumbnail URL;
- thumbnail hash;
- cached preview;
- analysis metadata.

Use controlled retrieval where actual visual inspection is needed.

Keep public market thumbnails separate from owned production assets.

---

## 19. Format intelligence

Support extensible format descriptors such as:

- long-form;
- short-form;
- livestream;
- static image;
- animated loop;
- POV;
- cinematic landscape;
- narration;
- music compilation.

Do not hard-code current music-channel production assumptions into the core model.

---

## 20. Niche discovery

Phase 9 must be able to surface market opportunities outside the user's current channels.

Create a NicheCandidate / MarketOpportunityCandidate abstraction.

It should preserve:

- concept;
- representative channels;
- representative videos;
- observed growth signals;
- activity/supply;
- competition observations;
- format patterns;
- evidence;
- unknowns;
- risks.

This is not yet a recommendation to launch a channel.

Phase 9 discovers and describes.

Phase 10 will decide whether something deserves an experiment.

---

## 21. Public competition observations

Where useful, expose descriptive market structure such as:

- number of active observed channels;
- recent upload volume;
- concentration of public views;
- number of emerging channels;
- number of recent breakout videos.

Do not collapse these into arbitrary 0-100 "competition scores" unless a transparent methodology exists.

Prefer exposing components.

---

## 22. External provider architecture

Keep market intelligence provider-agnostic.

Possible future sources include:

- YouTube public API;
- web research;
- Google Trends;
- third-party SEO/trend providers;
- manual evidence.

Do not integrate all providers in this phase unless justified.

Initial implementation may rely primarily on public YouTube data.

Every source type must preserve provenance.

---

## 23. Evidence model

Every important trend/niche inference should reference evidence.

Conceptually:

EvidenceReference:
- sourceType;
- sourceId / URL;
- observedAt;
- claim supported;
- structured snapshot/reference;
- freshness.

The user and operational agent must be able to inspect why an insight exists.

---

## 24. Freshness

Market intelligence becomes stale quickly.

Expose freshness at all levels:

- observations;
- channels;
- videos;
- trends;
- niche candidates.

Aggregated intelligence should include:

- computedAt;
- dataWindow;
- latestObservationAt.

Agents must be able to detect stale intelligence.

---

## 25. Collection scheduler

Reuse existing Phase 8 scheduling infrastructure where appropriate.

Do not create a second unrelated scheduler unless necessary.

Support distinct job types such as:

- discovery;
- observation refresh;
- watchlist refresh;
- trend recomputation.

Failures must be visible and auditable.

---

## 26. Quota and budget management

YouTube API quota consumption must be explicit.

Implement centralized discovery/observation budgets.

Differentiate expensive discovery operations from cheaper refresh operations.

Support configurable priorities such as:

- hot/new video: frequent refresh;
- active competitor: regular refresh;
- stable channel: lower frequency;
- ignored candidate: no refresh.

Do not allow uncontrolled recursive search to consume the daily quota.

Expose quota-limited or partially collected states.

---

## 27. Data quality

Create structured quality states such as:

- insufficient_history;
- missing_snapshot;
- stale_observation;
- deleted_video;
- private_video;
- hidden_subscriber_count;
- partial_discovery;
- quota_limited.

Agents must receive these limitations instead of silently interpreting incomplete data as complete.

---

## 28. Agent Operations integration

Integrate Phase 9 with the existing Agent Operations Interface.

Operational agents should be able to retrieve market intelligence without direct DB access.

Provide a coherent tool set, conceptually supporting tasks such as:

- search market intelligence;
- list discovered channels/videos;
- get market channel context;
- get market video context;
- query historical observations;
- list trend candidates;
- inspect trend evidence;
- list niche candidates;
- inspect niche evidence.

Prefer a small number of powerful composable MCP tools over many thin wrappers.

Maintain existing READ/DRAFT permission boundaries.

---

## 29. Agent-created research requests

Allow an operational agent to create structured research/discovery drafts.

Example:

"Monitor Japanese countryside night ambience for 30 days."

This must not automatically create unlimited collection jobs.

Respect:

- permissions;
- quotas;
- budgets;
- operator approval where appropriate.

Do not grant APPROVE/EXECUTE implicitly.

---

## 30. UI

Provide practical inspection UI.

Minimum useful areas:

### Market Overview
- new discoveries;
- breakout videos;
- emerging channels;
- trend candidates;
- active watchlists;
- stale/failed collection warnings.

### Channels
- channel;
- last observed;
- public scale indicators;
- upload cadence;
- recent relative performance;
- why watched.

### Videos
- title;
- channel;
- publication date;
- public views;
- recent velocity;
- relative performance;
- topic/format.

### Trends
- trend;
- lifecycle;
- first seen;
- latest evidence;
- independent channels;
- representative videos;
- freshness.

### Opportunities
- niche concept;
- representative channels/videos;
- evidence;
- unknowns.

Support drill-down into raw evidence and observation history.

---

## 31. AI-generated summaries

AI may create research summaries.

Treat them as generated interpretations, not canonical facts.

Store, where useful:

- generatedAt;
- provider/model;
- evidence references;
- relevant prompt/version metadata.

The underlying evidence remains authoritative.

---

## 32. Relationship to Phase 8

Phase 8 remains the owned-channel intelligence layer.

Phase 9 is public market intelligence.

Do not merge their data semantics.

The system should eventually support agent workflows like:

"Find external formats showing unusual public momentum and compare them with formats that historically perform well on our own channel."

Phase 9 supplies external evidence.

Phase 8 supplies owned evidence.

Phase 10 will turn the combination into controlled decisions/experiments.

---

## 33. Relationship to Phase 10

Do not implement the Decision & Experiment Engine in Phase 9.

Phase 9 may produce:

- trends;
- niche candidates;
- research summaries;
- evidence-backed inferences.

It should not automatically decide:

- launch a new channel;
- change a thumbnail;
- change publication strategy;
- produce a video;
- publish content.

Those belong to Phase 10 and later production/publishing systems.

---

## 34. Explicit non-goals

Do not implement in Phase 9:

- automatic content generation;
- automatic media production;
- automatic publishing;
- automatic YouTube metadata changes;
- experiment execution;
- revenue estimation without real data;
- competitor CTR/retention estimation;
- unrestricted scraping framework;
- full multi-platform social intelligence;
- mandatory graph DB;
- mandatory vector DB;
- black-box opportunity scoring.

---

## 35. Suggested implementation slices

Plan the phase in incremental slices.

Suggested structure:

### 9A — Market Data Model
- market channels;
- market videos;
- observations;
- discovery candidates;
- watchlists;
- evidence;
- provenance.

### 9B — Public YouTube Collector
- known channel refresh;
- known video refresh;
- snapshots;
- scheduler integration;
- quota accounting.

### 9C — Discovery
- seed queries;
- search;
- deduplication;
- candidate creation;
- relevance filtering;
- bounded recursive expansion.

### 9D — Historical Intelligence
- deltas;
- velocity;
- age-normalized performance;
- channel baselines;
- breakout detection;
- emerging-channel signals.

### 9E — Topics & Trends
- topic grouping;
- cross-channel evidence;
- trend candidate creation;
- lifecycle/freshness.

### 9F — Niche Discovery
- clustering/aggregation;
- niche candidates;
- representative evidence;
- uncertainty/unknowns.

### 9G — Agent Interface
- MCP/CLI market queries;
- structured evidence retrieval;
- research drafts.

### 9H — UI
- Overview;
- Channels;
- Videos;
- Trends;
- Opportunities;
- drill-down.

### 9I — Operational Hardening
- quota controls;
- stale data;
- scheduler failures;
- deleted/private content;
- data-quality diagnostics.

Do not implement every slice blindly.

First inspect existing Phase 8 collector/scheduler/analytics infrastructure and reuse it where appropriate.

---

## 36. Acceptance criteria

Phase 9 is not complete until the system can demonstrate all of the following.

### Discovery
Starting from configured seeds, the system discovers previously unknown relevant:
- videos;
- channels;
- topics.

### History
At least one public video has multiple persisted observations and public performance change can be reconstructed over time.

### Breakout detection
The system can identify a video materially outperforming the recent public baseline of its own channel and show the calculation/evidence.

### Emerging channels
The system can surface a channel because of observable recent momentum and explain why.

### Trend evidence
At least one TrendCandidate is supported by multiple independent public observations.

### Cross-channel evidence
A trend can show representative evidence from multiple channels where available.

### Freshness
The user and agent can see when market intelligence was last observed/computed.

### Quality limitations
Incomplete/stale/quota-limited data is explicitly represented.

### Owned/public separation
Private owned-channel analytics are never silently mixed with competitor/public observations.

### Agent access
An external operational agent can, through MCP:
1. retrieve relevant market candidates;
2. inspect evidence;
3. inspect historical observations;
4. generate a research summary/proposal;
5. remain within READ/DRAFT permissions.

### Quota safety
Discovery cannot recursively exhaust YouTube API quota without configured limits.

### Audit/provenance
The system can explain where each important observation or market insight came from.

---

## 37. End-state example

After Phase 9, an operational agent should be able to answer a request such as:

"Analyze the market around Rural Japan Music and identify new formats worth investigating."

Using structured system data, the agent should be able to retrieve:

- owned channel context from Phase 8;
- related market topics;
- emerging public videos;
- breakout videos;
- emerging channels;
- trend candidates;
- evidence;
- freshness.

The result should be evidence-backed, for example:

"Over the last 21 days, a cluster of 14 related videos appeared across 7 independent channels. Five materially exceeded the recent baseline of their own channels. The earliest observed acceleration began 18 days ago. These are the representative examples and observation histories."

The system must expose the evidence supporting such a statement.

---

## 38. Architectural priority

Prioritize:

1. historical observations;
2. provenance;
3. freshness;
4. evidence;
5. quota-safe discovery;
6. agent access.

Do not prioritize AI-generated summaries over the underlying data foundation.

The most valuable long-term asset created by Phase 9 is a reliable historical dataset of public market observations.

Historical public data that is not collected today often cannot be reconstructed later.

---

## 39. Planning and implementation process

Before implementation:

1. inspect the current repository;
2. inspect Phase 8 collector, scheduler, analytics and data-quality architecture;
3. inspect Phase 7 Agent Operations Interface;
4. identify reusable infrastructure;
5. prepare a detailed Phase 9 implementation plan;
6. define acceptance tests independently;
7. identify YouTube API quota implications;
8. identify any required owner decisions.

Do not begin Phase 10.

Do not implement speculative infrastructure without a validated requirement.

Follow the repository's AGENTS.md and approved Git workflow.

At completion, report in Russian:

- architecture implemented;
- data sources used;
- discovery behavior;
- observation/history behavior;
- trend/breakout methodology;
- quota controls;
- MCP/CLI capabilities;
- UI;
- tests;
- known limitations;
- implementation vs future extension points;
- Git state.
