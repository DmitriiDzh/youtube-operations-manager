# Proposal: Video Metadata CLI + MCP

## Intent

Desacoplar la lógica de YouTube del contexto web actual para habilitar un core reusable que liste videos, lea transcripciones, genere metadata editorial y actualice snippets. Esto permite operar el flujo fuera de NextAuth/session, primero por CLI y también por MCP para agentes externos, sin duplicar negocio.

## Scope

### In Scope
- Extraer/auth resolver reusable para YouTube fuera de `getServerSession`.
- Definir casos de uso tipados: listar videos, obtener transcript, generar metadata final, actualizar snippet.
- Exponer el mismo core por CLI y por MCP en este cambio.
- Validar entradas/salidas en bordes con TypeScript + Zod.

### Out of Scope
- Rediseño del frontend web.
- Automatización batch/scheduler.
- Versiones múltiples de título editorial o CMS externo.

## Capabilities

### New Capabilities
- `video-metadata-core`: contratos y casos de uso reusables para list/transcript/generate/update.
- `video-metadata-cli`: ejecución local/scriptable del workflow con salida estable para automatización.
- `video-metadata-mcp`: herramientas MCP que expongan el mismo core a agentes externos.
- `youtube-credential-resolution`: resolución segura de credenciales/tokens fuera del contexto web.

### Modified Capabilities
- None.

## Approach

Adoptar arquitectura core + adapters. El core concentra auth abstraída, cliente YouTube, transcript fallback, prompt editorial versionado y errores de dominio. CLI y MCP serán adapters finos sobre esos casos de uso: CLI optimiza operabilidad humana/scriptable; MCP optimiza integración agente-a-herramienta. Tradeoff: más diseño inicial que un CLI ad hoc, pero evita drift entre interfaces y reduce mantenimiento. Mantener Route Handlers actuales intactos salvo reutilización futura.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/youtube.ts` | Modified | Separar cliente/auth del uso estrictamente web y sumar update metadata/transcript hooks |
| `src/lib/auth.ts` | Modified | Revisar scopes y estrategia de refresh reutilizable |
| `src/lib/**` | New/Modified | Nuevo core de casos de uso, schemas y contratos |
| `src/app/api/youtube/videos/route.ts` | Modified | Referencia/posible adopción futura del core desacoplado |
| `package.json` | Modified | Scripts y dependencias para CLI/MCP/LLM |
| `openspec/changes/video-metadata-cli-mcp/` | Modified | Artefactos SDD del cambio |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Captions no disponibles por API | High | Definir fallback/no-transcript explícito en contrato |
| Auth CLI/MCP insegura o frágil | Med | Resolver credenciales por adapter estable y renovación centralizada |
| Drift entre CLI y MCP | Med | Un único core y schemas compartidos |
| Salida LLM no usable | Med | Zod + formato estructurado `finalTitle`/`description` |

## Rollback Plan

Eliminar adapters CLI/MCP y restaurar `src/lib/youtube.ts` al patrón acoplado actual; no requiere cambios destructivos de datos persistidos.

## Dependencies

- Exploration existente del cambio.
- Credenciales Google OAuth ya disponibles.
- Proveedor LLM a definir durante specs/design.

## Success Criteria

- [ ] Existe un core reusable independiente del contexto web para list/transcript/generate/update.
- [ ] CLI y MCP usan exactamente los mismos casos de uso y contratos.
- [ ] El output editorial queda acotado a `finalTitle` y `description` válidos.
- [ ] La estrategia de auth fuera de web queda especificada sin romper el flujo actual.
