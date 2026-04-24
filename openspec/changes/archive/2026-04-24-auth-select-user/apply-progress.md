# Apply Progress: auth-select-user

## Mode

Standard (strict_tdd: false)

## Completed Tasks

- [x] 1.1 Definir `SelectUserResult` y errores tipados (`AUTH_USER_NOT_FOUND`) en `src/lib/cli-auth/service.ts`, incluyendo `affectsRemoteOAuth=false`
- [x] 1.2 Implementar `CliAuthService.selectUser(userId)` en `src/lib/cli-auth/service.ts` validando existencia local vía DB antes de persistir
- [x] 1.3 Persistir `activeUserId` con `createActiveAuthStorage.write` reutilizando storage atómico existente
- [x] 1.4 Reusar/factorizar snapshot post-switch para devolver `activeUser`, `previousActiveUserId`, `changed`, `writeChannel`, `alignment`, `requiresReauth`
- [x] 2.1 Extender parser CLI con `auth select-user --userId <ID>` y validación estricta
- [x] 2.2 Conectar handler CLI a `CliAuthService.selectUser` con errores tipados
- [x] 2.3 Mantener contrato JSON estable del subcomando
- [x] 3.1 Agregar schema Zod 4 para `auth_user_select` (`userId: z.string().min(1)`)
- [x] 3.2 Registrar tool MCP `auth_user_select` con descripción explícita “local context only”
- [x] 3.3 Normalizar errores MCP separando validación, `AUTH_USER_NOT_FOUND` y error inesperado
- [x] 4.1 Extender `src/lib/cli-auth/service.test.ts` (success A→B, inexistente sin persistencia, idempotente)
- [x] 4.2 Extender `src/cli/video-metadata.test.ts` para `auth select-user` (success, flag faltante, `AUTH_USER_NOT_FOUND`)
- [x] 4.3 Extender `src/mcp/server.test.ts` para `auth_user_select` (registro, success, schema, inexistente)
- [x] 4.4 Verificar en suite equivalente de resolución que fallback sin `credentialRef` usa el nuevo `activeUserId`
- [x] 5.1 Actualizar `README.md` con uso de `auth select-user` y aclaración de NO cambio OAuth remoto
- [x] 5.2 Documentar `auth_user_select` (input/output/errores) y precedencia `credentialRef` explícito > `activeUserId`

## Validation

- `npm test`
- `npm run lint`
- `npx tsc --noEmit`

## Deviations

None — implementation follows proposal/spec/design and keeps OAuth remote identity untouched while switching only local fallback context.
