# Coding Agent Instructions

Before making architectural, product, or safety-critical changes, read:

`docs/PROJECT_SPEC.md`

This document defines the project roadmap, YouTube write-safety rules, upstream relationship, implementation phases, and acceptance criteria.

## Repository model

This is an **independent private repository initialized from the TubeMaster codebase**.

Git remotes are expected to follow this model:

```text
origin   → independent private repository
upstream → optional reference to the original TubeMaster repository
```

Rules:

- Do not treat this repository as a GitHub fork.
- Do not automatically merge, rebase, or synchronize from `upstream`.
- Upstream changes may be reviewed manually and adopted selectively.
- Do not optimize the project around permanent compatibility with upstream.
- Preserve working TubeMaster-derived subsystems unless there is a documented technical reason to change them.

## Development rules

- Read the relevant existing code before replacing or duplicating a subsystem.
- Preserve working OAuth, YouTube integration, Web UI, CLI, MCP, API, and safety behavior where practical.
- Do not create parallel implementations of existing functionality without justification.
- Verify current YouTube API behavior against official Google documentation when implementing or changing API interactions.
- Run tests, linting, and type checks after meaningful changes.
- Add tests for safety-critical logic.
- Keep project documentation updated when architecture changes.
- Never expose OAuth access tokens, refresh tokens, client secrets, authorization codes, or passwords to logs, browser code, or AI providers.
- Never identify YouTube videos by title when a canonical video ID is available.
- Never allow blank spreadsheet cells to imply deletion unless explicitly designed and confirmed.
- Never overwrite unrelated existing YouTube localizations.
- AI-generated metadata must remain a draft until it passes the project's approval workflow.

## YouTube write operations

All new YouTube write workflows must follow the safety model defined in `docs/PROJECT_SPEC.md`.

At minimum, safety-critical write operations should support:

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

The active/authorized channel identity must be validated before write operations.

A wrong-channel condition must fail closed.

## Agent behavior

For large tasks:

1. inspect the repository;
2. inspect `docs/PROJECT_SPEC.md`;
3. identify the smallest safe implementation phase;
4. avoid broad rewrites;
5. run tests before proceeding;
6. document architectural deviations.

Do not implement the entire roadmap in one unverified pass.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
