import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// env.js reads from process.env at import time, so we set vars before import
// and re-import for each scenario using dynamic import with cache busting.

async function importEnv() {
  const url = new URL("../src/config/env.js", import.meta.url).href + "?t=" + Date.now();
  return import(url);
}

// Track env vars set during tests so they can be cleaned up after each one.
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

test("getRequiredEnv returns the value when set", async () => {
  setEnv("TEST_VAR_X", "hello");
  const { getRequiredEnv } = await importEnv();
  assert.equal(getRequiredEnv("TEST_VAR_X"), "hello");
});

test("getRequiredEnv throws when missing", async () => {
  delete process.env.TEST_VAR_MISSING;
  const { getRequiredEnv } = await importEnv();
  assert.throws(
    () => getRequiredEnv("TEST_VAR_MISSING"),
    /Missing required environment variable: TEST_VAR_MISSING/
  );
});

test("ensureEnvVars passes when all vars are set", async () => {
  setEnv("DISCORD_TOKEN", "t");
  setEnv("WELCOME_CHANNEL_ID", "c");
  setEnv("AUTO_ROLE_ID_1", "r");
  setEnv("AUTO_ROLE_ID_2", "r");
  setEnv("AUTO_ROLE_ID_3", "r");
  setEnv("AUTO_ROLE_ID_4", "r");
  setEnv("PANEL_ADMIN_ROLE_ID", "r");
  setEnv("ADMIN_ROLE_ID", "r");

  const { ensureEnvVars } = await importEnv();
  assert.doesNotThrow(() => ensureEnvVars());
});

test("ensureEnvVars throws when a required var is missing", async () => {
  delete process.env.DISCORD_TOKEN;
  const { ensureEnvVars } = await importEnv();
  assert.throws(
    () => ensureEnvVars(),
    /Missing required environment variable: DISCORD_TOKEN/
  );
});
