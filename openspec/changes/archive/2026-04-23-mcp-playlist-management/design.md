# Design: MCP Playlist Management

## Technical Approach

Implementar un core `src/lib/playlist-management/` paralelo a `video-metadata`: contratos + schemas Zod + services + adapters. El core resolverá credenciales fuera de web, construirá un cliente YouTube reutilizable y expondrá `listPlaylists`, `createPlaylist`, `addVideos`, `removeVideos`. Web, MCP y CLI quedan como adapters finos. La lógica existente de `src/lib/youtube.ts` se conserva como base, pero las operaciones de playlists se extraen a helpers que trabajen con `youtube_v3.Youtube` autenticado para evitar duplicación y mantener compatibilidad con Route Handlers actuales.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Core reusable | Llamar `lib/youtube.ts` directo vs módulo dedicado | `playlist-management` core + adapters | Sigue el patrón ya probado de `video-metadata`, reduce drift entre web/MCP/CLI y centraliza validación/errores. |
| Auth boundary | `userId` web-only vs `credentialRef` + contexto activo | Resolver `credentialRef` en el borde y pasar credenciales resueltas al core | MCP/CLI no dependen de NextAuth; web sigue resolviendo `session.user.id` y delega al mismo core. |
| Resultado add/remove | Sólo contadores agregados vs detalle por item | Contrato por item + resumen agregado | Para agentes, `added: 2` no alcanza; hace falta saber qué video falló y por qué sin perder compatibilidad con semántica parcial. |
| CLI scope | Obligatoria ahora vs opcional | MCP obligatorio, CLI opcional con reuso del mismo core | Permite cortar alcance sin rehacer arquitectura; si CLI entra, sólo suma parser/envelope. |

## Data Flow

### Sequence: MCP add/remove

```text
MCP tool
  -> Zod input schema
  -> resolveEffectiveCredentialRef(explicit > activeUserId)
  -> resolveGoogleCredentials(requiredScopes)
  -> createYoutubeClient(auth)
  -> playlist-management service
  -> per-item result aggregation
  -> Zod output schema
  -> MCP structuredContent/text envelope
```

### Sequence: Web compatibility

```text
Route Handler -> getServerSession -> { userId }
  -> playlist-management core ({ credentialRef: { userId } })
  -> shared adapter over YouTube API
  -> NextResponse JSON
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/youtube.ts` | Modify | Extraer helpers playlist orientados a `youtube_v3.Youtube` y mantener wrappers web actuales. |
| `src/lib/playlist-management/contracts.ts` | Create | Tipos de dominio, errores y contratos por item. |
| `src/lib/playlist-management/schemas.ts` | Create | Zod input/output para list/create/add/remove. |
| `src/lib/playlist-management/services.ts` | Create | Casos de uso con scopes, agregación parcial y mapping de errores. |
| `src/lib/playlist-management/adapters/youtube-api.ts` | Create | Operaciones YouTube sobre playlists y playlistItems. |
| `src/lib/playlist-management/index.ts` | Create | Factory `createPlaylistManagementCore()`. |
| `src/app/api/youtube/{playlists,create-playlist,add-to-playlist,remove-from-playlist}/route.ts` | Modify | Reusar core compartido sin cambiar contrato web observable. |
| `src/mcp/server.ts` | Modify | Registrar tools `playlist_list`, `playlist_create`, `playlist_add_videos`, `playlist_remove_videos`. |
| `src/cli/video-metadata.ts` | Modify (optional) | Agregar namespace/comandos `playlist` o documentar follow-up si se corta alcance. |
| `src/mcp/server.test.ts`, `src/cli/video-metadata.test.ts`, `src/lib/playlist-management/*.test.ts` | Modify/Create | Cobertura de contratos, auth precedence y resultados parciales. |
| `README.md` | Modify | Uso mínimo de tools/comandos playlist y contrato de resultados. |
| `openspec/specs/youtube-credential-resolution/spec.md` | Modify | Extender requisitos de resolución/scopes a operaciones playlist. |

## Interfaces / Contracts

```ts
type PlaylistItemResult = {
  videoId: string;
  status: "added" | "removed" | "skipped" | "failed";
  reason?: "already-present" | "not-found-in-playlist" | "forbidden" | "api-error" | "unknown";
  message?: string;
};

type PlaylistMutationResult = {
  playlistId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  results: PlaylistItemResult[];
};
```

`list/create` devuelven shapes chicos (`playlists[]`, `playlist`). `add/remove` MUST devolver resumen agregado + `results[]`. El core requiere `youtube.readonly` para list y `youtube` para create/add/remove. Errores siguen `DomainError` con `validation_failed`, `unauthorized`, `AUTH_USER_NOT_FOUND`, `AUTH_SCOPE_INSUFFICIENT`, y nuevo fallback `update_failed` para errores remotos no clasificables.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Schemas, agregación por item, clasificación de errores parciales | `node:test` con payloads/stubs puros. |
| Integration | Resolver auth, adapter YouTube, wrappers web sin drift | Mock de Google API + stubs de `resolveEffectiveCredentialRef`. |
| Contract | MCP/CLI envelopes y precedence explícito > activo | Extender `src/mcp/server.test.ts` y `src/cli/video-metadata.test.ts`. |

## Migration / Rollout

No migration required. Rollout: (1) extraer core y adaptar rutas web, (2) publicar tools MCP, (3) agregar CLI sólo si entra en corte final. Docs mínimas: README con comandos/tools nuevos y ejemplo de resultado parcial en add/remove.

## Open Questions

- [ ] Si CLI queda fuera del corte, ¿se deja documentada como follow-up en `tasks.md` o se crea delta spec separado?
- [ ] ¿Conviene mapear `already-present`/`not-found-in-playlist` con inspección explícita o aceptar `api-error` genérico en la primera versión?
