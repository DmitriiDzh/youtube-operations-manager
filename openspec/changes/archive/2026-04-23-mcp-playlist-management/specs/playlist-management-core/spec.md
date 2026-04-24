# playlist-management-core Specification

## Purpose

Definir un core reusable para listar, crear y mutar playlists de YouTube desde web, CLI y MCP con contratos estables.

## Requirements

### Requirement: Casos de uso reutilizables de playlists

El sistema MUST exponer casos de uso `listPlaylists`, `createPlaylist`, `addVideosToPlaylist` y `removeVideosFromPlaylist` sin acoplarse al transporte (web/CLI/MCP).

#### Scenario: Listado reutilizable exitoso

- GIVEN credenciales resueltas válidas
- WHEN se ejecuta `listPlaylists`
- THEN se devuelve `playlists[]` con `id` y `title`

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
