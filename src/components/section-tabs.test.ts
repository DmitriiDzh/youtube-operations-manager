import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRedirectTarget, isSectionSubTab, productionRedirectTarget, rememberablePath, sectionHref, sectionOf } from "./section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the address rules, from the plan's address table and AC-RT-01/04.

test("AC-RT-04: /dashboard goes to Home; a Google Cloud OAuth result goes to Settings → API; every parameter is kept", () => {
  assert.equal(dashboardRedirectTarget({}), "/home");
  assert.equal(dashboardRedirectTarget({ tab: "x", a: ["1", "2"] }), "/home?tab=x&a=1&a=2");
  assert.equal(dashboardRedirectTarget({ cloudConnection: "error", cloudConnectionReason: "state mismatch" }), "/settings/api?cloudConnection=error&cloudConnectionReason=state+mismatch");
  assert.equal(dashboardRedirectTarget({ cloudConnection: "connected", skipped: undefined }), "/settings/api?cloudConnection=connected");
});

test("AC-RT-01: the sub-tab addresses of the plan's table are pages; anything else is not", () => {
  // BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01): Production's sub-tabs are now Servers' and Media's.
  for (const sub of ["sessions", "models", "templates", "setup"]) assert.ok(isSectionSubTab("servers", sub), sub);
  for (const sub of ["plans", "jobs"]) assert.ok(isSectionSubTab("media", sub), sub);
  assert.equal(isSectionSubTab("servers", "plans"), false);
  assert.equal(isSectionSubTab("media", "sessions"), false);
  assert.equal(isSectionSubTab("production", "sessions"), false, "Production is no longer a section (its addresses redirect)");
  for (const sub of ["overview", "content", "audience"]) assert.ok(isSectionSubTab("analytics", sub), sub);
  for (const sub of ["inbox", "channels", "videos", "discover", "topics"]) assert.ok(isSectionSubTab("research", sub), sub);
  for (const sub of ["general", "api", "channels", "ai-agent", "sync", "runpod", "gemini", "about"]) assert.ok(isSectionSubTab("settings", sub), sub);
  assert.equal(isSectionSubTab("media", "nope"), false);
  assert.equal(isSectionSubTab("settings", "media"), false);
  assert.equal(isSectionSubTab("home", "sessions"), false);
  assert.equal(isSectionSubTab("media", "constructor"), false);
});

test("review finding: a sidebar item leads back to its section's last sub-tab; a path belongs to its section only", () => {
  const sections = ["/home", "/media", "/servers", "/settings"];
  assert.equal(sectionOf("/media/plans/R-1/review", sections), "/media");
  assert.equal(sectionOf("/settings", sections), "/settings");
  assert.equal(sectionOf("/mediax", sections), null);
  assert.equal(sectionHref("/settings", { "/settings": "/settings/sync" }), "/settings/sync");
  assert.equal(sectionHref("/media", { "/settings": "/settings/sync" }), "/media");
});

// Re-review: a mistyped address must never become where the sidebar leads (it would lead back to a 404), and a plan review
// is remembered as Plans (the peer query is not in the path, and the sidebar must still lead out of the review).
test("only a real sub-tab address is remembered; a review counts as Plans; anything else is not remembered", () => {
  assert.deepEqual(rememberablePath("/settings/sync"), { section: "/settings", path: "/settings/sync" });
  assert.deepEqual(rememberablePath("/research/videos"), { section: "/research", path: "/research/videos" });
  assert.deepEqual(rememberablePath("/media/plans/R-0001/review"), { section: "/media", path: "/media/plans" });
  assert.deepEqual(rememberablePath("/servers/setup"), { section: "/servers", path: "/servers/setup" });
  assert.equal(rememberablePath("/settings/bogus"), null);
  assert.equal(rememberablePath("/media/plans/x"), null);
  assert.equal(rememberablePath("/media/plans/x/review/more"), null);
  assert.equal(rememberablePath("/production/sessions"), null, "an old Production address is not remembered (it redirects)");
  assert.equal(rememberablePath("/settings"), null);
  assert.equal(rememberablePath("/home"), null);
  assert.equal(rememberablePath("/merge/x"), null);
});

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-02): every old Production address lands on the same place in its new section.
test("AC-SM-02: plans (a review too) and jobs → Media; everything else -- /production itself too (it opened on Sessions) → Servers; the query is kept", () => {
  assert.equal(productionRedirectTarget(undefined, {}), "/servers");
  assert.equal(productionRedirectTarget(["plans"], {}), "/media/plans");
  assert.equal(productionRedirectTarget(["plans", "R-0001-S1-music", "review"], { device: "win", host: "DESKTOP-B0UCB4I" }), "/media/plans/R-0001-S1-music/review?device=win&host=DESKTOP-B0UCB4I");
  assert.equal(productionRedirectTarget(["jobs"], {}), "/media/jobs");
  assert.equal(productionRedirectTarget(["sessions"], {}), "/servers/sessions");
  assert.equal(productionRedirectTarget(["setup"], { a: ["1", "2"] }), "/servers/setup?a=1&a=2");
  assert.equal(productionRedirectTarget(["models"], {}), "/servers/models");
  assert.equal(productionRedirectTarget(["templates"], {}), "/servers/templates");
  assert.equal(productionRedirectTarget(["plans", "a b"], {}), "/media/plans/a%20b", "a segment stays one segment");
});
