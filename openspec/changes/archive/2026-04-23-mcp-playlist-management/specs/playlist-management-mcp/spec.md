# playlist-management-mcp Specification

## Purpose

Exponer el core de playlists como herramientas MCP con contratos estables y errores accionables para agentes.

## Requirements

### Requirement: Herramientas MCP de playlists

El servidor MCP MUST publicar `playlist_list`, `playlist_create`, `playlist_add_videos` y `playlist_remove_videos` usando contratos equivalentes al core.

#### Scenario: Tool de creación exitosa

- GIVEN una invocación válida de `playlist_create`
- WHEN MCP ejecuta la operación
- THEN devuelve `playlist.id` y `playlist.title` según contrato del core

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

El servidor MCP MUST validar payloads con schemas estrictos y SHALL devolver errores estructurados de validación, auth y dominio con mensajes accionables.

#### Scenario: Input MCP inválido

- GIVEN una tool call con payload incompleto
- WHEN se valida la invocación
- THEN MCP responde error estructurado de validación
