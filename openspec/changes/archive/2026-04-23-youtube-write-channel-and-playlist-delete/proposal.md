# Proposal: YouTube Write Channel and Playlist Delete

## Intent

Hoy CLI/MCP pueden mutar usando el usuario activo, pero no tienen un guardrail explícito para asegurar SOBRE QUÉ canal se escribe en setups multi-channel / Brand Account. Además falta `playlist_delete`, lo que deja el set de gestión de playlists incompleto.

## Scope

### In Scope
- Definir un canal activo de escritura para CLI/MCP y usarlo como precondición de mutaciones.
- Agregar `playlist_delete` al core, CLI y MCP.
- Mantener fail-closed: sin canal de escritura resoluble, las mutaciones no avanzan.

### Out of Scope
- Cambios de UI web o flujo NextAuth.
- Borrado masivo, soft-delete o confirmaciones interactivas avanzadas.
- Replantear lecturas existentes más allá de mensajes/ayudas mínimas.

## Capabilities

### New Capabilities
- `youtube-write-channel-guardrails`: selección, persistencia y validación del canal activo de escritura para mutaciones no-web.

### Modified Capabilities
- `playlist-management-core`: sumar delete y exigir guardrail de canal en mutaciones.
- `playlist-management-cli`: exponer `playlist delete` y errores accionables de canal activo.
- `playlist-management-mcp`: exponer `playlist_delete` y el mismo contrato fail-closed.
- `video-metadata-cli`: exigir canal activo de escritura antes de `apply`.
- `video-metadata-mcp`: exigir canal activo de escritura antes de `apply`.
- `youtube-credential-resolution`: extender resolución con contexto de canal seleccionado para escrituras.

## Approach

Reusar el patrón actual de core + Zod + auth local. La decisión mínima segura es separar lectura de escritura: lecturas pueden seguir resolviendo por credenciales activas; escrituras deben validar un `selectedChannelId` persistido o equivalente y rechazar si el canal destino no coincide. `playlist_delete` debe entrar por el mismo core para no duplicar validación ni envelopes.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/db.ts` | Modified | Persistencia/lectura de canal activo de escritura |
| `src/lib/cli-auth/**` | Modified | Resolver contexto activo + canal seleccionado |
| `src/lib/playlist-management/**` | Modified | Delete + guardrails compartidos |
| `src/lib/video-metadata/**` | Modified | Guardrail previo a `apply` |
| `src/cli/video-metadata.ts` | Modified | Nuevo comando/flags y errores accionables |
| `src/mcp/server.ts` | Modified | Nueva tool `playlist_delete` y validación de canal |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Falso bloqueo en cuentas sin canal resuelto | Med | Mensajes claros + path explícito para seleccionar canal |
| Drift entre metadata y playlists | Med | Guardrail compartido en core/resolver, no en transportes |
| Delete irreversible | Med | Validación estricta + contrato explícito + rollback por feature revert |

## Rollback Plan

Remover `playlist_delete` de CLI/MCP y desactivar la validación de canal de escritura en transportes no-web, volviendo al comportamiento actual basado sólo en `credentialRef`/usuario activo.

## Dependencies

- OAuth local y `activeUserId` ya existentes.
- Persistencia local de `selected_channel_id` disponible para completar el flujo.

## Success Criteria

- [ ] Toda mutación CLI/MCP falla con error accionable si no hay canal activo de escritura válido.
- [ ] `playlist_delete` existe en core, CLI y MCP con contrato estable.
- [ ] `apply` de metadata y mutaciones de playlist comparten la misma regla de guardrail.
