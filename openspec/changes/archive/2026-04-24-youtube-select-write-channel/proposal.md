# Proposal: YouTube Select Write Channel

## Intent

Hoy existe `selectedChannelId` persistido y `activeWriteChannel` observable, pero falta un flujo explícito para inspeccionar/seleccionar el canal esperado de escritura. En setups con Brand Accounts eso genera una falsa sensación de “cambio de canal”: persistir una selección NO cambia mágicamente el `activeWriteChannel` si OAuth sigue autenticado contra otro canal.

## Scope

### In Scope
- Agregar selector e inspector read-only/read-write del canal esperado de escritura para CLI/MCP.
- Hacer explícita la diferencia entre `selectedChannelId` persistido y `activeWriteChannel` resuelto desde OAuth.
- Mejorar mensajes/contratos para que el mismatch explique el límite y el siguiente paso accionable.

### Out of Scope
- Cambiar automáticamente el canal OAuth activo o reescribir el flujo NextAuth/OAuth.
- Eliminar el guardrail fail-closed actual en writes sensibles.
- Resolver switching real de Brand Account sin nuevo consentimiento OAuth.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `cli-auth-bootstrap`: sumar selección/inspección explícita del canal esperado persistido.
- `youtube-write-channel-guardrails`: aclarar contrato entre canal esperado persistido y canal OAuth activo.
- `youtube-credential-resolution`: propagar estado/errores accionables cuando la selección persistida no coincide con la sesión OAuth.
- `playlist-management-cli`: exponer el inspector/selector y mensajes de guardrail más claros.
- `playlist-management-mcp`: exponer el mismo contrato estable para agentes.

## Approach

Reusar persistencia existente (`selected_channel_id`) y el resolver actual de `activeWriteChannel`. Agregar una superficie explícita de inspección/selección que devuelva ambos valores, su fuente y una evaluación de estado (`matched`/`mismatch`/`unresolved`). Los writes siguen validando contra OAuth activo; la selección persistida sólo define el canal esperado por defecto y guía al usuario a reloguear o corregir la selección cuando haya desalineación.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/cli-auth/**` | Modified | Selector/inspector y mensajes para Brand Accounts |
| `src/lib/write-context/**` | Modified | Estado derivado entre selección persistida y canal OAuth activo |
| `src/cli/video-metadata.ts` | Modified | Nuevos comandos/flags de auth o write-context |
| `src/mcp/server.ts` | Modified | Tool equivalente para agentes |
| `README.md` | Modified | Documentar límite y flujo correcto |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Usuarios asumen que “select” cambia OAuth | High | Naming explícito + warnings + docs |
| Drift entre CLI y MCP | Med | Contrato compartido en `write-context` |

## Rollback Plan

Remover selector/inspector nuevo y volver a exponer sólo `whoami`/`write_context`, manteniendo el guardrail actual basado en `expectedChannelId` y `activeWriteChannel`.

## Dependencies

- `selected_channel_id` ya persistido en `src/lib/db.ts`.
- Resolución actual de `activeWriteChannel` desde OAuth local.

## Success Criteria

- [ ] CLI/MCP permiten ver `selectedChannelId` y `activeWriteChannel` con estado claro de alineación.
- [ ] La documentación y los errores explican que seleccionar canal esperado no cambia la sesión OAuth activa.
- [ ] En Brand Accounts, el flujo recomendado para corregir mismatch es explícito y accionable.
