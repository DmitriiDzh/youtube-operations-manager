import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRedirectTarget, isSectionSubTab, rememberablePath, sectionHref, sectionOf } from "./section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the address rules, from the plan's address table and AC-RT-01/04.

test("AC-RT-04: /dashboard goes to Home; a Google Cloud OAuth result goes to Settings → API; every parameter is kept", () => {
  assert.equal(dashboardRedirectTarget({}), "/home");
  assert.equal(dashboardRedirectTarget({ tab: "x", a: ["1", "2"] }), "/home?tab=x&a=1&a=2");
  assert.equal(dashboardRedirectTarget({ cloudConnection: "error", cloudConnectionReason: "state mismatch" }), "/settings/api?cloudConnection=error&cloudConnectionReason=state+mismatch");
  assert.equal(dashboardRedirectTarget({ cloudConnection: "connected", skipped: undefined }), "/settings/api?cloudConnection=connected");
});

test("AC-RT-01: the sub-tab addresses of the plan's table are pages; anything else is not", () => {
  for (const sub of ["sessions", "jobs", "plans", "models", "templates", "setup"]) assert.ok(isSectionSubTab("production", sub), sub);
  for (const sub of ["overview", "content", "audience"]) assert.ok(isSectionSubTab("analytics", sub), sub);
  for (const sub of ["inbox", "channels", "videos", "discover", "topics"]) assert.ok(isSectionSubTab("research", sub), sub);
  for (const sub of ["general", "api", "channels", "ai-agent", "sync", "runpod", "about"]) assert.ok(isSectionSubTab("settings", sub), sub);
  assert.equal(isSectionSubTab("production", "nope"), false);
  assert.equal(isSectionSubTab("settings", "media"), false);
  assert.equal(isSectionSubTab("home", "sessions"), false);
  assert.equal(isSectionSubTab("production", "constructor"), false);
});

test("review finding: a sidebar item leads back to its section's last sub-tab; a path belongs to its section only", () => {
  const sections = ["/home", "/production", "/settings"];
  assert.equal(sectionOf("/production/plans/R-1/review", sections), "/production");
  assert.equal(sectionOf("/settings", sections), "/settings");
  assert.equal(sectionOf("/productionx", sections), null);
  assert.equal(sectionHref("/settings", { "/settings": "/settings/sync" }), "/settings/sync");
  assert.equal(sectionHref("/production", { "/settings": "/settings/sync" }), "/production");
});

// Re-review: a mistyped address must never become where the sidebar leads (it would lead back to a 404), and a plan review
// is remembered as Plans (the peer query is not in the path, and the sidebar must still lead out of the review).
test("only a real sub-tab address is remembered; a review counts as Plans; anything else is not remembered", () => {
  assert.deepEqual(rememberablePath("/settings/sync"), { section: "/settings", path: "/settings/sync" });
  assert.deepEqual(rememberablePath("/research/videos"), { section: "/research", path: "/research/videos" });
  assert.deepEqual(rememberablePath("/production/plans/R-0001/review"), { section: "/production", path: "/production/plans" });
  assert.equal(rememberablePath("/settings/bogus"), null);
  assert.equal(rememberablePath("/production/plans/x"), null);
  assert.equal(rememberablePath("/production/plans/x/review/more"), null);
  assert.equal(rememberablePath("/settings"), null);
  assert.equal(rememberablePath("/home"), null);
  assert.equal(rememberablePath("/merge/x"), null);
});
