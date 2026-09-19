# 0003. In-repo `published/<version>/` release snapshots, committed directly on `main`

Status: Accepted

This is a git-workflow/release-process decision rather than an application-architecture one, but
it introduces a narrow, explicit exception to `AGENTS.md` §K.1 ("no direct commits on `main`"),
which is exactly the kind of thing this repository's ADR practice exists to record rather than
leave as an unwritten exception discovered later. Decided directly with the project owner,
2026-09-19.

## Context

The project owner wants a way to hand a specific, self-contained version of the application to
someone (another device, a real end user) without requiring them to know git, without requiring
them to have `node_modules`/build output committed anywhere, and with the version identifiable
just by looking at the files. The request: a `published/` folder in this repository, with one
subfolder per version, each subfolder being "a slice of `main`."

`docs/RELEASE_LAYOUT.md` §1 already describes a Syncthing-shared folder with `windows/`/`macos/`
subfolders for platform-specific release output. That document does not say what actually
populates those folders, or how a version is identified once there.

## Problem

Two things need deciding that are not obvious from "a slice of `main`":

1. **Which commit is a `published/<version>/` snapshot actually a slice of?** `AGENTS.md` §K.1
   says content reaches `main` only via an approved `dev → main --no-ff` merge, and forbids direct
   commits on `main` otherwise. A snapshot cannot be added to `main` *before* the release merge
   (there is nothing on `main` yet to slice), and a snapshot committed on `dev` before the merge is
   a slice of the release candidate, not of `main` — its `build-info.json` could not carry the
   actual `main` merge commit SHA, because that commit does not exist yet at snapshot-creation
   time.
2. **What does the snapshot contain?** The project owner confirmed `published/` may leave their
   own hands (handed to another device or person), so a full, unfiltered copy of the repository
   tree is not acceptable by default — it would carry `docs/TECHNICAL_DEBT.md` (which enumerates
   accepted security tradeoffs, e.g. plaintext local token storage), `AGENTS.md` itself, and the
   rest of this project's internal planning/process documentation.

## Alternatives

1. **Snapshot from `dev`, before the release merge.** Simple, no `main`-policy exception needed.
   Rejected by the project owner: it would not actually be "a slice of `main`," and its
   `build-info.json` would reference a commit that `main` never directly contains (the dev-side
   pre-merge commit, not the merge commit itself).
2. **Snapshot from `main`, as a direct commit immediately after the release merge.** Requires a
   narrow, explicit exception to `AGENTS.md` §K.1. Chosen — see Decision.
3. **Full, unfiltered tree copy (blocklist approach: copy everything, then delete known-sensitive
   paths).** Rejected: a blocklist only protects against *known* sensitive paths at the time it
   was written; a new internal-only doc added later (another ADR, another risk log) would leak
   into `published/` by default until someone remembers to add it to the blocklist. An allowlist
   is fail-safe in the same spirit as `src/lib/snapshot/contracts.ts`'s `SNAPSHOT_TRANSFERRED_TABLES`
   (a new table is excluded by default unless deliberately added) — see Decision.

## Decision

- A `published/<version>/` folder is added as a **direct commit on `main`**, immediately after
  and as part of the same release action as an already-approved `dev → main --no-ff` merge — never
  as a standalone action, never for any other content, and never bypassing the release approval
  itself (`AGENTS.md` §K.4 still gates the release; this only changes *where the snapshot commit
  lands*, not who approves the release). `AGENTS.md` §K.1 is updated with this single, named
  exception.
- The snapshot's `build-info.json` records the version, the `main` merge commit's SHA (which now
  exists, since the snapshot commit is its child), and a build timestamp.
- Content is **allowlisted, not blocklisted** — see `scripts/publish-snapshot.mjs`'s
  `PUBLISHED_ALLOWLIST` for the authoritative list. Currently: `src/`, `scripts/`, `public/`,
  `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`,
  `postcss.config.mjs`, `.env.example`, `README.md`, `LICENSE`, and the operator-facing docs
  (`docs/getting-started.md`, `docs/interfaces.md`, `docs/troubleshooting.md`,
  `docs/RELEASE_LAYOUT.md`, `docs/FIRST_LOCAL_TEST_BUILD.md`). Everything else — `AGENTS.md`,
  `CLAUDE.md`, `docs/PROJECT_SPEC.md`, `docs/ROADMAP_STATUS.md`, `docs/SYSTEM_MAP.md`,
  `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_PLAYBOOK.md`, `docs/TECHNICAL_DEBT.md`,
  `docs/UPSTREAM_*`, `docs/decisions/`, `docs/reports/`, `docs/acceptance/`,
  `docs/ai-localization/`, `docs/validation/`, `openspec/`, `data/`, `node_modules/`, `.next/`,
  `.git/`, and every `.env*` file except `.env.example` — is excluded by construction, since it is
  simply never on the allowlist. A future new top-level doc/dir is excluded by default until a
  reviewer deliberately adds it.
- `published/<version>/` is the canonical **source** referenced by `docs/RELEASE_LAYOUT.md` §1 —
  the `windows/`/`macos/` Syncthing-shared subfolders are populated *from* it (a plain copy, or the
  operator running the launcher scripts directly inside the published folder on each device), not
  an independent second release mechanism.
- Once created, a version's `published/<version>/` folder is immutable — the generator script
  refuses to overwrite an existing version folder without an explicit `--force`, mirroring the
  immutability convention already used for `src/lib/backup/`'s per-write-batch backups.

## Rationale

A direct-`main`-commit exception is narrower and more honest than either alternative: it keeps
"a slice of `main`" literally true (the stated requirement), and confines the one policy exception
to a single, named, always-release-gated action instead of either weakening what "a slice of
`main`" means (alternative 1) or accepting an open-ended content leak risk (alternative 3).

## Consequences

**Easier:** handing a specific version to another device or person becomes "copy this one
folder"; the version is identifiable by folder name and `build-info.json` without needing git.

**Harder:** the repository grows by roughly one full allowlisted-tree copy per released version —
accepted explicitly by the project owner as a tradeoff of this approach; `main`'s otherwise-strict
"only via `dev → main` merge" invariant now has one named, narrow, auditable exception that anyone
reading `AGENTS.md` §K.1 must know about; the allowlist requires deliberate maintenance whenever a
new top-level file/directory is added to the repository and is meant to ship to end users (e.g. a
future `public/` asset directory addition already falls inside the current allowlist, but a
hypothetical new top-level `cli-docs/` would not, until added here).

## Compatibility / migration impact

No existing contract changes. No local user data (`data/playlist-manager.db`) is affected — the
allowlist explicitly never includes `data/`. This decision has no effect until the first real,
project-owner-approved `dev → main` release merge; no `published/<version>/` folder exists in this
repository as of this ADR (this task built and tested the tooling only, per `AGENTS.md` §K.4's
"do not cut a release as an incidental side effect of an unrelated task").
