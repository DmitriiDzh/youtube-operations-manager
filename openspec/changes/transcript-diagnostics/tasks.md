# Tasks: Transcript Diagnostics

## Phase 1: Foundation Contracts & Schemas

- [x] 1.1 Update `src/lib/video-metadata/contracts.ts` to replace `unavailable.reason` with the granular union (`no-captions`, `captions-not-downloadable`, `permissions-insufficient`, `rate-limited`, `api-error`, `unknown`) and add typed `diagnostic` (`stage`, `httpStatus`, `apiReason`, `retriable`).
- [x] 1.2 Update `src/lib/video-metadata/schemas.ts` with strict Zod 4 schemas for the new transcript shape; keep `status` discriminant stable and preserve `unsupported.reason = provider-missing`.
- [x] 1.3 Ensure shared output validators (`transcriptOutputSchema`, `previewMetadataOutputSchema`) accept and preserve the new diagnostic payload without adding editorial fallback fields.

## Phase 2: Provider Diagnostic Mapping

- [x] 2.1 Refactor `src/lib/video-metadata/adapters/transcript-provider.ts` to add a dedicated classifier for `captions.list` and `captions.download` errors, preserving `stage` as `captions-list`/`captions-download`.
- [x] 2.2 Implement priority mapping `apiReason -> httpStatus -> fallback` for domain reasons; cover empty list/empty normalized SRT as `no-captions`.
- [x] 2.3 Mark retriable cases only for rate-limit and transient API failures (`rate-limited`, retriable `api-error`), defaulting unknown/untrusted cases to non-retriable.
- [x] 2.4 Sanitize diagnostics in provider output (no raw request config, headers, URLs, tokens, or full remote payloads).

## Phase 3: API/CLI/MCP Contract Exposure

- [x] 3.1 Create `src/app/api/video-metadata/transcript/route.ts` (Next.js App Router Route Handler) mirroring preview/apply auth+error handling and returning core transcript contract unchanged.
- [x] 3.2 Confirm `src/cli/video-metadata.ts` transcript command keeps envelope stable (`{ ok, data }`) while passing through new `transcript.diagnostic` fields unchanged.
- [x] 3.3 Confirm `src/mcp/server.ts` transcript tool keeps `structuredContent` and text payload aligned with core transcript contract, with no channel-specific reinterpretation.

## Phase 4: Tests & Regression Coverage

- [x] 4.1 Add `src/lib/video-metadata/adapters/transcript-provider.test.ts` with unit cases for list/download stage mapping, reason classification, retriable flag, and sanitization.
- [x] 4.2 Extend `src/lib/video-metadata/services.test.ts` to validate passthrough of granular `unavailable` reasons + diagnostic and verify `previewMetadata` still proceeds when transcript is unavailable/unsupported (sin fallback editorial).
- [x] 4.3 Extend `src/cli/video-metadata.test.ts` transcript tests to assert JSON envelope stability and exact propagation of diagnostic fields.
- [x] 4.4 Extend `src/mcp/server.test.ts` transcript tests to assert `structuredContent` and `content.text` include the same diagnostic contract.
- [x] 4.5 Add API regression tests for `src/app/api/video-metadata/transcript/route.ts` (happy path, unavailable mapped response, validation/auth errors) in `src/app/api/video-metadata/transcript/route.test.ts`.

## Phase 5: Minimal Documentation

- [x] 5.1 Update `README.md` video-metadata contract section with new transcript unavailable reasons and sanitized diagnostic fields; document additive compatibility expectations for existing consumers.
