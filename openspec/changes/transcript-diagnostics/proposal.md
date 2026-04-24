# Proposal: Transcript Diagnostics

## Intent

Mejorar el provider de transcript para distinguir causas reales de ausencia/falla de captions sin colapsar todo en `not-accessible`. Esto permite que batch processing tome decisiones mejores sobre reintentos, permisos y casos realmente sin captions, sin introducir todavía fallback editorial nuevo.

## Scope

### In Scope
- Ampliar el contrato `TranscriptResult.unavailable` con motivos diagnósticos acotados y seguros.
- Propagar diagnóstico estructurado mínimo (`stage`, `httpStatus`, `apiReason`, `retriable`) desde el provider.
- Alinear schemas, tests y contratos compartidos para core, CLI y MCP.

### Out of Scope
- Implementar fallback editorial nuevo o cambiar políticas editoriales actuales.
- Exponer payloads crudos de Google API o detalles sensibles.
- Rediseñar `status` de transcript más allá de `available | unavailable | unsupported`.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `video-metadata-core`: el resultado `unavailable` pasa de motivo binario a clasificación diagnóstica con detalle opcional seguro.
- `video-metadata-cli`: la salida estructurada debe preservar el contrato ampliado del core para automatización batch.
- `video-metadata-mcp`: las tools deben exponer el contrato ampliado del core sin degradar tipado ni serialización.

## Approach

Adoptar una expansión mínima del contrato: mantener `status` actual, reemplazar el motivo binario por un set acotado (`no-captions`, `captions-not-downloadable`, `permissions-insufficient`, `rate-limited`, `api-error`, `unknown`) y agregar `diagnostic` opcional sólo en `unavailable`. El mapping clasificará errores de `captions.list` y `captions.download` sin filtrar secretos y marcará retriabilidad cuando aplique.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/video-metadata/adapters/transcript-provider.ts` | Modified | Clasificación de errores por etapa `captions-list` / `captions-download`. |
| `src/lib/video-metadata/contracts.ts` | Modified | Ampliación de `TranscriptResult`. |
| `src/lib/video-metadata/schemas.ts` | Modified | Zod schema del output compartido. |
| `src/lib/video-metadata/services.test.ts` | Modified | Cobertura de razones/diagnóstico y continuidad del flujo. |
| `src/cli/video-metadata.test.ts` | Modified | Compatibilidad del contrato CLI. |
| `src/mcp/server.test.ts` | Modified | Compatibilidad del contrato MCP. |
| `openspec/specs/video-metadata-*/spec.md` | Modified | Deltas de comportamiento contractual. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Consumidores asumen reasons viejos | Med | Mantener `status`, documentar compatibilidad y cubrir CLI/MCP/tests. |
| Mapping incompleto de errores API | Med | Fallback explícito a `unknown` y detalle opcional seguro. |
| Diagnóstico expone demasiado contexto | Low | Limitar campos a metadata sanitizada. |

## Rollback Plan

Revertir el contrato ampliado y restaurar el mapping binario previo en provider, schemas y tests; como no cambia persistencia ni storage, el rollback es sólo de código/contrato.

## Dependencies

- `openspec/changes/transcript-diagnostics/exploration.md`
- YouTube Captions API error semantics ya consumidas por el provider actual.

## Success Criteria

- [ ] Un fallo de transcript diferencia al menos ausencia real, no descargable, permisos insuficientes, rate limit y error API genérico.
- [ ] CLI y MCP conservan contrato estable y serializable con el detalle diagnóstico nuevo.
- [ ] Batch processing puede distinguir qué casos reintentar y cuáles tratar como ausencia real de captions.
