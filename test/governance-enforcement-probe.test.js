import test from "node:test";
import assert from "node:assert/strict";

// Disposable enforcement probe; this branch must never target the default branch.
test("intentional negative control for required CI enforcement", () => {
  assert.fail("Expected validation-only failure: required CI must block this candidate.");
});
