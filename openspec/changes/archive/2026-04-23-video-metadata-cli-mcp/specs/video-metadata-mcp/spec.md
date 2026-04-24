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

El servidor MCP SHALL validar payloads de entrada y salida con esquemas estrictos y MUST rechazar invocaciones inválidas con errores estructurados.

#### Scenario: Input MCP inválido

- GIVEN un payload sin campos requeridos
- WHEN se procesa la invocación
- THEN se rechaza la solicitud con error de validación estructurado

### Requirement: Manejo de errores y control de mutación

Las herramientas MCP MUST devolver errores de dominio accionables y SHOULD soportar modo dry-run/review para updates cuando aplique.

#### Scenario: Update MCP en modo revisión

- GIVEN una solicitud de update con intención de revisión
- WHEN se ejecuta la herramienta
- THEN se devuelve propuesta de cambio validada
- AND no se ejecuta mutación remota
