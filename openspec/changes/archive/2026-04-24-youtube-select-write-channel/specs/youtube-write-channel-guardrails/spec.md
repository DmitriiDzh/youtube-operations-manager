# Delta for youtube-write-channel-guardrails

## ADDED Requirements

### Requirement: Estado de alineación entre canal esperado y canal OAuth activo

El sistema MUST evaluar `alignment.status` con contrato estable: `matched` (esperado=activo), `mismatch` (esperado≠activo), `unresolved` (faltan datos para decidir). El sistema SHALL exponer `alignment.requiresReauth=true` cuando exista `mismatch` y MUST mantener fail-closed en writes sensibles.

#### Scenario: Alineación matched

- GIVEN `expectedChannelId=UC_A` y `activeWriteChannel.id=UC_A`
- WHEN se evalúa contexto de escritura
- THEN `alignment.status="matched"`
- AND los writes sensibles pueden continuar

#### Scenario: Alineación mismatch requiere reauth

- GIVEN `expectedChannelId=UC_A` y `activeWriteChannel.id=UC_B`
- WHEN se valida un write sensible
- THEN se rechaza la mutación sin efectos remotos
- AND el error incluye guía explícita de reauth

#### Scenario: Alineación unresolved

- GIVEN falta `expectedChannelId` efectivo o no se resolvió canal activo
- WHEN se evalúa el contexto
- THEN `alignment.status="unresolved"`
- AND el sistema conserva bloqueo fail-closed para writes sensibles
