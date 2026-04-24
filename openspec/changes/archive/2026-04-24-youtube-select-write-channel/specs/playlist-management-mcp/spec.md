# Delta for playlist-management-mcp

## MODIFIED Requirements

### Requirement: Exposición MCP del canal activo de escritura

El servidor MCP SHALL exponer una herramienta read-only de contexto de escritura y MUST devolver `activeWriteChannel.id`, `selectedChannelId`, `alignment.status` (`matched|mismatch|unresolved`), `alignment.requiresReauth` y `credentialRef` efectivo.
(Previously: solo devolvía `activeWriteChannel.id`, `title?` y `credentialRef`.)

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

## ADDED Requirements

### Requirement: Tool MCP de selección de canal esperado

El servidor MCP MUST publicar `write_channel_select` con validación estricta de payload y SHALL devolver el estado de alineación resultante sin inferir switch OAuth automático.

#### Scenario: Select MCP inválido

- GIVEN una tool call sin `channelId` válido
- WHEN MCP valida payload
- THEN responde error estructurado de validación
- AND no modifica persistencia de selección
