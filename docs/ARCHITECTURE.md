Read this index whole; open only the subsystem file you touch.

# ARCHITECTURE.md

Living architecture reference for this repository. For the product roadmap and safety rules, see `docs/PROJECT_SPEC.md`. For how to extend this architecture, see `docs/DEVELOPMENT_PLAYBOOK.md`. For the current risk register and release gates, see `docs/TECHNICAL_DEBT.md`. For significant architectural decisions and their rationale, see `docs/decisions/`.

This document is updated whenever a phase changes the architecture. Current as of **Phase 4 (XLSX import, draft state, change sets, diff/approval UI)**; Phase 4.5 added no new architecture, only this documentation-consistency pass and §12 below.

---

## 1. Stack

Next.js 16 (App Router, Turbopack) + TypeScript + NextAuth (Google OAuth) + googleapis + Drizzle ORM over libSQL/SQLite + Zod + MCP SDK. Test runner is Node's built-in `node:test` via `tsx`.

## 2. Interfaces over one shared core

```text
Human Operator          AI Agent / Claude / Codex
      │                          │
   Web UI                       MCP
      │                          │
      └──────────┬───────────────┘
                 CLI ─────────────┘
                  │
         Domain core services
   (video-metadata, playlist-management,
    write-context, channel-sync, ...)
                  │
        googleapis (YouTube Data API v3)
                  │
          libSQL / SQLite (data/playlist-manager.db)
```

Every interface (Web UI route handlers, CLI, MCP) calls the same domain-module core factory functions (`createVideoMetadataCore()`, `createPlaylistManagementCore()`, `createChannelSyncCore()`); none of them re-implements YouTube API logic or write-safety checks independently. See `docs/PROJECT_SPEC.md` §66: "one safe operational core, many interfaces."

## 3. Domain module layering (`src/lib/*`)

Every domain module under `src/lib/` follows the same four-file layering, introduced early in this project and preserved for every module added since:

```text
contracts.ts   — plain TS types + the shared DomainError class (stable error codes)
schemas.ts     — Zod schemas validating every input/output boundary
services.ts    — orchestration logic, dependency-injected, unit-testable without network/DB
adapters/      — concrete implementations (YouTube API calls, persistence, logging)
index.ts       — core factory wiring real adapters into the services
```

| Module | Purpose | Write capability |
|---|---|---|
| `video-metadata/` | Transcript, AI-assisted draft preview, single-video metadata apply | Yes — guarded, dry-run capable |
| `playlist-management/` | Playlist CRUD + video membership | Yes — guarded, ownership-checked |
| `write-context/` | `expectedChannelId` fail-closed identity guardrail, shared by every write path | N/A (guardrail only) |
| `channel-sync/` (Phase 2) | Full-channel video enumeration + local persistence | **No — read-only** |
| `localization/` (Phase 3) | Read model over synced videos' existing localizations, missing-language computation, XLSX export | **No — read-only** |
| `changesets/` **(new, Phase 4)** | XLSX import parsing/validation, field-level diff, persistent change sets, local approve/reject | **No YouTube write — local DB only** |
| `cli-auth/` | Local credential resolution for CLI/MCP (active-user pointer, storage) | Local state only |

## Sections 4 and later

Every section below was moved verbatim (2026-11-17, `docs/roadmap/plans/DOCS_SPLIT_PLAN.md`), with its original heading and number, into the file in the last column; `ARCHITECTURE.md §47` is found by its number here. A new section is a new row here and an entry in the domain file.

