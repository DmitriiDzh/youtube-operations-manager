## Exploration: auth-select-user

### Current State
La CLI ya soporta `auth list-users` (desde DB) y resuelve credenciales por precedencia estricta: `credentialRef` explícito > `data/auth-context.json` (`activeUserId`) > error (`AUTH_USER_NOT_FOUND`).

No existe hoy una operación explícita para cambiar el `activeUserId` local sin relogin. El contexto activo se persiste de forma segura en `data/auth-context.json` vía `createActiveAuthStorage.write({ activeUserId })`, pero solo lo actualizan `auth login`/`auth login --device`.

En MCP no hay tool de selección de usuario activo: solo `whoami`, `write_context` y herramientas de write-channel. Resultado: el sistema puede almacenar múltiples identidades OAuth, pero no tiene un switch explícito de contexto para probar rápidamente cuál identidad corresponde al canal VODs.

### Affected Areas
- `src/lib/cli-auth/service.ts` — agregar operación `selectUser` reutilizando `db.getUserSummary` + `storage.write` y devolviendo estado estable post-switch.
- `src/cli/video-metadata.ts` — extender parser/comandos auth para `select-user` y `--userId` obligatorio.
- `src/cli/video-metadata.test.ts` — cubrir success/error envelope de `auth select-user` y rechazo de subcomando inválido actualizado.
- `src/mcp/server.ts` — agregar tool MCP para seleccionar usuario activo local (y validar input en borde con Zod).
- `src/mcp/server.test.ts` — validar contrato de la nueva tool y errores de validación/usuario inexistente.
- `src/lib/cli-auth/storage.ts` — se reutiliza sin cambios estructurales; confirmar semántica de overwrite atómico del contexto.
- `README.md` — documentar que `select-user` cambia contexto local, NO cambia sesión OAuth remota.
- `openspec/specs/cli-auth-bootstrap/spec.md` + `openspec/specs/video-metadata-cli/spec.md` + `openspec/specs/playlist-management-mcp/spec.md` + `openspec/specs/youtube-credential-resolution/spec.md` — extender escenarios y contratos para selección explícita.

### Approaches
1. **Selector mínimo (CLI + MCP) con validación local estricta** — `auth select-user --userId <ID>` y tool MCP equivalente que solo cambian `activeUserId` si el usuario existe en DB.
   - Pros: mínimo seguro; reutiliza persistencia existente; no toca OAuth remoto; mantiene precedencia actual sin breaking conceptual.
   - Cons: si el usuario existe pero tiene tokens degradados/expirados, el switch puede ser exitoso pero operaciones posteriores fallan (esperable, pero requiere mensajería clara).
   - Effort: Low/Medium

2. **Selector + listado MCP dedicado de usuarios** — además de select, exponer tool MCP para enumerar identidades locales y facilitar selección desde agentes 100% MCP.
   - Pros: UX MCP completa sin depender de CLI; reduce prueba/error al elegir `userId`.
   - Cons: amplía superficie pública MCP y tests; no es estrictamente necesario para resolver el gap principal de selección.
   - Effort: Medium

3. **Auto-switch heurístico por canal objetivo** — intentar elegir automáticamente usuario activo según `selectedChannelId`/`activeWriteChannel`.
   - Pros: menos pasos manuales en teoría.
   - Cons: opaco, no determinista y riesgoso para guardrails; mezcla concerns (selección de identidad vs alineación de canal).
   - Effort: High

### Recommendation
Adoptar **Approach 1** como mínimo seguro para este cambio, con contrato explícito:

- CLI: `auth select-user --userId <ID>`.
- MCP: tool equivalente de selección explícita (nombre a definir en proposal/spec, p. ej. `auth_user_select`).
- Validación: MUST fallar con error tipado si `userId` no existe en DB local.
- Respuesta sugerida: `activeUser`, `previousActiveUserId`, `changed`, más snapshot de contexto (`selectedChannelId`, `alignment`, `requiresReauth`) para feedback inmediato.
- Semántica inmutable: seleccionar usuario **NO** reautentica ni cambia OAuth remoto; solo cambia fallback implícito local.

Mantener **Approach 2** como opcional (MAY) si se prioriza ergonomía MCP pura en la misma iteración.

### Risks
- Confusión de producto: interpretar `select-user` como login/switch remoto OAuth.
- Cambio de contexto hacia usuario con tokens inválidos puede romper comandos posteriores (aunque el switch sea correcto).
- Riesgo de drift entre contratos CLI y MCP si no se centraliza en `CliAuthService.selectUser`.
- Riesgo de inconsistencias de mensajería si no se devuelve claramente el estado post-switch (incluyendo señales de reauth/alignment).

### Ready for Proposal
Yes — listo para `sdd-propose`/`sdd-spec` con foco en contrato explícito de `select-user`, validación estricta en borde, paridad CLI/MCP y documentación de semántica “local-context only”.
