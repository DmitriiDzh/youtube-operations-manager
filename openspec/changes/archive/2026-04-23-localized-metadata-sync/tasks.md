# Tasks: Localized Metadata Sync

## Phase 1: Contracts & Validation Foundation

- [x] 1.1 Extender `src/lib/video-metadata/contracts.ts` con tipos semánticos (`targetLanguage`, `languageSource`, `MetadataLocaleReview`, proposal interno de update) para alinear core/CLI/MCP.
- [x] 1.2 Actualizar `src/lib/video-metadata/schemas.ts` con Zod 4 como fuente de verdad del resultado enriquecido (`snippet`, `localizations.before/proposed/affected`) y errores accionables por idioma no resoluble.
- [x] 1.3 Ajustar/adaptar tipos compartidos en `src/lib/video-metadata/adapters/youtube-api.ts` para consumir/devolver el contrato nuevo sin `any` ni duplicación de shape.

## Phase 2: Core Sync Logic & YouTube Safe Update

- [x] 2.1 Implementar en `src/lib/video-metadata/services.ts` un builder compartido (p.ej. `buildMetadataSyncProposal`) que calcule `before/proposed/update` para dryRun y apply con la misma transformación.
- [x] 2.2 Implementar resolución de idioma objetivo en el core: priorizar `snippet.defaultLanguage`, fallback a única key de `localizations`, y error tipado bloqueante en ambigüedad/ausencia.
- [x] 2.3 Modificar `src/lib/youtube.ts` para leer contexto completo (`snippet.defaultLanguage` + `localizations`) y construir update seguro con `part:["snippet","localizations"]` preservando campos no editoriales y locales no objetivo.
- [x] 2.4 Actualizar `src/lib/video-metadata/adapters/youtube-api.ts` para exponer `getVideoMetadataContext` y `applyMetadataProposal`, eliminando el flujo snippet-only basado en `title/description` sueltos.
- [x] 2.5 Asegurar en `services.ts` que `dryRun=true` devuelva exactamente el mismo `proposed` que se usaría en apply, cambiando sólo el estado de ejecución.

## Phase 3: Channel Payload Parity (CLI/MCP/API)

- [x] 3.1 Actualizar serialización de `src/cli/video-metadata.ts` para emitir payload de review/apply con `targetLanguage` y diff por locale consistente con el contrato del core.
- [x] 3.2 Revisar handlers/herramientas en `src/mcp/server.ts` para propagar `structuredContent` enriquecido y errores tipados accionables por idioma no resoluble.
- [x] 3.3 Verificar en la capa API/transport (mapeos en CLI/MCP y adapters) que el contrato sea estable entre review y apply, sin drift de campos editoriales.

## Phase 4: Tests & Minimal Documentation

- [x] 4.1 Extender `src/lib/video-metadata/services.test.ts` con tabla de casos de idioma (`defaultLanguage`, fallback único, ambiguo, inexistente) y paridad dryRun/apply.
- [x] 4.2 Agregar pruebas de preservación en `services.test.ts` para confirmar que localizations no objetivo y campos snippet no editoriales permanecen intactos tras proposal/apply.
- [x] 4.3 Actualizar `src/cli/video-metadata.test.ts` para validar salida JSON con `targetLanguage`, `localizations.affected` y errores estructurados de idioma no resoluble.
- [x] 4.4 Actualizar `src/mcp/server.test.ts` para validar `structuredContent` enriquecido y no mutación remota en modo review.
- [x] 4.5 Documentar mínimo en `README.md` la nueva semántica: sync default+localized, dry-run obligatorio recomendado en rollout, y ejemplo breve del payload de review por locale.
