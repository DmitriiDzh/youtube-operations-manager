# Skill Registry

**Delegator use only.** Sub-agents receive compact rules resolved by the delegator.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| READMEs, guides, technical docs | docs-writer | /Users/alanbuscaglia/.claude/skills/docs-writer/SKILL.md |
| Jokes/fun requests | chiste-argento | /Users/alanbuscaglia/.claude/skills/chiste-argento/SKILL.md |
| AI chat features with AI SDK 5 | ai-sdk-5 | /Users/alanbuscaglia/.claude/skills/ai-sdk-5/SKILL.md |
| Django REST Framework API work | django-drf | /Users/alanbuscaglia/.claude/skills/django-drf/SKILL.md |
| .NET / C# APIs | dotnet | /Users/alanbuscaglia/.claude/skills/dotnet/SKILL.md |
| Enterprise assessment/report deliverables | enterprise-report | /Users/alanbuscaglia/.config/opencode/skills/enterprise-report/SKILL.md |
| Bubbletea installer UI work | gentleman-bubbletea | /Users/alanbuscaglia/.claude/skills/gentleman-bubbletea/SKILL.md |
| Installer E2E (Docker) | gentleman-e2e | /Users/alanbuscaglia/.claude/skills/gentleman-e2e/SKILL.md |
| Installer flow changes | gentleman-installer | /Users/alanbuscaglia/.claude/skills/gentleman-installer/SKILL.md |
| System detection/command execution | gentleman-system | /Users/alanbuscaglia/.claude/skills/gentleman-system/SKILL.md |
| Vim Trainer RPG mechanics | gentleman-trainer | /Users/alanbuscaglia/.claude/skills/gentleman-trainer/SKILL.md |
| Go tests / teatest | go-testing | /Users/alanbuscaglia/.claude/skills/go-testing/SKILL.md |
| Homebrew release workflow | homebrew-release | /Users/alanbuscaglia/.claude/skills/homebrew-release/SKILL.md |
| GitHub issue creation workflow | issue-creation | /Users/alanbuscaglia/.claude/skills/issue-creation/SKILL.md |
| Jira epic creation | jira-epic | /Users/alanbuscaglia/.claude/skills/jira-epic/SKILL.md |
| Jira task/ticket creation | jira-task | /Users/alanbuscaglia/.claude/skills/jira-task/SKILL.md |
| Dual adversarial review | judgment-day | /Users/alanbuscaglia/.claude/skills/judgment-day/SKILL.md |
| Maintainer-style async communications | maintainer-voice | /Users/alanbuscaglia/.claude/skills/maintainer-voice/SKILL.md |
| Next.js 15 App Router | nextjs-15 | /Users/alanbuscaglia/.config/opencode/skills/nextjs-15/SKILL.md |
| Next.js 16 App Router | nextjs-16 | /Users/alanbuscaglia/.claude/skills/nextjs-16/SKILL.md |
| Playwright E2E testing | playwright | /Users/alanbuscaglia/.claude/skills/playwright/SKILL.md |
| PR / issue review workflows | pr-review | /Users/alanbuscaglia/.claude/skills/pr-review/SKILL.md |
| Pytest patterns | pytest | /Users/alanbuscaglia/.claude/skills/pytest/SKILL.md |
| React 19 patterns | react-19 | /Users/alanbuscaglia/.claude/skills/react-19/SKILL.md |
| Release notes shell safety | release-note-safety | /Users/alanbuscaglia/.claude/skills/release-note-safety/SKILL.md |
| Repo hardening and contribution gates | repo-hardening | /Users/alanbuscaglia/.claude/skills/repo-hardening/SKILL.md |
| Angular scope-rule architecture | scope-rule-architect-angular | /Users/alanbuscaglia/.claude/skills/angular/SKILL.md |
| Create new agent skills | skill-creator | /Users/alanbuscaglia/.claude/skills/skill-creator/SKILL.md |
| Presentation web slide decks | stream-deck | /Users/alanbuscaglia/.claude/skills/stream-deck/SKILL.md |
| Tailwind CSS 4 best practices | tailwind-4 | /Users/alanbuscaglia/.claude/skills/tailwind-4/SKILL.md |
| Technical/candidate exercise review | technical-review | /Users/alanbuscaglia/.claude/skills/technical-review/SKILL.md |
| TypeScript strict mode patterns | typescript | /Users/alanbuscaglia/.claude/skills/typescript/SKILL.md |
| Zod 4 schema validation | zod-4 | /Users/alanbuscaglia/.claude/skills/zod-4/SKILL.md |
| Zustand 5 state management | zustand-5 | /Users/alanbuscaglia/.claude/skills/zustand-5/SKILL.md |
| Backlog triage and disposition reports | backlog-triage | /Users/alanbuscaglia/.claude/skills/backlog-triage/SKILL.md |
| PR creation workflow | branch-pr | /Users/alanbuscaglia/.claude/skills/branch-pr/SKILL.md |

