## Exploration: youtube-write-channel-and-playlist-delete

### Current State
Las operaciones de playlist en CLI/MCP comparten core y hoy resuelven credenciales con precedencia correcta (`credentialRef` explícito > contexto activo > error), pero **no exponen ni validan un contexto de canal de escritura** antes de mutaciones.

Hallazgos concretos en código:
- `playlist_create` termina en `createPlaylistForAuthenticated()` y ejecuta `youtube.playlists.insert(...)` sin `channelId` (`src/lib/youtube.ts`).
- El SDK tipado de YouTube v3 confirma que `playlists.insert` no acepta `channelId` estándar; sólo `onBehalfOfContentOwnerChannel` para CMS partners (`node_modules/googleapis/.../youtube/v3.d.ts`, `Params$Resource$Playlists$Insert`).
- `whoami` en CLI/MCP muestra usuario OAuth activo, pero no canal real de escritura (`src/lib/cli-auth/service.ts`, `src/mcp/server.ts`).
- Existe soporte de `channelId` explícito sólo para `list` de videos (lectura), no para writes de playlists (`src/mcp/server.ts`, `src/cli/video-metadata.ts`, `src/lib/video-metadata/adapters/youtube-api.ts`).
- No existe `playlist_delete` en core/MCP/CLI actualmente.

Resultado: hoy es posible crear playlists en el canal equivocado si la sesión OAuth activa corresponde a otro contexto (ej. canal principal vs canal VODs).

### Affected Areas
- `src/lib/youtube.ts` — funciones write/read de playlists; punto natural para resolver canal activo de escritura y delete de playlist.
- `src/lib/playlist-management/contracts.ts` — contratos para nuevo caso de uso `deletePlaylist` y señal de guardrail.
- `src/lib/playlist-management/schemas.ts` — input/output Zod para `expectedChannelId`, `playlist_delete` y validaciones.
- `src/lib/playlist-management/services.ts` — orquestación de guardrails previos a writes peligrosos (`create`/`delete`).
- `src/lib/playlist-management/adapters/youtube-api.ts` — llamadas YouTube para resolver canal activo, inspeccionar ownership y borrar playlist.
- `src/mcp/server.ts` + `src/mcp/server.test.ts` — nuevo tool `playlist_delete` y tool/contexto de escritura de canal.
- `src/cli/video-metadata.ts` + `src/cli/video-metadata.test.ts` — comando `playlist delete` y comando de inspección/validación de canal write.
- `openspec/specs/playlist-management-core/spec.md` — requisito de guardrail por canal esperado antes de create/delete.
- `openspec/specs/playlist-management-cli/spec.md` — contrato CLI para `playlist delete` y validación de canal esperado.
- `openspec/specs/playlist-management-mcp/spec.md` — contrato MCP equivalente y nueva herramienta.

### Approaches
1. **Guardrail sólo documental (recomendar `whoami` antes de write)** — mantener API actual sin checks obligatorios.
   - Pros: cero fricción de implementación; no rompe contratos.
   - Cons: NO mitiga el problema real; `whoami` no expone canal de escritura; alto riesgo operativo.
   - Effort: Low.

2. **Guardrail blando (expectedChannelId opcional)** — aceptar `expectedChannelId` en create/delete y validar sólo si viene.
   - Pros: compatible hacia atrás; mínima ruptura para consumidores actuales.
   - Cons: sigue permitiendo writes peligrosos por omisión; agentes/usuarios pueden “olvidarlo”.
   - Effort: Medium.

3. **Guardrail seguro por defecto (requerir expectedChannelId en writes peligrosos + exponer write context)**
   - Pros: previene explícitamente create/delete en canal incorrecto; flujo auditable y determinista para agentes.
   - Cons: cambio breaking en `playlist_create`; agrega 1-2 llamadas YouTube extra por operación (quota/latencia).
   - Effort: Medium.

### Recommendation
Recomiendo **Approach 3 (mínimo seguro)** con alcance acotado:

1. **Exponer contexto real de escritura** en CLI/MCP (nuevo comando/tool read-only), devolviendo al menos:
   - `activeChannel.id`
   - `activeChannel.title` (si disponible)
   - `credentialRef` efectivo (sin secretos)

2. **Agregar `expectedChannelId` obligatorio para `playlist_create` y `playlist_delete`**:
   - Resolver `activeWriteChannelId` con `channels.list(mine:true)` usando la credencial efectiva.
   - Si `expectedChannelId !== activeWriteChannelId`, abortar con error tipado y sin mutación.

3. **Agregar `playlist_delete`** en core + CLI + MCP:
   - Input mínimo: `playlistId`, `expectedChannelId`, `credentialRef?`.
   - Guardrails: validar canal activo esperado antes de borrar.

4. **No extender guardrail fuerte a add/remove en este cambio** (mantener scope mínimo al objetivo pedido: evitar create/delete en canal equivocado).

Esto ataca la causa raíz observada: en YouTube playlists, “forzar channelId en write” no es el control correcto para cuentas no-CMS; el control seguro es **validar contexto activo de canal antes de mutar**.

### Risks
- **Breaking change de contrato** en `playlist_create` (si `expectedChannelId` pasa a obligatorio).
- **Nuevos códigos de error**: el set actual de `DomainErrorCode` quizá no expresa claramente mismatch de canal (evaluar nuevo code o usar `validation_failed` con `details` canónicos).
- **Quota/latencia** por llamadas extra para resolver/validar canal antes de write.
- **Ambigüedad en Brand Accounts**: el canal activo depende del contexto OAuth realmente concedido; el guardrail lo hace explícito, pero puede sorprender a quien asumía otro canal.
- **UX de agentes**: si no se ordena un flujo (“primero resolver write context”), los errores de mismatch pueden parecer frecuentes al principio.

### Ready for Proposal
Yes — listo para `sdd-propose` con un plan mínimo seguro: (a) exponer `write channel context`, (b) exigir/validar `expectedChannelId` en create/delete, (c) incorporar `playlist_delete` en core/CLI/MCP con guardrails.
