# Coding Agent Instructions

This is the **primary persistent instruction file** for any coding agent (Claude Code or otherwise) working in this repository. `CLAUDE.md` exists only to import this file (`@AGENTS.md`) — do not duplicate rules there instead of here.

This file intentionally does **not** duplicate `docs/PROJECT_SPEC.md` (product requirements/roadmap) or `docs/DEVELOPMENT_PLAYBOOK.md` (how-to procedures). It states the persistent rules; those other documents state the "what" and the "how."

## A. Mandatory documentation reading

Before making architectural, product, or safety-critical changes, read (in this order, skip only what is genuinely irrelevant to the task at hand):

1. `docs/PROJECT_SPEC.md` — product roadmap, YouTube write-safety rules, upstream relationship, phases, acceptance criteria.
2. `docs/ROADMAP_STATUS.md` — which phase is actually complete, as of which commit, and what is assigned next; check this before assuming a phase's status from `docs/PROJECT_SPEC.md`'s numbering alone.
3. `docs/SYSTEM_MAP.md` — current, concise map of every subsystem (what exists, where, IMPLEMENTED/PLANNED/DEFERRED).
4. `docs/ARCHITECTURE.md` — detailed internal architecture, data flows, and documented limitations.
5. `docs/DEVELOPMENT_PLAYBOOK.md` — how to extend the actual codebase following established patterns.
6. `docs/TECHNICAL_DEBT.md` — known risks and the release gates they block; check before touching anything a risk entry references.
7. `docs/decisions/` — architectural decision records; check before replacing/altering anything an ADR governs.

For historical/baseline context only (not requirements sources): `docs/UPSTREAM_ANALYSIS.md`, `docs/UPSTREAM_BASELINE.md`.

**What counts as "architectural, product, or safety-critical" (added 2026-09-21, at the project owner's request to reduce unnecessary token spend on small slices).** This full seven-document pass is required when the change does at least one of the following: introduces a new subsystem, module boundary, or reusable pattern that other work will build on; touches write-safety, channel identity, conflict detection, approval integrity, or data preservation (the same category `docs/PROJECT_SPEC.md` §21/§27/§30 and `docs/TECHNICAL_DEBT.md`'s Gate B already single out for §L's own stricter testing rules); changes a persisted schema or a public API/MCP contract; or it is genuinely unclear whether the change is architectural. A small, additive slice within an already-assigned phase that extends an established pattern along lines the codebase already follows (a UI tweak, a narrow bug fix, one more field/route/test following an existing module's own conventions) does not require rereading the full list — read only the specific section(s) of `docs/SYSTEM_MAP.md`/`docs/ARCHITECTURE.md` that describe the subsystem being touched, plus whichever other entries in this list actually bear on the change. When genuinely unsure which category a change falls into, read more, not less — this note narrows the reading list for clearly small changes, it never creates a loophole to skip reading something safety-relevant.

The current implementation in `src/**` is the source of truth for **what actually exists**. `docs/PROJECT_SPEC.md` is the source of truth for **what is required**. If documentation and implementation disagree, identify and report the discrepancy — do not silently rewrite requirements to match an incomplete implementation, and do not silently rewrite documentation to claim something is implemented when it is not.

## B. Development / operations separation

This repository is the **development side only**.

```text
DEVELOPMENT SIDE                          OPERATIONS SIDE

Claude Code                               Independent operations agent (Codex)
    |                                          |
    v                                          v
Source repository                         Released product
    |                                          |
    v                                          v
Build / Test / Release preparation        MCP / API
                                               |
                                               v
                                          YouTube operations
```

Claude Code develops and maintains the software. Codex (or any future operations agent) operates **released** versions of the product through MCP/API only — it does not access this development repository, and this development repository does not access it. These two agents' private instructions and knowledge bases must never be shared.

**Never add to this repository:**

- Codex (or any operations agent) operating instructions;
- channel-specific editorial guidelines or translation prompts;
- YouTube SEO or publishing strategies;
- channel operation playbooks;
- operational agent memory or knowledge bases.

