# playlist-management-cli Specification

## Purpose

Exponer operaciones de playlists en CLI para uso humano y automatización, en paridad contractual con el core/MCP.

## Requirements

### Requirement: Comandos CLI de playlists

La CLI MUST exponer comandos para listar, crear, agregar videos y remover videos de playlists reutilizando casos de uso del core.

#### Scenario: Listado por CLI

- GIVEN credenciales válidas y parámetros correctos
- WHEN el usuario ejecuta comando de listado de playlists
- THEN la CLI invoca `listPlaylists` y devuelve salida estructurada

### Requirement: Resolución de auth para CLI

La CLI SHALL aceptar `credentialRef` explícito y MUST aplicar precedencia `credentialRef` > contexto activo local > error accionable.

#### Scenario: CLI usa contexto activo

- GIVEN comando sin `credentialRef` y `activeUserId` válido
- WHEN se ejecuta la operación
- THEN la CLI usa el usuario activo

#### Scenario: CLI falla sin fuente de credenciales

- GIVEN comando sin `credentialRef` y sin contexto activo
- WHEN se intenta resolver auth
- THEN la CLI devuelve error tipado y código de salida no exitoso

### Requirement: Salida JSON estable para resultados parciales

La CLI MUST emitir resultados serializables y estables para add/remove con `attempted/requested`, `added/removed` y `failures[]` cuando haya éxito parcial.

#### Scenario: Add parcial en CLI

- GIVEN `videoIds` con combinación de éxitos y fallas
- WHEN se ejecuta comando de add
- THEN la salida JSON conserva el contrato parcial estable

#### Scenario: Remove parcial en CLI

- GIVEN `videoIds` con combinación de éxitos y fallas
- WHEN se ejecuta comando de remove
- THEN la salida JSON conserva el contrato parcial estable

### Requirement: Validación estricta y errores claros

La CLI SHALL validar argumentos y payloads de entrada con schemas estrictos y MUST reportar errores accionables de parseo/validación.

#### Scenario: Argumento inválido

- GIVEN un comando con argumentos mal formados
- WHEN la CLI parsea la invocación
- THEN responde error de validación estructurado y exit code no exitoso
