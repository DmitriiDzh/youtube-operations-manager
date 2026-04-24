## Exploration: localized-metadata-sync

### Current State
Hoy el flujo de apply/dryRun arma el `proposed` haciendo merge del snippet actual y sólo pisa `title`/`description`.

- En `dryRun`, `applyMetadata` hace:
  - `before = getVideoSnippet(...)`
  - `proposed = { ...before, title, description }`
- En `apply`, `updateVideoSnippetSafe` hace:
  - `mergedSnippet = { ...currentSnippet, title, description }`
  - `videos.update(part:["snippet"], snippet: mergedSnippet)`

Esto preserva `snippet.localized` tal como viene de YouTube (stale si ya existía), por eso `proposed.localized.title/description` puede quedar viejo mientras `proposed.title/description` cambia.

Además, en los tipos de Google API usados por el proyecto, `snippet.localized` aparece como **read-only**; el recurso de video expone `localizations` como parte separada. Entonces confiar en mutar sólo `snippet` no garantiza consistencia con lo que muestra Studio para idiomas por defecto/localizados (ej. `defaultLanguage = es-419`).

### Affected Areas
- `src/lib/video-metadata/services.ts` — dryRun construye `proposed` localmente y hoy no sincroniza metadata localizada.
- `src/lib/youtube.ts` — `updateVideoSnippetSafe` actualiza únicamente `part:["snippet"]`.
- `src/lib/video-metadata/adapters/youtube-api.ts` — puente apply que hoy delega en `updateVideoSnippetSafe`.
- `src/lib/video-metadata/services.test.ts` — cobertura dryRun/apply existe, pero no contempla casos con `defaultLanguage` + localized/localizations.
- `openspec/specs/video-metadata-core/spec.md` — requirement de safe update/dry-run no explicita sincronización de localized.
- `README.md` — checklist manual actual dice “safe update: only title/description”, que puede inducir una expectativa incompleta para videos localizados.

### Approaches
1. **Parche mínimo en snippet.localized (sin tocar localizations)** — en dryRun/apply, además de title/description, reflejar también `snippet.localized.title/description` cuando exista.
   - Pros: cambio chico y rápido; corrige parcialmente la discrepancia visible en payload.
   - Cons: riesgo alto de falso positivo funcional: `snippet.localized` es read-only en API y puede no persistir en vivo; no alinea de forma robusta con Studio.
   - Effort: Low.

2. **Sincronización explícita de idioma por defecto vía localizations + propuesta unificada** — mantener update de snippet y agregar sincronización del registro localizado del `defaultLanguage` en `localizations`; usar la misma función de construcción de `proposed` para dryRun y apply.
   - Pros: consistente con el modelo de YouTube para contenido localizado; dryRun refleja mejor lo que se aplicará; reduce drift entre CLI/MCP y estado real.
   - Cons: más superficie (lectura/escritura de `localizations`, manejo de casos sin `defaultLanguage`, posibles conflictos con localizaciones manuales existentes).
   - Effort: Medium.

### Recommendation
Ir con **Approach 2 (mínimo viable controlado)**:

1. Mantener la semántica actual de safe update (no tocar campos no editoriales fuera de localización objetivo).
2. Definir una regla explícita: cuando exista `defaultLanguage` (ej. `es-419`), `finalTitle/description` también deben sincronizarse en la localización de ese idioma.
3. Centralizar el cálculo de `before/proposed` en una sola ruta compartida por `dryRun` y `apply`, para que ambos muestren exactamente la misma transformación.
4. Cubrir con tests de contrato el caso reportado (`defaultLanguage + localized/localizations`) y el caso sin localización.

Esto mantiene el cambio acotado al bug real (drift entre title/description y localized) sin rediseñar todo el dominio de internacionalización.

### Risks
- **Semántica de YouTube no trivial**: `snippet.localized` vs `localizations` pueden divergir; un mapping incorrecto puede simular consistencia en dryRun pero no en vivo.
- **Sobrescritura no deseada**: si hay traducciones manuales en otros idiomas, hay que evitar tocar localizaciones fuera del idioma objetivo.
- **Compatibilidad de consumidores**: payloads de revisión podrían incluir más campos/sincronizaciones y romper supuestos implícitos en herramientas externas.
- **Cobertura insuficiente**: sin tests con fixtures localizados reales, el bug puede reaparecer aunque pase el set actual.

### Ready for Proposal
Yes — listo para `sdd-propose` con alcance mínimo: sincronización de metadata localizada para idioma por defecto + unificación dryRun/apply del cálculo de `proposed`.
