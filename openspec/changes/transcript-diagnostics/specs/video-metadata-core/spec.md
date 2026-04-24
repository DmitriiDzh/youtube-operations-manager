# Delta for video-metadata-core

## MODIFIED Requirements

### Requirement: Obtener transcripción con ausencia explícita

El sistema MUST exponer una operación de transcript que devuelva contenido normalizado o ausencia explícita sin colapsar el flujo. Para `status=unavailable`, SHALL usar un contrato más expresivo (`reason` tipado + `diagnostic` opcional sanitizado). Para `status=unsupported`, SHALL devolver motivo tipado explícito. El contrato SHOULD preservar compatibilidad razonable con consumidores existentes manteniendo `status` estable y evitando campos sensibles en diagnóstico.
(Previously: El contrato distinguía transcript disponible/no disponible/unsupported pero con motivos acotados y sin diagnóstico estructurado.)

#### Scenario: Transcript disponible

- GIVEN un video con captions accesibles
- WHEN se solicita transcript por `videoId`
- THEN se devuelve transcript normalizado con estado `available`

#### Scenario: Transcript no disponible clasificado

- GIVEN un video sin captions, captions no descargables, permisos insuficientes, rate limit o error API
- WHEN se solicita transcript por `videoId`
- THEN se devuelve estado `unavailable` con `reason` tipado y específico
- AND `diagnostic` es opcional y sólo contiene campos sanitizados

#### Scenario: Provider de transcript no soportado

- GIVEN un entorno sin provider de transcript configurado o con capacidad deshabilitada
- WHEN se solicita transcript por `videoId`
- THEN se devuelve estado `unsupported` con motivo tipado explícito

## ADDED Requirements

### Requirement: Clasificación de errores de YouTube Captions API

El sistema MUST clasificar errores de `captions.list` y `captions.download` en categorías de dominio (`no-captions`, `captions-not-downloadable`, `permissions-insufficient`, `rate-limited`, `api-error`, `unknown`) y SHALL marcar recuperabilidad cuando sea inferible sin exponer datos sensibles.

#### Scenario: Error conocido de API mapeado

- GIVEN una respuesta de error de YouTube con código/razón reconocible
- WHEN se procesa el fallo de transcript
- THEN se asigna la categoría de dominio correspondiente
- AND el estado final permanece en `unavailable`

#### Scenario: Error no clasificable

- GIVEN un error sin código/razón clasificable
- WHEN se procesa el fallo de transcript
- THEN se usa categoría `unknown`

### Requirement: Validación estricta de input/output de transcript

El sistema MUST validar estrictamente entradas y salidas del caso de uso de transcript en sus bordes, y SHALL rechazar payloads fuera de esquema con errores tipados y accionables.

#### Scenario: Input inválido

- GIVEN un `videoId` ausente o inválido
- WHEN se invoca la operación de transcript
- THEN se rechaza la solicitud con error de validación tipado

#### Scenario: Output inválido del adapter

- GIVEN una respuesta de provider fuera del contrato de transcript
- WHEN se valida la salida
- THEN se rechaza la respuesta con error de validación tipado
