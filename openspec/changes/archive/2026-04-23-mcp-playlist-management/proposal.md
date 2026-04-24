# Proposal: MCP Playlist Management

## Intent

Agregar gestión de playlists a MCP y CLI reutilizando la lógica web ya probada en `src/lib/youtube.ts`. Esto evita duplicar reglas de YouTube, habilita automatización fuera de NextAuth y mantiene compatibilidad con el contexto activo local (`activeUserId`) ya usado por CLI/MCP.

## Scope

### In Scope
- Exponer listar playlists, crear playlist, agregar videos y remover videos en CLI.
- Exponer las mismas operaciones como tools MCP con contratos validados.
- Extraer/adaptar la lógica web de playlists para uso reusable fuera de Route Handlers.
- Mantener precedencia de auth: `credentialRef` explícito > contexto activo local > error tipado.

### Out of Scope
- Rediseño UI/web o cambio de endpoints web existentes.
- Batch/rules automation nueva sobre playlists.
- Edición de metadata de playlists, reorder o delete.

## Capabilities

### New Capabilities
- `playlist-management-core`: contratos y casos de uso reutilizables para listar/crear/agregar/remover playlists.
- `playlist-management-cli`: comandos CLI estables para gestión de playlists.
- `playlist-management-mcp`: tools MCP estables para gestión de playlists.

### Modified Capabilities
- `youtube-credential-resolution`: extender resolución/scope checks para operaciones de playlists usando contexto activo local.

## Approach

Reusar `getUserPlaylists`, `createPlaylist`, `addVideoToPlaylist` y `removeVideosFromPlaylist` como base, pero detrás de un adapter/core compartido y validado con Zod. CLI y MCP quedan finos, igual que en video metadata. Tradeoff: sumar una capa de contratos/servicios parece más trabajo que llamar helpers directo, pero evita drift entre interfaces, centraliza errores y preserva compatibilidad con auth no-web.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/youtube.ts` | Modified | Aislar/reusar operaciones web de playlists |
| `src/lib/playlist-management/**` | New | Core, schemas, contratos y servicios |
| `src/cli/video-metadata.ts` or new playlist CLI entry | Modified | Comandos playlist |
| `src/mcp/server.ts` | Modified | Nuevas tools playlist |
| `openspec/specs/youtube-credential-resolution/spec.md` | Modified | Auth/contexto activo para playlists |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Drift entre web y adapters nuevos | Med | Reusar helpers existentes y tests compartidos |
| Auth ambigua entre sesión web y contexto local | Med | Mantener precedencia explícita y errores tipados |
| Alta parcial en add/remove por fallas por item | Med | Especificar resultado agregado y errores accionables |

## Rollback Plan

Quitar comandos/tools nuevos y dejar intactos los Route Handlers web actuales; la lógica original en `src/lib/youtube.ts` sigue siendo la fuente segura para restaurar comportamiento.

## Dependencies

- Credenciales OAuth Google ya soportadas por web/CLI.
- Contexto activo local en `data/auth-context.json`.

## Success Criteria

- [ ] CLI y MCP exponen las 4 operaciones de playlists con contratos validados.
- [ ] La implementación reutiliza lógica web existente en vez de duplicarla.
- [ ] Las operaciones funcionan con `credentialRef` o `activeUserId` sin depender de sesión web.
- [ ] Endpoints web actuales siguen compatibles sin cambios de comportamiento.
