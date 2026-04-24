# Delta for video-metadata-core

## MODIFIED Requirements

### Requirement: Actualizar título y descripción sin pérdida de snippet

El sistema MUST actualizar `title` y `description` del snippet y, cuando exista idioma objetivo resoluble, MUST sincronizar esos mismos valores en `localizations` del idioma objetivo; además SHALL preservar campos de snippet remoto y localizaciones no objetivo sin cambios.
(Previously: solo exigía actualizar `title`/`description` preservando el resto del snippet.)

#### Scenario: Update preservando campos

- GIVEN un snippet actual con múltiples campos
- WHEN se aplica update de metadata editorial
- THEN se actualizan `title` y `description` en snippet
- AND todos los otros campos del snippet permanecen sin cambios

#### Scenario: Sincronización de localización objetivo

- GIVEN un video con `defaultLanguage` resoluble y `localizations` existentes
- WHEN se aplica update editorial
- THEN el locale objetivo refleja el mismo `title`/`description` final que snippet
- AND las localizaciones de idiomas no objetivo no se modifican

### Requirement: Validación estricta y dry-run/review

El sistema MUST validar entradas y salidas en bordes con esquemas estrictos y SHOULD soportar modo dry-run/review antes de aplicar cambios remotos; además, para updates localizados, dry-run MUST usar exactamente la misma transformación de payload que apply y SHALL fallar con error tipado y accionable cuando no se pueda resolver idioma objetivo (`defaultLanguage`/fallback).
(Previously: sólo requería validación estricta y dry-run sin exigir paridad exacta con apply ni error por idioma no resoluble.)

#### Scenario: Modo dry-run

- GIVEN una solicitud de actualización con `dryRun=true`
- WHEN se ejecuta el flujo de update
- THEN se devuelve vista de revisión before/proposed por snippet y locale objetivo
- AND no se persiste ninguna mutación remota

#### Scenario: Error por idioma no resoluble

- GIVEN un video sin `defaultLanguage` ni idioma objetivo derivable
- WHEN se solicita review o apply de metadata
- THEN se rechaza la operación con error tipado y mensaje accionable
- AND no se ejecuta mutación remota
