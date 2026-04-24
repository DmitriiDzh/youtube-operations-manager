# Delta for video-metadata-cli

## ADDED Requirements

### Requirement: Guardrail de canal activo antes de `apply`

La CLI MUST validar canal de escritura antes de `apply`, SHALL exigir `expectedChannelId` para la mutación y MUST fail-closed ante mismatch o canal no resoluble.

#### Scenario: Apply con canal válido

- GIVEN `expectedChannelId` coincide con el canal activo resuelto
- WHEN se ejecuta `apply`
- THEN la mutación continúa con flujo normal

#### Scenario: Apply rechazado por mismatch

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se ejecuta `apply`
- THEN la CLI devuelve error accionable de guardrail
- AND finaliza con exit code no exitoso

#### Scenario: Apply rechazado por canal no resoluble

- GIVEN `expectedChannelId` presente
- WHEN no puede resolverse canal activo de escritura
- THEN la CLI rechaza `apply`
- AND no ejecuta update remoto
