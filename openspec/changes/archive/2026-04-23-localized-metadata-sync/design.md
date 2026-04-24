# Design: Localized Metadata Sync

## Technical Approach

Centralizar el cálculo en un helper único que lea `snippet` + `localizations`, resuelva un `targetLanguage`, y produzca un `proposal` compartido por `dryRun` y `apply`. `dryRun` devolverá ese proposal tal cual; `apply` reutilizará el mismo objeto para armar `videos.update(part:["snippet","localizations"])` sin tocar traducciones fuera del locale objetivo.

## Architecture Decisions

| Decision | Options | Choice | Rationale |
|---|---|---|---|
| Resolver idioma objetivo | exigir `defaultLanguage`; inferir desde localizations; usar `snippet.localized` | Preferir `snippet.defaultLanguage`; fallback a única key de `localizations`; nunca usar `snippet.localized` sola | `localized` es read-only y no trae el código de idioma. Una única localization existente sí da contexto suficiente. Si no hay una resolución unívoca, el flujo falla con error accionable. |
| Payload común | construir `proposed` por separado en service y adapter; helper compartido | Helper compartido `buildMetadataSyncProposal` | Evita drift entre review y apply; un solo lugar decide `before`, `proposed` y `requestBody`. |
| Update remoto | actualizar sólo `snippet`; actualizar `snippet` + `localizations` merged | `videos.update` con `part:["snippet","localizations"]` y merge explícito | YouTube modela traducciones en `localizations`; mergear sobre el estado remoto completo preserva traducciones no objetivo. |
| Manejo de `defaultLanguage` faltante | bloquear siempre; inferir y no persistir; inferir y persistir | Inferir desde única localization existente y persistirlo en `snippet.defaultLanguage` | Convierte un estado ambiguo pero recuperable en uno determinista para futuras ediciones. |

## Data Flow

```text
applyMetadata
  └─ resolve credentials
     └─ youtubeApi.getVideoMetadataContext(videoId)
        └─ buildMetadataSyncProposal(remote, draft)
           ├─ dryRun: return review from proposal
           └─ apply: youtubeApi.applyMetadataProposal(proposal.update)
```

Sequence:

```text
Service -> YouTube adapter: fetch snippet + localizations
Adapter -> Proposal builder: resolve target language
Proposal builder -> Service: before/proposed/update payload
Service -> Adapter: apply only when dryRun=false
Adapter -> YouTube API: videos.update(snippet, localizations)
```

## File Changes

| File | Action | Description |
|---|---|---|
| `src/lib/video-metadata/services.ts` | Modify | Reemplazar el merge inline de dry-run por el proposal compartido; mapear error bloqueante cuando no haya idioma resoluble. |
| `src/lib/video-metadata/contracts.ts` | Modify | Agregar tipos semánticos para `targetLanguage`, `languageSource`, review por locale y proposal interno. |
| `src/lib/video-metadata/schemas.ts` | Modify | Validar el contrato enriquecido de apply/review con mapa de locales afectados y error details accionables. |
| `src/lib/video-metadata/adapters/youtube-api.ts` | Modify | Exponer lectura de contexto completo y apply basado en proposal, no en `title/description` sueltos. |
| `src/lib/youtube.ts` | Modify | Reemplazar helpers snippet-only por fetch/update seguros con `snippet.defaultLanguage` y `localizations`, omitiendo `snippet.localized` del request. |
| `src/cli/video-metadata.test.ts` | Modify | Afirmar que el JSON expone `targetLanguage` y diff por locale. |
| `src/mcp/server.test.ts` | Modify | Afirmar `structuredContent` alineado con el contrato enriquecido. |
| `src/lib/video-metadata/services.test.ts` | Modify | Cubrir resolución de idioma, dry-run/apply compartidos y preservación de localizations no objetivo. |

## Interfaces / Contracts

```ts
type LocaleMetadata = { title: string; description: string };

type MetadataLocaleReview = {
  locale: string;
  before: LocaleMetadata | null;
  proposed: LocaleMetadata;
  source: "defaultLanguage" | "existing-localization";
};

type MetadataApplyResult = {
  dryRun: boolean;
  videoId: string;
  targetLanguage: string;
  snippet: { before: Record<string, unknown>; proposed: Record<string, unknown> };
  localizations: {
    before: Record<string, LocaleMetadata>;
    proposed: Record<string, LocaleMetadata>;
    affected: MetadataLocaleReview[];
  };
};
```

`buildMetadataSyncProposal` devolverá además un `update` interno con `requestBody.id`, `requestBody.snippet`, y `requestBody.localizations`. `proposed.snippet` debe reflejar exactamente el mismo `defaultLanguage`, `title` y `description` que se enviarán en apply.

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Unit | Resolución de idioma objetivo | Tabla de casos: `defaultLanguage`, única localization, ambiguo, inexistente. |
| Unit | Proposal builder | Mismo `proposed` para dryRun y apply; merge preserva locales no objetivo. |
| Integration | Service apply/dryRun | `services.test.ts` con doubles del adapter verificando que dryRun no muta y apply usa el mismo proposal. |
| Integration | Transport contracts | CLI/MCP snapshots/assertions del output enriquecido. |

## Migration / Rollout

No migration required. Rollout recomendado: usar `dryRun` primero sobre videos con y sin localizations para validar el contrato enriquecido antes de aplicar en producción.

## Open Questions

- [ ] Confirmar si YouTube rechaza `localizations` cuando se persiste un `defaultLanguage` inferido por primera vez; el diseño asume que ese update es válido.
