# DOCS_SPLIT_PLAN — split SYSTEM_MAP.md and ARCHITECTURE.md into an index + one file per subsystem

Status: **plan only, not implemented** (2026-11-17, token plan item 3, stage B). Nothing here is done until the owner
assigns it. Stage A (slim `AGENTS.md`, `docs/WRITE_AUTHORIZATIONS.md`, `docs/AGENT_RULES_DETAIL.md`, `docs/archive/`)
is on `feature/docs-slim`.

## 1. Why

`docs/SYSTEM_MAP.md` (654 KB) and `docs/ARCHITECTURE.md` (545 KB) are on `AGENTS.md` §A's reading list. An agent
cannot read either whole (each is about 150–170k tokens), so today it greps headings and reads ranges, and a careless
agent loses a whole context window on one read. Goal: each file becomes a **short index (≤ 30 KB, about 8k tokens)**
that an agent can read whole, plus one file per subsystem that it reads only when it touches that subsystem.

## 2. Measured layout (2026-11-17, `dev` 19c2a944)

**SYSTEM_MAP.md:** header 2.2 KB; §1 data flow 0.9 KB; **§2 subsystems 627 KB** (83 `###` subsections, from
2.1 Authentication to 2.9bh); §3 where to change 2.9 KB; **§4 component status 20.4 KB**; §5 write-safety invariant
0.7 KB. Largest §2 parts: 2.9v Market Intelligence 51.5 KB, 2.9am live stream 37.7 KB, 2.8 localization read model
35.7 KB, 2.9h Automerge 21.9 KB, 2.9b AI localization 21.7 KB, 2.10 Web UI 21.4 KB, 2.9x Phase 14 21.4 KB, 2.9w
decision engine 20.3 KB, 2.9r agent operations 19.4 KB. **Duplicate anchors exist** (2.9w twice, 2.9x twice, 2.9ap
twice) — they must be disambiguated, see §5.

**ARCHITECTURE.md:** header 0.6 KB; §1–§3 2.8 KB; then 66 `##` sections from §4 Phase 2 sync (6 KB) to the unnumbered
`## BL-263 …` (4.4 KB). Largest: §14 Phase 8 64 KB, §26 media generation 47 KB, §18 Market Intelligence 37 KB, §47
publishing 33 KB, §6 Change Sets 22 KB, §23 device sync 17.5 KB. Numbers §27–§28 do not exist; the last 21 sections
have no number (`## BL-NNN — …`).

**References:** `SYSTEM_MAP` is named 98 times in 60 files (64 with a `§`), `ARCHITECTURE.md` 168 times in 58 files
(140 with a `§`), 18 of those files in `src/`/`scripts/` (comments), plus `.claude/agents/ytm-dev.md`,
`reviewer.md` and `.claude/skills/roadmap-backlog/SKILL.md`.

## 3. Target files

Moves are **verbatim and by whole section** (same method and proof script as stage A: every original line must appear
byte-identical in exactly one new file; original headings, including their numbers, are kept so `§2.9am` / `§47`
still greps). Files group subsystems by domain; the same domain gets the same file name in both folders.

