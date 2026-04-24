## Exploration: playlist-metadata-update

### Current State
El dominio `playlist-management` ya está centralizado y reusable entre core, CLI y MCP (`src/lib/playlist-management/**`, `src/cli/video-metadata.ts`, `src/mcp/server.ts`).

Hoy:
- `createPlaylist` soporta `title` + `privacyStatus` + guardrail (`expectedChannelId` vía `writeContext.assertWriteChannel`), pero no `description`.
- `listPlaylists` devuelve contrato mínimo (`id`, `title`) sin `description` ni `privacyStatus`.
- No existe caso de uso `updatePlaylist` en core ni tool/comando equivalente en MCP/CLI.
- Guardrails fail-closed de write-channel ya existen y están testeados para create/delete (`WRITE_CHANNEL_REQUIRED|UNRESOLVED|MISMATCH`), con precedencia de auth consistente.

### Affected Areas
- `src/lib/playlist-management/contracts.ts` — ampliar `Playlist` y agregar resultado/contrato de update.
- `src/lib/playlist-management/schemas.ts` — nuevos schemas Zod de input/output para update; extender create/list sin drift.
- `src/lib/playlist-management/services.ts` — agregar `updatePlaylist` reutilizando resolución auth + guardrail + validación.
- `src/lib/playlist-management/adapters/youtube-api.ts` — leer/escribir `snippet.description` y `status.privacyStatus`.
- `src/lib/youtube.ts` — helpers YouTube para metadata completa de playlist y mutación update.
- `src/cli/video-metadata.ts` — comando `playlist update` y soporte `--description` en `playlist create`.
- `src/mcp/server.ts` — tool `playlist_update` y schema de `playlist_create` con description.
- `src/lib/playlist-management/*.test.ts`, `src/cli/video-metadata.test.ts`, `src/mcp/server.test.ts` — actualizar contratos y cobertura de guardrail para update.
- `openspec/specs/playlist-management-core/spec.md` + `playlist-management-cli/spec.md` + `playlist-management-mcp/spec.md` — formalizar requisitos y escenarios del cambio.

### Approaches
1. **Patch mínimo sobre create + update directo** — agregar `description` en create y un `updatePlaylist` que actualice sólo lo recibido, sin prelectura.
   - Pros: rápido, menos código.
   - Cons: riesgo de comportamiento inesperado en campos omitidos durante update (dependiente de semántica exacta de `playlists.update`), menor robustez contractual.
   - Effort: Low.

2. **Extensión segura del core existente (recomendada)** — ampliar contrato `Playlist`, agregar `updatePlaylist` con guardrail fail-closed y estrategia merge explícita (obtener estado actual + aplicar patch validado de `title/description/privacyStatus`).
   - Pros: mantiene una sola fuente de verdad, reutiliza guardrails actuales, reduce riesgo de sobrescritura accidental y mantiene paridad CLI/MCP.
   - Cons: toca más tests/contratos existentes (list/create), requiere alinear snapshots/envelopes.
   - Effort: Medium.

3. **Duplicar lógica por transporte (CLI/MCP)** — implementar update por fuera del core para cada interfaz.
   - Pros: entrega rápida local por superficie.
   - Cons: rompe arquitectura actual, alto riesgo de drift en validación/errores/guardrails.
   - Effort: High.

### Recommendation
Recomiendo **Approach 2** como propuesta mínima segura.

Plan mínimo seguro:
1. Extender `Playlist` a `{ id, title, description, privacyStatus }` en core (con salida estable y aditiva).
2. Permitir `description` opcional en `createPlaylist` (CLI/MCP) manteniendo guardrail actual sin cambios de política.
3. Introducir `updatePlaylist` como write sensible con:
   - `playlistId` obligatorio,
   - patch de `title?`, `description?`, `privacyStatus?` con regla “al menos un campo mutable”,
   - `expectedChannelId` requerido en superficies no-web para mantener fail-closed consistente.
4. Reutilizar `writeContext.assertWriteChannel` y preflight ownership similar a delete antes de mutar.
5. Mantener envelopes de error actuales (`DomainError`) y no cambiar precedencia de credenciales.

### Risks
- **Breaking contract parcial**: consumidores que asumen playlist `{id,title}` podrían fallar si validan shape estricto. Mitigar con cambio aditivo y actualización de specs/tests.
- **Semántica de update en YouTube API**: patch incompleto puede pisar metadata si no se mergea correctamente. Mitigar con read-before-update y tests.
- **Inconsistencia CLI/MCP**: si uno exige `expectedChannelId` y el otro no, el guardrail pierde predictibilidad. Mitigar alineando schemas y pruebas cruzadas.
- **Regresión en create/delete**: al tocar schemas compartidos puede romper flujos existentes. Mitigar con suite actual + casos nuevos de regresión.

### Ready for Proposal
Yes — listo para avanzar con propuesta/specs finales enfocadas en extensión del core actual (sin nuevo dominio), update fail-closed y contratos aditivos estables para CLI/MCP.
