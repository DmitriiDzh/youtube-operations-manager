# Delta for youtube-credential-resolution

## MODIFIED Requirements

### Requirement: Verificación de permisos y scopes requeridos

El sistema MUST validar que las credenciales incluyan scopes necesarios para lectura y mutaciones de metadata y playlists.
(Previously: validaba scopes sólo para operaciones de metadata)

#### Scenario: Scopes insuficientes

- GIVEN credenciales sin permisos para la operación solicitada
- WHEN se intenta iniciar una operación de update de metadata o mutación de playlists
- THEN se rechaza con error de autorización tipado y accionable

### Requirement: Precedencia de resolución entre referencia explícita y contexto activo

El sistema MUST resolver credenciales con precedencia estricta: `credentialRef` explícito > contexto activo implícito (`activeUserId`) > error accionable.
(Previously: la precedencia estaba definida para list/transcript/preview/apply y MCP de video metadata)

#### Scenario: Referencia explícita tiene prioridad

- GIVEN existe `activeUserId=A` y la invocación incluye `credentialRef=B`
- WHEN se resuelven credenciales para una operación
- THEN el sistema usa `B` y no `A`

#### Scenario: Fallback a contexto activo

- GIVEN no se envía `credentialRef` y existe `activeUserId`
- WHEN se resuelven credenciales para `list`, `transcript`, `preview`, `apply`, operaciones de playlists o MCP
- THEN se usa el usuario activo sin requerir `--userId`

#### Scenario: Playlist sin referencia explícita ni contexto activo

- GIVEN no se envía `credentialRef` y no existe `activeUserId`
- WHEN se resuelven credenciales para `playlist_list`, `playlist_create`, `playlist_add_videos` o `playlist_remove_videos`
- THEN el sistema falla con error estructurado y accionable de resolución auth
