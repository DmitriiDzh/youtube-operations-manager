# Coding Agent Instructions

This is the **primary persistent instruction file** for any coding agent in this repository. `CLAUDE.md` only imports it (`@AGENTS.md`); never put rules there instead of here.

It does not duplicate `docs/PROJECT_SPEC.md` (requirements/roadmap) or `docs/DEVELOPMENT_PLAYBOOK.md` (how-to). Many rules here are short forms; their original full wording is in `docs/AGENT_RULES_DETAIL.md`, which is binding and wins wherever a short form seems narrower. Authorized YouTube writers: `docs/WRITE_AUTHORIZATIONS.md`.

## A. Mandatory documentation reading

Before making architectural, product, or safety-critical changes, read (in this order, skip only what is genuinely irrelevant to the task at hand):

`docs/PROJECT_SPEC.md` (requirements, write-safety, phases, acceptance) → `docs/ROADMAP_STATUS.md` (what is actually complete, at which commit, what is assigned next) → `docs/SYSTEM_MAP.md` (where every subsystem is, its status) → `docs/ARCHITECTURE.md` (internals, data flows, limitations) → `docs/DEVELOPMENT_PLAYBOOK.md` (how to extend) → `docs/TECHNICAL_DEBT.md` (risks and gates; check before touching anything a risk references) → `docs/decisions/` (ADRs; check before altering anything one governs).

**Narrow reading for small slices.** The full list is required when a change adds a subsystem, module boundary or reusable pattern; touches write-safety, channel identity, conflict detection, approval integrity or data preservation; changes a persisted schema or a public API/MCP contract; or when unsure. A small additive slice within an already-assigned phase that follows an established pattern reads only the touched subsystem's `docs/SYSTEM_MAP.md`/`docs/ARCHITECTURE.md` sections plus what else bears on it. When unsure, read more, not less; this is never a loophole to skip anything safety-relevant (`docs/AGENT_RULES_DETAIL.md` §A).

`src/**` is the source of truth for **what exists**; `docs/PROJECT_SPEC.md` for **what is required**. If they disagree, report the discrepancy — never silently rewrite requirements to match an incomplete implementation, nor docs to claim something is implemented when it is not.

## B. Development / operations separation

This repository is the **development side only**.

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
- **After a phase is completed and accepted, update `docs/ROADMAP_STATUS.md`** (status, completion date, commit hash, next assignment, open blockers) — a log, not a rewrite of `docs/PROJECT_SPEC.md`. **Recording a phase as complete never authorizes starting the next one.**

## D. Preservation of working functionality

- Read the relevant existing code before replacing or duplicating a subsystem.
- Preserve working OAuth, YouTube integration, Web UI, CLI, MCP, API, and safety behavior where practical.
- Do not create parallel implementations of existing functionality without a documented reason (see `docs/DEVELOPMENT_PLAYBOOK.md` §6.2/§6.4 — one YouTube client, one guardrail, one contracts/schemas/services/adapters pattern per domain).
- `origin` is this repository's only remote; it has no upstream. Never add another remote (in particular none pointing at TubeMaster, which it was bootstrapped from) and never fetch, merge or cherry-pick from one (owner, 2026-10-05).

## E. Mandatory test/lint/build validation

Run after every meaningful change:

```bash
npm test
npm run lint
npm run build
```

Also inspect `git status` and `git diff --check` before presenting work. Never suppress a failing test, weaken a test to make it pass, or change unrelated application code to make a task's validation look clean. If validation fails, report the real root cause; fix only what the task requires and ask before broader corrections.

## F. Authentication and data-security requirements

- Never expose OAuth access tokens, refresh tokens, client secrets, authorization codes, or passwords to logs, browser code, or AI providers.
- Never identify YouTube videos by title when a canonical video ID is available.
- Never allow blank spreadsheet cells to imply deletion unless explicitly designed and confirmed.
- Never overwrite unrelated existing YouTube localizations.
- The Change Set / localization mechanism (import, AI generation, tracked-language management, deletion) has authority over exactly `title` and `description`, per language, and nothing else — never `defaultLanguage`/`defaultAudioLanguage`, tags, category, privacy, scheduling, or captions/subtitles (`docs/PROJECT_SPEC.md` §21).
- **Every other authorized YouTube writer, and every exception to the line above, is listed in `docs/WRITE_AUTHORIZATIONS.md`, which is binding exactly as if it were written in this file; any new writer must be added there.** Read it before touching any YouTube write or anything it governs: Batches' language fields, video details, live and channel translations, channel branding, uploads and their translations, the upload queue, publish dates, the weekly plan and week template, social cross-posts, thumbnails, the owner package-review gate, package metadata after upload, captions, and which agent roles get which of these tools.
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

