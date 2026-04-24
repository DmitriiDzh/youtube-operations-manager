# Design: CLI Auth Bootstrap

## Technical Approach

Agregar un subsistema `cli-auth` que haga bootstrap OAuth fuera de NextAuth y reutilice el storage actual de `users`. El flujo default será browser + callback loopback en `127.0.0.1`, con fallback explícito headless (`--device`). CLI y MCP resolverán primero un `credentialRef` efectivo (override explícito o usuario activo local) y recién después invocarán el resolver OAuth existente.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Bootstrap flow | loopback, device-only, manual copy/paste | Loopback + PKCE default; device fallback | Mejor UX para desktop y agentes locales, mantiene refresh token offline; device queda para SSH/headless. |
| Active user persistence | columna en SQLite, JSON complementario | Archivo local `data/auth-context.json` con `activeUserId` | Evita mezclar estado de máquina con estado compartido del dominio; rollback simple y sin migración destructiva. |
| Credential precedence | active-first, explicit-first | `credentialRef` explícito > contexto activo > error tipado | Preserva multiusuario/CI y evita ambigüedad en CLI/MCP. |
| Revoke behavior | borrar fila, limpiar tokens | Revocar remoto + nullear tokens; conservar perfil/rules | Protege datos funcionales y permite re-login sin perder referencias locales. |

## Data Flow

### Loopback login

```text
CLI auth login -> AuthBootstrapService -> Google OAuth URL + PKCE
CLI auth login -> Browser
Browser -> Google consent -> 127.0.0.1:{port}/callback
Callback server -> exchange code -> fetch identity
Identity + tokens -> db.users upsert
activeUserId -> data/auth-context.json
```

### Default credential resolution

```text
CLI/MCP request
  -> resolveEffectiveCredentialRef()
     -> explicit ref? yes => use it
     -> no => read activeUserId from auth-context.json
  -> resolveGoogleCredentials({ userId })
  -> refresh/scope validation
  -> core service
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/auth.ts` | Modify | Extraer helpers OAuth CLI: auth URL, code exchange, device polling, identity fetch, revoke. |
| `src/lib/db.ts` | Modify | Agregar upsert/list/get user metadata para CLI, null-safe token cleanup y selección por `userId`. |
| `src/lib/cli-auth/storage.ts` | Create | Manejo de `data/auth-context.json`, permisos `0600`, escritura atómica y lectura del usuario activo. |
| `src/lib/cli-auth/service.ts` | Create | Casos de uso `login`, `loginDevice`, `whoami`, `listUsers`, `logout`, `revoke`, `resolveEffectiveCredentialRef`. |
| `src/cli/video-metadata.ts` | Modify | Soportar namespace `auth` y usar contexto activo cuando faltan flags de credenciales. |
| `src/mcp/server.ts` | Modify | Hacer `credentialRef` opcional en tools CLI-auth-enabled y resolver default activo antes del core. |
| `src/lib/video-metadata/adapters/google-auth.ts` | Modify | Mantener resolver actual pero consumir helpers DB nuevos y persistir refresh actualizado sin tocar logs. |
| `src/cli/video-metadata.test.ts` / `src/mcp/server.test.ts` / `src/lib/.../google-auth.test.ts` | Modify | Cobertura de precedence, active context y revoke/logout. |

## Interfaces / Contracts

```ts
type ActiveAuthContext = { activeUserId: string; updatedAt: string; version: 1 };

type AuthUserSummary = {
  userId: string;
  email: string;
  name: string | null;
  tokenExpiry: number | null;
  hasRefreshToken: boolean;
  isActive: boolean;
};

function resolveEffectiveCredentialRef(args: {
  explicit?: CredentialRef;
}): Promise<CredentialRef>;
```

CLI JSON mantendrá envelope estable `{ ok, data | error }`. `auth whoami` devolverá `AuthUserSummary`; `auth list-users` devolverá `users: AuthUserSummary[]`; `auth logout` sólo limpia contexto activo; `auth revoke` revoca remoto, limpia tokens y desactiva si corresponde.

## Security Boundaries

- Scopes solicitados: `openid email profile` + `youtube.readonly` + `youtube`; validación estricta de scopes requeridos por operación.
- `data/auth-context.json` MUST escribirse con permisos `0600`; `data/` SHOULD crearse con `0700` cuando sea posible.
- Logs de CLI/MCP/core NO deben incluir `access_token`, `refresh_token`, auth URL completa, `code_verifier` ni payloads de revoke.
- `auth revoke` debe llamar al endpoint de Google y luego limpiar tokens locales; si falla revoke remoto, NO se debe fingir logout exitoso.
- Errores deben ser accionables pero redactados: mostrar `userId`/email, nunca secretos.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | PKCE/state generation, active-context permissions, precedence rules | `node:test` con stubs de fs/OAuth client. |
| Integration | upsert CLI user, refresh persistence, revoke cleanup, MCP default auth | tests contra DB/file temporal bajo `data/` aislado. |
| Manual | browser loopback, device flow, repeated consent without refresh token, revoked active user | checklist documentada en README con comandos reales. |

## Migration / Rollout

No migration required. Se agregan helpers idempotentes sobre `users` y un archivo local nuevo. Rollout seguro: primero `auth login/whoami/list-users/logout/revoke`, luego activar resolución implícita en CLI y MCP.

## Open Questions

- [ ] Confirmar si `GOOGLE_CLIENT_ID/SECRET` actuales sirven para loopback o si hace falta client Desktop separado.
- [ ] Confirmar soporte aprobado de Google Device Authorization para los scopes YouTube del proyecto.
- [ ] Definir si MCP debe exponer `whoami` como tool auxiliar o mantenerlo sólo en CLI.
