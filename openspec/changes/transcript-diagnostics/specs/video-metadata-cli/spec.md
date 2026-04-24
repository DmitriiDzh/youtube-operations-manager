# Delta for video-metadata-cli

## ADDED Requirements

### Requirement: Exposición consistente del contrato de transcript en CLI

La CLI MUST exponer para transcript el mismo contrato de `status` y `reason` del core, incluyendo `unavailable` con diagnóstico opcional sanitizado y `unsupported` tipado, sin mutar semántica entre interfaces.

#### Scenario: Transcript unavailable en CLI

- GIVEN un video cuyo transcript falla en captions API
- WHEN el usuario ejecuta el comando de transcript
- THEN la CLI devuelve `status=unavailable` con `reason` clasificado
- AND incluye `diagnostic` sólo con campos permitidos cuando exista

#### Scenario: Transcript unsupported en CLI

- GIVEN un entorno sin provider de transcript compatible
- WHEN el usuario ejecuta el comando de transcript
- THEN la CLI devuelve `status=unsupported` con motivo tipado

### Requirement: Compatibilidad razonable para consumidores CLI

La CLI SHOULD mantener estabilidad de envelope y `status` para automatizaciones existentes, y MAY agregar campos nuevos de transcript sólo de forma aditiva.

#### Scenario: Consumidor legacy interpreta salida

- GIVEN una automatización existente que consume `status`
- WHEN la CLI devuelve nuevos motivos de transcript
- THEN la automatización puede continuar usando `status` sin ruptura de envelope

### Requirement: Validación estricta de entrada/salida de transcript en CLI

La CLI SHALL validar input/output de transcript con esquemas estrictos y MUST devolver errores estructurados y accionables ante parseo fallido.

#### Scenario: Argumento inválido de transcript

- GIVEN una invocación con parámetros inválidos
- WHEN se parsea el comando
- THEN la CLI falla con error de validación estructurado y código no exitoso
