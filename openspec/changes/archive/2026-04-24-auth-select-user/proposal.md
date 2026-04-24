# Proposal: Auth Select User

## Intent

Hoy la CLI/MCP pueden listar usuarios locales y usar `activeUserId` implícito, pero no existe un comando explícito para cambiar esa identidad activa sin relogin. Eso fricciona setups multiusuario y vuelve opaco cómo impacta el cambio sobre `whoami`, `write_context` y el fallback de writes.

## Scope

### In Scope
- Agregar `auth select-user --userId <ID>` para cambiar `activeUserId` local con validación estricta.
- Exponer un equivalente MCP para actualizar el contexto activo local y devolver el estado resultante.
- Aclarar compatibilidad con write-context: el cambio altera el fallback implícito, no los overrides explícitos ni el guardrail de canal.

### Out of Scope
- Reautenticar usuarios, refrescar tokens o cambiar la identidad OAuth remota.
- Modificar `selectedChannelId` de otros usuarios o migrar selecciones entre perfiles.
- Relajar precedencia `credentialRef` explícito > contexto activo.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `cli-auth-bootstrap`: sumar selección explícita del usuario OAuth activo local.
- `playlist-management-mcp`: exponer tool MCP equivalente para cambiar identidad activa local.
- `youtube-credential-resolution`: aclarar que el fallback implícito depende del `activeUserId` seleccionado y no pisa `credentialRef` explícito.

## Approach

Reusar `data/auth-context.json` como única fuente de `activeUserId`. `auth select-user` validará existencia local del usuario antes de persistirlo y responderá con un envelope estable (`activeUser`, `previousActiveUserId?`, `writeChannel?`). El equivalente MCP delegará en la misma lógica. Para compatibilidad, `whoami`, `write_context`, `list/preview/apply` y playlists seguirán resolviendo auth por precedencia actual; solo cambia el fallback implícito cuando no se envía `credentialRef`.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/lib/cli-auth/service.ts` | Modified | Nueva operación `selectUser` + validación y respuesta estable |
| `src/cli/video-metadata.ts` | Modified | Nuevo comando `auth select-user --userId` |
| `src/mcp/server.ts` | Modified | Nueva tool MCP para seleccionar usuario activo local |
| `src/lib/cli-auth/storage.ts` | Modified | Reusar persistencia segura de `activeUserId` |
| `README.md` | Modified | Documentar impacto sobre fallback auth y write-context |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Confundir “select-user” con login real | Med | Naming/documentación explícita: cambia contexto local, no OAuth remoto |
| Cambiar usuario y romper writes implícitos esperados | Med | Responder `writeChannel` resultante y mantener guardrails fail-closed |
| Seleccionar usuario sin credenciales válidas | Med | Validar existencia local y devolver estado degradado/accionable |

## Rollback Plan

Remover `auth select-user` y la tool MCP; conservar `auth login` como único mecanismo para fijar `activeUserId` y seguir usando `credentialRef` explícito como escape hatch.

## Dependencies

- `src/lib/cli-auth/storage.ts` y `data/auth-context.json` ya persisten `activeUserId`.
- `src/lib/db.ts` ya expone `listUsers/getUserSummary` para validar selección local.

## Success Criteria

- [ ] CLI y MCP permiten cambiar `activeUserId` local sin relogin.
- [ ] `whoami`/`write_context` reflejan inmediatamente la nueva identidad activa.
- [ ] La documentación deja claro que `select-user` no cambia OAuth remoto y que `credentialRef` explícito sigue teniendo prioridad.