**Single write gateway (ADR 0005).** Only `src/lib/youtube-write-gateway/` may call a mutating YouTube Data API method (`videos.update`, `playlists.*`, `playlistItems.*`, any future one); never through `youtube-read-gateway` or a parallel call site (`gateway-inventory.test.ts` enforces it). Every write surface calls its `assertLiveWritesAuthorized` (the Live writes check, RISK-09) immediately before its gateway write call. A new write operation is a new gateway function, never a bypass.

**Single read gateway (ADR 0007).** Only `src/lib/youtube-read-gateway/` reaches a real YouTube-family read client: callers import only the barrel `@/lib/youtube-read-gateway`, never a child (`data-api.ts`, `analytics-api.ts`) or `googleapis` (`read-gateway-inventory.test.ts` enforces it). A new read category is a new child re-exported from the barrel.

**Reads toggles.** `getDataApiReadsEnabled`/`getAnalyticsReadsEnabled` (`src/lib/db.ts`) are checked in each child's client constructor; default on, persistent (like Live Writes, ADR 0044). Disabled reads also fail writes that need those reads (fail closed, intended). Live Writes alone authorizes a write (`docs/AGENT_RULES_DETAIL.md` §G).

## H. Documentation maintenance

Keep project documentation current when architecture, features, schema, or contracts change — see the table in `docs/DEVELOPMENT_PLAYBOOK.md` §6.12 for exactly which document to update for which kind of change. Do not let `docs/SYSTEM_MAP.md`/`docs/ARCHITECTURE.md` drift from the actual `src/**` state; a discrepancy discovered during any task should be corrected as part of that task, not left for later.

**Keep new `docs/ROADMAP_STATUS.md` and `docs/roadmap/BACKLOG.md` entries short:** a few sentences (what shipped, which requirement, scope boundary) plus the commit hash; no implementation narrative. Old long entries are not rewritten just to shorten them (`docs/AGENT_RULES_DETAIL.md` §H).

**Interface text in every language (BL-152).** The Web UI has no text of its own in components: every text is a key in `src/lib/ui-text/locales/<language>/<area>.ts`, added in English **and** every other supported language in the same change (`docs/DEVELOPMENT_PLAYBOOK.md` §6.9 item 11; the build and `src/lib/ui-text/*.test.ts` enforce it). MCP, API and CLI texts stay English.

## I. Communication preferences

- Communicate with the user in Russian by default.
- Keep technical identifiers, file names, API names, code symbols, MCP tool names, protocol names, and standard framework terminology in their original (English) form — do not translate them.
- Technical documentation (`docs/**`) may be written in English when this improves precision and readability for future coding agents; conversational replies to the user are in Russian regardless.
- **Standing rule:** proactively notify the owner over Telegram when a feature is merged into `dev` and when a build is actually produced/run (smoke test, `published/<version>/` snapshot). It implies no `main` merge, push or release (§K.2/§K.4; `docs/AGENT_RULES_DETAIL.md` §I).

## J. Git commit message language and format

Every commit **must** have a descriptive Russian message (established 2026-09-19, "Git Branching and Release Policy"). English is used only where an existing, already-established repository convention clearly requires it (there is none currently).

