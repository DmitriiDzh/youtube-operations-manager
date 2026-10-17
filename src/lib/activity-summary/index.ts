// BL-195 stage D: the Activity centre's summary. Pure -- the sources (other feature modules' own reads) are wired in by the
// route (`src/app/api/activity/route.ts`), so no feature module is imported from here (AGENTS.md §M; e.g. live-streams'
// boundaries test allows no `src/lib` module to import it).
export * from "./contracts";
export { createActivitySummary, type ActivityDeps, type ActivityMediaJob, type ActivityOperation, type ActivityStream, type ActivityUpload } from "./services";