## Compact Rules

### nextjs-16
- Usar App Router como default (server-first).
- Preferir Route Handlers en `app/api/**/route.ts` para endpoints.
- Mantener mutaciones en Server Actions cuando aplique; evitar lógica crítica en cliente.
- Respetar convenciones de data fetching/caching de Next 16.
- Revisar docs locales en `node_modules/next/dist/docs/` ante dudas o cambios breaking.

### react-19
- Evitar memoización defensiva innecesaria; priorizar claridad.
- Mantener componentes server por defecto y marcar cliente sólo si hace falta.
- Efectos sólo para sync con sistemas externos, no para derivar estado trivial.
- Formularios/mutaciones: usar patrones modernos del ecosistema React 19.
- Mantener componentes chicos, orientados a responsabilidad única.

### typescript
- Mantener `strict` activo y evitar `any` salvo justificación explícita.
- Preferir tipos derivados e inferencia guiada en vez de tipos duplicados.
- Modelar contratos externos con tipos explícitos.
- Resolver nullability en bordes (API/DB/env), no en el core.
- Priorizar tipos de dominio semánticos sobre primitivas sueltas.

### tailwind-4
- Usar clases utilitarias consistentes con diseño existente.
- Evitar estilos inline si puede resolverse con utilidades.
- Mantener composición de clases legible y estable.
- No introducir convenciones de Tailwind legacy incompatibles con v4.
- Reutilizar patrones visuales ya presentes en componentes.

### zod-4
- Definir esquemas como fuente de verdad para entradas externas.
- Validar en bordes de API/comandos antes de ejecutar lógica.
- Derivar tipos TypeScript desde Zod para evitar drift.
- Devolver errores claros y accionables en parseo fallido.
- Evitar validación duplicada manual cuando ya existe schema.

### zustand-5
- Mantener stores pequeñas y orientadas por dominio.
- Evitar mega-stores globales sin segmentación.
- Encapsular acciones de negocio dentro del store.
- Minimizar acople UI↔estado (selectors y contratos claros).
- Evitar mutaciones accidentales fuera de acciones controladas.

### playwright
- Favorecer selectores estables y explícitos.
- Aplicar page objects para flujos complejos.
- Mantener tests E2E enfocados en comportamiento de usuario.
- Evitar asserts frágiles por timing; usar expectativas robustas.
- Aislar datos/estado para minimizar flakes.

### pytest
- Usar fixtures para setup compartido.
- Mantener tests chicos con intención clara.
- Separar unit/integration mediante markers.
- Mockear dependencias externas para tests deterministas.
- Nombrar tests por comportamiento esperado.

### docs-writer
- Aplicar pirámide invertida: primero el resultado clave.
- Escribir para escaneo (chunks, bullets, headings claros).
- Usar progressive disclosure (de simple a profundo).
- Evitar párrafos largos con baja densidad informativa.
- Priorizar claridad operacional sobre marketing.

### maintainer-voice
- Ser directo, concreto y basado en evidencia.
- Explicar decisiones con contexto técnico verificable.
- Dar feedback accionable, no ambiguo.
- Mantener tono colaborativo con estándares altos.
- Cerrar con próximos pasos claros.

### repo-hardening
- Definir contribution gates explícitos (templates, checks, policies).
- Estandarizar labels y estados de backlog.
- Configurar automatizaciones de higiene (stale/triage) con criterio.
- Documentar flujo de contribución y revisión.
- Evitar reglas ambiguas que no puedan automatizarse.

### branch-pr
- Preparar PR con contexto de cambios desde branch base.
- Redactar resumen orientado a impacto y alcance.
- Verificar estado remoto antes de crear PR.
- Mantener historial limpio y coherente con el cambio.
- Incluir riesgos, validaciones y pasos de revisión.

### issue-creation
- Definir problema, impacto y alcance verificables.
- Incluir criterios de aceptación claros.
- Separar hipótesis de hechos observables.
- Adjuntar contexto técnico mínimo reproducible.
- Evitar issues vagos sin resultado esperado.

### release-note-safety
- Escapar correctamente markdown/backticks en shell.
- Preferir heredoc para bodies multi-línea en `gh`.
- Evitar interpolaciones inseguras en comandos de release.
- Validar formato antes de publicar notas.
- Mantener release notes reproducibles y auditables.

### skill-creator
- Escribir skills con trigger claro y aplicable.
- Definir reglas accionables, no prosa motivacional.
- Incluir límites y anti-patterns explícitos.
- Mantener formato estándar de skill metadata.
- Priorizar instrucciones ejecutables por agentes.

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| CLAUDE.md | /Users/alanbuscaglia/work/youtube-playlist-manager/CLAUDE.md | Index — references files below |
| AGENTS.md | /Users/alanbuscaglia/work/youtube-playlist-manager/AGENTS.md | Referenced by CLAUDE.md |

Read the convention files listed above for project-specific patterns and rules.
