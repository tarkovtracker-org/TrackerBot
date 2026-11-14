import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";

const text = await readFile(new URL("../.github/workflows/update-license-year.yml", import.meta.url), "utf8");
const document = parseDocument(text);
assert.equal(document.errors.length, 0);
const workflow = document.toJS();

test("annual license automation uses a reviewed PR rather than pushing to the default branch", () => {
  assert.equal(workflow.permissions.contents, "read");
  const job = workflow.jobs["update-license-year"];
  assert.equal(job.permissions.contents, "write");
  assert.equal(job.permissions["pull-requests"], "write");
  assert.equal(job.permissions.actions, undefined, "no privileged CI dispatch token is needed");
  assert.match(job.if, /github\.ref/);
  assert.match(job.if, /default_branch/);
  assert.match(job.if, /LICENSE_PR_AUTOMATION_ENABLED/);
  assert.deepEqual(job.steps.filter(step => step.run).map(step => step.run), ["node scripts/license-pr.js"]);
  assert.doesNotMatch(text, /\bgit\s+push\b/, "never add a direct workflow push, with or without arguments");
});

test("only trusted schedule/manual events can reach the write job and checkout does not retain credentials", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  const job = workflow.jobs["update-license-year"];
  const checkout = job.steps.find(step => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.["persist-credentials"], false);
  assert.equal(checkout?.with?.ref, "${{ github.sha }}");
  assert.match(job.if, /github\.repository == 'tarkovtracker-org\/TrackerBot'/);
});
