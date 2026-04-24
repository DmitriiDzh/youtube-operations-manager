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

La CLI SHALL emitir resultados estructurados y errores tipados consistentes para consumo programático, incluyendo errores de validación estricta con causa accionable cuando no exista idioma objetivo resoluble.

#### Scenario: Respuesta estructurada

- GIVEN una ejecución exitosa
- WHEN la CLI responde
- THEN la salida cumple el esquema de salida definido

#### Scenario: Error de validación de entrada

- GIVEN argumentos faltantes o inválidos
- WHEN se parsea la invocación
- THEN la CLI falla con mensaje accionable y código de salida no exitoso

### Requirement: Modo review/dry-run previo a mutaciones

La CLI MUST soportar modo review/dry-run para operaciones de update y MAY requerir confirmación explícita antes de aplicar; adicionalmente, la salida de review SHALL exponer un payload consistente con el contrato del core/API (before/proposed de snippet y locale objetivo) para automatización humana.

#### Scenario: Dry-run en update

- GIVEN comando de update con bandera de revisión
- WHEN se ejecuta la operación
- THEN la CLI muestra diff o propuesta de cambios
- AND no aplica mutaciones en YouTube

#### Scenario: Contrato estable entre review y apply

- GIVEN un mismo input de update ejecutado en dry-run y apply
- WHEN la CLI serializa el resultado
- THEN el shape de campos editoriales coincide con el contrato del core
- AND sólo cambia el estado de ejecución (revisión vs aplicado)

#### Scenario: Error por idioma no resoluble

- GIVEN un update con video sin `defaultLanguage` ni fallback de idioma
- WHEN la CLI ejecuta review o apply
- THEN devuelve error tipado con mensaje claro para corregir contexto
- AND el código de salida es no exitoso

### Requirement: Namespace `auth` para bootstrap e inspección

La CLI MUST exponer `auth login`, `auth whoami`, `auth list-users` y `auth logout` o `auth revoke` como comandos de primer nivel bajo `auth`.

#### Scenario: Login CLI exitoso

- GIVEN configuración OAuth válida y consentimiento del usuario
- WHEN se ejecuta `auth login`
- THEN la CLI confirma éxito en JSON estable y establece contexto activo

#### Scenario: Comando auth desconocido

- GIVEN un subcomando `auth` no soportado
- WHEN se parsea la invocación
- THEN la CLI responde error de validación estructurado y código no exitoso

### Requirement: Contrato JSON estable para comandos auth

La CLI SHALL validar estrictamente entrada/salida de `auth` y MUST devolver errores JSON con `code`, `message` y `details` serializables.

#### Scenario: Error por callback inválido

- GIVEN falla OAuth por callback inválido
- WHEN finaliza `auth login`
- THEN la CLI devuelve JSON con `code=AUTH_CALLBACK_INVALID` y mensaje accionable

#### Scenario: Error por refresh token ausente

- GIVEN operación auth detecta expiración sin `refresh_token`
- WHEN se necesita renovar token
- THEN la CLI devuelve JSON con `code=AUTH_REFRESH_TOKEN_MISSING`

### Requirement: Guardrail de canal activo antes de `apply`

La CLI MUST validar canal de escritura antes de `apply`, SHALL exigir `expectedChannelId` para la mutación y MUST fail-closed ante mismatch o canal no resoluble.

#### Scenario: Apply con canal válido

- GIVEN `expectedChannelId` coincide con el canal activo resuelto
- WHEN se ejecuta `apply`
- THEN la mutación continúa con flujo normal

#### Scenario: Apply rechazado por mismatch

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se ejecuta `apply`
- THEN la CLI devuelve error accionable de guardrail
- AND finaliza con exit code no exitoso

#### Scenario: Apply rechazado por canal no resoluble

- GIVEN `expectedChannelId` presente
- WHEN no puede resolverse canal activo de escritura
- THEN la CLI rechaza `apply`
- AND no ejecuta update remoto
