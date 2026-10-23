import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "trackerbot-build-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", scripts: { build: manifest.scripts.build } }));
  await mkdir(path.join(directory, "scripts"));
  await writeFile(path.join(directory, "scripts/check-syntax.js"), await readFile(new URL("../scripts/check-syntax.js", import.meta.url), "utf8"));
  await writeFile(path.join(directory, "bot.js"), "export const bot = true;\n");
  await writeFile(path.join(directory, "webserver.js"), "export const web = true;\n");
  return { directory, build() {
    return spawnSync("npm", ["run", "build", "--silent"], { cwd: directory, encoding: "utf8", timeout: 10000 });
  } };
}

test("the hosting build command checks valid source without starting services", async t => {
  const api = await fixture(t);
  await mkdir(path.join(api.directory, "src/web"), { recursive: true });
  await writeFile(path.join(api.directory, "src/web/example.js"), "throw new Error('must not execute');\n");
  const result = api.build();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Syntax checked 4 JavaScript files/);
});

test("the build fails on syntax errors in nested source files", async t => {
  const api = await fixture(t);
  await mkdir(path.join(api.directory, "src/web"), { recursive: true });
  await writeFile(path.join(api.directory, "src/web/broken.js"), "export const = ;\n");
  const result = api.build();
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Syntax check failed: src\/web\/broken.js/);
});

test("the build ignores installed dependencies and Git metadata", async t => {
  const api = await fixture(t);
  for (const ignored of ["node_modules", ".git"]) {
    await mkdir(path.join(api.directory, ignored));
    await writeFile(path.join(api.directory, ignored, "broken.js"), "export const = ;\n");
  }
  const result = api.build();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Syntax checked 3 JavaScript files/);
});
