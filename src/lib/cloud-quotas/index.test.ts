import assert from "node:assert/strict";
import test from "node:test";
import { deriveGoogleCloudProjectNumber } from "./index";

// Google's own documented OAuth client ID format: "{project_number}-{random}.apps.googleusercontent.com".
// Real example confirmed working in this session's live spike: "131970858038-es0itv25q90uoeb9pcq29ld2imoks4ne.apps.googleusercontent.com".
test("deriveGoogleCloudProjectNumber: extracts the numeric prefix before the first hyphen", () => {
  assert.equal(
    deriveGoogleCloudProjectNumber("131970858038-es0itv25q90uoeb9pcq29ld2imoks4ne.apps.googleusercontent.com"),
    "131970858038"
  );
});

test("deriveGoogleCloudProjectNumber: undefined client id -> null", () => {
  assert.equal(deriveGoogleCloudProjectNumber(undefined), null);
});

test("deriveGoogleCloudProjectNumber: malformed client id with no numeric prefix -> null", () => {
  assert.equal(deriveGoogleCloudProjectNumber("not-a-valid-client-id"), null);
});
