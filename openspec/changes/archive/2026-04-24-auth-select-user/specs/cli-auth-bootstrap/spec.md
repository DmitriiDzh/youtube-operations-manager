# Delta for cli-auth-bootstrap

## MODIFIED Requirements

### Requirement: Comandos de inspección de identidad

El sistema MUST exponer `auth whoami`, `auth list-users` y `auth select-user --userId <ID>` con salida JSON estable y validación estricta. `auth select-user` SHALL actualizar únicamente el `activeUserId` local y MUST NOT cambiar la identidad OAuth remota.
(Previously: solo incluía `auth whoami` y `auth list-users`.)

#### Scenario: whoami con contexto activo

- GIVEN existe `activeUserId` y usuario persistido
- WHEN se ejecuta `auth whoami`
- THEN retorna JSON con `userId`, `email`, `scopes`, `hasRefreshToken`, `isActive`

#### Scenario: list-users multiusuario

- GIVEN existen múltiples usuarios en persistencia local
- WHEN se ejecuta `auth list-users`
- THEN retorna arreglo JSON estable con `isActive` por usuario

#### Scenario: select-user exitoso con persistencia local

- GIVEN existe un usuario local `B` y `activeUserId=A`
- WHEN se ejecuta `auth select-user --userId B`
- THEN el sistema persiste `activeUserId=B`
- AND retorna contrato estable con `activeUser`, `previousActiveUserId`, `changed`, `writeChannel` y `affectsRemoteOAuth=false`

#### Scenario: select-user falla por usuario inexistente

- GIVEN `userId` no existe en persistencia local
- WHEN se ejecuta `auth select-user`
- THEN falla con error estructurado `AUTH_USER_NOT_FOUND`
- AND no modifica el `activeUserId` previamente persistido
