# cli-auth-bootstrap Specification

## Purpose

Definir bootstrap OAuth desde CLI para crear, inspeccionar, seleccionar y revocar contexto autenticado reutilizable por CLI y MCP.

## Requirements

### Requirement: Login OAuth y persistencia de contexto

El sistema MUST soportar `auth login` (loopback default) y MAY soportar `auth login --device` como fallback headless. En login exitoso, SHALL persistir usuario, `access_token`, `refresh_token` (si existe), expiración y scopes; además MUST actualizar un contexto activo local con `activeUserId`.

#### Scenario: Login loopback exitoso

- GIVEN un usuario autoriza en browser y el callback OAuth es válido
- WHEN se completa `auth login`
- THEN se guardan tokens/scopes del usuario y se marca `activeUserId`

#### Scenario: Callback inválido

- GIVEN `state` inválido, `code` ausente o callback expirado
- WHEN termina `auth login`
- THEN falla con error estructurado `AUTH_CALLBACK_INVALID`

### Requirement: Comandos de inspección de identidad

El sistema MUST exponer `auth whoami`, `auth list-users` y `auth select-user --userId <ID>` con salida JSON estable y validación estricta. `auth select-user` SHALL actualizar únicamente el `activeUserId` local y MUST NOT cambiar la identidad OAuth remota.

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

### Requirement: Logout/Revoke y estados degradados

El sistema MUST soportar `auth logout` o `auth revoke` para revocar/desactivar contexto y SHALL reportar errores de auth accionables.

#### Scenario: Revocación exitosa

- GIVEN un usuario activo con token vigente
- WHEN se ejecuta `auth revoke`
- THEN se revoca remoto, se limpian tokens locales y se desactiva contexto

#### Scenario: Refresh token ausente

- GIVEN usuario sin `refresh_token` y access token expirado
- WHEN cualquier operación requiere renovación
- THEN falla con error estructurado `AUTH_REFRESH_TOKEN_MISSING` indicando re-login

### Requirement: Comandos explícitos de write channel

El sistema MUST exponer `write_channel_whoami` y `write_channel_select` para inspeccionar/persistir canal esperado. `write_channel_whoami` SHALL devolver `activeWriteChannel`, `selectedChannelId`, `effectiveCredentialRef` y `alignment.status` (`matched|mismatch|unresolved`) con `alignment.requiresReauth`. `write_channel_select` MUST validar `channelId` en borde y MUST NOT afirmar que cambió la sesión OAuth activa.

#### Scenario: Inspección alineada

- GIVEN `selectedChannelId` coincide con `activeWriteChannel.id`
- WHEN se ejecuta `write_channel_whoami`
- THEN la respuesta indica `alignment.status="matched"`
- AND `alignment.requiresReauth=false`

#### Scenario: Selección con mismatch

- GIVEN `activeWriteChannel.id=UC_B` y selección solicitada `UC_A`
- WHEN se ejecuta `write_channel_select`
- THEN persiste `selectedChannelId=UC_A` y retorna `alignment.status="mismatch"`
- AND incluye mensaje accionable de reauth

#### Scenario: Selección inválida

- GIVEN un `channelId` vacío o malformado
- WHEN se valida `write_channel_select`
- THEN falla con error estructurado de validación

### Requirement: Listado mínimo seguro de canales conocidos

El sistema MAY exponer `write_channel_list` con alcance mínimo seguro: devolver canales conocidos desde estado local (`activeWriteChannel` y/o `selectedChannelId`) y `source` (`active|stored`), sin prometer catálogo remoto completo.

#### Scenario: Listado mínimo sin catálogo remoto

- GIVEN existe canal activo y selección persistida
- WHEN se ejecuta `write_channel_list`
- THEN retorna solo entradas conocidas con `source`
- AND no declara cobertura completa de Brand Accounts
