# Delta for video-metadata-mcp

## ADDED Requirements

### Requirement: Guardrail de canal activo antes de `apply`

El servidor MCP MUST validar canal de escritura antes de `apply`, SHALL exigir `expectedChannelId` y MUST fail-closed ante mismatch o canal no resoluble.

#### Scenario: Apply permitido con canal coincidente

- GIVEN `expectedChannelId` coincide con el canal activo
- WHEN el agente invoca `apply`
- THEN la operación continúa según contrato del core

#### Scenario: Apply bloqueado por mismatch

- GIVEN `expectedChannelId` distinto al canal activo
- WHEN se invoca `apply`
- THEN MCP devuelve error estructurado accionable
- AND no muta metadata en YouTube

#### Scenario: Apply bloqueado por canal no resoluble

- GIVEN `expectedChannelId` presente
- WHEN falla la resolución de canal activo
- THEN MCP rechaza la invocación
- AND responde error tipado consistente
