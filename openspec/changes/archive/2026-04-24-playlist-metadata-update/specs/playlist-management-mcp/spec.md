# Delta for playlist-management-mcp

## MODIFIED Requirements

### Requirement: Herramientas MCP de playlists

El servidor MCP MUST publicar `playlist_list`, `playlist_create`, `playlist_update`, `playlist_delete`, `playlist_add_videos` y `playlist_remove_videos` usando contratos equivalentes al core.
(Previously: no existía `playlist_update`.)

#### Scenario: Tool de creación exitosa

- GIVEN una invocación válida de `playlist_create`
- WHEN MCP ejecuta la operación
- THEN devuelve `playlist.id`, `playlist.title`, `playlist.description` y `playlist.privacyStatus` según contrato del core

#### Scenario: Tool de update exitosa

- GIVEN una invocación válida de `playlist_update` con patch permitido
- WHEN MCP ejecuta la operación
- THEN devuelve playlist actualizada serializable con metadata completa

#### Scenario: Tool de borrado exitosa

- GIVEN una invocación válida de `playlist_delete`
- WHEN MCP ejecuta la operación
- THEN devuelve resultado serializable de borrado exitoso

### Requirement: Guardrail fail-closed en mutaciones sensibles

El servidor MCP MUST exigir `expectedChannelId` para `playlist_create`, `playlist_update` y `playlist_delete`, y SHALL rechazar la mutación ante mismatch, canal no resoluble u ownership inválido en update.
(Previously: el guardrail sólo cubría `playlist_create` y `playlist_delete`.)

#### Scenario: Mismatch bloquea tool de update

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `playlist_update`
- THEN MCP responde error estructurado accionable
- AND no ejecuta mutación remota

#### Scenario: Mismatch bloquea tool de create

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `playlist_create`
- THEN MCP responde error estructurado accionable
- AND no ejecuta mutación remota

#### Scenario: Ownership inválido bloquea tool de update

- GIVEN `expectedChannelId` válido pero playlist fuera de ownership
- WHEN se ejecuta preflight de update
- THEN MCP rechaza `playlist_update`
- AND retorna error tipado de guardrail

#### Scenario: Canal no resoluble bloquea tool de delete

- GIVEN `expectedChannelId` presente
- WHEN no se puede resolver canal activo de escritura
- THEN MCP rechaza `playlist_delete`
- AND retorna error tipado de guardrail

### Requirement: Validación estricta y errores claros

El servidor MCP MUST validar payloads con schemas estrictos, SHALL aceptar en update sólo `title?`, `description?`, `privacyStatus?` y MUST devolver error claro cuando el patch no incluya campos mutables.
(Previously: no definía validación explícita del patch de update.)

#### Scenario: Input MCP inválido

- GIVEN una tool call con payload incompleto
- WHEN se valida la invocación
- THEN MCP responde error estructurado de validación

#### Scenario: Patch vacío en playlist_update

- GIVEN una tool call `playlist_update` sin `title`, `description` ni `privacyStatus`
- WHEN MCP valida payload
- THEN responde error claro indicando que requiere al menos un campo mutable