| Domain file | `docs/system/` gets SYSTEM_MAP §2 parts | `docs/architecture/` gets ARCHITECTURE sections | ≈ KB sys / arch |
|---|---|---|---|
| `auth-identity.md` | 2.1, 2.2, 2.3, 2.15 | — (cross-cutting rules stay in the index) | 9 / 0 |
| `youtube-gateways.md` | 2.4, 2.9f, 2.9g, 2.9k, 2.9at | §22 audit rules, §24 data sources / API policy | 23 / 8 |
| `persistence-tests.md` | 2.5, 2.14 | §7 persistence | 7 / 5 |
| `channel-video-sync.md` | 2.6, 2.7 | §4, §8 API routes (Phase 2/3) | 5 / 8 |
| `localization.md` | 2.8, 2.9u, 2.9ay | §5, §46 channel language | 46 / 13 |
| `changesets-batches.md` | 2.9, 2.9a, 2.9au | §6, §10, §11, §12 | 37 / 33 |
| `ai-localization.md` | 2.9b, 2.9c | — | 28 / 0 |
| `video-details.md` | 2.9d, 2.9e | §9 Web UI (Phase 2/3) | 26 / 5 |
| `device-sync.md` | 2.9h, 2.9m, 2.16a, 2.16 | §13, §23, §30, §31 | 45 / 33 |
| `analytics.md` | 2.9i, 2.9n, 2.9o, 2.9p, 2.9q, 2.9t, 2.9z | §14 | 43 / 64 |
| `analytics-stored-data.md` | 2.9ad, 2.9ae, 2.9af, 2.9ap (Suggested videos), 2.9ah | §36–§40, §49 | 15 / 19 |
| `cloud.md` | 2.9j, 2.9l, 2.9ap (Cloud APIs) | §15, §16, §50 | 15 / 23 |
| `agent-operations.md` | 2.9r, 2.9s, 2.9y, 2.9aa, 2.9ab, 2.9ba, 2.9bh | §17, §21, §25, §34, BL-228, BL-248, BL-271 | 58 / 23 |
| `market-intelligence.md` | 2.9v, 2.9ac | §18, §35 | 57 / 43 |
| `decision-engine.md` | 2.9w (Decision engine), 2.9ag | §19 | 23 / 13 |
| `channel-workspaces.md` | 2.9x (Workspaces), 2.9w (Phase 13) | §20 | 4 / 5 |
| `media-generation.md` | 2.9x (Phase 14), 2.9ai, 2.9ax, 2.9ak, 2.9aw, 2.9bb, 2.9av | §26, §29, §41, §43, BL-199/134, BL-200 | 45 / 86 |
| `media-review.md` | 2.9al, 2.9ao, 2.9aj, 2.9az, 2.9bg, 2.9bd | §42, §44, §48, BL-229, BL-236, BL-241 | 25 / 30 |
| `video-costs.md` | 2.9aq | §51, §52 | 6 / 9 |
| `live-streams.md` | 2.9am | §45, BL-207 | 38 / 20 |
| `publishing.md` | 2.9an, 2.9bc, 2.9bf, 2.9bl, 2.9bn, 2.9bm | §47, BL-225, BL-238, BL-255, BL-257, BL-263, BL-265, BL-267, BL-269 | 33 / 70 |
| `channel-identity-writers.md` | — (described inside 2.9am today) | BL-210, BL-223 | 0 / 10 |
| `web-ui.md` | 2.10, 2.9ar, 2.9as | §32 interface language, §33, BL-221 | 26 / 18 |
| `interfaces.md` | 2.11, 2.12, 2.13 | — (contracts stay in `docs/interfaces.md`) | 16 / 0 |
| `disk-hygiene.md` | 2.9be | BL-237 | 4 / 3 |

`analytics.md` (arch, 64 KB), `media-generation.md` (arch, 86 KB) and `publishing.md` (arch, 70 KB) stay large; if
wanted, split them further at their `###` level in the same pass (for example `media-generation-runpod.md`,
`media-generation-gemini.md`). The 25 rows above are a starting point; the exact grouping is checked against the
inventory script's output before moving, and every section must land in exactly one file.

## 4. What stays in the index files

**`docs/SYSTEM_MAP.md` (≈ 20 KB):** the header; §1 data flow (verbatim); a new §2 **table** — one row per original
subsection: anchor (`2.9am`), one-line name, status word copied from its heading (IMPLEMENTED / PLANNED / DEFERRED),
file (`docs/system/live-streams.md`); §3 where to change (verbatim); §5 invariant (verbatim). **§4 component status
(20 KB) moves to `docs/system/component-status.md`**, and the index keeps a pointer; otherwise the index would be
over 30 KB. (Alternative: merge §4's status column into the new §2 table and drop the separate status list — smaller,
but it rewrites rather than moves, so not preferred.)

**`docs/ARCHITECTURE.md` (≈ 15 KB):** the header; §1 Stack, §2 Interfaces, §3 Domain module layering (verbatim, they
are the cross-cutting rules); a table of every other section: number or `BL-NNN`, title, file.

