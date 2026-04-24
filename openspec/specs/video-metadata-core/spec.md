# video-metadata-core Specification

## Purpose

Definir un core reutilizable para listar videos, leer transcripciones, generar metadata editorial y actualizar snippet de YouTube sin depender de contexto web.

## Requirements

### Requirement: Listar videos del canal objetivo

El sistema MUST exponer un caso de uso para listar videos del canal configurado y devolver una colección tipada con campos mínimos de identificación y metadata editorial.

#### Scenario: Listado exitoso

- GIVEN credenciales válidas y canal objetivo resoluble
- WHEN se ejecuta la operación de listado
- THEN se devuelve una lista tipada de videos del canal
- AND cada item incluye identificador de video y campos necesarios para edición

#### Scenario: Error de acceso al canal

- GIVEN credenciales inválidas o sin permisos
- WHEN se ejecuta la operación de listado
- THEN se devuelve un error de dominio tipado y accionable

### Requirement: Obtener transcripción con ausencia explícita

El sistema MUST exponer una operación de transcript que devuelva contenido normalizado o ausencia explícita sin colapsar el flujo.

#### Scenario: Transcript disponible

- GIVEN un video con captions accesibles
- WHEN se solicita transcript por `videoId`
- THEN se devuelve transcript normalizado con estado `available`

#### Scenario: Transcript no disponible

- GIVEN un video sin captions o no accesibles
- WHEN se solicita transcript por `videoId`
- THEN se devuelve estado `unavailable` con motivo tipado
- AND el flujo editorial permanece habilitado con fallback definido

#### Scenario: Provider de transcript no soportado

- GIVEN un entorno sin provider de transcript configurado
- WHEN se solicita transcript por `videoId`
- THEN se devuelve estado `unsupported` con motivo tipado
- AND el flujo editorial permanece habilitado con fallback definido

### Requirement: Generar metadata editorial única

El sistema MUST generar exactamente un `finalTitle` y una `description` usando el prompt editorial provisto por el usuario, y SHALL rechazar salidas ambiguas o inválidas.

#### Scenario: Generación válida

- GIVEN contexto de video y prompt editorial válido
- WHEN se ejecuta la generación
- THEN se devuelve un único `finalTitle` y una única `description` válidos

#### Scenario: Salida inválida del modelo

- GIVEN respuesta del modelo fuera de contrato
- WHEN se valida la salida
- THEN se rechaza la respuesta con error de validación tipado

### Requirement: Actualizar título y descripción sin pérdida de snippet

El sistema MUST actualizar `title` y `description` del snippet y, cuando exista idioma objetivo resoluble, MUST sincronizar esos mismos valores en `localizations` del idioma objetivo; además SHALL preservar campos de snippet remoto y localizaciones no objetivo sin cambios.

#### Scenario: Update preservando campos

- GIVEN un snippet actual con múltiples campos
- WHEN se aplica update de metadata editorial
- THEN se actualizan únicamente `title` y `description`
- AND todos los otros campos del snippet permanecen sin cambios

#### Scenario: Sincronización de localización objetivo

- GIVEN un video con `defaultLanguage` resoluble y `localizations` existentes
- WHEN se aplica update editorial
- THEN el locale objetivo refleja el mismo `title`/`description` final que snippet
- AND las localizaciones de idiomas no objetivo no se modifican

### Requirement: Validación estricta y dry-run/review

El sistema MUST validar entradas y salidas en bordes con esquemas estrictos y SHOULD soportar modo dry-run/review antes de aplicar cambios remotos; además, para updates localizados, dry-run MUST usar exactamente la misma transformación de payload que apply y SHALL fallar con error tipado y accionable cuando no se pueda resolver idioma objetivo (`defaultLanguage`/fallback).

#### Scenario: Modo dry-run

- GIVEN una solicitud de actualización con `dryRun=true`
- WHEN se ejecuta el flujo de update
- THEN se devuelve vista de revisión de cambios propuestos
- AND no se persiste ninguna mutación remota

#### Scenario: Error por idioma no resoluble

- GIVEN un video sin `defaultLanguage` ni idioma objetivo derivable
- WHEN se solicita review o apply de metadata
- THEN se rechaza la operación con error tipado y mensaje accionable
- AND no se ejecuta mutación remota
