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

## H. Documentation maintenance

Keep project documentation current when architecture, features, schema, or contracts change — see the table in `docs/DEVELOPMENT_PLAYBOOK.md` §6.12 for exactly which document to update for which kind of change. Do not let `docs/SYSTEM_MAP.md`/`docs/ARCHITECTURE.md` drift from the actual `src/**` state; a discrepancy discovered during any task should be corrected as part of that task, not left for later.

## I. Communication preferences

- Communicate with the user in Russian by default.
- Keep technical identifiers, file names, API names, code symbols, MCP tool names, protocol names, and standard framework terminology in their original (English) form — do not translate them.
- Technical documentation (`docs/**`) may be written in English when this improves precision and readability for future coding agents; conversational replies to the user are in Russian regardless.

## J. Git commit message preference

Git commit messages should preferably be written in Russian, unless an existing repository convention clearly requires English.

## K. Git / release authorization boundaries

Do not automatically:

- merge or rebase from `upstream`;
- `git push` to `origin` (including `origin/main`);
- create git tags or releases;
- deploy a production build;
- execute a real (non-dry-run) YouTube write.

Every one of these actions requires **explicit authorization** from the project owner for that specific action — a prior approval does not carry forward to a new, unrelated action of the same kind. Committing locally (without pushing) is fine as part of ordinary development once the project owner has approved the specific change; it is not itself a "release" action.

The project owner retains authority over product priorities, significant architectural decisions, security tradeoffs, scope expansion, production operations, releases, and Git pushes when authorization is required. Claude Code (or any coding agent working from this file) should handle ordinary implementation decisions independently within approved requirements and established architecture — do not ask for approval on every minor implementation detail, but do escalate decisions involving substantial architecture, security, compatibility, data-loss risk, or scope changes.

## L. Specification-driven and independent testing

**Tests must derive expected behavior from product requirements and external contracts — `docs/PROJECT_SPEC.md`, documented API/MCP contracts, ADRs, official YouTube API documentation — never from reading the implementation under test and writing down what it happens to do.** A test that merely confirms "the code does what the code does" provides no evidence of correctness; it only proves the code is self-consistent. See `docs/DEVELOPMENT_PLAYBOOK.md` §6.14 for the full workflow this rule requires.

For substantial or safety-critical changes (anything touching write-safety, channel identity, conflict detection, approval integrity, or data preservation — see `docs/PROJECT_SPEC.md` §21/§27/§30 and `docs/TECHNICAL_DEBT.md`'s Gate B list):

- Define acceptance criteria **before** implementation, from the requirement, not from a draft implementation.
- Define expected outputs independently of the code that will produce them (compute or state the expected value by hand from the spec, not by running the implementation and copying its output into the test).
- Include negative and boundary scenarios, not only the happy path.
- **Never weaken a test merely to make the implementation pass.** A failing test is evidence requiring investigation of the implementation — it is not, by itself, an instruction to change the test.
- **Never replace a fixed expected value with a dynamically generated value derived from the implementation** (e.g. asserting `result === computeResult(input)` using the same function under test, or a snapshot taken from a first run without independent verification that the snapshot itself is correct).
- Changing a previously-approved acceptance test requires explicit justification: state which requirement the old test was wrong about (or which requirement changed), not "the implementation doesn't do this" alone. See `docs/DEVELOPMENT_PLAYBOOK.md` §6.14's "Test changes during implementation" for the required procedure — do not silently rewrite an acceptance test.

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

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
