# Design: transcript-diagnostics

## Technical Approach

Extender el resultado `TranscriptResult` para que el provider de captions conserve diagnóstico estructurado y seguro, sin cambiar el modelo de estados (`available | unavailable | unsupported`) ni agregar fallback editorial. La implementación se apoya en el flujo actual `captions.list -> captions.download`, pero reemplaza el `catch` genérico por clasificación explícita de errores por etapa.

## Architecture Decisions

### Decision: mantener `status` y enriquecer `unavailable`

| Option | Tradeoff | Decision |
|---|---|---|
| Sólo ampliar `reason` | mínimo cambio, pero sin detalle operativo | No |
| Nuevo `status=diagnostic` | rompe contratos y consumidores | No |
| Mantener `status=unavailable` + `reason` granular + `diagnostic` opcional | conserva compatibilidad semántica y agrega causa raíz | Sí |

Rationale: CLI, MCP, prompt editorial y services ya distinguen por `status`; el detalle extra debe vivir dentro de `unavailable`.

### Decision: exponer sólo diagnóstico sanitizado

| Option | Tradeoff | Decision |
|---|---|---|
| Serializar error remoto completo | útil para debug, pero filtra headers/tokens/config | No |
| Guardar mensaje raw | puede incluir contexto sensible e inestable | No |
| Whitelist de campos seguros | menos detalle, pero contrato estable y seguro | Sí |

Rationale: `diagnostic` sólo incluirá `stage`, `httpStatus`, `apiReason` y `retriable`; nunca request config, headers, URL completa, payload ni credenciales.

### Decision: mapear por etapa + HTTP status + API reason

| Option | Tradeoff | Decision |
|---|---|---|
| Mapear sólo por status HTTP | demasiado ambiguo | No |
| Mapear sólo por reason textual | depende de variaciones del proveedor | No |
| Resolver con prioridad `apiReason -> httpStatus -> fallback`, preservando `stage` | más robusto ante errores reales | Sí |

Rationale: `captions.list` y `captions.download` fallan distinto; `stage` evita perder esa señal.

## Data Flow

```text
Services.getTranscript
  -> transcriptProvider.getTranscript(videoId, credentials)
      -> captions.list
         -> items vacíos => unavailable(no-captions)
         -> error => classifyTranscriptError(stage=list)
      -> captions.download
         -> texto vacío => unavailable(no-captions)
         -> error => classifyTranscriptError(stage=download)
      -> transcript normalizado => available
  -> Zod valida salida
  -> CLI/MCP serializan el mismo payload
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/lib/video-metadata/contracts.ts` | Modify | Ampliar `TranscriptResult.unavailable` con reasons granulares y `diagnostic` tipado. |
| `src/lib/video-metadata/schemas.ts` | Modify | Reflejar el nuevo contrato con Zod 4 estricto. |
| `src/lib/video-metadata/adapters/transcript-provider.ts` | Modify | Extraer helper de clasificación y preservar etapa/HTTP/apiReason/retriable. |
| `src/lib/video-metadata/services.test.ts` | Modify | Cubrir passthrough del nuevo shape y continuidad del flujo editorial sin fallback nuevo. |
| `src/lib/video-metadata/adapters/transcript-provider.test.ts` | Create | Tests unitarios del mapping `captions.list/download -> diagnostic reason`. |
| `src/cli/video-metadata.test.ts` | Modify | Regresión del envelope JSON cuando transcript devuelve `diagnostic`. |
| `src/mcp/server.test.ts` | Modify | Regresión de `structuredContent`/texto MCP con el nuevo contrato. |

## Interfaces / Contracts

```ts
type TranscriptDiagnostic = {
  stage: "captions-list" | "captions-download";
  httpStatus?: number;
  apiReason?: string;
  retriable?: boolean;
};

type TranscriptUnavailableReason =
  | "no-captions"
  | "captions-not-downloadable"
  | "permissions-insufficient"
  | "rate-limited"
  | "api-error"
  | "unknown";
```

Mapping inicial:
- items vacíos o SRT normalizado vacío -> `no-captions`
- `download` con `forbidden`, `captionNotFound`, `cannotDownload` (o equivalente 403 de captions) -> `captions-not-downloadable`
- `insufficientPermissions`, `forbidden`, `authError` ligado a scopes/credenciales -> `permissions-insufficient`
- `rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, HTTP 429 -> `rate-limited`
- HTTP 5xx / `backendError` -> `api-error`
- resto -> `unknown`

Si existe conflicto, gana el mapping más específico por `apiReason`; `retriable=true` sólo para `rate-limited` y `api-error` transitorio.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | Clasificación del provider | Stub de `createYoutubeClient` y errores sintéticos para `captions.list`/`download`, validando `reason` + `diagnostic`. |
| Integration | Contrato del core | Ajustar `services.test.ts` para aceptar el nuevo `TranscriptResult` y verificar que `previewMetadata` sigue funcionando con `status=unavailable`. |
| Regression | CLI/MCP | Afirmar que ambos exponen `diagnostic` intacto en JSON/`structuredContent` y no transforman el payload. |

## Migration / Rollout

No migration required. Cambio de contrato aditivo dentro de `unavailable`, pero requiere actualizar tests y cualquier consumidor que asuma sólo `not-accessible`.

## Open Questions

- [ ] Falta `proposal.md` y delta spec del cambio; la implementación debería alinear `openspec/specs/video-metadata-core/spec.md` o crear delta antes de aplicar.
- [ ] Confirmar el set exacto de `apiReason` que devuelve Google para captions no descargables en producción para cerrar el mapping fino.