| § | Section | File |
|---|---|---|
| 4 | Phase 2: Channel/Video Synchronization | `docs/architecture/channel-video-sync.md` |
| 5 | Phase 3: Localization Manager | `docs/architecture/localization.md` |
| 6 | Phase 4: XLSX Import, Draft State, Change Sets & Diff/Approval | `docs/architecture/changesets-batches.md` |
| 7 | Persistence | `docs/architecture/persistence-tests.md` |
| 8 | API Routes | `docs/architecture/channel-video-sync.md` |
| 9 | Web UI | `docs/architecture/video-details.md` |
| 10 | What remains deliberately unimplemented after Phase 4 | `docs/architecture/changesets-batches.md` |
| 11 | Extension points confirmed by these phases | `docs/architecture/changesets-batches.md` |
| 12 | Known limitations | `docs/architecture/changesets-batches.md` |
| 13 | Pre-Release: Cross-Platform Persistence & Device Handoff | `docs/architecture/device-sync.md` |
| 14 | Phase 8 | `docs/architecture/analytics.md` |
| 15 | Cloud connection | `docs/architecture/cloud.md` |
| 16 | Cloud Quotas | `docs/architecture/cloud.md` |
| 17 | Agent Operations Interface | `docs/architecture/agent-operations.md` |
| 18 | Market Intelligence | `docs/architecture/market-intelligence.md` |
| 19 | Decision & Experiment Engine | `docs/architecture/decision-engine.md` |
| 20 | Channel Workspaces | `docs/architecture/channel-workspaces.md` |
| 21 | Channel-bound agent isolation | `docs/architecture/agent-operations.md` |
| 22 | Architecture audit, 2026-10-01: documented rules that were implicit | `docs/architecture/youtube-gateways.md` |
| 23 | Automatic device sync | `docs/architecture/device-sync.md` |
| 24 | Data sources and YouTube API policy compliance | `docs/architecture/youtube-gateways.md` |
| 25 | Factory Operator access: logical path registry and a second agent role | `docs/architecture/agent-operations.md` |
| 26 | Remote media generation | `docs/architecture/media-generation.md` |
| 29 | Generation plans | `docs/architecture/media-generation.md` |
| 30 | Shared Production settings and the conflict screen | `docs/architecture/device-sync.md` |
| 31 | Analytics and reach data shared between devices | `docs/architecture/device-sync.md` |
| 32 | Interface language | `docs/architecture/web-ui.md` |
| 33 | Servers and Media, other channels' work, plan move, reviewing from two computers | `docs/architecture/web-ui.md` |
| 34 | Agent tokens shared between devices, and the Producer role | `docs/architecture/agent-operations.md` |
| 35 | Watchlist hygiene and agent proposals | `docs/architecture/market-intelligence.md` |
| 36 | Video milestones: day-7 and day-28 retention and totals | `docs/architecture/analytics-stored-data.md` |
| 37 | Stored traffic sources and devices per day | `docs/architecture/analytics-stored-data.md` |
| 38 | Stored search terms per video and per channel week | `docs/architecture/analytics-stored-data.md` |
| 39 | Experiment arms on videos | `docs/architecture/analytics-stored-data.md` |
| 40 | Own-video comments | `docs/architecture/analytics-stored-data.md` |
| 41 | GPU availability per datacenter, now and every 15 minutes | `docs/architecture/media-generation-runpod.md` |
| 42 | Re-checks of rated tracks: a fixed version, or a question about one spot | `docs/architecture/media-review.md` |
| 43 | Images and video through Google's Gemini API, driven by the Factory Operator | `docs/architecture/media-generation-gemini.md` |
| 44 | Review of generated images and video: one of N, pins, reason chips | `docs/architecture/media-review.md` |
| 45 | A channel's 24/7 live stream of its own public videos | `docs/architecture/live-streams.md` |
| 46 | The channel's language is the truth for localization | `docs/architecture/localization.md` |
| 47 | Publishing from YT Manager: uploads, calendar, reminder | `docs/architecture/publishing.md` |
| 48 | Storyboards reviewed before video, and Media's tabs by kind | `docs/architecture/media-review.md` |
| 49 | Stored "Suggested videos" sources per video and per channel week | `docs/architecture/analytics-stored-data.md` |
| 50 | Cloud APIs together: one Settings tab, a Gemini card in Servers, spend and limi… | `docs/architecture/cloud.md` |
| 51 | Video numbers given by YT Manager | `docs/architecture/video-costs.md` |
| 52 | The visual cost of each video | `docs/architecture/video-costs.md` |
| BL-199/BL-134 | one store for this computer's secrets; gated Hugging Face pulls | `docs/architecture/media-generation-runpod.md` |
| BL-200 | pod runtimes the Factory Operator manages | `docs/architecture/media-generation-runpod.md` |
| BL-207 | live stream translations at publish | `docs/architecture/live-streams.md` |
| BL-210 | a channel's own translations | `docs/architecture/channel-identity-writers.md` |
| BL-223 | the channel branding writer | `docs/architecture/channel-identity-writers.md` |
| BL-225 | the weekly publishing plan | `docs/architecture/publishing.md` |
| BL-221 | the Content section redesign | `docs/architecture/web-ui.md` |
| BL-266 | «Ролики и релизы» folded into «План» | `docs/architecture/web-ui.md` |
| BL-228 | one-time paid approvals through the HUB "System" topic | `docs/architecture/agent-operations.md` |
| BL-229 | the music library per genre | `docs/architecture/media-review.md` |
| BL-236 | speech in designed channel voices | `docs/architecture/media-review.md` |
| BL-237 | disk hygiene | `docs/architecture/disk-hygiene.md` |
| BL-238 | local video cleanup after upload | `docs/architecture/publishing.md` |
| BL-241 | clips for review | `docs/architecture/media-review.md` |
| BL-272 | master still images for review | `docs/architecture/media-review.md` |
| BL-248 | the owner's review decisions wake the Producer | `docs/architecture/agent-operations.md` |
| BL-255 | replacing an uploaded video's thumbnail | `docs/architecture/publishing.md` |
| BL-271 | waiting for a long operation without agent tokens | `docs/architecture/agent-operations.md` |
| BL-269 | English captions for WWE long videos | `docs/architecture/publishing.md` |
| BL-257 | the owner's review of final release packages | `docs/architecture/publishing.md` |
| BL-267 | the week template replaces slot approval | `docs/architecture/publishing.md` |
| BL-265 | the media-only gate and packaging fixes after upload | `docs/architecture/publishing.md` |
| BL-263 | the second video code `S<n>` and the Short recode | `docs/architecture/publishing.md` |
