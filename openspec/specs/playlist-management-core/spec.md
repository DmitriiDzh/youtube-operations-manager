# playlist-management-core Specification

## Purpose

Definir un core reusable para listar, crear, actualizar y mutar playlists de YouTube desde web, CLI y MCP con contratos estables.

## Requirements

### Requirement: Casos de uso reutilizables de playlists

El sistema MUST exponer casos de uso `listPlaylists`, `createPlaylist`, `updatePlaylist`, `deletePlaylist`, `addVideosToPlaylist` y `removeVideosFromPlaylist` sin acoplarse al transporte (web/CLI/MCP).

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

#### Scenario: Mismatch bloquea create

- GIVEN `expectedChannelId` distinto al canal activo resuelto
- WHEN se ejecuta `createPlaylist`
- THEN la operación falla sin crear playlist
- AND devuelve error tipado y accionable

#### Scenario: Mismatch bloquea update

- GIVEN `expectedChannelId` distinto al canal activo resuelto
- WHEN se ejecuta `updatePlaylist`
- THEN la operación falla sin mutar playlist
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

### Requirement: Validación estricta de inputs de delete y guardrail

El sistema MUST validar estrictamente `playlistId`, `expectedChannelId` y envelopes de salida; SHALL devolver errores estructurados de validación cuando el parseo falle y SHALL aceptar en update sólo patch `title?`, `description?`, `privacyStatus?` con al menos un campo mutable.

#### Scenario: Input inválido para delete

- GIVEN `playlistId` vacío o `expectedChannelId` inválido
- WHEN se valida la entrada
- THEN el core responde error de validación claro

#### Scenario: Patch vacío en update

- GIVEN una solicitud `updatePlaylist` sin `title`, `description` ni `privacyStatus`
- WHEN se valida la entrada
- THEN el core rechaza con error claro indicando que requiere al menos un campo mutable

### Requirement: Resolución de auth por referencia explícita o contexto activo

El core SHALL aceptar `credentialRef` opcional y MUST operar con precedencia estricta `credentialRef` explícito > contexto activo local > error tipado.

#### Scenario: Override explícito

- GIVEN `activeUserId=A` y request con `credentialRef=B`
- WHEN se resuelve auth para cualquier operación de playlist
- THEN el core usa `B` como credencial efectiva

#### Scenario: Sin referencia ni contexto

- GIVEN request sin `credentialRef` y sin `activeUserId`
- WHEN se resuelve auth
- THEN falla con error estructurado y accionable

### Requirement: Contrato estable para resultados parciales en add/remove

Las operaciones de mutación MUST devolver resultados agregados estables con conteos de intento y éxito, y SHALL incluir detalle de fallas por item cuando existan.

#### Scenario: Add con éxito parcial

- GIVEN `videoIds` con al menos un item inválido o no procesable
- WHEN se ejecuta `addVideosToPlaylist`
- THEN la respuesta incluye `attempted`, `added` y `failures[]` por `videoId`

#### Scenario: Remove con éxito parcial

- GIVEN `videoIds` mixtos para remoción
- WHEN se ejecuta `removeVideosFromPlaylist`
- THEN la respuesta incluye `requested`, `removed` y `failures[]` por `videoId`

### Requirement: Validación estricta y errores claros

El sistema MUST validar entradas/salidas externas con schemas estrictos y SHALL devolver errores tipados con mensaje accionable ante parseo o contrato inválido.

#### Scenario: Payload inválido

- GIVEN una solicitud con campos faltantes o tipos incorrectos
- WHEN se valida la entrada
- THEN el core rechaza con error estructurado de validación
