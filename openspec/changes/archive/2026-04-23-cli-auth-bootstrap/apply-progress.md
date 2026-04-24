# Apply Progress — cli-auth-bootstrap

## Mode

Standard (strict_tdd: false)

## Completed Tasks

- [x] 1.1 `src/lib/cli-auth/storage.ts`
- [x] 1.2 `src/lib/db.ts` CLI auth helpers
- [x] 1.3 `src/lib/auth.ts` OAuth bootstrap helpers
- [x] 1.4 Typed auth errors mapped to stable JSON envelopes
- [x] 2.1 `src/lib/cli-auth/service.ts` core auth use-cases
- [x] 2.2 Loopback login integration (`auth login`)
- [x] 2.3 Device flow fallback (`auth login --device`)
- [x] 2.4 `google-auth` adapter auth error alignment + refresh persistence
- [x] 2.5 CLI `auth` namespace + active-context fallback for metadata commands
- [x] 2.6 MCP optional `credentialRef` + active-context default + explicit precedence
- [x] 3.1 CLI test expansion
- [x] 3.2 MCP test expansion
- [x] 3.3 Google auth adapter test expansion
- [x] 3.4 New tests for `cli-auth/storage` and `cli-auth/service`
- [x] 3.5 Verification commands executed
- [x] 4.1 README quickstart for agents
- [x] 4.2 Manual checklist added
- [x] 4.3 Security limits + rollback notes documented

## Verification

- ✅ `npm test`
- ✅ `npm run lint`
- ✅ `npx tsc --noEmit`

## Notes

- Device login is implemented with real Google Device Authorization endpoints; behavior depends on OAuth client type support in Google Cloud config. Failures are surfaced as structured errors.
- `auth logout` clears active context only; `auth revoke` requires successful remote revoke before local token cleanup.

## Corrective Batch — verify CRITICAL closure (2026-04-23)

- ✅ Added runtime CLI test for successful default loopback path (`auth login`) with stable success envelope assertions.
- ✅ Added runtime CLI envelope test for `AUTH_REFRESH_TOKEN_MISSING` (`ok=false`, `error.code`, `message`, `details`, exit code 1).
- ✅ Addressed verify WARNING cheaply by expanding active-context fallback coverage for CLI `transcript`, `preview`, and `apply` (in addition to existing `list`).
- ✅ Validation run after batch: `npm test` (42/42), `npm run lint`, `npx tsc --noEmit`.
