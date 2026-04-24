# Proposal: Localized Metadata Sync

## Intent

Hoy `dryRun` y `apply` sólo sincronizan `snippet.title`/`snippet.description`. En videos con `defaultLanguage` y `localizations`, la review no refleja lo que ve cada locale y un apply real puede dejar metadata divergente o pisar contenido localizado. Necesitamos que la propuesta y la mutación representen el estado completo y seguro por locale.

## Scope

### In Scope
- Sincronizar metadata default + localized en review (`dryRun`) y apply real.
- Definir contrato de salida que muestre cambios por locale además del snippet base.
- Preservar campos remotos no editoriales al construir updates a YouTube.

### Out of Scope
- Generación automática de copy distinta por locale.
- Soporte para editar locales arbitrarios fuera del idioma default y los localizations ya existentes.

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `video-metadata-core`: el update/review debe incluir sincronización segura de snippet + localizations.
- `video-metadata-cli`: el dry-run/apply debe exponer diff claro por locale para automatización humana.
- `video-metadata-mcp`: las tools de update/review deben reflejar el contrato enriquecido del core.

## Approach

Leer `snippet`, `defaultLanguage` y `localizations` del video antes de proponer o aplicar. Construir un payload normalizado con metadata editorial default y un mapa de locales afectados; en `dryRun` devolver before/proposed por locale, y en apply enviar una actualización única que mantenga campos no editoriales intactos. Si el video no tiene contexto de idioma suficiente, fallar con error accionable en vez de aplicar a ciegas.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/youtube.ts` | Modified | Leer/escribir `localizations` y `defaultLanguage` en updates seguros |
| `src/lib/video-metadata/services.ts` | Modified | Armar review/apply sincronizados por locale |
| `src/lib/video-metadata/contracts.ts` | Modified | Extender resultado de apply/review |
| `src/lib/video-metadata/schemas.ts` | Modified | Validar payloads y salidas enriquecidas |
| `src/cli/video-metadata.ts` / `src/mcp/server.ts` | Modified | Exponer nuevo contrato de review/apply |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Update parcial que borre localizations | Med | Merge explícito sobre estado remoto completo |
| Videos sin idioma default claro | Med | Validación previa y error bloqueante |
| Cambio de contrato rompa consumidores | Low | Delta specs + tests para CLI/MCP |

## Rollback Plan

Revertir el cambio y volver al flujo actual de snippet-only; como mitigación operativa, mantener `dryRun` obligatorio durante rollout inicial para validar payloads reales antes de aplicar.

## Dependencies

- YouTube Data API debe aceptar update conjunto de `snippet` y `localizations` para el video objetivo.

## Success Criteria

- [ ] `dryRun` muestra before/proposed consistente para metadata default y locales afectados.
- [ ] `apply` real deja sincronizados snippet y localizations sin perder otros campos remotos.
- [ ] Videos sin contexto suficiente fallan con error claro y no ejecutan mutación remota.
