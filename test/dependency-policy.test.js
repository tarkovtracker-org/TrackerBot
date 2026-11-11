import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { parseDocument } from "yaml";

const exact = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));

test("production dependencies are exact pins matching manifest and lock resolution", () => {
  assert.ok(Object.keys(manifest.dependencies).length, "do not pass on an empty manifest");
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, exact, `${name} must be pinned exactly`);
    assert.equal(lock.packages[""].dependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
});

test("security overrides are exact pins and installed at the requested version", () => {
  assert.ok(Object.keys(manifest.overrides).length, "security overrides must not silently disappear");
  for (const [name, version] of Object.entries(manifest.overrides)) {
    assert.match(version, exact, `${name} override must be exact`);
    const copies = Object.entries(lock.packages).filter(([location]) =>
      location === `node_modules/${name}` || location.endsWith(`/node_modules/${name}`)
    );
    assert.ok(copies.length, `${name} override must resolve to an installed package`);
    for (const [location, entry] of copies) {
      assert.equal(entry.version, version, `${location} must respect the global override`);
    }
  }
});

/** Parse actual job/step declarations and require immutable external action refs.
 * @param {string} source Workflow YAML source.
 * @param {string} name Workflow name used in failure diagnostics.
 */
function assertPinnedActions(source, name) {
  const document = parseDocument(source, { uniqueKeys: true });
  assert.equal(document.errors.length, 0, `${name}: invalid YAML`);
  const workflow = document.toJS({ maxAliasCount: 100 });
  const jobs = workflow?.jobs;
  assert.ok(jobs && typeof jobs === "object" && !Array.isArray(jobs), `${name}: jobs mapping required`);
  const actions = [];
  for (const job of Object.values(jobs)) {
    assert.ok(job && typeof job === "object" && !Array.isArray(job), `${name}: invalid job`);
    if (Object.hasOwn(job, "uses")) actions.push(job.uses);
    if (job.steps !== undefined) {
      assert.ok(Array.isArray(job.steps), `${name}: steps must be a sequence`);
      for (const step of job.steps) {
        assert.ok(step && typeof step === "object" && !Array.isArray(step), `${name}: invalid step`);
        if (Object.hasOwn(step, "uses")) actions.push(step.uses);
      }
    }
  }
  assert.ok(actions.length, `no action declarations found in ${name}`);
  for (const action of actions) {
    assert.equal(typeof action, "string", `${name}: action reference must be a string`);
    assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${name}: pin ${action} to a full SHA`);
  }
}

test("action pin checks include shorthand even when a pinned named step exists", () => {
  const pinned = "actions/checkout@" + "a".repeat(40);
  const check = steps => assertPinnedActions(`jobs:\n  check:\n    steps:\n${steps}\n`, "fixture.yml");
  assert.throws(() => check(`      - name: Pinned\n        uses: ${pinned}\n      - uses: actions/checkout@v7`), /pin actions\/checkout@v7/);
  assert.doesNotThrow(() => check(`      - uses: ${pinned}`));
  assert.throws(() => check(`      - uses: ${pinned}\n      - uses : actions/checkout@v7`), /pin actions\/checkout@v7/);
  assert.doesNotThrow(() => check(`      - uses \t: ${pinned}`));
});

test("quoted and flow-style YAML action keys cannot bypass pin checks", () => {
  const pinned = "actions/checkout@" + "a".repeat(40);
  for (const step of ['- "uses": actions/checkout@v7', "- 'uses': actions/checkout@v7", '- {uses: actions/checkout@v7}']) {
    assert.throws(() => assertPinnedActions(`jobs:\n  check:\n    steps:\n      - uses: ${pinned}\n      ${step}\n`, "quoted.yml"), /pin actions\/checkout@v7/);
  }
});

test("parsed workflow checks handle aliases and quoted values without treating script text as actions", () => {
  const pinned = "actions/checkout@" + "a".repeat(40);
  assert.doesNotThrow(() => assertPinnedActions(`jobs:\n  check:\n    steps:\n      - &checkout {"uses": "${pinned}"}\n      - *checkout\n      - run: |\n          uses: actions/checkout@v7\n`, "aliases.yml"));
  assert.throws(() => assertPinnedActions(`jobs:\n  check:\n    steps:\n      - &checkout {uses: actions/checkout@v7}\n      - *checkout\n`, "alias-floating.yml"), /pin actions\/checkout@v7/);
});

test("parsed workflow checks reject invalid YAML, empty action sets and floating reusable workflows", () => {
  assert.throws(() => assertPinnedActions("jobs: [", "invalid.yml"), /invalid YAML/);
  assert.throws(() => assertPinnedActions("jobs:\n  check:\n    steps:\n      - run: echo test\n", "empty.yml"), /no action declarations/);
  assert.throws(() => assertPinnedActions("jobs:\n  check:\n    uses: owner/repo/.github/workflows/check.yml@main\n", "reusable.yml"), /pin owner\/repo/);
});

test("every checked-in external workflow action uses a full commit SHA", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name));
  assert.ok(workflows.length, "must inspect actual workflows");
  for (const name of workflows) {
    assertPinnedActions(await readFile(new URL(name, directory), "utf8"), name);
  }
});
