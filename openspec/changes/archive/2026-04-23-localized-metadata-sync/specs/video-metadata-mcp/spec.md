# Delta for video-metadata-mcp

## MODIFIED Requirements

### Requirement: Manejo de errores y control de mutación

Las herramientas MCP MUST devolver errores de dominio accionables y SHOULD soportar modo dry-run/review para updates cuando aplique; además, el payload de review/update SHALL reutilizar el mismo contrato enriquecido del core (before/proposed de snippet y locale objetivo) para mantener paridad con CLI/API.
(Previously: sólo exigía propuesta validada en revisión sin contrato enriquecido ni paridad explícita entre canales.)

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

### Requirement: Validación estricta de entradas y salidas MCP

El servidor MCP SHALL validar payloads de entrada y salida con esquemas estrictos y MUST rechazar invocaciones inválidas con errores estructurados, incluyendo error accionable cuando no pueda resolverse idioma objetivo para sincronización localizada.
(Previously: exigía validación estricta general sin contemplar explícitamente el caso de idioma no resoluble.)

#### Scenario: Input MCP inválido

- GIVEN un payload sin campos requeridos
- WHEN se procesa la invocación
- THEN se rechaza la solicitud con error de validación estructurado

#### Scenario: Idioma objetivo no resoluble

- GIVEN una solicitud de update/review sin `defaultLanguage` ni fallback de idioma
- WHEN MCP valida la operación
- THEN devuelve error estructurado y accionable de validación
- AND no ejecuta mutación remota
