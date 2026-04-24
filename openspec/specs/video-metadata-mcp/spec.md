# video-metadata-mcp Specification

## Purpose

Exponer las capacidades del core como herramientas MCP para agentes externos sin desalinear contratos respecto de CLI.

## Requirements

### Requirement: Herramientas MCP equivalentes al core

El servidor MCP MUST publicar herramientas para listar videos, obtener transcript, generar metadata y actualizar metadata, usando exactamente los contratos del core.

#### Scenario: Invocación de herramienta de generación

- GIVEN una solicitud MCP válida con contexto y prompt editorial
- WHEN el agente invoca la herramienta de generación
- THEN la herramienta devuelve `finalTitle` y `description` según contrato del core

### Requirement: Validación estricta de entradas y salidas MCP

El servidor MCP SHALL validar payloads de entrada y salida con esquemas estrictos y MUST rechazar invocaciones inválidas con errores estructurados, incluyendo error accionable cuando no pueda resolverse idioma objetivo para sincronización localizada.

#### Scenario: Input MCP inválido

- GIVEN un payload sin campos requeridos
- WHEN se procesa la invocación
- THEN se rechaza la solicitud con error de validación estructurado

#### Scenario: Idioma objetivo no resoluble

- GIVEN una solicitud de update/review sin `defaultLanguage` ni fallback de idioma
- WHEN MCP valida la operación
- THEN devuelve error estructurado y accionable de validación
- AND no ejecuta mutación remota

### Requirement: Manejo de errores y control de mutación

Las herramientas MCP MUST devolver errores de dominio accionables y SHOULD soportar modo dry-run/review para updates cuando aplique; además, el payload de review/update SHALL reutilizar el mismo contrato enriquecido del core (before/proposed de snippet y locale objetivo) para mantener paridad con CLI/API.

#### Scenario: Update MCP en modo revisión

- GIVEN una solicitud de update con intención de revisión
- WHEN se ejecuta la herramienta
- THEN se devuelve propuesta de cambio validada por snippet y locale objetivo
- AND no se ejecuta mutación remota

#### Scenario: Paridad de contrato MCP con core

- GIVEN una operación de update/review válida
- WHEN MCP serializa la respuesta
- THEN los campos editoriales coinciden con el contrato del core
- AND el resultado es consistente con la salida esperada en CLI/API

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

### Requirement: Guardrail de canal activo antes de `apply`

El servidor MCP MUST validar canal de escritura antes de `apply`, SHALL exigir `expectedChannelId` y MUST fail-closed ante mismatch o canal no resoluble.

#### Scenario: Apply permitido con canal coincidente

- GIVEN `expectedChannelId` coincide con el canal activo
- WHEN el agente invoca `apply`
- THEN la operación continúa según contrato del core

#### Scenario: Apply bloqueado por mismatch

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `apply`
- THEN MCP devuelve error estructurado accionable
- AND no muta metadata en YouTube

#### Scenario: Apply bloqueado por canal no resoluble

- GIVEN `expectedChannelId` presente
- WHEN falla la resolución de canal activo
- THEN MCP rechaza la invocación
- AND responde error tipado consistente
