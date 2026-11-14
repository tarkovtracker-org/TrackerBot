import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const launcherRoot = new URL("../node_modules/concurrently/", import.meta.url);
const launcher = JSON.parse(await readFile(new URL("package.json", launcherRoot), "utf8"));
const cli = fileURLToPath(new URL(launcher.bin.concurrently, launcherRoot));

test("the declared runtime follows the supported Node 24 production policy", () => {
  assert.equal(manifest.engines.node, ">=24.0.0");
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
});

async function run(t, fail) {
  const directory = await mkdtemp(path.join(tmpdir(), "trackerbot-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(manifest.scripts.start, 'concurrently -n bot,web "npm:start:bot" "npm:start:web"');
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts: {
    "start:bot": "node service.cjs bot", "start:web": "node service.cjs web"
  } }));
  await writeFile(path.join(directory, "service.cjs"), `
    console.log('started-' + process.argv[2] + '-héllo');
    process.exit(process.argv[2] === ${JSON.stringify(fail)} ? 7 : 0);
  `);
  const result = spawnSync(process.execPath, [cli, "-n", "bot,web", "npm:start:bot", "npm:start:web"], {
    cwd: directory, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }
  });
  assert.ifError(result.error);
  return result;
}

test("the installed launcher resolves both npm services and preserves Unicode output", async t => {
  const result = await run(t, null);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /started-bot-héllo/);
  assert.match(result.stdout, /started-web-héllo/);
  assert.match(result.stdout, /\[bot\]/);
  assert.match(result.stdout, /\[web\]/);
});

for (const service of ["bot", "web"]) {
  test(`the installed launcher fails when the ${service} service fails`, async t => {
    const result = await run(t, service);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(`started-${service}-héllo`));
  });
}