Both indexes start with one line: "Read this index whole; open only the subsystem file you touch."

## 5. Cross-links

- **Duplicate anchors.** Rename the second 2.9w / 2.9x / 2.9ap to unique ids (proposed: 2.9w2, 2.9x2, 2.9ap2) in the
  heading and in the index, and fix the few references that mean the second one (grep shows which by context). This
  is the only change of text in the move; it gets its own commit.
- **Existing references stay valid without edits.** `SYSTEM_MAP §2.9am` and `ARCHITECTURE.md §47` still resolve:
  the index table maps every id to its file, and the heading is unchanged inside that file. No mass rewrite of the 200+
  references in ADRs, plans, archives and `src` comments.
- **Living docs are updated:** `AGENTS.md` §A (one line: "index + subsystem files"), `.claude/agents/ytm-dev.md`
  (replace "500+ KB, never read whole, grep headings" with "read the index, then the one file"), `reviewer.md`,
  `roadmap-backlog` SKILL, `docs/DEVELOPMENT_PLAYBOOK.md` §6.12 and §6.13 (see §6).
- **Links inside moved text** to "§N above/below" keep working by number through the index; relative Markdown links
  (`[x](../decisions/…)`) get one extra `../` — the proof script lists every changed link so the reviewer sees them.
- **Guard:** a small test or script (`scripts/check-doc-index.mjs`, optional) fails if a `docs/system/*.md` or
  `docs/architecture/*.md` heading is missing from its index, or an index row points at a missing file.

## 6. Playbook §6.12 table changes

| When this changes... | ...update these (new text) |
|---|---|
| Architecture (new domain module, new data flow, new security boundary) | the domain file in `docs/architecture/` (detailed "why") and in `docs/system/` (concise "where"), **plus one row in each index**; a new domain gets a new file in both folders |
| A new feature is implemented | its `docs/system/<domain>.md` section, the row in `docs/SYSTEM_MAP.md`'s §2 index, `docs/system/component-status.md`, `docs/interfaces.md` if it adds an entry point, `docs/architecture/<domain>.md` if it changes a data flow |
| Database schema changes | `docs/architecture/persistence-tests.md` (schema section), ADR if non-additive |
| Security boundaries change | the limitation section in `docs/architecture/<domain>.md`, `docs/TECHNICAL_DEBT.md` |
| A development phase is completed | `docs/ROADMAP_STATUS.md`; the index headers ("Current as of …"); `docs/system/component-status.md` |

§6.13 Definition of Done: "docs updated" becomes "the touched domain file(s) and their index rows updated".

## 7. Steps and cost

1. Inventory script prints every `##`/`###` section with bytes; agree the grouping table (§3) — 1 short step.
2. Commit the duplicate-anchor renames (§5).
3. Move script (same pattern as stage A's `build_agents.py` + `verify_verbatim.py`): writes the files and the two
   indexes, then proves every original line is in exactly one new file. One commit per document.
4. Pointer updates in living docs and `.claude` (§5), playbook §6.12/§6.13 (§6). One commit.
5. `npm test`, `npm run lint` (no doc is read by tests today; confirmed in stage A), `git diff --check`.

**Effort:** one agent session, about 150–250k tokens (mostly reading the inventory and verifying; the moves are
scripted and never pass through the model). No code changes; risk is limited to broken references, which the proof
script and the index guard catch.

**Saving:** an agent that today greps 650 KB of headings and reads 20–60 KB ranges (often several, and sometimes a
whole file by mistake: 150k+ tokens) instead reads a ≤ 30 KB index (≈ 8k tokens) and one 5–60 KB domain file. For a
typical small slice that is about 10–25k tokens instead of 30–80k, and the worst case (a full read) drops from
≈ 170k to ≈ 8k tokens per document.

**Not in scope:** rewording or shortening any section's text; splitting `docs/TECHNICAL_DEBT.md` (414 KB after the
archive; candidate for a later, separate plan: index of open RISK ids + one file per gate); `docs/interfaces.md`.
