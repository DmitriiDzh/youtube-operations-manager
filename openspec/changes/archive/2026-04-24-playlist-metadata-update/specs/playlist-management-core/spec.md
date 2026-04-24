# Delta for playlist-management-core

## MODIFIED Requirements

### Requirement: Casos de uso reutilizables de playlists

El sistema MUST exponer casos de uso `listPlaylists`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `addVideosToPlaylist` y `removeVideosFromPlaylist` sin acoplarse al transporte (web/CLI/MCP).
(Previously: no existía `updatePlaylist` y el listado devolvía sólo `id`/`title`.)

#### Scenario: Listado reutilizable exitoso

- GIVEN credenciales resueltas válidas
- WHEN se ejecuta `listPlaylists`
- THEN se devuelve `playlists[]` con `id`, `title`, `description` y `privacyStatus`

#### Scenario: Update reutilizable exitoso

- GIVEN `playlistId` válido y un patch con al menos un campo mutable
- WHEN se ejecuta `updatePlaylist`
- THEN el core devuelve la playlist actualizada serializable con metadata completa

#### Scenario: Delete reutilizable exitoso

- GIVEN `playlistId` válido y autorización vigente
- WHEN se ejecuta `deletePlaylist`
- THEN el core devuelve resultado exitoso serializable

### Requirement: Guardrail de canal para writes sensibles de playlists

El core MUST exigir `expectedChannelId` para `createPlaylist`, `updatePlaylist` y `deletePlaylist`, SHALL resolver `activeWriteChannel.id` para la credencial efectiva, MUST validar ownership de la playlist antes de `updatePlaylist` y MUST fail-closed ante mismatch o canal no resoluble.
(Previously: el guardrail sólo aplicaba a `createPlaylist` y `deletePlaylist`, sin ownership preflight para update.)

#### Scenario: Mismatch bloquea update

- GIVEN `expectedChannelId` distinto al canal activo resuelto
- WHEN se ejecuta `updatePlaylist`
- THEN la operación falla sin mutar playlist
- AND devuelve error tipado y accionable

#### Scenario: Mismatch bloquea create

- GIVEN `expectedChannelId` distinto al canal activo resuelto
- WHEN se ejecuta `createPlaylist`
- THEN la operación falla sin crear playlist
- AND devuelve error tipado y accionable

#### Scenario: Canal no resoluble bloquea delete

- GIVEN `expectedChannelId` presente y canal activo no resoluble
- WHEN se ejecuta `deletePlaylist`
- THEN la operación se rechaza
- AND no se invoca mutación remota

#### Scenario: Ownership inválido bloquea update

- GIVEN `expectedChannelId` válido pero la playlist pertenece a otro canal
- WHEN se valida preflight de ownership para `updatePlaylist`
- THEN la operación se rechaza
- AND no se invoca mutación remota

### Requirement: Validación estricta y errores claros

El sistema MUST validar entradas/salidas externas con schemas estrictos, SHALL aceptar en update sólo patch `title?`, `description?`, `privacyStatus?`, MUST exigir al menos un campo mutable en el patch y SHALL devolver errores tipados con mensaje accionable ante parseo o contrato inválido.
(Previously: no definía reglas explícitas de patch para update de playlist.)

#### Scenario: Payload inválido

- GIVEN una solicitud con campos faltantes o tipos incorrectos
- WHEN se valida la entrada
- THEN el core rechaza con error estructurado de validación

#### Scenario: Patch vacío en update

- GIVEN una solicitud `updatePlaylist` sin `title`, `description` ni `privacyStatus`
- WHEN se valida la entrada
- THEN el core rechaza con error claro indicando que requiere al menos un campo mutable
