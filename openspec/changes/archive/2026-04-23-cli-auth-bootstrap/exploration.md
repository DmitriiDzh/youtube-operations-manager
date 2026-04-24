## Exploration: cli-auth-bootstrap

### Current State
El proyecto YA resuelve credenciales fuera de sesión web para operación (CLI/MCP) pero NO para bootstrap de login. Hoy `src/cli/video-metadata.ts` y `src/mcp/server.ts` exigen `credentialRef` (`--userId` o token directo), y `resolveGoogleCredentials` en `src/lib/video-metadata/adapters/google-auth.ts` puede refrescar token y persistirlo en SQLite cuando recibe `userId`.

La persistencia actual en `users` (`src/lib/db.ts`) ya guarda `access_token`, `refresh_token`, `token_expiry`, `oauth_scope`, y se hidrata en login web vía NextAuth (`upsertUserOAuthOnSignIn` desde `src/lib/auth.ts`).

Gap real: falta un flujo CLI nativo para crear/administrar esas credenciales sin depender de haber pasado antes por `/api/auth/signin`.

### Affected Areas
- `src/lib/auth.ts` — define scopes YouTube y crea OAuth client; punto natural para reutilizar generación de URL de consentimiento + exchange.
- `src/lib/db.ts` — ya tiene storage de tokens, pero hoy `saveUserOAuthTokens` sólo actualiza filas existentes (no crea usuario nuevo); para CLI bootstrap eso es limitante.
- `src/cli/video-metadata.ts` — parser actual sólo contempla comandos de metadata; no existe namespace `auth`.
- `src/lib/video-metadata/adapters/google-auth.ts` — ya resuelve y refresca credenciales; sirve como consumidor principal del estado que cree `auth login`.
- `src/mcp/server.ts` — hoy requiere `credentialRef` en cada tool call; oportunidad para usar contexto CLI persistido y evitar pasar secretos en cada invocación.
- `README.md` / `package.json` — deberán reflejar comandos de auth y flujo recomendado para automatizaciones/agentes.
- `openspec/specs/youtube-credential-resolution/spec.md` — probablemente necesita extenderse para cubrir “credential bootstrap via CLI” y revocación.

### Approaches
1. **OAuth Installed App con loopback localhost + PKCE (recomendado)** — `auth login` abre browser, levanta callback local temporal (`127.0.0.1:{port}`), intercambia `code` por tokens y persiste en SQLite.
   - Pros: UX estándar para CLI desktop; no requiere copiar/pegar códigos; alineado con Google para desktop (loopback recomendado en macOS/Linux/Windows); permite refresh token offline.
   - Cons: requiere OAuth Client tipo Desktop (el client web actual puede no servir para loopback); depende de browser disponible; hay que manejar puertos/firewall y timeout.
   - Effort: Medium

2. **OAuth Device Code flow (TV/Limited Input client)** — `auth login --device` muestra `verification_url` + `user_code`, hace polling hasta autorización, persiste tokens.
   - Pros: excelente para servidores remotos/headless; no necesita callback local; UX robusta en SSH/containers.
   - Cons: requiere otro OAuth client type; scope set soportado es limitado (YouTube read/write sí está soportado, pero hay que validar OIDC/base scopes); complejidad de polling/backoff (`authorization_pending`, `slow_down`).
   - Effort: Medium

3. **Manual auth code exchange (`--code`)** — CLI imprime URL, usuario pega `code` manualmente (sin listener local), luego exchange y persistencia.
   - Pros: implementación simple, útil como fallback cuando no abre browser ni se puede usar device flow.
   - Cons: UX frágil; alto error humano; OOB/copy-paste histórico de Google está deprecado como método principal; debe ser fallback explícito y no camino por defecto.
   - Effort: Low/Medium

### Recommendation
Adoptar **Approach 1 como default** + **Approach 2 como fallback explícito para headless**.

Diseño de alto nivel sugerido:
- `auth login` (default loopback):
  1) genera auth URL con scopes `YOUTUBE_SCOPES` y `access_type=offline`,
  2) abre browser,
  3) recibe callback local,
  4) hace token exchange,
  5) obtiene identidad (`sub`, email) vía ID token/UserInfo,
  6) upsert en `users` con `userId=sub` + tokens + scope,
  7) marca “active auth context” local.
- `auth login --device`: mismo destino de persistencia usando device flow.
- `auth whoami`: lee contexto activo + valida estado mínimo (existencia usuario/tokens).
- `auth list-users`: lista usuarios en SQLite con metadata mínima (id/email/expiración/hasRefreshToken/active).
- `auth revoke` (y/o `auth logout`): revoca token contra `https://oauth2.googleapis.com/revoke`, limpia tokens locales del usuario y, para `logout`, desactiva contexto activo.

Para habilitar agentes vía CLI/MCP sin pasar secretos por invocación:
- guardar un contexto local no-versionado (ej. `data/auth-context.json`) con `activeUserId`;
- permitir en CLI/MCP resolver credenciales por contexto activo cuando no venga `credentialRef` explícito;
- mantener `credentialRef` explícito como override para multi-tenant/CI.

### Risks
- **Tipo de OAuth client**: el login web actual usa cliente web/NextAuth; loopback CLI suele requerir cliente Desktop con redirect URI de loopback autorizado.
- **Refresh token issuance**: Google no siempre devuelve `refresh_token` en consentimientos repetidos; sin refresh token el flujo CLI se degrada al expirar access token.
- **Límites de refresh tokens**: exceso de re-login puede invalidar tokens previos por límites por usuario/cliente.
- **Device flow constraints**: requiere client específico “TV and Limited Input devices” y manejo correcto de polling/backoff.
- **Revocación impacta proyecto**: revocar puede invalidar scopes/tokens para el proyecto completo de OAuth según documentación; riesgo para sesiones existentes.
- **Seguridad local**: SQLite/context file en disco requiere permisos estrictos y exclusión de logs para no filtrar tokens.
- **Compatibilidad MCP**: si se vuelve implícito el contexto activo, hay que definir precedencia clara entre `credentialRef` explícito vs contexto local para evitar ambigüedad.

### Ready for Proposal
Yes — listo para `sdd-propose` con foco en:
1) estrategia dual de login (loopback default + device fallback),
2) modelo de persistencia/upsert de usuario OAuth desde CLI,
3) contrato mínimo de comandos `auth` y semántica de revocación,
4) integración de contexto activo para uso por CLI/MCP/agentes.
