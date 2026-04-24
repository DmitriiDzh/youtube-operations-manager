# Apply Progress: localized-metadata-sync

## Mode

Standard (strict_tdd: false)

## Completed Tasks

- [x] 1.1 Extender `contracts.ts` con tipos semánticos para target language, review por locale y proposal interno.
- [x] 1.2 Actualizar `schemas.ts` con Zod 4 para validar salida enriquecida de apply/review.
- [x] 1.3 Adaptar `adapters/youtube-api.ts` al nuevo contrato sin flujo snippet-only.
- [x] 2.1 Implementar builder compartido de proposal en `services.ts`.
- [x] 2.2 Implementar resolución de idioma objetivo (defaultLanguage -> fallback único -> error bloqueante tipado).
- [x] 2.3 Modificar `youtube.ts` para fetch/update seguro con `part:["snippet","localizations"]`.
- [x] 2.4 Exponer `getVideoMetadataContext` y `applyMetadataProposal` en adapter YouTube.
- [x] 2.5 Garantizar paridad exacta de payload propuesto entre dryRun y apply.
- [x] 3.1 Mantener serialización CLI alineada al contrato enriquecido (sin drift).
- [x] 3.2 Mantener MCP `structuredContent` y errores tipados para idioma no resoluble.
- [x] 3.3 Verificar estabilidad de contrato entre review/apply en transport layers.
- [x] 4.1 Extender pruebas de servicios con tabla de resolución de idioma + paridad dryRun/apply.
- [x] 4.2 Agregar pruebas de preservación de localizations no objetivo y campos snippet no editoriales.
- [x] 4.3 Actualizar pruebas CLI para `targetLanguage`, `localizations.affected` y error tipado.
- [x] 4.4 Actualizar pruebas MCP para contrato enriquecido y error tipado.
- [x] 4.5 Documentar semántica nueva en README con ejemplo de payload.

## Verification

- ✅ `npm test`
- ✅ `npm run lint`
- ✅ `npx tsc --noEmit`

## Notes

- `dryRun` y `apply` ahora comparten exactamente la misma transformación (`buildMetadataSyncProposal`).
- El flujo bloquea con `target_language_unresolvable` cuando no hay idioma objetivo unívoco.
- Se preservan localizaciones no objetivo y campos snippet no editoriales; se omite `snippet.localized` en payload de update.

## Corrective Batch (verify warnings closure)

- ✅ Adapter apply alineado al source of truth del core: `applyMetadataProposal` consume `proposal.update` completo sin recalcular merge local.
- ✅ Paridad dryRun/apply explicitada en transportes con tests dedicados en CLI y MCP, comparando payloads y verificando que sólo cambia `dryRun`.
- ✅ Quality gates revalidados después del batch correctivo (`npm test`, `npm run lint`, `npx tsc --noEmit`).
