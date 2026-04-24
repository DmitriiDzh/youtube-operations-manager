## Exploration: transcript-diagnostics

### Current State
El provider actual (`createTranscriptProvider`) hace `captions.list` y luego `captions.download`; si cualquier paso falla, colapsa todo en `{ status: "unavailable", reason: "not-accessible" }`.

Eso genera pérdida de diagnóstico: hoy no se distingue entre falta real de captions, captions existentes no descargables, permisos/scopes insuficientes, rate limit o error API transitorio. El caso reportado (`swAq5hV42_s`) encaja exactamente con ese colapso porque la respuesta vuelve rápido y no es timeout.

El core/CLI/MCP sí preserva payloads tipados, pero el contrato de transcript es demasiado chico:
- `TranscriptResult.unavailable.reason` sólo acepta `"no-captions" | "not-accessible"`.
- El `catch` del provider ignora información del error remoto (status HTTP, reason de API, etc.).

### Affected Areas
- `src/lib/video-metadata/adapters/transcript-provider.ts` — origen de la pérdida diagnóstica (`catch` genérico).
- `src/lib/video-metadata/contracts.ts` — contrato `TranscriptResult` (reasons limitados).
- `src/lib/video-metadata/schemas.ts` — Zod schema del output de transcript.
- `src/lib/video-metadata/services.test.ts` — asserts de `unavailable` reasons y continuidad de flujo.
- `src/cli/video-metadata.test.ts` y `src/mcp/server.test.ts` — snapshots/expectations de payload si se amplía el contrato.
- `openspec/specs/video-metadata-core/spec.md` — escenario de transcript no disponible (debe explicitar diagnóstico granular).

### Approaches
1. **Expandir sólo `reason` en `unavailable`** — mantener shape actual y sumar razones más específicas.
   - Pros: cambio mínimo, bajo riesgo de compatibilidad, fácil de propagar en tests.
   - Cons: si más adelante hace falta metadata diagnóstica (HTTP status/retriable/apiReason), se vuelve a tocar contrato.
   - Effort: Low.

2. **Agregar `diagnostic` tipado dentro de `unavailable`** — mantener `reason` resumido + detalle opcional estructurado.
   - Pros: permite diagnóstico real (ej. `httpStatus`, `apiReason`, `retriable`, `stage=list|download`) sin romper semántica de `status`.
   - Cons: más superficie de contrato y más test cases; requiere decidir qué detalle exponer sin filtrar secretos.
   - Effort: Medium.

### Recommendation
Ir con una **propuesta mínima híbrida** (cercana a Approach 2, pero acotada):

- Mantener `status` actual (`available | unavailable | unsupported`).
- En `unavailable.reason`, pasar de binario a set diagnóstico acotado:
  - `no-captions`
  - `captions-not-downloadable`
  - `permissions-insufficient`
  - `rate-limited`
  - `api-error`
  - `unknown`
- Agregar `diagnostic` opcional sólo para `unavailable` con campos seguros:
  - `stage: "captions-list" | "captions-download"`
  - `httpStatus?: number`
  - `apiReason?: string`
  - `retriable?: boolean`

Esto mantiene fallback editorial fuera de alcance (como pidió el objetivo), pero evita perder causa raíz.

### Risks
- **Compatibilidad de contrato**: consumidores que asumen sólo `no-captions/not-accessible` pueden romper parseo.
- **Clasificación incompleta**: errores de Google API pueden variar; mapping inicial debe tener fallback robusto (`unknown`).
- **Sobreexposición de error**: incluir diagnóstico sin sanitizar podría filtrar contexto sensible si se serializa completo.
- **Cobertura de tests**: hoy no hay tests específicos del adapter de transcript; sin eso, mapping puede degradar silenciosamente.

### Ready for Proposal
Yes — listo para `sdd-propose` con alcance mínimo en contrato + clasificación de errores del provider, sin tocar fallback editorial.
