## Exploration: video-metadata-cli-mcp

### Current State
El proyecto ya tiene una base sólida para operaciones sobre YouTube en `src/lib/youtube.ts` (listar videos recientes del canal autenticado, crear playlists, agregar/quitar videos) y expone esas capacidades por Route Handlers en `src/app/api/youtube/**` con sesión de NextAuth.

Hoy NO existe:
- flujo de transcripción,
- generación editorial con LLM,
- actualización de metadata de video (title/description),
- CLI,
- servidor MCP.

Además, la autenticación está acoplada al contexto web (`session.user.id` + tokens persistidos en SQLite), lo que no es reusable directo para ejecución CLI/MCP sin una capa de adaptación.

### Affected Areas
- `src/lib/youtube.ts` — hoy concentra integración YouTube; se debe extender para transcript + update metadata y desacoplar del patrón estrictamente web.
- `src/lib/auth.ts` — define scopes OAuth actuales; hay que validar scopes finales para lectura de transcripción y escritura de snippet.
- `src/app/api/youtube/videos/route.ts` — patrón actual de listing autenticado; referencia para exponer flujo reusable por API.
- `src/app/api/youtube/*/route.ts` — patrón de borde HTTP actual (autorización + validación mínima).
- `package.json` — probable incorporación de dependencias para CLI, MCP y proveedor LLM.
- `openspec/changes/video-metadata-cli-mcp/` — nuevo set de artefactos SDD del cambio.

### Approaches
1. **Adapters sobre un Core de Dominio (recomendado)** — crear un "video metadata workflow core" reusable (listar videos, obtener transcript, generar propuesta editorial, actualizar metadata) y exponerlo vía adapters HTTP/CLI/MCP.
   - Pros: una sola lógica de negocio; menor drift entre CLI y MCP; testeabilidad de pasos; respeta objetivo de “mismo core” para múltiples interfaces.
   - Cons: refactor inicial moderado; requiere definir contratos y errores de dominio antes de implementar adapters.
   - Effort: Medium

2. **Implementaciones separadas por canal (API/CLI/MCP)** — cada interfaz implementa su propio flujo consumiendo utilidades sueltas.
   - Pros: arranque más rápido para un primer demo.
   - Cons: duplicación alta; inconsistencias probables en prompt/salida; mantenimiento caro; contradice objetivo explícito de “mismo core”.
   - Effort: Medium/High

### Recommendation
Avanzar con **Approach 1**: diseñar un core orientado a casos de uso (ListChannelVideos, GetVideoTranscript, GenerateRioplatenseMetadata, UpdateVideoMetadata) con contratos tipados y validación en bordes (Zod), y luego montar adapters:

- Route Handlers para uso web/API,
- CLI para ejecución manual/automatizada,
- MCP server para integración de agentes.

Sobre la prompt editorial: definirla como artefacto versionado del dominio y forzar salida estructurada con un único `finalTitle` + `description` (sin variantes), con reglas obligatorias: voz rioplatense, SEO en primeros 200 caracteres, timestamps cuando haya segmentos temporales, y exclusión de sponsors viejos.

### Risks
- **Transcripción no garantizada por API oficial**: no todos los videos tienen captions accesibles por API; esto impacta casos sin transcript y exige estrategia de fallback clara.
- **Auth fuera de sesión web**: CLI/MCP no tienen `getServerSession`; hay que definir cómo resolver credenciales de manera segura y reutilizable.
- **Cuotas/rate limits de YouTube + LLM**: el flujo completo suma llamadas encadenadas y puede fallar parcial; requiere diseño de errores y reintentos.
- **Calidad editorial inconsistente**: sin schema de salida estricto y prompt hardening, el modelo puede devolver múltiples títulos o formato no usable.

### Ready for Proposal
Yes — se puede pasar a `sdd-propose` con foco en:
1) contrato del core reusable,
2) estrategia de transcript/fallback,
3) estrategia de auth para CLI/MCP,
4) definición formal del output editorial (1 título final + descripción).
