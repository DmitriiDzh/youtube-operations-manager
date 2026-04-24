# Delta for playlist-management-cli

## MODIFIED Requirements

### Requirement: Exposición del canal activo de escritura en CLI

La CLI SHALL exponer un comando read-only para inspeccionar el contexto de escritura y MUST incluir `activeWriteChannel.id`, `selectedChannelId`, `alignment.status` (`matched|mismatch|unresolved`), `alignment.requiresReauth` y `credentialRef` efectivo.
(Previously: solo exigía `activeWriteChannel.id`, `title?` y `credentialRef`.)

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

## ADDED Requirements

### Requirement: Selector explícito de canal esperado en CLI

La CLI MUST exponer `write_channel_select` con validación estricta de entrada y SHALL devolver estado de alineación resultante sin prometer cambio de sesión OAuth.

#### Scenario: Select con mismatch informado

- GIVEN el usuario selecciona un canal distinto del activo
- WHEN ejecuta `write_channel_select`
- THEN la CLI persiste `selectedChannelId` y devuelve `mismatch`
- AND entrega error/aviso accionable de reauth
