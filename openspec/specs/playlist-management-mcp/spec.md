# playlist-management-mcp Specification

## Purpose

Exponer el core de playlists como herramientas MCP con contratos estables y errores accionables para agentes.

## Requirements

### Requirement: Herramientas MCP de playlists

El servidor MCP MUST publicar `playlist_list`, `playlist_create`, `playlist_update`, `playlist_delete`, `playlist_add_videos` y `playlist_remove_videos` usando contratos equivalentes al core.

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

### Requirement: Exposición MCP del canal activo de escritura

El servidor MCP SHALL exponer una herramienta read-only de contexto de escritura y MUST devolver `activeWriteChannel.id`, `selectedChannelId`, `alignment.status` (`matched|mismatch|unresolved`), `alignment.requiresReauth` y `credentialRef` efectivo.

#### Scenario: Tool de contexto de escritura

- GIVEN credenciales resolubles
- WHEN el agente invoca la tool de contexto
- THEN obtiene `activeWriteChannel.id`
- AND recibe contrato estable para automatización

#### Scenario: Tool de contexto con mismatch

- GIVEN `selectedChannelId` y canal activo diferentes
- WHEN el agente invoca la tool
- THEN obtiene `alignment.status="mismatch"`
- AND `alignment.requiresReauth=true` con siguiente acción explícita

### Requirement: Tool MCP de selección de canal esperado

El servidor MCP MUST publicar `write_channel_select` con validación estricta de payload y SHALL devolver el estado de alineación resultante sin inferir switch OAuth automático.

#### Scenario: Select MCP inválido

- GIVEN una tool call sin `channelId` válido
- WHEN MCP valida payload
- THEN responde error estructurado de validación
- AND no modifica persistencia de selección

### Requirement: Guardrail fail-closed en mutaciones sensibles

El servidor MCP MUST exigir `expectedChannelId` para `playlist_create`, `playlist_update` y `playlist_delete`, y SHALL rechazar la mutación ante mismatch, canal no resoluble u ownership inválido en update.

#### Scenario: Mismatch bloquea tool de create

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `playlist_create`
- THEN MCP responde error estructurado accionable
- AND no ejecuta mutación remota

#### Scenario: Mismatch bloquea tool de update

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `playlist_update`
- THEN MCP responde error estructurado accionable
- AND no ejecuta mutación remota

#### Scenario: Canal no resoluble bloquea tool de delete

- GIVEN `expectedChannelId` presente
- WHEN no se puede resolver canal activo de escritura
- THEN MCP rechaza `playlist_delete`
- AND retorna error tipado de guardrail

#### Scenario: Ownership inválido bloquea tool de update

- GIVEN `expectedChannelId` válido pero playlist fuera de ownership
- WHEN se ejecuta preflight de update
- THEN MCP rechaza `playlist_update`
- AND retorna error tipado de guardrail

### Requirement: Auth MCP con precedencia explícita

El servidor MCP SHALL permitir tool calls sin `credentialRef` cuando exista contexto activo local y MUST priorizar `credentialRef` explícito cuando esté presente.

#### Scenario: MCP usa contexto activo

- GIVEN una tool call sin `credentialRef` y con `activeUserId` válido
- WHEN se resuelve auth
- THEN la operación de playlist se ejecuta con el usuario activo

#### Scenario: MCP respeta override

- GIVEN `activeUserId=A` y request con `credentialRef=B`
- WHEN se resuelve auth
- THEN MCP usa `B` por precedencia

### Requirement: Tool MCP de selección explícita de usuario activo local

El servidor MCP MUST exponer `auth_user_select` para cambiar el `activeUserId` local con validación estricta de payload. La herramienta SHALL compartir contrato estable con CLI y MUST NOT afirmar ni ejecutar cambios de OAuth remoto.

#### Scenario: Selección MCP exitosa

- GIVEN existe un usuario local `B` y `activeUserId=A`
- WHEN el agente invoca `auth_user_select` con `userId=B`
- THEN el sistema persiste `activeUserId=B`
- AND retorna `activeUser`, `previousActiveUserId`, `changed`, `writeChannel` y `affectsRemoteOAuth=false`

#### Scenario: Payload MCP inválido

- GIVEN una tool call sin `userId` válido
- WHEN MCP valida la entrada
- THEN responde error estructurado de validación
- AND no modifica persistencia local

#### Scenario: Usuario local inexistente

- GIVEN una tool call con `userId` no registrado localmente
- WHEN MCP intenta seleccionar identidad activa
- THEN responde error estructurado `AUTH_USER_NOT_FOUND`
- AND mantiene el `activeUserId` previo

### Requirement: Contratos estables para resultados parciales

El servidor MCP MUST mantener resultados parciales estables en add/remove, propagando `attempted/requested`, `added/removed` y `failures[]` cuando aplique.

#### Scenario: Add parcial en MCP

- GIVEN una tool call de add con items mixtos
- WHEN finaliza la operación
- THEN MCP devuelve contrato parcial estable y serializable

#### Scenario: Remove parcial en MCP

- GIVEN una tool call de remove con items mixtos
- WHEN finaliza la operación
- THEN MCP devuelve contrato parcial estable y serializable

### Requirement: Validación estricta y errores claros

El servidor MCP MUST validar payloads con schemas estrictos y SHALL aceptar en update sólo `title?`, `description?`, `privacyStatus?` y MUST devolver error claro cuando el patch no incluya campos mutables.

#### Scenario: Input MCP inválido

- GIVEN una tool call con payload incompleto
- WHEN se valida la invocación
- THEN MCP responde error estructurado de validación

#### Scenario: Patch vacío en playlist_update

- GIVEN una tool call `playlist_update` sin `title`, `description` ni `privacyStatus`
- WHEN MCP valida payload
- THEN responde error claro indicando que requiere al menos un campo mutable
