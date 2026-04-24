# youtube-credential-resolution Specification

## Purpose

Definir resolución segura de credenciales de YouTube fuera del contexto web para permitir ejecución confiable desde CLI y MCP.

## Requirements

### Requirement: Resolución de credenciales fuera de sesión web

El sistema MUST resolver credenciales sin depender de `getServerSession` y SHALL entregar un contexto de autenticación utilizable por el core.

#### Scenario: Resolución exitosa para adapter no-web

- GIVEN ejecución desde CLI o MCP con fuente de credenciales configurada
- WHEN se inicializa el contexto de auth
- THEN se devuelve un contexto válido para llamadas de YouTube API

### Requirement: Verificación de permisos y scopes requeridos

El sistema MUST validar que las credenciales incluyan scopes necesarios para lectura y mutaciones de metadata y playlists.

#### Scenario: Scopes insuficientes

- GIVEN credenciales sin permisos para la operación solicitada
- WHEN se intenta iniciar una operación de update de metadata o mutación de playlists
- THEN se rechaza con error de autorización tipado y accionable

### Requirement: Manejo robusto de renovación y fallas de auth

El sistema SHOULD manejar renovación de token cuando corresponda y MUST propagar fallas de auth en formato de error de dominio consistente.

#### Scenario: Token expirado sin renovación posible

- GIVEN un token expirado y renovación fallida
- WHEN se ejecuta cualquier caso de uso del core
- THEN la operación falla con error de autenticación consistente para CLI y MCP

### Requirement: Precedencia de resolución entre referencia explícita y contexto activo

El sistema MUST resolver credenciales con precedencia estricta: `credentialRef` explícito > contexto activo implícito (`activeUserId`) > error accionable. El `activeUserId` implícito SHALL ser el último seleccionado localmente por login o `select-user`, y MUST afectar solo el fallback sin `credentialRef`. Para writes sensibles definidos por este cambio, además MUST resolver `activeWriteChannel.id` asociado a la credencial efectiva. El cambio de usuario activo MUST NOT mutar identidad OAuth remota, scopes ni sesión de terceros.

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

### Requirement: Contrato explícito de mismatch de canal esperado

El sistema SHALL exponer error estructurado estable cuando `expectedChannelId` no coincida con `activeWriteChannel.id`, incluyendo ambos IDs en `details` para diagnóstico.

#### Scenario: Error estructurado por mismatch

- GIVEN `expectedChannelId=UC_A` y `activeWriteChannel.id=UC_B`
- WHEN se valida una mutación sensible
- THEN devuelve error tipado de guardrail
- AND `details` incluye `expectedChannelId` y `activeWriteChannelId`

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

### Requirement: Errores de resolución de auth para contexto local

El sistema SHALL devolver errores tipados y estables para fallas comunes de auth en resolución/renovación.

#### Scenario: Usuario inexistente en contexto activo

- GIVEN `activeUserId` apunta a un usuario no persistido
- WHEN se intenta resolver credenciales
- THEN falla con error estructurado `AUTH_USER_NOT_FOUND`

#### Scenario: Scopes insuficientes

- GIVEN credenciales resueltas sin scopes requeridos para la operación
- WHEN se inicia la operación
- THEN falla con error estructurado `AUTH_SCOPE_INSUFFICIENT`
