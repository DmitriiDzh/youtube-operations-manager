# Delta for youtube-credential-resolution

## ADDED Requirements

### Requirement: Contrato accionable de desalineación para selección persistida

El sistema SHALL propagar errores estructurados y estables cuando `selectedChannelId` no coincida con `activeWriteChannel.id`. En `mismatch`, MUST incluir `requiresReauth=true`, IDs de diagnóstico y `recommendedAction` explícita; en `unresolved`, MUST indicar qué dato falta o qué resolución de auth falló.

#### Scenario: Mismatch con acción de reauth

- GIVEN credencial efectiva válida y `selectedChannelId=UC_A` con activo `UC_B`
- WHEN se resuelve contexto para mutación sensible
- THEN retorna error tipado de guardrail con ambos IDs
- AND `recommendedAction` indica reloguear con el canal esperado

#### Scenario: Unresolved por auth local degradada

- GIVEN no existe contexto activo válido o falla resolución del canal activo
- WHEN se prepara una operación sensible
- THEN retorna error tipado `unresolved` accionable
- AND el mensaje explica el siguiente paso (login/select)

### Requirement: Validación estricta en bordes de resolución

El sistema MUST validar entradas externas de resolución (`credentialRef`, `expectedChannelId`, `selectedChannelId`) con schemas estrictos y SHALL devolver errores claros de parseo sin ejecutar lógica de dominio.

#### Scenario: credentialRef inválido

- GIVEN una entrada de `credentialRef` con formato inválido
- WHEN se valida la solicitud
- THEN la resolución falla con error estructurado de validación
- AND no intenta llamadas remotas de YouTube
