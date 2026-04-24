# Proposal: Playlist Metadata Update

## Intent

CLI/MCP ya gestionan playlists, pero hoy listan sólo `id/title` y no pueden actualizar metadata existente. Este cambio agrega `description` a lectura y habilita update explícito de `title`, `description` y `privacyStatus` sin romper guardrails de escritura.

## Scope

### In Scope
- Exponer metadata completa de playlist (`id`, `title`, `description`, `privacyStatus`) en core, CLI y MCP.
- Agregar operación de update de playlist en core, CLI y MCP.
- Mantener validación Zod estricta, errores estables y guardrail `expectedChannelId` fail-closed para updates.

### Out of Scope
- Cambios de UI/web o nuevos Route Handlers.
- Localizaciones, thumbnails, reorder, batch edit o cambios masivos.
- Replantear auth/contexto activo fuera de lo necesario para soportar update.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `playlist-management-core`: ampliar contrato de playlist y sumar `updatePlaylist`.
- `playlist-management-cli`: sumar comando `playlist update` y salida JSON con metadata completa.
- `playlist-management-mcp`: sumar tool `playlist_update` y respuestas serializables con metadata completa.

## Approach

Extender el core existente en `src/lib/playlist-management/**` en vez de abrir otro dominio. El adapter YouTube debe leer/escribir `snippet.description`, `snippet.title` y `status.privacyStatus`; CLI/MCP quedan finos, reutilizando auth actual (`credentialRef` explícito > contexto activo) y el mismo guardrail de canal usado en create/delete. Tradeoff: tocar contratos existentes obliga a actualizar tests de list/create, pero evita drift entre interfaces y deja una única fuente de verdad.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/playlist-management/contracts.ts` | Modified | Extender shape de playlist y resultado de update |
| `src/lib/playlist-management/schemas.ts` | Modified | Inputs/outputs Zod para list/create/update |
| `src/lib/playlist-management/services.ts` | Modified | Caso de uso `updatePlaylist` + guardrail |
| `src/lib/playlist-management/adapters/youtube-api.ts` | Modified | Leer/escribir metadata completa en YouTube API |
| `src/cli/video-metadata.ts` | Modified | Comando `playlist update` |
| `src/mcp/server.ts` | Modified | Tool `playlist_update` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Drift de contratos al ampliar `Playlist` | Med | Actualizar specs/tests primero y reutilizar schemas compartidos |
| Update sobre playlist de otro canal | Med | Exigir `expectedChannelId` y validar ownership antes de mutar |
| Campos opcionales ambiguos en update | Low | Definir patch explícito: al menos un campo mutable requerido |

## Rollback Plan

Remover `playlist_update` de CLI/MCP, revertir el contrato ampliado del core y volver a exponer sólo `id/title`; create/delete/add/remove siguen operativos con la implementación actual.

## Dependencies

- Google YouTube Data API con scopes de lectura/escritura ya soportados.
- Infra actual de auth local y write-context guardrails.

## Success Criteria

- [ ] `playlist list` y `playlist_list` devuelven `description` y `privacyStatus` además de `id/title`.
- [ ] CLI y MCP exponen update de playlist con validación estricta y errores accionables.
- [ ] Update fail-closed ante mismatch/unresolved write channel.
- [ ] Tests/specs reflejan el contrato ampliado sin romper create/delete/add/remove.
