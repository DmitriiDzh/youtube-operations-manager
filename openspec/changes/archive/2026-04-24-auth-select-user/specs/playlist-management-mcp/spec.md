# Delta for playlist-management-mcp

## ADDED Requirements

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
