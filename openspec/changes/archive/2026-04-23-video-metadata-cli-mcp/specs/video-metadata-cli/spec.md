# video-metadata-cli Specification

## Purpose

Exponer el core de metadata de video mediante una CLI usable por humanos y automatizaciones.

## Requirements

### Requirement: Exponer operaciones del core por comandos CLI

La CLI MUST ofrecer comandos para listar videos, obtener transcript, generar metadata y actualizar metadata reutilizando los mismos contratos del core.

#### Scenario: Ejecución de comando de listado

- GIVEN credenciales resueltas y parámetros válidos
- WHEN el usuario ejecuta comando de listado
- THEN la CLI invoca el caso de uso equivalente del core
- AND devuelve salida compatible con automatización

### Requirement: Salida estable y validada

La CLI SHALL emitir resultados estructurados y errores tipados consistentes para consumo programático.

#### Scenario: Respuesta estructurada

- GIVEN una ejecución exitosa
- WHEN la CLI responde
- THEN la salida cumple el esquema de salida definido

#### Scenario: Error de validación de entrada

- GIVEN argumentos faltantes o inválidos
- WHEN se parsea la invocación
- THEN la CLI falla con mensaje accionable y código de salida no exitoso

### Requirement: Modo review/dry-run previo a mutaciones

La CLI MUST soportar modo review/dry-run para operaciones de update y MAY requerir confirmación explícita antes de aplicar.

#### Scenario: Dry-run en update

- GIVEN comando de update con bandera de revisión
- WHEN se ejecuta la operación
- THEN la CLI muestra diff o propuesta de cambios
- AND no aplica mutaciones en YouTube
