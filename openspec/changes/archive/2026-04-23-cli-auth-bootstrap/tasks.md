# Tasks: CLI Auth Bootstrap

## Phase 1: Infrastructure & Contracts

- [x] 1.1 Crear `src/lib/cli-auth/storage.ts` con schema Zod v4 para `ActiveAuthContext`, lectura/escritura atómica de `data/auth-context.json`, permisos `0600` y creación de `data/` con `0700` cuando aplique.
- [x] 1.2 Extender `src/lib/db.ts` con helpers CLI auth (`upsertOAuthUserFromCli`, `listOAuthUsers`, `getOAuthUserSummary`, `clearUserOAuthTokens`) manteniendo compatibilidad con filas existentes y sin migraciones destructivas.
- [x] 1.3 Extraer en `src/lib/auth.ts` helpers OAuth reutilizables para CLI (PKCE/state, auth URL loopback, exchange code, device polling opcional, fetch identidad y revoke remoto) sin exponer secretos en logs.
- [x] 1.4 Definir errores tipados de auth (`AUTH_CALLBACK_INVALID`, `AUTH_REFRESH_TOKEN_MISSING`, `AUTH_USER_NOT_FOUND`, `AUTH_SCOPE_INSUFFICIENT`) y mapearlos a `DomainError`/envelopes JSON estables.

## Phase 2: Core Implementation

- [x] 2.1 Implementar `src/lib/cli-auth/service.ts` con casos `login`, `loginDevice`, `whoami`, `listUsers`, `logout`, `revoke` y `resolveEffectiveCredentialRef` (precedencia: explícito > contexto activo > error).
- [x] 2.2 Integrar `login` loopback en `service.ts`: abrir browser, levantar callback local en `127.0.0.1`, intercambiar código, persistir usuario/tokens en SQLite y activar `activeUserId`.
- [x] 2.3 Implementar fallback `auth login --device` en `service.ts` con polling controlado, expiración/cancelación y mensajes accionables para headless.
- [x] 2.4 Actualizar `src/lib/video-metadata/adapters/google-auth.ts` para usar nuevos helpers DB/auth, persistir refresh actualizado y emitir errores tipados de scopes/usuario faltante.
- [x] 2.5 Actualizar `src/cli/video-metadata.ts` para agregar namespace `auth` (`login`, `whoami`, `list-users`, `logout`, `revoke`) y reutilizar `resolveEffectiveCredentialRef` en `list/transcript/preview/apply` cuando no se pasa `--userId` ni `--accessToken`.
- [x] 2.6 Actualizar `src/mcp/server.ts` para permitir `credentialRef` opcional en tools, resolver contexto activo por defecto y respetar override explícito por request.

## Phase 3: Integration & Verification

- [x] 3.1 Expandir `src/cli/video-metadata.test.ts` con casos de `auth login/whoami/list-users/logout/revoke`, comando `auth` inválido, y envelopes de error/success estables.
- [x] 3.2 Expandir `src/mcp/server.test.ts` validando fallback a `activeUserId`, precedencia de `credentialRef` explícito y errores estructurados `AUTH_USER_NOT_FOUND` / `AUTH_SCOPE_INSUFFICIENT`.
- [x] 3.3 Expandir `src/lib/video-metadata/adapters/google-auth.test.ts` para refresh sin token (`AUTH_REFRESH_TOKEN_MISSING`), usuario inexistente y actualización de tokens persistidos.
- [x] 3.4 Agregar tests unitarios de `src/lib/cli-auth/storage.ts` y `src/lib/cli-auth/service.ts` (PKCE/state, permisos de archivo, revoke remoto fallido, logout sin borrar perfil).
- [x] 3.5 Ejecutar verificación automática: `npm test`, `npm run lint`, `npx tsc --noEmit`; registrar resultados y casos pendientes en el change.

## Phase 4: Documentation & Manual Checks

- [x] 4.1 Actualizar `README.md` con quickstart para agentes: `auth login`, `auth whoami`, `auth list-users`, `auth logout`, `auth revoke`, y precedencia de credenciales para CLI/MCP.
- [x] 4.2 Crear `openspec/changes/cli-auth-bootstrap/manual-checklist.md` con checklist manual razonable (loopback browser, device flow, usuario revocado activo, refresh faltante, override MCP explícito).
- [x] 4.3 Documentar límites de seguridad operativa (redacción de secretos, permisos de `auth-context.json`, rollback a `credentialRef` explícito) y enlazar desde README.
