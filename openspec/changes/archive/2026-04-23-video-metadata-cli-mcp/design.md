# Design: Video Metadata CLI + MCP

## Technical Approach

Implement a `video-metadata` core in `src/lib/video-metadata/` with explicit ports for auth, YouTube, transcript, editorial generation, and logging. Web, CLI, and MCP become thin adapters that validate input with Zod, build the same dependency graph, and call the same use cases. Existing Next.js Route Handlers remain server-first and adopt the core incrementally, starting with listing and metadata preview/apply paths.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Core shape | Extend `src/lib/youtube.ts` vs modular core | Modular core + adapters | Keeps CLI/MCP/web on one contract and avoids leaking NextAuth/request concerns into business logic. |
| Auth reuse | `getServerSession` everywhere vs token resolver | Shared token resolver + token store | NextAuth is fine for web entry, but CLI/MCP need credentials without request context. Resolver keeps one refresh/update path. |
| Transcript contract | Hard fail vs nullable/fallback result | `available \| unavailable \| unsupported` result | Captions are unreliable; domain result must distinguish “missing transcript” from execution failure. |
| Metadata execution | Single mutating command vs preview/apply split | Separate preview and apply use cases | Safer UX, clearer MCP tools, and clean logging/audit boundaries. |
| Prompt storage | Inline strings vs versioned template module | Versioned editorial template module | Prevents prompt drift across adapters and supports future variants without changing adapter code. |

## Data Flow

Sequence (preview):

`web/cli/mcp` → `input schema` → `credential resolver` → `youtube service` → `transcript service` → `editorial template + generator` → `output schema` → `logger`

Sequence (apply):

`web/cli/mcp` → `preview result or explicit payload` → `apply schema` → `credential resolver` → `youtube update service` → `logger`

Notes:
- Web adapter resolves `userId` from session, then immediately hands off to core.
- CLI/MCP resolve `userId` or explicit token source from flags/env/config.
- Logging records request, preview, and apply outcomes, but adapters decide presentation (JSON, MCP content, HTTP).

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/auth.ts` | Modify | Extract shared Google scopes/OAuth client factory from NextAuth config. |
| `src/lib/db.ts` | Modify | Add reusable token persistence helpers for stored OAuth credentials. |
| `src/lib/youtube.ts` | Modify | Reduce to low-level YouTube API helpers or re-export adapter helpers used by core. |
| `src/lib/video-metadata/contracts.ts` | Create | Core ports, domain types, and result envelopes. |
| `src/lib/video-metadata/schemas.ts` | Create | Zod input/output schemas for list, transcript, preview, and apply. |
| `src/lib/video-metadata/editorial-template.ts` | Create | Versioned editorial prompt/template configuration. |
| `src/lib/video-metadata/services.ts` | Create | Use cases: list videos, get transcript, generate metadata, update metadata. |
| `src/lib/video-metadata/adapters/google-auth.ts` | Create | Credential resolver + token refresh/store implementation. |
| `src/lib/video-metadata/adapters/youtube-api.ts` | Create | Google API adapter for listing/details/update calls. |
| `src/lib/video-metadata/adapters/transcript-provider.ts` | Create | Transcript retrieval adapter with explicit unavailable states. |
| `src/lib/video-metadata/adapters/metadata-generator.ts` | Create | LLM adapter returning schema-validated editorial output. |
| `src/lib/video-metadata/adapters/logger.ts` | Create | Structured logger interface and default implementation. |
| `src/app/api/youtube/videos/route.ts` | Modify | Use core listing flow through web adapter boundary. |
| `src/app/api/video-metadata/preview/route.ts` | Create | HTTP preview endpoint on top of core. |
| `src/app/api/video-metadata/apply/route.ts` | Create | HTTP apply endpoint on top of core. |
| `src/cli/video-metadata.ts` | Create | CLI adapter with `list`, `preview`, and `apply` commands. |
| `src/mcp/server.ts` | Create | MCP adapter exposing list/preview/apply tools. |
| `package.json` | Modify | Add CLI/MCP scripts and required runtime deps. |

## Interfaces / Contracts

```ts
type CredentialRef = { userId: string } | { accessToken: string; refreshToken?: string };

type TranscriptResult =
  | { status: "available"; text: string; language?: string }
  | { status: "unavailable"; reason: "no-captions" | "not-accessible" }
  | { status: "unsupported"; reason: "provider-missing" };

type MetadataDraft = { finalTitle: string; description: string; promptVersion: string };
```

Adapters MUST validate external input with Zod and return typed domain errors (`unauthorized`, `validation_failed`, `transcript_unavailable`, `generation_failed`, `update_failed`).

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Schemas, template assembly, error mapping | Add lightweight TS tests once runner exists; until then prioritize pure-function structure. |
| Integration | Credential resolution, YouTube adapter mapping, preview/apply orchestration | Mock Google/LLM ports behind core interfaces. |
| E2E | CLI/MCP happy path against sandbox credentials | Deferred until repo adds test infrastructure. |

## Migration / Rollout

No data migration required. Roll out in three steps: introduce core, wire web preview/list endpoints, then add CLI and MCP scripts. Keep current playlist-management routes untouched during this change.

## Open Questions

- [ ] Which transcript provider/library will be used when the official YouTube Data API lacks captions access?
- [ ] Which LLM provider/package is the project-standard dependency for `metadata-generator`?
