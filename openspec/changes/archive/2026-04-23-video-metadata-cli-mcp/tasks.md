# Tasks: Video Metadata CLI + MCP

## Phase 1: Foundation / Shared Contracts

- [x] 1.1 Create `src/lib/video-metadata/contracts.ts` with domain types/errors (`CredentialRef`, `TranscriptResult`, `MetadataDraft`, domain error union) shared by web/CLI/MCP.
- [x] 1.2 Create `src/lib/video-metadata/schemas.ts` with Zod schemas for list/transcript/preview/apply input-output; include `dryRun` and strict parse errors.
- [x] 1.3 Create `src/lib/video-metadata/editorial-template.ts` with fixed user prompt template + `promptVersion` constant (single source of truth).
- [x] 1.4 Modify `src/lib/auth.ts` to export reusable YouTube scopes and OAuth client factory independent from `getServerSession`.
- [x] 1.5 Modify `src/lib/db.ts` to add reusable OAuth token read/write helpers for user-based and explicit credential references.
- [x] 1.6 Create `src/lib/video-metadata/adapters/google-auth.ts` to resolve credentials, validate required scopes, refresh tokens, and map auth failures to typed domain errors.

## Phase 2: Core Services / YouTube + LLM Integration

- [x] 2.1 Modify `src/lib/youtube.ts` to expose low-level fetch/update helpers needed by core, including safe snippet merge for updates.
- [x] 2.2 Create `src/lib/video-metadata/adapters/youtube-api.ts` to map YouTube list/detail/update responses into domain contracts.
- [x] 2.3 Create `src/lib/video-metadata/adapters/transcript-provider.ts` returning explicit transcript states (`available`, `unavailable`, `unsupported`) with typed reasons.
- [x] 2.4 Create `src/lib/video-metadata/adapters/metadata-generator.ts` to run generation with the fixed prompt and validate output (`finalTitle`, `description`) via Zod.
- [x] 2.5 Create `src/lib/video-metadata/adapters/logger.ts` with structured logger interface + default implementation for preview/apply traces.
- [x] 2.6 Create `src/lib/video-metadata/services.ts` implementing use cases: `listVideos`, `getTranscript`, `previewMetadata`, `applyMetadata` with boundary validation.
- [x] 2.7 Implement dry-run/review path in `applyMetadata` so `dryRun=true` returns proposed changes without remote mutation.

## Phase 3: Adapter Wiring (Web, CLI, MCP)

- [x] 3.1 Create `src/lib/video-metadata/index.ts` composition factory to wire shared core dependencies for web/CLI/MCP adapters.
- [x] 3.2 Modify `src/app/api/youtube/videos/route.ts` to call `listVideos` from core while preserving current auth boundary behavior.
- [x] 3.3 Create `src/app/api/video-metadata/preview/route.ts` Route Handler using core preview use case and schema-validated HTTP payloads.
- [x] 3.4 Create `src/app/api/video-metadata/apply/route.ts` Route Handler using core apply use case with dry-run support.
- [x] 3.5 Create `src/cli/video-metadata.ts` CLI adapter with commands `list`, `transcript`, `preview`, `apply`; output stable JSON and non-zero exit on typed errors.
- [x] 3.6 Create `src/mcp/server.ts` MCP adapter exposing tools `list`, `transcript`, `preview`, `apply` with strict input/output validation.
- [x] 3.7 Modify `package.json` scripts/dependencies for CLI execution, MCP server startup, and metadata generator runtime.

## Phase 4: Manual Verification + Minimal Docs

- [ ] 4.1 Run manual auth matrix (web/CLI/MCP): valid credentials, insufficient scopes, expired token without refresh; verify consistent domain errors.
- [ ] 4.2 Run manual transcript matrix: captions available, no captions, provider unsupported; verify fallback behavior remains usable.
- [ ] 4.3 Run manual generation checks with fixed prompt: valid output accepted; malformed model output rejected as `validation_failed`.
- [ ] 4.4 Run manual safe-update checks: only `title`/`description` change, other snippet fields preserved; `dryRun=true` performs no mutation.
- [x] 4.5 Execute quality gates `npm run lint` and `npx tsc --noEmit`; resolve lint/type issues from new core/adapters.
- [x] 4.6 Add minimal usage docs in `README.md` (or `docs/video-metadata-cli-mcp.md`): required env vars, CLI/MCP commands, and manual verification checklist.