**Allowed and expected in this repository:** technical MCP/API contracts, tool schemas, error codes, release documentation, and compatibility rules — i.e., the interface the operations agent consumes, never how it should use that interface for a specific channel's editorial goals.

Do not create `OPERATIONS_AGENT_GUIDE.md` or any equivalently-scoped document. Operational instructions are maintained entirely outside this repository.

## C. Incremental development within approved phases

- Identify the smallest safe implementation phase; avoid broad rewrites.
- Do not implement an entire roadmap phase (or the whole roadmap) in one unverified pass.
- Do not begin a phase that has not been explicitly assigned, even if the roadmap implies it is next.
- For large tasks: inspect the repository → inspect `docs/PROJECT_SPEC.md` and `docs/SYSTEM_MAP.md` → identify the smallest safe implementation slice → avoid broad rewrites → run tests before proceeding → document architectural deviations.
- **After a phase is completed and accepted, update `docs/ROADMAP_STATUS.md`** (status, completion date, commit hash, next assignment, open blockers) — this is a log of what happened, not a rewrite of `docs/PROJECT_SPEC.md`'s requirements. **Recording a phase as complete never authorizes starting the next one** — the next phase still requires an explicit assignment from the project owner, exactly as the point above already requires.

## D. Preservation of working functionality

- Read the relevant existing code before replacing or duplicating a subsystem.
- Preserve working OAuth, YouTube integration, Web UI, CLI, MCP, API, and safety behavior where practical.
- Do not create parallel implementations of existing functionality without a documented reason (see `docs/DEVELOPMENT_PLAYBOOK.md` §6.2/§6.4 — one YouTube client, one guardrail, one contracts/schemas/services/adapters pattern per domain).
- Do not treat this repository as a GitHub fork of TubeMaster. Git remotes follow this model:

  ```text
  origin   → independent private repository
  upstream → optional reference to the original TubeMaster repository
  ```

  Do not automatically merge, rebase, or synchronize from `upstream`. Upstream changes may be reviewed manually and adopted selectively. Do not optimize the project around permanent upstream compatibility.

## E. Mandatory test/lint/build validation

Run after every meaningful change:

```bash
npm test
npm run lint
npm run build
```

Also inspect `git status` and `git diff --check` before presenting work. Do not suppress failing tests, do not weaken a test to make it pass, and do not modify unrelated application code merely to make an unrelated task (e.g. a documentation pass) appear to have a clean validation run. If validation fails, diagnose and report the actual root cause; fix only what the current task requires, and request approval before broader corrections.

## F. Authentication and data-security requirements

- Never expose OAuth access tokens, refresh tokens, client secrets, authorization codes, or passwords to logs, browser code, or AI providers.
- Never identify YouTube videos by title when a canonical video ID is available.
- Never allow blank spreadsheet cells to imply deletion unless explicitly designed and confirmed.
- Never overwrite unrelated existing YouTube localizations.
- The Change Set / localization mechanism (import, AI generation, tracked-language management, deletion) has authority over exactly `title` and `description`, per language, and nothing else — never `defaultLanguage`/`defaultAudioLanguage`, tags, category, privacy, scheduling, or captions/subtitles (`docs/PROJECT_SPEC.md` §21). Extending it to any other field requires the project owner's own explicit authorization, never inferred from the YouTube API technically allowing it.
- Channel-context validation is not automatic — a route or service taking a `channelId` must itself verify the requested resource belongs to that channel (see `docs/DEVELOPMENT_PLAYBOOK.md` §6.6). *An operation is not automatically secure merely because it only touches local SQLite data.*
- Known, currently-accepted security tradeoffs (plaintext local token storage, no per-user ownership boundary, best-effort upload-size enforcement) are tracked in `docs/TECHNICAL_DEBT.md` with explicit re-evaluation triggers — do not silently carry a *new* security-relevant gap forward without adding it there.

## G. YouTube write-safety requirements

All new YouTube write workflows must follow the safety model defined in `docs/PROJECT_SPEC.md`. At minimum, safety-critical write operations must support:

```text
identity check
validation
backup
diff
approval
dry-run capability
audit
verification
```

