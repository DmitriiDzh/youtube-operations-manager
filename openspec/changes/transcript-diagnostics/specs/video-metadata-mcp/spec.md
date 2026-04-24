# Delta for video-metadata-mcp

## ADDED Requirements

### Requirement: Exposición consistente del contrato de transcript en MCP

El servidor MCP MUST devolver en herramientas de transcript el mismo contrato del core (`status`, `reason`, diagnóstico opcional sanitizado para `unavailable`, motivo tipado para `unsupported`) sin reinterpretaciones por canal.

#### Scenario: Transcript unavailable en MCP

- GIVEN una tool call válida cuyo transcript falla por captions API
- WHEN se procesa la herramienta
- THEN se devuelve `status=unavailable` con `reason` clasificado
- AND `diagnostic` es opcional y sanitizado

#### Scenario: Transcript unsupported en MCP

- GIVEN una tool call en entorno sin provider soportado
- WHEN se procesa la herramienta
- THEN se devuelve `status=unsupported` con motivo tipado

### Requirement: Validación estricta de payloads transcript en MCP

El servidor MCP SHALL validar payloads de entrada/salida de transcript con esquemas estrictos y MUST rechazar payloads inválidos con error estructurado.

#### Scenario: Payload de transcript inválido

- GIVEN una invocación MCP de transcript con campos inválidos
- WHEN se valida el request o response
- THEN se rechaza con error de validación estructurado y accionable

### Requirement: Compatibilidad razonable para clientes MCP

El servidor MCP SHOULD mantener estabilidad de envelope y semántica de `status` para clientes existentes, y MAY extender transcript con campos aditivos sin romper parseo básico.

#### Scenario: Cliente existente con parseo por status

- GIVEN un cliente MCP existente que ramifica por `status`
- WHEN recibe nuevos motivos de transcript
- THEN el flujo base permanece operativo sin cambios obligatorios
