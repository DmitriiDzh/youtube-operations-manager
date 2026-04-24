# Delta for playlist-management-core

## MODIFIED Requirements

### Requirement: Casos de uso reutilizables de playlists

El sistema MUST exponer casos de uso `listPlaylists`, `createPlaylist`, `deletePlaylist`, `addVideosToPlaylist` y `removeVideosFromPlaylist` sin acoplarse al transporte (web/CLI/MCP).
(Previously: no incluía `deletePlaylist`.)

#### Scenario: Listado reutilizable exitoso

- GIVEN credenciales resueltas válidas
- WHEN se ejecuta `listPlaylists`
- THEN se devuelve `playlists[]` con `id` y `title`

#### Scenario: Delete reutilizable exitoso

- GIVEN `playlistId` válido y autorización vigente
- WHEN se ejecuta `deletePlaylist`
- THEN el core devuelve resultado exitoso serializable

## ADDED Requirements

### Requirement: Guardrail de canal para writes sensibles de playlists

El core MUST exigir `expectedChannelId` para `createPlaylist` y `deletePlaylist`, SHALL resolver `activeWriteChannel.id` para la credencial efectiva y MUST fail-closed ante mismatch o canal no resoluble.

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

### Requirement: Validación estricta de inputs de delete y guardrail

El sistema MUST validar estrictamente `playlistId`, `expectedChannelId` y envelopes de salida; SHALL devolver errores estructurados de validación cuando el parseo falle.

#### Scenario: Input inválido para delete

- GIVEN `playlistId` vacío o `expectedChannelId` inválido
- WHEN se valida la entrada
- THEN el core responde error de validación claro
