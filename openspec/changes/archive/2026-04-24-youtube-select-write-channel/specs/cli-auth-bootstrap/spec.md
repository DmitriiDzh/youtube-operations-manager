# Delta for cli-auth-bootstrap

## ADDED Requirements

### Requirement: Comandos explícitos de write channel

El sistema MUST exponer `write_channel_whoami` y `write_channel_select` para inspeccionar/persistir canal esperado. `write_channel_whoami` SHALL devolver `activeWriteChannel`, `selectedChannelId`, `effectiveCredentialRef` y `alignment.status` (`matched|mismatch|unresolved`) con `alignment.requiresReauth`. `write_channel_select` MUST validar `channelId` en borde y MUST NOT afirmar que cambió la sesión OAuth activa.

#### Scenario: Inspección alineada

- GIVEN `selectedChannelId` coincide con `activeWriteChannel.id`
- WHEN se ejecuta `write_channel_whoami`
- THEN la respuesta indica `alignment.status="matched"`
- AND `alignment.requiresReauth=false`

#### Scenario: Selección con mismatch

- GIVEN `activeWriteChannel.id=UC_B` y selección solicitada `UC_A`
- WHEN se ejecuta `write_channel_select`
- THEN persiste `selectedChannelId=UC_A` y retorna `alignment.status="mismatch"`
- AND incluye mensaje accionable de reauth

#### Scenario: Selección inválida

- GIVEN un `channelId` vacío o malformado
- WHEN se valida `write_channel_select`
- THEN falla con error estructurado de validación

### Requirement: Listado mínimo seguro de canales conocidos

El sistema MAY exponer `write_channel_list` con alcance mínimo seguro: devolver canales conocidos desde estado local (`activeWriteChannel` y/o `selectedChannelId`) y `source` (`active|stored`), sin prometer catálogo remoto completo.

#### Scenario: Listado mínimo sin catálogo remoto

- GIVEN existe canal activo y selección persistida
- WHEN se ejecuta `write_channel_list`
- THEN retorna solo entradas conocidas con `source`
- AND no declara cobertura completa de Brand Accounts
