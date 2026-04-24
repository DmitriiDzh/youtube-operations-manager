# Delta for playlist-management-cli

## MODIFIED Requirements

### Requirement: Comandos CLI de playlists

La CLI MUST exponer comandos para listar, crear, borrar, agregar videos y remover videos de playlists reutilizando casos de uso del core.
(Previously: no exponía borrado de playlist.)

#### Scenario: Listado por CLI

- GIVEN credenciales válidas y parámetros correctos
- WHEN el usuario ejecuta comando de listado de playlists
- THEN la CLI invoca `listPlaylists` y devuelve salida estructurada

#### Scenario: Delete por CLI

- GIVEN `playlistId` y `expectedChannelId` válidos
- WHEN el usuario ejecuta `playlist delete`
- THEN la CLI invoca `deletePlaylist` y devuelve resultado serializable

## ADDED Requirements

### Requirement: Exposición del canal activo de escritura en CLI

La CLI SHALL exponer un comando read-only para inspeccionar el canal activo de escritura y MUST incluir `activeWriteChannel.id`, `title?` y `credentialRef` efectivo.

#### Scenario: Inspección de contexto de escritura

- GIVEN credenciales resolubles
- WHEN el usuario consulta contexto de escritura
- THEN recibe `activeWriteChannel.id`
- AND la salida es JSON estable

### Requirement: Guardrail fail-closed para writes sensibles

La CLI MUST exigir `expectedChannelId` para `playlist create` y `playlist delete`, y SHALL rechazar la operación cuando haya mismatch o canal no resoluble.

#### Scenario: Mismatch de canal en create

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se ejecuta `playlist create`
- THEN CLI responde error accionable
- AND finaliza con exit code no exitoso

#### Scenario: Canal no resoluble en delete

- GIVEN `playlist delete` con `expectedChannelId`
- WHEN no puede resolverse el canal activo
- THEN CLI falla sin mutación remota
- AND devuelve error estructurado claro