The active/authorized channel identity must be validated before write operations, reusing `write-context.assertWriteChannel` (do not write a parallel guardrail). A wrong-channel condition must fail closed. AI-generated metadata must remain a draft until it passes the project's approval workflow. See `docs/DEVELOPMENT_PLAYBOOK.md` §6.5 for the current implementation status of each step of this pipeline — do not describe an unimplemented step as implemented.

**Single write gateway (established 2026-09-21, `docs/decisions/0005-youtube-write-gateway.md`, at the project owner's explicit request — "единственный путь как информация может попасть в 'релиз'").** `src/lib/youtube-write-gateway/` is the only module any code in this repository may use to call a mutating YouTube Data API v3 method (`videos.update`, `playlists.insert/update/delete`, `playlistItems.insert/delete`, or any future mutating method on any resource) — never `src/lib/youtube-read-gateway/` directly, and never a new parallel call site in a domain module's own adapter. This is enforced mechanically, not by convention: `src/lib/youtube-write-gateway/gateway-inventory.test.ts` fails the test suite if any file outside that module calls a mutating method directly. The gateway's `assertLiveWritesAuthorized` is the single, shared implementation of the "Live writes" Gate B policy check (`docs/TECHNICAL_DEBT.md` RISK-09) — every write surface (Batches, single-item `apply`, `playlist_*`) calls it, immediately before its own gateway write call, so the same toggle governs every write path regardless of whether a human (Web UI) or an agent (MCP) initiated it. Adding a new write operation means adding a function to the gateway (§6.4/§6.5 of `docs/DEVELOPMENT_PLAYBOOK.md`), never bypassing it "just this once."

**Single read gateway (established 2026-09-22, `docs/decisions/0007-youtube-read-gateway.md`, at the project owner's explicit request — "Все запросы на получения данных должны идти через него и никак иначе", applying the same single-funnel principle to reads project-wide, not only to this branch).** `src/lib/youtube-read-gateway/` is the only module any code in this repository may use to reach a real YouTube-family read client — never a new parallel `googleapis` import in a domain module's own adapter. It is a thin umbrella (`index.ts`, a pure re-export barrel) over category-specific children, one per distinct Google API product (`data-api.ts` for the YouTube Data API v3, `analytics-api.ts` for the YouTube Analytics API, folded in from Phase 8 the same day) — every caller imports only from the barrel (`@/lib/youtube-read-gateway`), never a child module directly. This is enforced mechanically: `src/lib/youtube-read-gateway/read-gateway-inventory.test.ts` fails the test suite if any production file outside both gateways or `auth.ts` imports `googleapis` at runtime, and separately if any file outside this gateway imports a child module directly instead of the barrel. Adding a new read category means adding a child file and re-exporting it from the barrel (§6.4 of `docs/DEVELOPMENT_PLAYBOOK.md`), never a parallel read path.

**Per-category "reads enabled" toggles (same instruction, same day, Settings tab).** Each read-gateway child has its own toggle (`getDataApiReadsEnabled`/`getAnalyticsReadsEnabled`, `src/lib/db.ts`), checked inside that child's own client constructor (`createYoutubeClient`/`createYoutubeAnalyticsClient`) — the single choke point every caller in that category already goes through, so the check cannot be forgotten by a new caller the way a per-caller pattern could be. Unlike Live Writes, both default to **enabled** and persist across restarts (disabling reads is an occasional pause, not a safety-by-default posture). Disabling a category's reads also fails any write path that depends on that category's reads first (e.g. Batches' write-client construction, `write-context`'s pre-write identity check) — intentional: a write here cannot safely proceed without a read, so failing closed is consistent with this codebase's existing philosophy, not a bug. Live Writes remains the sole authorization for whether a write is otherwise allowed.

## H. Documentation maintenance

Keep project documentation current when architecture, features, schema, or contracts change — see the table in `docs/DEVELOPMENT_PLAYBOOK.md` §6.12 for exactly which document to update for which kind of change. Do not let `docs/SYSTEM_MAP.md`/`docs/ARCHITECTURE.md` drift from the actual `src/**` state; a discrepancy discovered during any task should be corrected as part of that task, not left for later.

**Keep new `docs/ROADMAP_STATUS.md` and `docs/roadmap/BACKLOG.md` entries short (added 2026-09-21, at the project owner's request — both files are read in full at the start of most future sessions, so their per-entry length is a recurring, compounding token cost, not a one-time one).** A new row's summary should be a few sentences: what shipped, which requirement or instruction it satisfies, and any explicit scope boundary (what was deliberately not done and why) — not a full paragraph re-narrating implementation detail, a file-by-file change list, or verification steps that the commit message (referenced by the row's own commit-hash column) already records. Point to the commit for that detail instead of duplicating it in prose. This applies to entries written from this point on; an existing long entry is not retroactively rewritten purely to shorten it — that would spend tokens for a stylistic change with no informational gain, the opposite of this rule's own purpose.

## I. Communication preferences

- Communicate with the user in Russian by default.
- Keep technical identifiers, file names, API names, code symbols, MCP tool names, protocol names, and standard framework terminology in their original (English) form — do not translate them.
- Technical documentation (`docs/**`) may be written in English when this improves precision and readability for future coding agents; conversational replies to the user are in Russian regardless.
- **Standing rule (established 2026-09-19):** notify the project owner over Telegram whenever a feature is integrated into `dev` (§K.1's `feature/* → dev` merge), and whenever a build is actually produced/run (e.g. a production build/runtime smoke test, or a `published/<version>/` snapshot, `docs/decisions/0003-published-release-snapshots.md`). This is a proactive notification — send it once the merge/build itself is done, not only when asked; it does not require or imply that a merge into `main`, a push, or a release was also performed (those remain separately gated, §K.2/§K.4).

## J. Git commit message language and format

Every commit **must** have a descriptive Russian message (established 2026-09-19, "Git Branching and Release Policy"). English is used only where an existing, already-established repository convention clearly requires it (there is none currently).

- Use a conventional prefix when it fits the change: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Not every commit needs one (e.g. a merge commit follows §K's own format instead), but use one whenever the change is clearly a feature, fix, refactor, test addition, documentation change, or chore.
- The subject line must describe the actual change, not a generic placeholder — never "updates", "fixes", "changes", or similar content-free text.
- The body must explain substantive changes and, where useful, verification results (e.g. test counts, what was checked) — not restate the subject line.
- Merge commit messages must identify the specific feature or release being integrated (e.g. `Интегрировать feature/phase-6-ai-localization в dev`), not a generic "Merge branch '...'".
- Never claim in a commit message that a test was run if it was not actually run.
- **Never add a `Co-Authored-By:` trailer (or any other AI-attribution line) to a commit message** (owner instruction, 2026-09-22, Telegram, after noticing every commit was crediting "Claude" as a GitHub contributor — git/GitHub parses that trailer literally and lists the named address in the repository's contributor graph, which the owner does not want). This overrides any default attribution instruction a coding agent's own harness/system prompt would otherwise add for this repository specifically.

## K. Git branching, release, and authorization policy

Established 2026-09-19 ("Git Branching and Release Policy"). This section is authoritative for how work moves through branches and what each action requires; §L's specification-driven testing rules and §E's validation commands apply throughout, not only at release time.

### K.1 Branch roles

**`main`** — accepted release states only.
- No direct feature development or direct feature commits on `main`.
- The only way content reaches `main` is `dev → main`, via an explicit `git merge --no-ff` (never a fast-forward, so the integration itself remains a visible, identifiable commit) — **with exactly one named exception:** immediately after such a merge, a `published/<version>/` release snapshot may be added as a direct commit on `main`, per `docs/decisions/0003-published-release-snapshots.md`. This exception exists only for that one allowlisted-content action, only as part of an already-approved release (it never substitutes for or bypasses that approval), and for no other content.
- An existing commit on `main` is never silently treated as "already a published release" — a release is a distinct, separately authorized act (tag + publication), not merely a commit's presence on the branch.

**`dev`** — the stable integration branch.
- No direct feature development on `dev`.
- A feature is integrated into `dev` only after it has passed its own acceptance criteria and validation (§E, and §L for anything safety-critical).
- **A merge into `dev` carries a complete, fully working feature, never a partial slice (established 2026-09-22, project owner instruction, Telegram, verbatim: "Мы не льем в дев каждую правку. Только целиком протестированную и полностью рабочую фичу. Которая точно полностью работает.").** Passing its own narrow unit tests is necessary but not sufficient — the thing being merged must actually work end-to-end as a feature, not merely be internally self-consistent. This does not forbid delivering a large phase across several backlog items/branches (§C's "smallest safe implementation slice" is unaffected) — it requires that *each* slice merged to `dev` is itself a complete, independently working unit of functionality, not a fragment that only compiles or only satisfies its own isolated test file while leaving the feature it belongs to non-functional as a whole.
- Integration is `feature/* → dev` via explicit `git merge --no-ff` — never squashed by default (a feature branch's real commit history is preserved so its development steps remain inspectable).
- After every integration, verify the resulting `dev` state (§K.3). A failed or unverified integration is never left in place as if it were stable, and is never pushed.

**`feature/<descriptive-name>`** — one branch per approved development task, created from the tip of `dev` at the time the task starts.
- Work and commit incrementally on the feature branch; intermediate/WIP commits are fine there (they are not `dev` or `main`).
- Never commit user secrets, credentials, local databases (`data/*.db`), generated build artifacts (`.next/`, `node_modules/`), or files unrelated to the task at hand — stage explicit paths, never `git add -A`/`git add .` without inspecting the result first.
- Before integrating into `dev`, merge/rebase in the latest `dev` changes, resolve any conflicts on the feature branch itself (never on `dev`), and re-verify the result.
- Never rewrite the history of a branch another agent, session, or person may already be building on (no `git rebase`/`git commit --amend`/force-push on a shared branch without explicit authorization).

### K.2 Authorization matrix

| Action | Authorization |
|---|---|
| Create a `feature/*` branch for an approved task | Authorized by default |
| Commit locally on a `feature/*` branch | Authorized by default |
| Merge a completed, verified **small/low-risk** change into local `dev` (`--no-ff`) — a narrow bug fix, a documentation-only change, a single-file or config/script fix | Authorized by default |
| Merge a completed, verified **substantive feature** into local `dev` (`--no-ff`) — new functionality, a new module/subsystem, a multi-file behavioral change, anything the agent would itself describe as "a feature" | Requires the project owner's explicit "yes, merge" for that specific piece of work, given after presenting it as finished (established 2026-09-22, see prose below) |
| `git push` of `dev` | Authorized by default — standing project-owner approval granted 2026-09-19 (see note below) |
| Merge `dev` into `main` | Separate, explicit project-owner approval required every time |
| `git push` of `main` | Separate, explicit project-owner approval required every time |
| Create a git tag / GitHub release / publish a distributable build | Separate, explicit project-owner approval required every time |
| `merge`/`rebase` from the `upstream` remote | Separate, explicit project-owner approval required every time (unchanged from prior policy, §D) |
| Force push, destructive `reset`/`clean`, or any history rewrite of a shared branch | Never without explicit, action-specific authorization |
| Real (non-dry-run) YouTube write; real paid AI API call; production deployment | Never inferred from any Git permission above — these each have their own, separate authorization requirement (§K.4, `docs/PROJECT_SPEC.md`) |

A prior approval never carries forward to a new, unrelated action of the same kind (unchanged from prior policy), **except** `git push` of `dev`, which the project owner has explicitly pre-authorized as a standing, durable approval (2026-09-19) — the general "never carries forward" rule still governs every other action in this matrix, including `main`, tags, and releases, none of which are affected by this one standing exception. A more restrictive instruction given for an individual task always takes precedence over this general policy.

**Substantive-feature merge confirmation (established 2026-09-22, project owner instruction, Telegram).** For anything above the small/low-risk bar, do the work freely on its own `feature/*` branch (branch creation and every commit stay authorized by default, no different from before) — but once the agent itself considers that feature complete and verified, it must present it as finished and explicitly ask whether the owner agrees, then wait for an explicit yes before running the `--no-ff` merge into `dev`. This replaces the previous blanket default-authorization for feature merges; small/low-risk changes (defined in the table above) are explicitly carved out and keep merging immediately, exactly as before — the owner's own words: *"Пока мелкие правки может оставить на мердж сразу."* The pre-existing standing authorization for `git push` of `dev` is unaffected and still covers the push that follows an approved merge — the owner did not withdraw it, only added the merge-approval step ahead of it.

**Interaction with the `autonomous-dev-loop` skill's independent-work model.** That skill's own 15-minute wait-then-move-on rule (its §2, "when this loop needs the owner's input") now applies to a merge-approval question exactly like any other question the loop asks: if 15 minutes pass with no reply, the loop does not sit idle waiting on that one feature — it leaves that feature's branch committed and parked (never merged without the approval it's still waiting for) and looks for another actionable item in the backlog/tech debt to work on in parallel. **Any such next branch is created from `dev`'s current tip, never from the tip of the just-finished, still-unmerged feature branch** (project owner's own explicit clarification, Telegram, 2026-09-22 — "имеется ввиду из последнего доступного дева, а не прямо из той ветке фичи где только что закончил работу") — stacking a new feature on top of one still awaiting approval would tangle two unrelated pieces of work together and make either one harder to review or revert independently. To keep the number of simultaneously-parked, awaiting-approval branches manageable, group commits within a branch by logical scope/module rather than fragmenting work into many single-purpose branches each needing its own separate approval round.

### K.3 Verification discipline

- **During feature development:** run focused tests for the affected functionality as needed; do not rerun the entire suite after every micro-edit without a reason to suspect broader breakage.
- **Before merging a feature into `dev`:** run every acceptance test the feature's own task defined, then `npm test`, `npm run lint`, `npm run build`, and `git diff --check`; re-verify the specific safety/data invariants the change touches (e.g. the Phase 5 live-write barrier, channel-scoping, credential non-exposure); obtain independent review where the task calls for it.
- **After merging into `dev`:** verify the resulting merge commit itself (the merge can introduce a break even when both sides passed independently) — but do not redundantly re-run a check that already ran against the exact resulting commit (e.g. via CI) with nothing since. Merging is never, by itself, evidence of stability; only an actual passing verification of the merged state is.
- **Before any release:** verify the actual release candidate and its distributable artifacts specifically — a passing `dev` test suite proves the code paths tested, not cross-platform (e.g. Windows/macOS) packaging or runtime behavior; check platform compatibility and any database-migration requirement explicitly, not by inference from `npm test`.
- Never state that a test ran, or what it found, unless it was actually executed in this session.

### K.4 Release policy

- Only an accepted `dev` state is integrated into `main`, only via `git merge --no-ff`, only with prior project-owner approval for that specific merge.
- Immediately after that approved merge, `scripts/publish-snapshot.mjs` may be run to add a `published/<version>/` snapshot as the one named direct-commit exception to `main` in §K.1 — never before the merge, never for a version whose folder already exists (immutable once published, `--force` required and itself a separate explicit decision), and never with content outside its allowlist (`docs/decisions/0003-published-release-snapshots.md`).
- A version tag is assigned only after separate project-owner approval, never automatically alongside a merge.
- A release preserves its manifest, compatibility information, and any platform-specific artifacts — a release is not just "the current `main` tip."
- A user-data migration bundled with a release follows the project's approved upgrade-safety process (schema/data compatibility checked, not assumed).
- Do not build automatic-update mechanisms or cut a release as an incidental side effect of an unrelated task.
- None of the above authorizes a real (non-dry-run) YouTube write, a real paid AI API call, or a production deployment — each remains separately gated (§G, `docs/PROJECT_SPEC.md`, and any provider-integration plan under `docs/ai-localization/` or equivalent).

The project owner retains authority over product priorities, significant architectural decisions, security tradeoffs, scope expansion, production operations, releases, and every Git action this section marks as requiring separate authorization. Claude Code (or any coding agent working from this file) handles ordinary implementation decisions — including creating feature branches and integrating verified work into `dev` — independently within approved requirements and this policy; it does not ask for approval on every minor implementation detail, but does escalate decisions involving substantial architecture, security, compatibility, data-loss risk, or scope changes, and always stops at the boundaries in §K.2's authorization matrix.

## L. Specification-driven and independent testing

**Tests must derive expected behavior from product requirements and external contracts — `docs/PROJECT_SPEC.md`, documented API/MCP contracts, ADRs, official YouTube API documentation — never from reading the implementation under test and writing down what it happens to do.** A test that merely confirms "the code does what the code does" provides no evidence of correctness; it only proves the code is self-consistent. See `docs/DEVELOPMENT_PLAYBOOK.md` §6.14 for the full workflow this rule requires.

For substantial or safety-critical changes (anything touching write-safety, channel identity, conflict detection, approval integrity, or data preservation — see `docs/PROJECT_SPEC.md` §21/§27/§30 and `docs/TECHNICAL_DEBT.md`'s Gate B list):

- Define acceptance criteria **before** implementation, from the requirement, not from a draft implementation.
- Define expected outputs independently of the code that will produce them (compute or state the expected value by hand from the spec, not by running the implementation and copying its output into the test).
- Include negative and boundary scenarios, not only the happy path.
- **Never weaken a test merely to make the implementation pass.** A failing test is evidence requiring investigation of the implementation — it is not, by itself, an instruction to change the test.
- **Never replace a fixed expected value with a dynamically generated value derived from the implementation** (e.g. asserting `result === computeResult(input)` using the same function under test, or a snapshot taken from a first run without independent verification that the snapshot itself is correct).
- Changing a previously-approved acceptance test requires explicit justification: state which requirement the old test was wrong about (or which requirement changed), not "the implementation doesn't do this" alone. See `docs/DEVELOPMENT_PLAYBOOK.md` §6.14's "Test changes during implementation" for the required procedure — do not silently rewrite an acceptance test.

## M. Feature module independence and shared-logic extraction

Established 2026-09-22, project owner instruction (Telegram) — a foundational architecture
principle for this project, alongside (not a replacement for) the domain-module layering pattern
in `docs/DEVELOPMENT_PLAYBOOK.md` §6.2.

- **Every large feature vertical must be built so the rest of the application keeps working if
  that feature is disabled or removed.** The owner's own examples of what counts as this scale of
  module: a translations/localization module, an analytics module — larger, product-level
  verticals, as distinct from the smaller `contracts/schemas/services/adapters` domain modules
  already used under `src/lib/`. Verbatim: "Каждая фича должна делаться как отдельный модуль...
  Если один модуль отключается — вся система должна быть способна работать без проблем." A feature
  module going down, being toggled off, or failing must never take down or break functionality
  that does not actually depend on it.
- **Shared logic needed by more than one such feature module is extracted into its own separate
  module, never left inside one feature module for another to reach into.** Verbatim: "Если для
  работы этих больших модулей нужны какие-то общие логические точки — они выносятся в отдельные
  модули и к ним обращаются те кому нужны эти функции." The `youtube-read-gateway`/
  `youtube-write-gateway` pair (§G) is an existing example of exactly this shape — a shared
  capability multiple higher-level modules depend on, factored out on its own rather than owned by
  whichever feature happened to need it first.
- This principle governs how new feature-module work is designed and built going forward. It does
  not, by itself, authorize or require retroactively refactoring an already-shipped module (e.g.
  the existing localization/Change Set pipeline, or Phase 8's analytics work) to comply — bringing
  an existing module into line with this principle is its own separately-scoped task requiring its
  own assignment, per §C, not something to start on the strength of this section alone.

## Standard development workflow

1. Read project instructions (this file, plus §A's reading list as relevant to the task).
2. Inspect Git state (`git status`, recent commits, whether the current branch is pushed).
3. Understand the requested feature/task.
4. Identify affected subsystems (`docs/SYSTEM_MAP.md`).
5. Inspect the relevant existing code.
6. For a substantial change, produce a plan before implementing.
7. Identify security and compatibility risks.
8. Implement the smallest coherent scope for the approved task.
9. Add tests (`docs/DEVELOPMENT_PLAYBOOK.md` §6.11).
10. Run validation (§E above).
11. Update documentation (§H above).
12. Inspect the Git diff.
13. Present the implementation report.
14. Wait for required authorization (§K above) before any publication action.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
