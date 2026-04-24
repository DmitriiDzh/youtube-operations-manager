# video-metadata-api Specification

## Purpose

Exponer transcript por Route Handlers con el mismo contrato del core para mantener consistencia entre API, CLI y MCP.

## Requirements

### Requirement: Contrato de transcript consistente en API

La API MUST devolver para transcript el mismo contrato semántico del core (`status=available|unavailable|unsupported`) con `reason` tipado, `diagnostic` opcional sanitizado en `unavailable`, y motivo tipado en `unsupported`.

#### Scenario: Respuesta unavailable en endpoint transcript

- GIVEN un request válido cuyo transcript falla en captions API
- WHEN el Route Handler responde
- THEN devuelve `status=unavailable` con `reason` clasificado
- AND incluye sólo diagnóstico sanitizado cuando aplique

#### Scenario: Respuesta unsupported en endpoint transcript

- GIVEN un request válido sin provider de transcript soportado
- WHEN el Route Handler responde
- THEN devuelve `status=unsupported` con motivo tipado

### Requirement: Validación estricta de bordes en API

La API SHALL validar request/response con esquemas estrictos y MUST devolver errores estructurados y accionables ante input/output inválido.

#### Scenario: Request inválido

- GIVEN un request con `videoId` inválido
- WHEN se valida la entrada del endpoint
- THEN la API rechaza con error de validación estructurado

#### Scenario: Response fuera de esquema

- GIVEN una salida interna de transcript fuera de contrato
- WHEN se valida antes de responder
- THEN la API rechaza la salida y devuelve error de validación tipado

### Requirement: Compatibilidad razonable para consumidores API

La API SHOULD preservar estabilidad del envelope y de `status` para consumidores existentes, y MAY introducir campos de diagnóstico sólo en forma aditiva y sanitizada.

#### Scenario: Cliente existente consume status estable

- GIVEN un cliente existente que procesa `status`
- WHEN recibe nuevos motivos/diagnóstico de transcript
- THEN su parseo base por `status` continúa funcionando