- Use a conventional prefix when it fits the change: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Not every commit needs one (e.g. a merge commit follows §K's own format instead), but use one whenever the change is clearly a feature, fix, refactor, test addition, documentation change, or chore.
- The subject line must describe the actual change, not a generic placeholder — never "updates", "fixes", "changes", or similar content-free text.
- The body must explain substantive changes and, where useful, verification results (e.g. test counts, what was checked) — not restate the subject line.
- Merge commit messages must identify the specific feature or release being integrated (e.g. `Интегрировать feature/phase-6-ai-localization в dev`), not a generic "Merge branch '...'".
- Never claim in a commit message that a test was run if it was not actually run.
- **Never add a `Co-Authored-By:` trailer or any other AI-attribution line to a commit message** (owner, 2026-09-22); this overrides any harness default for this repository (`docs/AGENT_RULES_DETAIL.md` §J).

## K. Git branching, release, and authorization policy

Established 2026-09-19. Authoritative for how work moves through branches and what each action requires; §L and §E apply throughout.

### K.1 Branch roles

**`main`** — accepted release states only.
- No direct feature development or direct feature commits on `main`.
- Content reaches `main` only as `dev → main` via an explicit `git merge --no-ff` (never fast-forward) — **one exception:** right after such an approved merge, a `published/<version>/` snapshot may be committed directly on `main` (ADR 0003), only that allowlisted content.
- An existing commit on `main` is never silently treated as "already a published release" — a release is a distinct, separately authorized act (tag + publication), not merely a commit's presence on the branch.

**`dev`** — the stable integration branch.
- No direct feature development on `dev`.
- A feature is integrated into `dev` only after it has passed its own acceptance criteria and validation (§E, and §L for anything safety-critical).
- **A merge into `dev` carries a complete, end-to-end working and tested feature, never a partial slice** (owner, 2026-09-22); its own unit tests passing is not enough. A phase may ship across several items, each a complete working unit (`docs/AGENT_RULES_DETAIL.md` §K.1).
- Integration is `feature/* → dev` via explicit `git merge --no-ff` — never squashed by default (a feature branch's real commit history is preserved so its development steps remain inspectable).
- After every integration, verify the resulting `dev` state (§K.3). A failed or unverified integration is never left in place as if it were stable, and is never pushed.

**`feature/<descriptive-name>`** — one branch per approved development task, created from the tip of `dev` at the time the task starts.
- **All slices of one phase share ONE branch, merged into `dev` together once** when the owner says it is ready (owner, 2026-09-26); slices are separate commits; the §K.2 gate applies to the whole branch (`docs/AGENT_RULES_DETAIL.md` §K.1).
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
| Force push, destructive `reset`/`clean`, or any history rewrite of a shared branch | Never without explicit, action-specific authorization |
| Real (non-dry-run) YouTube write; real paid AI API call; production deployment | Never inferred from any Git permission above — these each have their own, separate authorization requirement (§K.4, `docs/PROJECT_SPEC.md`) |

A prior approval never carries forward to a new, unrelated action, **except** `git push` of `dev` (standing owner approval, 2026-09-19). A more restrictive task-specific instruction always wins.

**Substantive-feature merge (owner, 2026-09-22):** once the feature is complete and verified on its branch, present it as finished, ask, and wait for the owner's explicit yes before the `--no-ff` merge into `dev`. Small/low-risk changes keep merging immediately; the standing `dev` push covers the push after an approved merge.

**With `autonomous-dev-loop`:** a merge question unanswered for 15 minutes parks that branch (committed, never merged unapproved) while the loop works another item; **the next branch is cut from `dev`'s current tip, never from the parked branch**. Group commits by scope rather than many small branches (`docs/AGENT_RULES_DETAIL.md` §K.2).

### K.3 Verification discipline

- **During development:** focused tests as needed; no full-suite rerun after every micro-edit without reason.
- **Before merging into `dev`:** the task's acceptance tests, then `npm test`, `npm run lint`, `npm run build`, `git diff --check`; re-verify the safety/data invariants the change touches (live-write barrier, channel scoping, credential non-exposure); independent review where the task calls for it.
- **After merging into `dev`:** verify the merge commit itself (unless that exact commit was already checked); a merge alone is never evidence of stability.
- **Before any release:** verify the actual release candidate and its artifacts, including cross-platform packaging/runtime and database migrations, explicitly, not by inference from `npm test`.
- Never state that a test ran, or what it found, unless it was actually executed in this session.

### K.4 Release policy

- Only an accepted `dev` state is integrated into `main`, only via `git merge --no-ff`, only with prior project-owner approval for that specific merge.
- Right after that approved merge, `scripts/publish-snapshot.mjs` may add the `published/<version>/` snapshot (§K.1's exception) — never before the merge, never over an existing version folder (`--force` is its own explicit decision), never with content outside its allowlist (ADR 0003).
- A version tag is assigned only after separate project-owner approval, never automatically alongside a merge.
- A release preserves its manifest, compatibility information, and any platform-specific artifacts — a release is not just "the current `main` tip."
- A user-data migration bundled with a release follows the project's approved upgrade-safety process (schema/data compatibility checked, not assumed).
- Do not build automatic-update mechanisms or cut a release as an incidental side effect of an unrelated task.
- None of the above authorizes a real (non-dry-run) YouTube write, a real paid AI API call, or a production deployment — each remains separately gated (§G, `docs/PROJECT_SPEC.md`, and any provider-integration plan under `docs/ai-localization/` or equivalent).

The owner decides product priorities, significant architecture, security tradeoffs, scope, production operations, releases and every Git action this section gates. Agents make ordinary implementation decisions independently, escalate architecture/security/compatibility/data-loss/scope questions, and always stop at §K.2's boundaries (`docs/AGENT_RULES_DETAIL.md` §K).

## L. Specification-driven and independent testing

**Tests derive expected behavior from requirements and external contracts** (`docs/PROJECT_SPEC.md`, API/MCP contracts, ADRs, official YouTube API docs), **never from reading the implementation under test** and recording what it does (`docs/DEVELOPMENT_PLAYBOOK.md` §6.14).

For substantial or safety-critical changes (anything touching write-safety, channel identity, conflict detection, approval integrity, or data preservation — see `docs/PROJECT_SPEC.md` §21/§27/§30 and `docs/TECHNICAL_DEBT.md`'s Gate B list):

- Define acceptance criteria **before** implementation, from the requirement, not from a draft implementation.
- State expected outputs by hand from the spec, never by copying the implementation's output.
- Include negative and boundary scenarios, not only the happy path.
- **Never weaken a test merely to make the implementation pass.** A failing test is evidence requiring investigation of the implementation — it is not, by itself, an instruction to change the test.
- **Never replace a fixed expected value with one derived from the implementation** (the same function under test, or an unverified first-run snapshot).
- Changing an approved acceptance test needs explicit justification (which requirement the old test got wrong, or which changed — never "the implementation doesn't do this"), per `docs/DEVELOPMENT_PLAYBOOK.md` §6.14.

## M. Feature module independence and shared-logic extraction

- **Every large feature vertical (e.g. translations, analytics) is built so the rest of the app keeps working if it is disabled, removed or failing** (owner, 2026-09-22).
- **Logic needed by more than one such module goes into its own module** (like the gateways, §G), never left inside one for another to reach into.
- This governs new work, never by itself a retroactive refactor of a shipped module (§C; `docs/AGENT_RULES_DETAIL.md` §M).

## N. Restarting the owner's live server (hard rule)

**Restart only through restart-when-idle; ask nobody first** (owner msg 3420; BL-220, ADR 0049): the owner's button (Settings → О программе) or `scripts/macos/restart-when-idle.sh`. The server waits by itself until nothing works with it (media sessions and jobs, Gemini jobs, an upload in its last-chunk or finishing window, a live stream starting/stopping/switching, the operation lock, holds, the owner's quiet minutes without MCP calls), then restarts. Agents hold it with `factory_hold_restart` / `agent_hold_restart` (`docs/AGENT_RULES_DETAIL.md` §N).

- Never use `stop.sh`, `start.sh`, `update.sh` or a process kill on the live server instead, unless the owner, in their own words,
  asks for that one restart (for example «перезапускай»).
- Tell the owner before requesting a restart, and confirm afterwards that it came back (the version and schema from the card or
  `factory_restart_status`).
- The live 24/7 streams are not a reason to wait: their encoders survive a restart.
- Merging into `dev` is not a restart and is never held back by this rule.

## Standard development workflow

Read instructions (this file, §A as relevant) → inspect Git state → understand the task → find affected subsystems (`docs/SYSTEM_MAP.md`) → read the code → plan a substantial change → identify security/compatibility risks → implement the smallest coherent scope → add tests (`docs/DEVELOPMENT_PLAYBOOK.md` §6.11) → validate (§E) → update docs (§H) → inspect the diff → report → wait for authorization (§K) before any publication action.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
