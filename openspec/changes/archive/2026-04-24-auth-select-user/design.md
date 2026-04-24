# Design: Auth Select User

## Technical Approach

Agregar un `selectUser` compartido en `CliAuthService` que valide `userId` contra DB local, persista `activeUserId` en `data/auth-context.json`, y devuelva el mismo snapshot post-switch para CLI y MCP. La resolución de credenciales no cambia: solo cambia el fallback implícito cuando no hay `credentialRef` explícito.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Persistencia de usuario activo | Nueva tabla / reutilizar `auth-context.json` | Reutilizar `createActiveAuthStorage.write({ activeUserId })` | Ya es la fuente de verdad del contexto activo y mantiene overwrite atómico + permisos restrictivos. |
| Orquestación de switch | Lógica duplicada en CLI/MCP / centralizar en servicio | Centralizar en `CliAuthService.selectUser` | Evita drift de validación, mensajes y shape de respuesta entre superficies. |
| Nombre MCP | Reusar `whoami` o `write_context` / tool dedicada | Tool dedicada `auth_user_select` | Hace explícito que cambia identidad local, no canal ni OAuth remoto; evita ambigüedad con `write_channel_select`. |
| Feedback post-switch | Solo `activeUserId` / snapshot enriquecido | Devolver `activeUser`, `previousActiveUserId`, `changed`, `writeChannel` | Permite ver impacto inmediato sobre fallback auth y guardrails (`activeWriteChannel`, `alignment`, `requiresReauth`). |

## Data Flow

```text
CLI auth select-user / MCP auth_user_select
  -> CliAuthService.selectUser(userId)
    -> db.getUserSummary(userId)
    -> storage.read() for previousActiveUserId
    -> storage.write({ activeUserId: userId })
    -> whoami()-style post-switch snapshot
      -> credentialResolver? (best effort)
      -> writeContext.getWriteChannelContext(...) or fallback
```

Sequence notes:
- Si `userId` no existe localmente, falla antes de persistir con error tipado.
- Si el usuario existe pero auth/write-channel no se puede resolver, el switch IGUAL persiste y devuelve estado degradado accionable (`alignment.status="unresolved"`, `requiresReauth`).

## File Changes

| File | Action | Description |
|---|---|---|
| `openspec/changes/auth-select-user/design.md` | Create | Artefacto técnico del cambio. |
| `src/lib/cli-auth/service.ts` | Modify | Agregar `selectUser`, factorizar snapshot post-switch reutilizando `whoami` internamente. |
| `src/cli/video-metadata.ts` | Modify | Exponer `auth select-user --userId <ID>` con JSON estable. |
| `src/mcp/server.ts` | Modify | Registrar `auth_user_select` con schema estricto y descripción explícita “local context only”. |
| `src/lib/cli-auth/service.test.ts` | Modify | Cubrir switch exitoso, usuario inexistente y fallback degradado de `writeChannel`. |
| `src/cli/video-metadata.test.ts` | Modify | Cubrir comando nuevo y rechazo de flags inválidos/subcomando actualizado. |
| `src/mcp/server.test.ts` | Modify | Cubrir contrato de `auth_user_select` y validación Zod previa a persistencia. |
| `README.md` | Modify | Documentar semántica del switch y relación con `credentialRef`/`write_context`. |

## Interfaces / Contracts

```ts
type SelectUserResult = {
  activeUser: AuthUserSummary;
  previousActiveUserId: string | null;
  changed: boolean;
  effectiveCredentialRef: { userId: string };
  writeChannel: WriteChannelContext;
  activeWriteChannel: WriteChannelContext["activeWriteChannel"];
  selectedChannelId: string | null;
  alignment: WriteChannelContext["alignment"];
  requiresReauth: boolean;
};
```

CLI:
- `auth select-user --userId <ID>`

MCP:
- `auth_user_select` input `{ userId: z.string().min(1) }`
- descripción: “Switch local active user fallback. Does not login, reauth, or switch active OAuth channel.”

`whoami` y `write_context` no cambian de nombre; solo reflejan inmediatamente el nuevo `activeUserId` luego del switch.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | `selectUser` valida usuario, persiste storage y reporta `changed` correctamente | `node:test` en `src/lib/cli-auth/service.test.ts` con stubs de storage/DB/writeContext |
| Integration | CLI emite envelope estable para success/error de `auth select-user` | Extender `src/cli/video-metadata.test.ts` |
| Integration | MCP rechaza payload inválido y expone contrato no ambiguo de `auth_user_select` | Extender `src/mcp/server.test.ts` |
| Docs | Semántica “local-context only” y feedback de alignment | README con ejemplo corto y nota de precedencia |

## Migration / Rollout

No migration required. Reusa `auth-context.json`; no cambia schema de DB ni precedencia de `credentialRef` explícito.

## Open Questions

- [ ] Confirmar si el snapshot post-switch debe incluir `knownChannels` al tope además de `writeChannel`, o si alcanza con reutilizar el shape actual de `whoami`.
