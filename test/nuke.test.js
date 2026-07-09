import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// nukeCommand reads env vars at call time via the exported helper, so we can
// set them per-test without cache busting.

async function importNuke() {
  const url = new URL("../src/commands/nukeCommand.js", import.meta.url).href + "?t=" + Date.now();
  return import(url);
}

const envVarsToClean = new Set();

function setEnv(name, value) {
  process.env[name] = value;
  envVarsToClean.add(name);
}

afterEach(() => {
  for (const name of envVarsToClean) {
    delete process.env[name];
  }
  envVarsToClean.clear();
});

test("getAffectedBotFeatures lists features tied to the channel ID", async () => {
  setEnv("WELCOME_CHANNEL_ID", "111");
  setEnv("HONEYPOT_CHANNEL_ID", "111"); // same channel used by both
  const { getAffectedBotFeatures } = await importNuke();
  const features = getAffectedBotFeatures("111");
  assert.ok(features.some(f => f.includes("welcome messages")));
  assert.ok(features.some(f => f.includes("honeypot")));
});

test("getAffectedBotFeatures returns empty for a non-bot channel", async () => {
  setEnv("WELCOME_CHANNEL_ID", "111");
  setEnv("HONEYPOT_CHANNEL_ID", "222");
  const { getAffectedBotFeatures } = await importNuke();
  assert.deepEqual(getAffectedBotFeatures("999"), []);
});

test("getAffectedBotFeatures returns empty when no bot channel env vars are set", async () => {
  delete process.env.WELCOME_CHANNEL_ID;
  delete process.env.HONEYPOT_CHANNEL_ID;
  const { getAffectedBotFeatures } = await importNuke();
  assert.deepEqual(getAffectedBotFeatures("111"), []);
});
