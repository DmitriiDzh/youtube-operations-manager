# playlist-management-cli Specification

## Purpose

Exponer operaciones de playlists en CLI para uso humano y automatización, en paridad contractual con el core/MCP.

## Requirements

### Requirement: Comandos CLI de playlists

La CLI MUST exponer comandos para listar, crear, actualizar, borrar, agregar videos y remover videos de playlists reutilizando casos de uso del core.

#### Scenario: Listado por CLI

- GIVEN credenciales válidas y parámetros correctos
- WHEN el usuario ejecuta comando de listado de playlists
- THEN la CLI invoca `listPlaylists` y devuelve `id`, `title`, `description` y `privacyStatus`

#### Scenario: Update por CLI

- GIVEN `playlistId`, `expectedChannelId` y un patch válido
- WHEN el usuario ejecuta `playlist update`
- THEN la CLI invoca `updatePlaylist` y devuelve playlist actualizada serializable

#### Scenario: Delete por CLI

- GIVEN `playlistId` y `expectedChannelId` válidos
- WHEN el usuario ejecuta `playlist delete`
- THEN la CLI invoca `deletePlaylist` y devuelve resultado serializable

### Requirement: Exposición del canal activo de escritura en CLI

La CLI SHALL exponer un comando read-only para inspeccionar el contexto de escritura y MUST incluir `activeWriteChannel.id`, `selectedChannelId`, `alignment.status` (`matched|mismatch|unresolved`), `alignment.requiresReauth` y `credentialRef` efectivo.

#### Scenario: Inspección de contexto de escritura

- GIVEN credenciales resolubles
- WHEN el usuario consulta contexto de escritura
- THEN recibe `activeWriteChannel.id`
- AND la salida es JSON estable

#### Scenario: Contexto desalineado

- GIVEN `selectedChannelId` distinto del canal activo
- WHEN el usuario consulta contexto de escritura
- THEN la respuesta indica `alignment.status="mismatch"`
- AND el mensaje explica que requiere reauth para habilitar writes

### Requirement: Selector explícito de canal esperado en CLI

La CLI MUST exponer `write_channel_select` con validación estricta de entrada y SHALL devolver estado de alineación resultante sin prometer cambio de sesión OAuth.

#### Scenario: Select con mismatch informado

- GIVEN el usuario selecciona un canal distinto del activo
- WHEN ejecuta `write_channel_select`
- THEN la CLI persiste `selectedChannelId` y devuelve `mismatch`
- AND entrega error/aviso accionable de reauth

### Requirement: Guardrail fail-closed para writes sensibles

La CLI MUST exigir `expectedChannelId` para `playlist create`, `playlist update` y `playlist delete`, y SHALL rechazar la operación cuando haya mismatch, canal no resoluble o ownership inválido en update.

#### Scenario: Mismatch de canal en create

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se ejecuta `playlist create`
- THEN CLI responde error accionable
- AND finaliza con exit code no exitoso

#### Scenario: Mismatch de canal en update

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se ejecuta `playlist update`
- THEN CLI responde error accionable
- AND finaliza con exit code no exitoso

#### Scenario: Ownership inválido en update

- GIVEN `expectedChannelId` válido pero playlist fuera de ownership
- WHEN se ejecuta `playlist update`
- THEN CLI falla sin mutación remota
- AND devuelve error estructurado claro

#### Scenario: Canal no resoluble en delete

- GIVEN `playlist delete` con `expectedChannelId`
- WHEN no puede resolverse el canal activo
- THEN CLI falla sin mutación remota
- AND devuelve error estructurado claro

### Requirement: Resolución de auth para CLI

La CLI SHALL aceptar `credentialRef` explícito y MUST aplicar precedencia `credentialRef` > contexto activo local > error accionable.

#### Scenario: CLI usa contexto activo

- GIVEN comando sin `credentialRef` y `activeUserId` válido
- WHEN se ejecuta la operación
- THEN la CLI usa el usuario activo

#### Scenario: CLI falla sin fuente de credenciales

- GIVEN comando sin `credentialRef` y sin contexto activo
- WHEN se intenta resolver auth
- THEN la CLI devuelve error tipado y código de salida no exitoso

### Requirement: Salida JSON estable para resultados parciales

La CLI MUST emitir resultados serializables y estables para add/remove con `attempted/requested`, `added/removed` y `failures[]` cuando haya éxito parcial.

#### Scenario: Add parcial en CLI

- GIVEN `videoIds` con combinación de éxitos y fallas
- WHEN se ejecuta comando de add
- THEN la salida JSON conserva el contrato parcial estable

#### Scenario: Remove parcial en CLI

- GIVEN `videoIds` con combinación de éxitos y fallas
- WHEN se ejecuta comando de remove
- THEN la salida JSON conserva el contrato parcial estable

### Requirement: Validación estricta y errores claros

La CLI SHALL validar argumentos y payloads de entrada con schemas estrictos y MUST aceptar en update sólo `title?`, `description?`, `privacyStatus?` y MUST reportar error accionable cuando el patch no incluya campos mutables.

#### Scenario: Argumento inválido

- GIVEN un comando con argumentos mal formados
- WHEN la CLI parsea la invocación
- THEN responde error de validación estructurado y exit code no exitoso

#### Scenario: Patch vacío en update

- GIVEN `playlist update` sin `--title`, `--description` ni `--privacyStatus`
- WHEN la CLI valida la invocación
- THEN falla con error claro indicando que debe enviar al menos un campo mutable
