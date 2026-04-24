## Exploration: youtube-select-write-channel

### Current State
El guardrail actual ya protege writes sensibles (`apply`, `playlist_create`, `playlist_delete`) comparando `expectedChannelId` vs `activeWriteChannel.id` y falla en modo fail-closed (`WRITE_CHANNEL_REQUIRED`, `WRITE_CHANNEL_UNRESOLVED`, `WRITE_CHANNEL_MISMATCH`).

Hallazgos de implementación:
- `selectedChannelId` existe en DB (`users.selected_channel_id`) y se usa como fallback de `expectedChannelId` cuando no viene explícito (`src/lib/write-context/service.ts`).
- No hay una superficie explícita de “selector”: hoy `selectedChannelId` se persiste de forma implícita después de writes exitosos (`src/lib/video-metadata/services.ts`, `src/lib/playlist-management/services.ts`).
- CLI/MCP exponen inspección read-only vía `auth whoami` y tool `write_context`, que ya devuelven `activeWriteChannel`, `selectedChannelId`, `effectiveCredentialRef` (`src/lib/cli-auth/service.ts`, `src/mcp/server.ts`).
- La resolución de canal activo usa `channels.list(mine:true,maxResults:1)` (`src/lib/write-context/adapters/youtube-api.ts`), por lo que el sistema hoy no enumera canales “seleccionables” como catálogo completo.

Conclusión: hay guardrail, pero no UX explícita de selección. Persistir selección NO cambia el canal OAuth activo.

### Affected Areas
- `src/lib/write-context/contracts.ts` — extender contrato de estado (`matched/mismatch/unresolved`) y shape de selector.
- `src/lib/write-context/service.ts` — lógica compartida para evaluar alineación y (opcionalmente) validar/persistir selección segura.
- `src/lib/cli-auth/service.ts` — API de alto nivel para `write_channel_whoami`, `write_channel_select`, y potencial `write_channel_list`.
- `src/cli/video-metadata.ts` — nuevos comandos CLI para inspección/selección explícita.
- `src/mcp/server.ts` — nuevas tools MCP equivalentes para agentes.
- `src/lib/db.ts` — reutilizar `getSelectedChannelId/setSelectedChannelId` (sin migraciones en propuesta mínima).
- `README.md` — documentar claramente qué requiere reauth vs qué resuelve selección persistida.
- `openspec/specs/*` (guardrails/credential-resolution/CLI/MCP) — actualizar escenarios y contratos.

### Approaches
1. **Selector “ciego” (persistir siempre `selectedChannelId`)** — `write_channel_select` solo guarda valor.
   - Pros: implementación mínima, rápida.
   - Cons: UX engañosa; deja mismatch persistente sin explicar límite OAuth; aumenta errores en writes.
   - Effort: Low.

2. **Selector explícito + estado de alineación (sin cambiar OAuth)** — inspección completa + selección validada contra contexto activo.
   - Pros: diferencia explícita entre `selectedChannelId` y `activeWriteChannel`; guía accionable para agentes/humanos; no rompe guardrail existente.
   - Cons: requiere cambios de contrato en CLI/MCP y tests.
   - Effort: Medium.

3. **Selector + “switch real de canal” vía OAuth automático** — intentar cambiar active write channel desde app.
   - Pros: UX ideal en teoría (un solo comando).
   - Cons: fuera de alcance técnico seguro del sistema actual; depende de consentimiento/contexto OAuth/Brand Account; alto riesgo de comportamiento no determinista.
   - Effort: High.

### Recommendation
Recomiendo **Approach 2 (mínimo seguro)**:

1. Exponer explícitamente un contrato común `write_channel_whoami` (CLI/MCP) con:
   - `activeWriteChannel` (de OAuth actual)
   - `selectedChannelId` (persistido)
   - `effectiveCredentialRef`
   - `alignment.status`: `matched | mismatch | unresolved`
   - `alignment.requiresReauth: boolean`

2. Agregar `write_channel_select(channelId)` con semántica segura:
   - Si `activeWriteChannel.id === channelId` → persistir y devolver `matched`.
   - Si difiere → **no prometer switch OAuth**; devolver estado `mismatch` + acción recomendada de reauth.
   - Decisión de producto mínima segura: permitir persistencia solo cuando match, o permitir persistencia con warning explícito (`pending-mismatch`).

3. `write_channel_list` como opcional viable:
   - **Versión mínima segura**: listar “known channels” derivado de `{activeWriteChannel, selectedChannelId}` con `source` (active/stored), sin prometer catálogo completo remoto.
   - Posponer listado remoto real (multi-channel) para cambio posterior por riesgo de ambigüedad y dependencia API.

4. Mantener guardrail fail-closed tal cual en writes sensibles.

Dependencia reauth vs selección persistida (clave del cambio):
- **No requiere reauth**: cuando el canal deseado ya coincide con `activeWriteChannel.id`; la selección persistida solo consolida default.
- **Sí requiere reauth**: cuando el canal deseado difiere del `activeWriteChannel.id`; persistir selección sola no habilita writes porque el guardrail seguirá detectando mismatch.

### Risks
- Riesgo de UX: usuarios/agentes pueden interpretar `select` como switch OAuth real.
- Riesgo de drift de contratos entre CLI y MCP si no se centraliza en `write-context`.
- Riesgo de complejidad prematura si se intenta `write_channel_list` remoto “completo” en este cambio.
- Riesgo de breaking change menor en consumidores que parsean `whoami/write_context` con shape fijo.

### Ready for Proposal
Yes — listo para avanzar con propuesta/specs enfocadas en contrato explícito de inspección/selección, manteniendo guardrails y separando claramente selección persistida de cambio real de sesión OAuth.
