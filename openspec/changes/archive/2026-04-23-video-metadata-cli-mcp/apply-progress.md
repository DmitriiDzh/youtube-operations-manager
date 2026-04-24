# Apply Progress — Batch 3 (cumulative)

**Change**: `video-metadata-cli-mcp`  
**Mode**: Standard (Strict TDD disabled)

## Completed in previous batches

- [x] Added executable automated test runner (`node:test` + `tsx`) and wired `npm test`.
- [x] Added runtime test evidence for core video-metadata scenarios.
- [x] Fixed preexisting lint blocker in `src/app/dashboard/page.tsx` and re-ran quality gates.
- [x] Updated OpenSpec testing capabilities and validation commands documentation.
- [x] Marked task 4.5 as complete in `tasks.md`.

## Completed in this batch

- [x] Added automated CLI adapter tests covering list invocation, structured success envelope, validation failure envelope, and apply dry-run behavior.
- [x] Added automated MCP adapter tests covering preview generation, strict invalid-input rejection with structured errors, and apply dry-run review behavior.
- [x] Added automated credential-resolution tests for non-web resolution success, insufficient scopes, and expired-token-without-refresh failure mapping.
- [x] Added explicit runtime evidence that preview/editorial flow remains enabled when transcript is `unavailable` or `unsupported`.

## Behavioral Scenario Evidence (runtime)

| Spec Domain | Scenario | Evidence | Status |
|---|---|---|---|
| video-metadata-core | Listado exitoso | `src/lib/video-metadata/services.test.ts` → `listVideos returns typed list when credentials are valid` | ✅ TESTED |
| video-metadata-core | Error de acceso al canal | `src/lib/video-metadata/services.test.ts` → `listVideos maps unknown adapter errors to unauthorized` | ✅ TESTED |
| video-metadata-core | Transcript disponible | `src/lib/video-metadata/services.test.ts` → `getTranscript keeps available status` | ✅ TESTED |
| video-metadata-core | Transcript no disponible + fallback editorial habilitado | `src/lib/video-metadata/services.test.ts` → `getTranscript keeps unavailable status` + `previewMetadata remains enabled when transcript is unavailable` | ✅ TESTED |
| video-metadata-core | Provider no soportado + fallback editorial habilitado | `src/lib/video-metadata/services.test.ts` → `getTranscript keeps unsupported status` + `previewMetadata remains enabled when transcript provider is unsupported` | ✅ TESTED |
| video-metadata-core | Generación válida | `src/lib/video-metadata/services.test.ts` → `previewMetadata returns one finalTitle and one description` + `src/lib/video-metadata/adapters/metadata-generator.test.ts` → `metadata generator returns valid draft in rule-based mode` | ✅ TESTED |
| video-metadata-core | Salida inválida del modelo | `src/lib/video-metadata/adapters/metadata-generator.test.ts` → `metadata generator rejects malformed raw-json as validation_failed` | ✅ TESTED |
| video-metadata-core | Update preservando campos | `src/lib/video-metadata/services.test.ts` → `applyMetadata updates only title/description while preserving snippet fields` | ✅ TESTED |
| video-metadata-core | Modo dry-run | `src/lib/video-metadata/services.test.ts` → `applyMetadata dryRun proposes title/description and avoids remote mutation` | ✅ TESTED |
| video-metadata-cli | Ejecución de comando de listado | `src/cli/video-metadata.test.ts` → `CLI list command calls core listVideos and returns structured JSON` | ✅ TESTED |
| video-metadata-cli | Respuesta estructurada | `src/cli/video-metadata.test.ts` → `CLI list command calls core listVideos and returns structured JSON` | ✅ TESTED |
| video-metadata-cli | Error de validación de entrada | `src/cli/video-metadata.test.ts` → `CLI returns validation error and non-zero exit for missing required flags` | ✅ TESTED |
| video-metadata-cli | Dry-run en update | `src/cli/video-metadata.test.ts` → `CLI apply dry-run forwards dryRun=true and returns proposal` | ✅ TESTED |
| video-metadata-mcp | Invocación de herramienta de generación | `src/mcp/server.test.ts` → `MCP preview tool returns finalTitle and description for valid input` | ✅ TESTED |
| video-metadata-mcp | Input MCP inválido | `src/mcp/server.test.ts` → `MCP handlers reject invalid input with structured validation error` | ✅ TESTED |
| video-metadata-mcp | Update MCP en modo revisión | `src/mcp/server.test.ts` → `MCP apply tool supports dry-run review without mutation` | ✅ TESTED |
| youtube-credential-resolution | Resolución exitosa para adapter no-web | `src/lib/video-metadata/adapters/google-auth.test.ts` → `resolveGoogleCredentials returns usable auth context for non-web adapters` | ✅ TESTED |
| youtube-credential-resolution | Scopes insuficientes | `src/lib/video-metadata/adapters/google-auth.test.ts` → `resolveGoogleCredentials rejects credentials with insufficient scopes` | ✅ TESTED |
| youtube-credential-resolution | Token expirado sin renovación posible | `src/lib/video-metadata/adapters/google-auth.test.ts` → `resolveGoogleCredentials fails consistently when token is expired and cannot refresh` | ✅ TESTED |

### Coverage summary after Batch 3

- Scenarios with automated runtime evidence: **19/19**
- Remaining verify gaps by scenario matrix: **0**

## Quality gate execution (this batch)

```bash
npm test          # ✅ pass (21 tests)
npm run lint      # ✅ pass
npx tsc --noEmit  # ✅ pass
```

## Remaining tasks

- [ ] 4.1 Run manual auth matrix (web/CLI/MCP)
- [ ] 4.2 Run manual transcript matrix
- [ ] 4.3 Run manual generation checks with fixed prompt
- [ ] 4.4 Run manual safe-update checks

## Notes

- This batch focused on closing all verify `UNTESTED` scenarios with executable evidence and resolving transcript-fallback `PARTIAL` evidence.
- Task 4.1–4.4 remain open because they explicitly require manual matrix execution in real environment credentials.
