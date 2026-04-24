# Delta for youtube-credential-resolution

## MODIFIED Requirements

### Requirement: Precedencia de resolución entre referencia explícita y contexto activo

El sistema MUST resolver credenciales con precedencia estricta: `credentialRef` explícito > contexto activo implícito (`activeUserId`) > error accionable; para writes sensibles definidos por este cambio, además MUST resolver `activeWriteChannel.id` asociado a la credencial efectiva.
(Previously: sólo exigía precedencia de credenciales, sin resolución explícita de canal de escritura.)

#### Scenario: Referencia explícita tiene prioridad

- GIVEN existe `activeUserId=A` y la invocación incluye `credentialRef=B`
- WHEN se resuelven credenciales para una operación
- THEN el sistema usa `B` y no `A`

#### Scenario: Fallback a contexto activo

- GIVEN no se envía `credentialRef` y existe `activeUserId`
- WHEN se resuelven credenciales para `list`, `transcript`, `preview`, `apply`, operaciones de playlists o MCP
- THEN se usa el usuario activo sin requerir `--userId`

#### Scenario: Canal de escritura no resoluble en write sensible

- GIVEN credencial efectiva resuelta para una mutación sensible
- WHEN no puede resolverse `activeWriteChannel.id`
- THEN la resolución falla de forma tipada y accionable

## ADDED Requirements

### Requirement: Contrato explícito de mismatch de canal esperado

El sistema SHALL exponer error estructurado estable cuando `expectedChannelId` no coincida con `activeWriteChannel.id`, incluyendo ambos IDs en `details` para diagnóstico.

#### Scenario: Error estructurado por mismatch

- GIVEN `expectedChannelId=UC_A` y `activeWriteChannel.id=UC_B`
- WHEN se valida una mutación sensible
- THEN devuelve error tipado de guardrail
- AND `details` incluye `expectedChannelId` y `activeWriteChannelId`
