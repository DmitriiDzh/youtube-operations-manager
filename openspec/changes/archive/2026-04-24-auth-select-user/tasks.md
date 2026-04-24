# Tasks: Auth Select User

## Phase 1: Foundation (auth service + storage)

- [x] 1.1 Definir `SelectUserResult` y errores tipados (`AUTH_USER_NOT_FOUND`) en `src/lib/cli-auth/service.ts`, incluyendo `affectsRemoteOAuth=false`.
- [x] 1.2 Implementar `CliAuthService.selectUser(userId)` en `src/lib/cli-auth/service.ts` validando existencia local vía DB antes de persistir.
- [x] 1.3 Persistir `activeUserId` con `createActiveAuthStorage.write` en `src/lib/cli-auth/storage.ts` sin romper overwrite atómico/permisos.
- [x] 1.4 Reusar/factorizar snapshot post-switch en `src/lib/cli-auth/service.ts` para devolver `activeUser`, `previousActiveUserId`, `changed`, `writeChannel`, `alignment`, `requiresReauth`.

## Phase 2: CLI implementation

- [x] 2.1 Extender parser en `src/cli/video-metadata.ts` con `auth select-user --userId <ID>` y validación estricta de flag requerida.
- [x] 2.2 Conectar handler CLI a `CliAuthService.selectUser` en `src/cli/video-metadata.ts`, mapeando errores tipados a salida accionable.
- [x] 2.3 Mantener contrato JSON estable del subcomando en `src/cli/video-metadata.ts` alineado con `auth whoami`/`auth list-users`.

## Phase 3: MCP integration

- [x] 3.1 Agregar schema Zod 4 de entrada en `src/mcp/server.ts` para `auth_user_select` (`userId: z.string().min(1)`).
- [x] 3.2 Registrar `auth_user_select` en `src/mcp/server.ts` delegando a `CliAuthService.selectUser` y aclarando “local context only”.
- [x] 3.3 Normalizar errores MCP en `src/mcp/server.ts` separando validación de payload, `AUTH_USER_NOT_FOUND` y fallas inesperadas.

## Phase 4: Testing & verification

- [x] 4.1 Extender `src/lib/cli-auth/service.test.ts` para escenario exitoso A→B, usuario inexistente sin persistir cambios, y selección idempotente (`changed=false`).
- [x] 4.2 Extender `src/cli/video-metadata.test.ts` para `auth select-user` exitoso, `--userId` faltante/inválido y error `AUTH_USER_NOT_FOUND`.
- [x] 4.3 Extender `src/mcp/server.test.ts` para registro de `auth_user_select`, éxito, error de schema y usuario local inexistente.
- [x] 4.4 Verificar en tests de resolución (`src/lib/youtube-auth/context.ts` o suite equivalente) que el fallback sin `credentialRef` usa el nuevo `activeUserId`.

## Phase 5: Documentation

- [x] 5.1 Actualizar `README.md` con uso de `auth select-user`, aclarando que NO hace login/reauth OAuth remoto.
- [x] 5.2 Documentar `auth_user_select` en `README.md` (input/output/errores) y precedencia `credentialRef` explícito > `activeUserId` implícito.
