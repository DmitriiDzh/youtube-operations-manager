// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the section's layout renders the sub-tab (its sub-tabs stay mounted and are
// only hidden, so switching never reloads them); this page only gives the sub-tab its address. BL-184: it exists as a file because
// `storyboards/[storyboardId]` makes `storyboards` a static folder, which the `[sub]` page no longer answers for.
export default function SubTabPage() {
  return null;
}
