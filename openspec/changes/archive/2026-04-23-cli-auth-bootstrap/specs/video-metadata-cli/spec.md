# Delta for video-metadata-cli

## ADDED Requirements

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
