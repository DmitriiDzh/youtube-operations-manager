# Design: Playlist Metadata Update

## Technical Approach

Extender el dominio existente `src/lib/playlist-management/**` con un contrato de playlist aditivo (`id`, `title`, `description`, `privacyStatus`) y un caso de uso nuevo `updatePlaylist`. La mutación seguirá el patrón seguro ya usado en video metadata: guardrail fail-closed (`assertWriteChannel`) + preflight de ownership + merge read-before-update para evitar sobrescribir campos no enviados. CLI y MCP sólo cablean schemas/handlers/comandos; la lógica sensible queda en el core.

## Architecture Decisions

| Decision | Choice | Alternatives considered | Rationale |
|---|---|---|---|
| Contrato de playlist | Ampliar `Playlist` existente con `description` y `privacyStatus` sin remover `id/title` | Crear `PlaylistDetails`; devolver shapes distintas por operación | El cambio es aditivo, mantiene compatibilidad para consumidores que leen subset y evita drift entre list/create/update. |
| Update seguro | `updatePlaylist` hace fetch del estado actual, mergea patch validado y recién después llama `playlists.update` | Enviar sólo campos presentes; lógica de merge en CLI/MCP | La API de YouTube update trabaja sobre recursos completos; el merge en core protege contra pérdida accidental de metadata. |
| Guardrail + ownership | Reusar `writeContext.assertWriteChannel()` y sumar lookup `getPlaylistForUpdate()` con `snippet.channelId` | Confiar en 403/404 remotos; validar sólo expected vs active | El canal activo correcto NO garantiza ownership de la playlist. El preflight da error estable y evita mutación remota indebida. |
| Wiring transportes | CLI/MCP agregan `playlist update` / `playlist_update` y reutilizan schemas compartidos con `credentialRef` opcional en transporte | Validación manual por flags/tool; core-only sin schemas parciales | Mantiene la convención actual: Zod en bordes, auth fallback en transporte y contratos serializables iguales al core. |

## Data Flow

Sequence (`playlist update` / `playlist_update`):

Client -> CLI/MCP parser -> playlistUpdateInputSchema
CLI/MCP -> auth.resolveEffectiveCredentialRef (si falta)
transport -> core.updatePlaylist
core -> authResolver.resolve(write scope)
core -> writeContext.assertWriteChannel(expectedChannelId)
core -> youtubeApi.getPlaylistForUpdate(playlistId)
core -> ownership check (`playlist.channelId === guardrail.activeWriteChannel.id`)
core -> merge `{ current + patch }`
core -> youtubeApi.updatePlaylist(merged)
core -> channelSelectionStore.setSelectedChannelId(...) [solo userId]

`listPlaylists` y `createPlaylist` pasan a mapear/retornar metadata completa con el mismo contrato extendido.

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/playlist-management/contracts.ts` | Modify | Extender `Playlist`; agregar `UpdatePlaylistResult`/patch types. |
| `src/lib/playlist-management/schemas.ts` | Modify | `playlistSchema` ampliado; input/output de update; `description` opcional en create; regla “al menos un campo mutable”. |
| `src/lib/playlist-management/services.ts` | Modify | Nuevo `updatePlaylist`; merge seguro; guardrail + ownership; list/create usan contrato ampliado. |
| `src/lib/playlist-management/adapters/youtube-api.ts` | Modify | Lookup/update de playlist con metadata completa. |
| `src/lib/youtube.ts` | Modify | Helpers para listar/crear/update con `description` y `privacyStatus`, más mapper compartido de playlist. |
| `src/cli/video-metadata.ts` | Modify | Comando `playlist update`; `playlist create` acepta `--description`; `playlist list` conserva envelope estable. |
| `src/mcp/server.ts` | Modify | Handler/tool `playlist_update`; `playlist_create` acepta `description`; `playlist_list` expone metadata completa. |
| `src/lib/playlist-management/*.test.ts` | Modify | Cobertura de schemas, merge y ownership/update fail-closed. |
| `src/cli/video-metadata.test.ts` / `src/mcp/server.test.ts` | Modify | Wiring, envelopes estables y errores tipados en update. |
| `README.md` | Modify | Ejemplos mínimos de `playlist update` y contrato de metadata completa. |

## Interfaces / Contracts

```ts
type Playlist = {
  id: string;
  title: string;
  description: string;
  privacyStatus: "private" | "public" | "unlisted";
};

type UpdatePlaylistInput = {
  credentialRef?: CredentialRef;
  playlistId: string;
  expectedChannelId: string;
  title?: string;
  description?: string;
  privacyStatus?: Playlist["privacyStatus"];
};
```

Rules:
- `updatePlaylist` MUST reject patch vacío con `validation_failed`.
- `createPlaylist` MAY omit `description`; output siempre normaliza `description` a string y `privacyStatus` a enum.
- Ownership inválido en update MUST devolver `WRITE_CHANNEL_MISMATCH` con `{ expectedChannelId, activeWriteChannelId }` sin mutación.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `playlistSchema`, create/update inputs, patch vacío | ampliar `schemas.test.ts` |
| Unit | merge read-before-update, persistence selectiva y ownership preflight | ampliar `services.test.ts` con dobles de `youtubeApi` |
| Integration | CLI `playlist list/create/update` y envelopes JSON | ampliar `src/cli/video-metadata.test.ts` |
| Integration | MCP `playlist_list/create/update` y errores estructurados | ampliar `src/mcp/server.test.ts` |

## Migration / Rollout

No migration required. El cambio es contractual y aditivo. Rollout recomendado: primero core/helpers, luego wiring CLI/MCP, después README mínima.

## Open Questions

- [ ] ¿Queremos agregar delta spec MCP en este change para dejar explícito `playlist_update`, o alcanza con cubrirlo en tasks/verify usando el patrón ya establecido en `server.ts`?
