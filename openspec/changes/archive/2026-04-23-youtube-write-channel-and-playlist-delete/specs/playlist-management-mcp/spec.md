# Delta for playlist-management-mcp

## MODIFIED Requirements

### Requirement: Herramientas MCP de playlists

El servidor MCP MUST publicar `playlist_list`, `playlist_create`, `playlist_delete`, `playlist_add_videos` y `playlist_remove_videos` usando contratos equivalentes al core.
(Previously: no incluía `playlist_delete`.)

#### Scenario: Tool de creación exitosa

- GIVEN una invocación válida de `playlist_create`
- WHEN MCP ejecuta la operación
- THEN devuelve `playlist.id` y `playlist.title` según contrato del core

#### Scenario: Tool de borrado exitosa

- GIVEN una invocación válida de `playlist_delete`
- WHEN MCP ejecuta la operación
- THEN devuelve resultado serializable de borrado exitoso

## ADDED Requirements

### Requirement: Exposición MCP del canal activo de escritura

El servidor MCP SHALL exponer una herramienta read-only para contexto de escritura y MUST devolver `activeWriteChannel.id`, `title?` y `credentialRef` efectivo.

#### Scenario: Tool de contexto de escritura

- GIVEN credenciales resolubles
- WHEN el agente invoca la tool de contexto
- THEN obtiene `activeWriteChannel.id`
- AND recibe contrato estable para automatización

### Requirement: Guardrail fail-closed en mutaciones sensibles

El servidor MCP MUST exigir `expectedChannelId` para `playlist_create` y `playlist_delete`, y SHALL rechazar la mutación ante mismatch o canal no resoluble.

#### Scenario: Mismatch bloquea tool de create

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `playlist_create`
- THEN MCP responde error estructurado accionable
- AND no ejecuta mutación remota

#### Scenario: Canal no resoluble bloquea tool de delete

- GIVEN `expectedChannelId` presente
- WHEN no se puede resolver canal activo de escritura
- THEN MCP rechaza `playlist_delete`
- AND retorna error tipado de guardrail
