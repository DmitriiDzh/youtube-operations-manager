# Delta for youtube-credential-resolution

## ADDED Requirements

### Requirement: Precedencia de resolución entre referencia explícita y contexto activo

El sistema MUST resolver credenciales con precedencia estricta: `credentialRef` explícito > contexto activo implícito (`activeUserId`) > error accionable.

#### Scenario: Referencia explícita tiene prioridad

- GIVEN existe `activeUserId=A` y la invocación incluye `credentialRef=B`
- WHEN se resuelven credenciales para una operación
- THEN el sistema usa `B` y no `A`

#### Scenario: Fallback a contexto activo

- GIVEN no se envía `credentialRef` y existe `activeUserId`
- WHEN se resuelven credenciales para `list`, `transcript`, `preview`, `apply` o MCP
- THEN se usa el usuario activo sin requerir `--userId`

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
