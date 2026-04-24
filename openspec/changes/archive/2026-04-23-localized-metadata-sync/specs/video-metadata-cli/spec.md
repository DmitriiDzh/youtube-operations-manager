# Delta for video-metadata-cli

## MODIFIED Requirements

### Requirement: Modo review/dry-run previo a mutaciones

La CLI MUST soportar modo review/dry-run para operaciones de update y MAY requerir confirmación explícita antes de aplicar; adicionalmente, la salida de review SHALL exponer un payload consistente con el contrato del core/API (before/proposed de snippet y locale objetivo) para automatización humana.
(Previously: sólo exigía mostrar diff o propuesta de cambios sin definir contrato por locale ni consistencia cross-channel.)

#### Scenario: Dry-run en update

- GIVEN comando de update con bandera de revisión
- WHEN se ejecuta la operación
- THEN la CLI muestra payload estructurado de review por snippet y locale objetivo
- AND no aplica mutaciones en YouTube

#### Scenario: Contrato estable entre review y apply

- GIVEN un mismo input de update ejecutado en dry-run y apply
- WHEN la CLI serializa el resultado
- THEN el shape de campos editoriales coincide con el contrato del core
- AND sólo cambia el estado de ejecución (revisión vs aplicado)

### Requirement: Salida estable y validada

La CLI SHALL emitir resultados estructurados y errores tipados consistentes para consumo programático, incluyendo errores de validación estricta con causa accionable cuando no exista idioma objetivo resoluble.
(Previously: exigía salida estructurada y errores tipados sin caso explícito de validación por idioma.)

#### Scenario: Respuesta estructurada

- GIVEN una ejecución exitosa
- WHEN la CLI responde
- THEN la salida cumple el esquema de salida definido

#### Scenario: Error de validación de entrada

- GIVEN argumentos faltantes o inválidos
- WHEN se parsea la invocación
- THEN la CLI falla con mensaje accionable y código de salida no exitoso

#### Scenario: Error por idioma no resoluble

- GIVEN un update con video sin `defaultLanguage` ni fallback de idioma
- WHEN la CLI ejecuta review o apply
- THEN devuelve error tipado con mensaje claro para corregir contexto
- AND el código de salida es no exitoso
