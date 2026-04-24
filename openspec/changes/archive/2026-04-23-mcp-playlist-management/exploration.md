## Exploration: mcp-playlist-management

### Current State
Las capacidades de playlists YA existen en web, pero están acopladas a sesión NextAuth:

- Route Handlers web:
  - `GET /api/youtube/playlists` → `getUserPlaylists(session.user.id)`
  - `POST /api/youtube/create-playlist` → `createPlaylist(session.user.id, title, privacyStatus)`
  - `POST /api/youtube/add-to-playlist` → loop sobre `videoIds` y `addVideoToPlaylist(...)` con conteo parcial `added`
  - `POST /api/youtube/remove-from-playlist` → `removeVideosFromPlaylist(...)` con retorno `removed`
- Lógica reusable actual en `src/lib/youtube.ts`:
  - `getUserPlaylists`, `createPlaylist`, `addVideoToPlaylist`, `removeVideosFromPlaylist`
  - pero todas reciben `userId` (dependen de `getAuthenticatedYoutube(userId)`), no `credentialRef` genérico.

Paralelamente, la plataforma CLI/MCP existente para video-metadata ya tiene patrón sólido:

- core + adapters + schemas Zod (`src/lib/video-metadata/**`)
- resolución de credenciales `credentialRef explícito > active local context > error tipado` (`src/lib/cli-auth/service.ts`)
- envelopes JSON estables en CLI y MCP (`src/cli/video-metadata.ts`, `src/mcp/server.ts`)

Conclusión: hay lógica de negocio de playlists aprovechable, pero no está empaquetada en un core portable para CLI/MCP.

### Affected Areas
- `src/lib/youtube.ts` — contiene la lógica actual de playlists a reutilizar/extractar para evitar duplicación.
- `src/lib/video-metadata/adapters/google-auth.ts` — patrón reusable para resolver tokens/scopes con `credentialRef` fuera de web.
- `src/lib/cli-auth/service.ts` — resolución de contexto activo para CLI/MCP.
- `src/mcp/server.ts` — punto de integración para nuevas tools MCP de playlists.
- `src/cli/video-metadata.ts` — opción de extender comandos CLI reutilizando el mismo patrón de parsing/envelope.
- `src/app/api/youtube/{playlists,create-playlist,add-to-playlist,remove-from-playlist}/route.ts` — consumidores web que no deben romperse.
- `src/mcp/server.test.ts` y `src/cli/video-metadata.test.ts` — suites existentes para extender cobertura de contrato.
- `README.md` y `openspec/specs/*` — documentación/especificaciones a alinear con nuevas capacidades.

### Approaches
1. **MCP-only (mínimo estricto)** — exponer sólo tools MCP de playlists, sin CLI nueva.
   - Pros: menor alcance, entrega rápida del objetivo principal.
   - Cons: deja asimetría con CLI y duplica UX (video metadata sí tiene CLI, playlists no).
   - Effort: Low.

2. **MCP + CLI usando helpers directos de `lib/youtube.ts`** — conectar handlers directamente con funciones actuales por `userId`.
   - Pros: implementación rápida en apariencia.
   - Cons: rompe el patrón actual de `credentialRef` explícito y dificulta soportar token explícito; alto riesgo de drift y errores de auth fuera de sesión web.
   - Effort: Medium.

3. **Core de playlists + adapters (recomendado mínimo sostenible)** — replicar patrón video-metadata en versión acotada: contratos Zod + service + adapter YouTube reutilizando lógica existente.
   - Pros: máxima reutilización sin duplicar reglas; paridad de auth CLI/MCP; contratos tipados y testeables.
   - Cons: más archivos iniciales que un “atajo directo”.
   - Effort: Medium.

### Recommendation
Ir con **Approach 3** como propuesta mínima realista:

1. Crear `playlist-management-core` chico (listar, crear, agregar, remover) con validación Zod en bordes.
2. Reusar lógica de `src/lib/youtube.ts` extrayendo funciones que operen con cliente autenticado (no sólo `userId`) para no duplicar comportamiento.
3. Exponer tools MCP nuevas (`playlist_list`, `playlist_create`, `playlist_add_videos`, `playlist_remove_videos`) con el mismo estilo de error/success envelope ya usado.
4. CLI: dejarla **opcional** en este cambio (feature-flag de alcance):
   - si entra en scope: comandos bajo namespace `playlist` usando el mismo `resolveEffectiveCredentialRef`.
   - si no entra: documentar explícitamente “MCP-first” y abrir follow-up para CLI.

Propuesta mínima de contrato operativo:
- `list`: `{ playlists: Array<{ id: string; title: string }> }`
- `create`: `{ playlist: { id: string; title: string } }`
- `add`: `{ added: number, attempted: number }` (mantener semántica parcial actual)
- `remove`: `{ removed: number, requested: number }`

### Risks
- **Acoplamiento actual a `userId` web**: las funciones de playlists no aceptan `credentialRef` explícito hoy.
- **Semántica parcial add/remove**: el comportamiento actual ignora errores por item; para agentes puede ser ambiguo sin `attempted/requested`.
- **Cobertura insuficiente**: hoy no hay tests específicos para endpoints/helpers de playlists.
- **Drift de contratos**: si MCP/CLI implementan directo contra YouTube API sin core, divergen rápido del comportamiento web.
- **Compatibilidad de nombres de comandos/tools**: elegir nombres inconsistentes con video-metadata puede complicar adopción por agentes.

### Ready for Proposal
Yes — listo para avanzar a `sdd-spec`/`sdd-design` con alcance MCP obligatorio, CLI opcional explicitada por criterio de corte, y reutilización centrada en extraer/adaptar la lógica existente de `src/lib/youtube.ts`.
