# Proposal: CLI Auth Bootstrap

## Intent

Agregar bootstrap OAuth usable desde CLI para que humanos y agentes puedan autenticarse sin pasar tokens manualmente. El problema hoy no es resolver credenciales existentes, sino CREAR y activar ese contexto fuera del login web.

## Scope

### In Scope
- `auth login` con loopback localhost + browser como camino default.
- Fallback viable para headless (`auth login --device`) y contexto activo reutilizable por CLI/MCP.
- Comandos mínimos: `auth login`, `auth whoami`, `auth list-users`, `auth revoke`/`auth logout`.
- Compatibilidad con credenciales ya persistidas en SQLite y precedencia clara entre `credentialRef` explícito vs contexto activo.

### Out of Scope
- Reemplazar NextAuth web o migrar credenciales existentes.
- Soportar CI non-interactive puro sin una estrategia OAuth aprobada.
- Multi-profile avanzado, sync remota o secret managers.

## Capabilities

### New Capabilities
- `cli-auth-bootstrap`: bootstrap, activación, inspección y revocación de auth OAuth desde CLI.

### Modified Capabilities
- `youtube-credential-resolution`: aceptar contexto activo local y definir compatibilidad con filas OAuth existentes.
- `video-metadata-cli`: agregar namespace `auth` y contratos de salida/errores programáticos.
- `video-metadata-mcp`: permitir uso de contexto autenticado por defecto sin exigir token/manual ref en cada llamada.

## Approach

Usar OAuth Installed App con loopback + PKCE como default por mejor UX y refresh token offline. Mantener device code como fallback explícito cuando el proyecto confirme soporte de client type y polling. Persistir tokens en SQLite existente y guardar sólo `activeUserId` en archivo local no versionado. Precedencia: `credentialRef` explícito > contexto activo > error accionable. Tradeoff: más superficie de auth local, pero se evita copiar tokens y se mantiene control multiusuario.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/cli/video-metadata.ts` | Modified | Namespace `auth` y comandos mínimos |
| `src/lib/auth.ts` | Modified | URL/exchange OAuth reutilizable para CLI |
| `src/lib/db.ts` | Modified | Upsert/lookup de usuarios OAuth desde CLI |
| `src/lib/video-metadata/adapters/google-auth.ts` | Modified | Resolver contexto activo + precedencia |
| `src/mcp/server.ts` | Modified | Auth implícita opcional para tools |
| `README.md` / `package.json` | Modified | Documentación y entrypoints CLI |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Client OAuth incorrecto para loopback/device | Med | Especificar client types y fallback permitido |
| Refresh token no emitido/revocado | High | Detectar estado degradado y pedir re-login explícito |
| Contexto implícito ambiguo en MCP | Med | Definir precedencia estricta y `whoami`/errores claros |
| Tokens expuestos en disco/logs | Med | Archivo local mínimo, permisos restrictivos y redacción de secretos |

## Rollback Plan

Deshabilitar namespace `auth` y volver a exigir `credentialRef` explícito en CLI/MCP; conservar SQLite existente sin migraciones destructivas.

## Dependencies

- Exploration existente en `openspec/changes/cli-auth-bootstrap/exploration.md`.
- Credenciales Google OAuth actuales + validación de client types necesarios.

## Success Criteria

- [ ] Un usuario puede autenticarse desde CLI sin copiar tokens manualmente.
- [ ] CLI y MCP pueden reutilizar un contexto autenticado local con override explícito.
- [ ] Credenciales existentes en SQLite siguen siendo compatibles.
- [ ] Seguridad/UX quedan especificadas con fallback headless y rollback claro.
