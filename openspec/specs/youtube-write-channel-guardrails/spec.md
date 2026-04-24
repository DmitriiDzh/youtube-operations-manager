# youtube-write-channel-guardrails Specification

## Purpose

Definir un guardrail de canal activo de escritura para mutaciones no-web (CLI/MCP), evitando writes en canal incorrecto.

## Requirements

### Requirement: Resolución y exposición del canal activo de escritura

El sistema MUST resolver `activeWriteChannel` para la credencial efectiva y SHALL exponerlo en superficies read-only de CLI/MCP con `id`, `title?` y `credentialRef` efectivo (sin secretos).

#### Scenario: Contexto de escritura disponible

- GIVEN credenciales válidas y canal resoluble
- WHEN se consulta el contexto de escritura
- THEN se devuelve `activeWriteChannel.id`
- AND la respuesta incluye `title` cuando esté disponible

### Requirement: Fail-closed en canal no resoluble

El sistema MUST NOT ejecutar mutaciones sensibles cuando no pueda resolver `activeWriteChannel.id` y SHALL responder error tipado y accionable.

#### Scenario: Canal no resoluble

- GIVEN una operación sensible de write
- WHEN la resolución de canal falla o retorna vacío
- THEN la mutación se rechaza
- AND el error indica cómo seleccionar/corregir el canal activo

### Requirement: Validación estricta de canal esperado

El sistema MUST exigir `expectedChannelId` en writes sensibles definidos por este cambio y SHALL rechazar la operación si `expectedChannelId !== activeWriteChannel.id`.

#### Scenario: Mismatch de canal esperado

- GIVEN `expectedChannelId=UC_A` y `activeWriteChannel.id=UC_B`
- WHEN se intenta una mutación sensible
- THEN la operación falla sin efectos remotos
- AND el error incluye ambos IDs para diagnóstico

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
