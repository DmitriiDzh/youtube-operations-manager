# Delta for video-metadata-mcp

## ADDED Requirements

### Requirement: Resolución implícita de contexto autenticado en MCP

El servidor MCP MUST permitir operaciones sin `credentialRef` cuando exista contexto activo local y SHALL mantener override explícito por request cuando `credentialRef` esté presente.

#### Scenario: MCP usa contexto activo por defecto

- GIVEN una tool call sin `credentialRef` y con `activeUserId` válido
- WHEN el servidor resuelve autenticación
- THEN ejecuta la operación usando el usuario activo

#### Scenario: MCP respeta override explícito

- GIVEN una tool call con `credentialRef` explícito y `activeUserId` distinto
- WHEN el servidor resuelve autenticación
- THEN usa el `credentialRef` explícito por precedencia

### Requirement: Errores de auth tipados para herramientas MCP

El servidor MCP SHALL devolver errores estructurados ante auth inválida, incluyendo usuario inexistente y scopes insuficientes.

#### Scenario: Usuario inexistente

- GIVEN una tool call sin `credentialRef` y `activeUserId` no existente
- WHEN se inicializa la herramienta
- THEN devuelve error estructurado `AUTH_USER_NOT_FOUND`

#### Scenario: Scope insuficiente para mutación

- GIVEN credenciales válidas pero sin scope para operación solicitada
- WHEN se invoca la herramienta
- THEN devuelve error estructurado `AUTH_SCOPE_INSUFFICIENT`
