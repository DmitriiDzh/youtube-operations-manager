# Delta for playlist-management-cli

## MODIFIED Requirements

### Requirement: Comandos CLI de playlists

La CLI MUST exponer comandos para listar, crear, actualizar, borrar, agregar videos y remover videos de playlists reutilizando casos de uso del core.
(Previously: no existía comando `playlist update`.)

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

### Requirement: Guardrail fail-closed para writes sensibles

La CLI MUST exigir `expectedChannelId` para `playlist create`, `playlist update` y `playlist delete`, y SHALL rechazar la operación cuando haya mismatch, canal no resoluble o ownership inválido en update.
(Previously: el guardrail sólo cubría `playlist create` y `playlist delete`.)

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

### Requirement: Validación estricta y errores claros

La CLI SHALL validar argumentos y payloads de entrada con schemas estrictos, MUST aceptar en update sólo `title?`, `description?`, `privacyStatus?` y MUST reportar error accionable cuando el patch no incluya campos mutables.
(Previously: no definía validación específica del patch de update.)

#### Scenario: Argumento inválido

- GIVEN un comando con argumentos mal formados
- WHEN la CLI parsea la invocación
- THEN responde error de validación estructurado y exit code no exitoso

#### Scenario: Patch vacío en update

- GIVEN `playlist update` sin `--title`, `--description` ni `--privacyStatus`
- WHEN la CLI valida la invocación
- THEN falla con error claro indicando que debe enviar al menos un campo mutable
