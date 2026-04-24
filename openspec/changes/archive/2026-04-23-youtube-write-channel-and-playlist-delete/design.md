# Design: YouTube Write Channel and Playlist Delete

## Technical Approach

Separar lectura de escritura. Las mutaciones CLI/MCP (`playlist_create`, `playlist_delete`, metadata `apply`) seguirán resolviendo credenciales con el patrón actual, pero antes de mutar pasarán por un guardrail compartido que: (1) resuelve el canal real activo con `channels.list(mine:true)`, (2) obtiene el canal esperado desde input explícito o persistencia local, y (3) falla cerrado si falta coincidencia. `playlist_delete` reutiliza ese guardrail y suma preflight de ownership antes del delete irreversible.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Resolver canal real | Nuevo helper compartido `src/lib/write-context/**` que usa `ResolvedCredentials` + YouTube adapter para `channels.list(part:["id","snippet"], mine:true)` | Duplicarlo en playlists/metadata; inferir por `whoami` | El canal de write depende del token OAuth, no del usuario local. Un helper cross-cutting evita drift. |
| Canal esperado | Persistir por usuario local en `users.selected_channel_id`; aceptar `expectedChannelId` explícito y darle precedencia | Sólo flag explícito; sólo DB | Explícito sirve para agentes/stateless; DB sirve para sesiones CLI/MCP con `userId`. Precedencia mantiene el patrón actual explícito > contexto local. |
| Guardrail reusable | Servicio `assertWriteChannel(args)` invocado por playlists y video metadata | Checks en CLI/MCP; checks sólo en adapter YouTube | La regla pertenece al core, no al transporte. Así cubre writes futuros sin duplicar envelopes. |
| Delete seguro | `playlist_delete` hace guardrail + `getPlaylistForDelete` (verifica `snippet.channelId`) + `playlists.delete(id)` | Borrar directo; confiar sólo en 403/404 remotos | El delete es irreversible; el preflight da error claro y evita depender de mensajes inconsistentes del API. |

## Data Flow

Sequence (CLI/MCP write):

User/Agent -> transport -> core service
transport -> auth.resolveEffectiveCredentialRef (si falta)
core -> authResolver.resolve(write scope)
core -> write-context.resolveExpectedChannel(explicit > stored user selection)
core -> write-context.resolveActiveChannel(YouTube channels.list mine:true)
core -> write-context.assertMatch()
core -> playlist/video adapter -> YouTube mutation
core -> db.saveSelectedChannelId(userId, expectedChannelId) [solo si credentialRef es {userId} y hubo match]

`whoami`/inspección reutiliza `resolveActiveChannel` para mostrar `activeChannel`, `selectedChannelId` y `effectiveCredentialRef` sin secretos.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/write-context/contracts.ts` | Create | Tipos `WriteChannelContext`, errores y contratos del guardrail. |
| `src/lib/write-context/service.ts` | Create | Resolver canal esperado/real y `assertWriteChannel`. |
| `src/lib/write-context/adapters/youtube-api.ts` | Create | `getActiveChannel()` y lookup mínimo para playlists. |
| `src/lib/db.ts` | Modify | Helpers `getSelectedChannelId` / `setSelectedChannelId`; reutiliza columna existente. |
| `src/lib/video-metadata/contracts.ts` | Modify | Nuevos `DomainErrorCode`: `WRITE_CHANNEL_REQUIRED`, `WRITE_CHANNEL_MISMATCH`, `WRITE_CHANNEL_UNRESOLVED`. |
| `src/lib/playlist-management/{contracts,schemas,services,index.ts}` | Modify | `expectedChannelId`, `deletePlaylist`, integración del guardrail. |
| `src/lib/playlist-management/adapters/youtube-api.ts` | Modify | `deletePlaylist`, `getPlaylistForDelete`, reuse write-context adapter. |
| `src/lib/video-metadata/services.ts` | Modify | Aplicar guardrail antes de `applyMetadata`. |
| `src/lib/cli-auth/service.ts` | Modify | `whoami()` suma contexto de canal de write. |
| `src/cli/video-metadata.ts` | Modify | `playlist delete --playlistId --expectedChannelId?`; output de `auth whoami` enriquecido. |
| `src/mcp/server.ts` | Modify | Tool `playlist_delete`; `whoami` enriquecido. |
| `README.md` | Modify | Flujo mínimo: `auth whoami` -> confirmar canal -> writes con `expectedChannelId`. |

## Interfaces / Contracts

```ts
type WriteChannelContext = {
  activeChannel: { id: string; title: string | null } | null;
  expectedChannelId: string | null;
  source: "explicit" | "stored" | "missing";
};

type PlaylistDeleteInput = {
  credentialRef?: CredentialRef;
  playlistId: string;
  expectedChannelId?: string;
};
```

Rules:
- `expectedChannelId` opcional en transporte/core, pero guardrail MUST fallar con `WRITE_CHANNEL_REQUIRED` si no hay explícito ni stored.
- Si `activeChannel.id !== expectedChannelId`, MUST fallar con `WRITE_CHANNEL_MISMATCH` y detalles `{ expectedChannelId, activeChannelId }`.
- Si `channels.list(mine:true)` no devuelve canal, MUST fallar con `WRITE_CHANNEL_UNRESOLVED`.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `write-context` precedence, fail-closed, persistence-only-for-userId | `node:test` con dobles de DB + YouTube adapter |
| Unit | `playlist_delete` preflight y mapping de errores | ampliar `src/lib/playlist-management/services.test.ts` |
| Integration | `auth whoami`/CLI/MCP incluyen `activeChannel` y `selectedChannelId` | ampliar tests de `src/cli/video-metadata.test.ts` y `src/mcp/server.test.ts` |
| Schema | Zod de `expectedChannelId`, `playlist_delete` y nuevos outputs | ampliar `schemas.test.ts` |

## Migration / Rollout

No migration required. La columna `selected_channel_id` ya existe; sólo se agregan helpers y se empieza a poblar tras writes validados. Rollout: primero guardrail + `whoami` enriquecido, luego `playlist_delete`.

## Open Questions

- [ ] ¿Queremos un comando/tool dedicado para seleccionar canal sin ejecutar un write, o alcanza con bootstrap por `expectedChannelId` explícito en el primer write?
