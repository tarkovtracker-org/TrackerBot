import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

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
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
});

test("every checked-in external workflow action uses a full commit SHA", async () => {
  const directory = new URL(".github/workflows/", root);
  const workflows = (await readdir(directory)).filter(name => /\.ya?ml$/.test(name));
  assert.ok(workflows.length, "must inspect actual workflows");
  for (const name of workflows) {
    const source = await readFile(new URL(name, directory), "utf8");
    const uses = [...source.matchAll(/^\s+uses:\s*(\S+)/gm)];
    assert.ok(uses.length, `no action declarations found in ${name}`);
    for (const [, action] of uses) {
      assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/, `${name}: pin ${action} to a full SHA`);
    }
  }
});
