# Tasks: YouTube Write Channel and Playlist Delete

## Phase 1: Foundation (guardrails + contracts)

- [x] 1.1 Crear `src/lib/write-context/contracts.ts` con `WriteChannelContext`, códigos de error (`WRITE_CHANNEL_REQUIRED|MISMATCH|UNRESOLVED`) y detalles tipados.
- [x] 1.2 Crear `src/lib/write-context/adapters/youtube-api.ts` con `getActiveChannel()` vía `channels.list(mine:true)` y normalización `{id,title}`.
- [x] 1.3 Crear `src/lib/write-context/service.ts` con precedencia `expectedChannelId` explícito > `users.selected_channel_id` y `assertWriteChannel()` fail-closed.
- [x] 1.4 Modificar `src/lib/db.ts` para `getSelectedChannelId(userId)` / `setSelectedChannelId(userId, channelId)` reutilizando la columna existente.
- [x] 1.5 Actualizar `src/lib/video-metadata/contracts.ts` y `src/lib/playlist-management/contracts.ts` para aceptar `expectedChannelId` y mapear nuevos errores.
- [x] 1.6 Actualizar `src/lib/playlist-management/schemas.ts` (Zod 4) para validar `playlist_delete` y exigir `expectedChannelId` en writes sensibles.

## Phase 2: Core implementation (playlist delete + shared guardrail)

- [x] 2.1 Integrar `assertWriteChannel()` en `src/lib/playlist-management/services.ts` para `createPlaylist` y nuevo `deletePlaylist`.
- [x] 2.2 Extender `src/lib/playlist-management/adapters/youtube-api.ts` con `getPlaylistForDelete` (preflight ownership por `snippet.channelId`) y `deletePlaylist`.
- [x] 2.3 Exponer `deletePlaylist` en `src/lib/playlist-management/index.ts` manteniendo compatibilidad de exports.
- [x] 2.4 Aplicar el mismo guardrail en `src/lib/video-metadata/services.ts` antes de `apply` para evitar drift entre metadata/playlists.
- [x] 2.5 En writes con `credentialRef` por `userId`, persistir `selectedChannelId` tras match exitoso usando `setSelectedChannelId`.

## Phase 3: Transport wiring (CLI + MCP)

- [x] 3.1 Modificar `src/lib/cli-auth/service.ts` para que `whoami()` incluya `activeWriteChannel`, `selectedChannelId` y `effectiveCredentialRef` sin secretos.
- [x] 3.2 Extender `src/cli/video-metadata.ts` con `playlist delete --playlistId --expectedChannelId [--credentialRef]` y error/exit code no exitoso en guardrail fail.
- [x] 3.3 Actualizar mutaciones CLI (`playlist create`, `apply`) para requerir `expectedChannelId` y retornar JSON estable de mismatch/unresolved.
- [x] 3.4 Extender `src/mcp/server.ts` con tool `playlist_delete` (schema estricto) y tool read-only de contexto de escritura.
- [x] 3.5 Aplicar guardrail en tools MCP mutantes (`playlist_create`, `playlist_delete`, `apply`) con errores estructurados accionables.

## Phase 4: Testing and verification

- [x] 4.1 Agregar tests de `write-context` (nuevo archivo) para precedencia explícito>stored, `WRITE_CHANNEL_REQUIRED`, mismatch y unresolved.
- [x] 4.2 Extender `src/lib/playlist-management/schemas.test.ts` y `services.test.ts` para create/delete: éxito, mismatch, canal no resoluble y parseo inválido.
- [x] 4.3 Extender `src/lib/cli-auth/storage.test.ts` y `service.test.ts` para persistencia/lectura de `selectedChannelId` y payload enriquecido de `whoami`.
- [x] 4.4 Extender `src/cli/video-metadata.test.ts` para `playlist delete`, guardrail en `apply/create` y salida JSON estable en fallos.
- [x] 4.5 Extender `src/mcp/server.test.ts` para tool `playlist_delete`, contexto read-only y fail-closed sin mutación remota.

## Phase 5: Documentation

- [x] 5.1 Actualizar `README.md` con flujo: `auth whoami` → confirmar `activeWriteChannel` → ejecutar writes con `expectedChannelId`.
- [x] 5.2 Documentar contrato de `playlist_delete` (CLI/MCP), ejemplos mínimos y tabla de errores de guardrail con campos `details`.
