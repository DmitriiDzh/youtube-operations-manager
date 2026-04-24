# Delta for youtube-credential-resolution

## MODIFIED Requirements

### Requirement: Precedencia de resolución entre referencia explícita y contexto activo

El sistema MUST resolver credenciales con precedencia estricta: `credentialRef` explícito > contexto activo implícito (`activeUserId`) > error accionable. El `activeUserId` implícito SHALL ser el último seleccionado localmente por login o `select-user`, y MUST afectar solo el fallback sin `credentialRef`. Para writes sensibles definidos por este cambio, además MUST resolver `activeWriteChannel.id` asociado a la credencial efectiva. El cambio de usuario activo MUST NOT mutar identidad OAuth remota, scopes ni sesión de terceros.
(Previously: definía la precedencia explícita > `activeUserId` sin especificar de forma explícita el origen/semántica de `activeUserId` seleccionado.)

#### Scenario: Referencia explícita tiene prioridad

- GIVEN existe `activeUserId=A` y la invocación incluye `credentialRef=B`
- WHEN se resuelven credenciales para una operación
- THEN el sistema usa `B` y no `A`

#### Scenario: Fallback a contexto activo

- GIVEN no se envía `credentialRef` y existe `activeUserId`
- WHEN se resuelven credenciales para `list`, `transcript`, `preview`, `apply`, operaciones de playlists o MCP
- THEN se usa el usuario activo sin requerir `--userId`

#### Scenario: Cambio de usuario activo actualiza fallback implícito

- GIVEN `activeUserId` cambia localmente de `A` a `B` mediante selección explícita
- WHEN una operación CLI o MCP se ejecuta sin `credentialRef`
- THEN la resolución usa `B` como identidad efectiva
- AND conserva intacta cualquier identidad OAuth remota existente

#### Scenario: Canal de escritura no resoluble en write sensible

- GIVEN credencial efectiva resuelta para una mutación sensible
- WHEN no puede resolverse `activeWriteChannel.id`
- THEN la resolución falla de forma tipada y accionable
