# Apply Progress: transcript-diagnostics

## Mode

Standard (strict_tdd: false)

## Completed Tasks

- [x] 1.1 Contract updated with granular unavailable reasons + typed diagnostic
- [x] 1.2 Zod schemas updated for new transcript contract
- [x] 1.3 Shared transcript/preview output validators preserve diagnostic payload
- [x] 2.1 Provider refactored with explicit `captions-list`/`captions-download` error classification
- [x] 2.2 Mapping priority implemented: `apiReason -> httpStatus -> fallback`, including empty list/normalized SRT as `no-captions`
- [x] 2.3 Retriable behavior restricted to `rate-limited` and transient `api-error`
- [x] 2.4 Diagnostic sanitization enforced (no raw config/headers/urls/tokens/payloads)
- [x] 3.1 Transcript API route handler created with auth + DomainError handling
- [x] 3.2 CLI transcript JSON envelope remains stable and diagnostic passthrough verified
- [x] 3.3 MCP transcript `structuredContent` and text payload alignment verified
- [x] 4.1 Transcript provider unit tests added for stage mapping/classification/retriable/sanitization
- [x] 4.2 Services regression tests extended for passthrough and preview continuity without editorial fallback
- [x] 4.3 CLI transcript regression test extended for diagnostic propagation
- [x] 4.4 MCP transcript regression test extended for payload parity
- [x] 4.5 Transcript API route regression tests added (happy path, unavailable payload, validation/auth)
- [x] 5.1 README contract section updated with additive compatibility notes

## Validation

- `npm test`
- `npm run lint`
- `npx tsc --noEmit`

## Deviations

None — implementation follows proposal/spec/design and keeps fallback behavior as `unknown` without introducing editorial fallback.
