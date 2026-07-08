import { test } from "node:test";
import assert from "node:assert/strict";

// env.js reads from process.env at import time, so we set vars before import
// and re-import for each scenario using dynamic import with cache busting.

async function importEnv() {
  const url = new URL("../src/config/env.js", import.meta.url).href + "?t=" + Date.now();
  return import(url);
}

test("getRequiredEnv returns the value when set", async () => {
  process.env.TEST_VAR_X = "hello";
  const { getRequiredEnv } = await importEnv();
  assert.equal(getRequiredEnv("TEST_VAR_X"), "hello");
  delete process.env.TEST_VAR_X;
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
  process.env.DISCORD_TOKEN = "t";
  process.env.BUG_REPORT_CHANNEL_ID = "c";
  process.env.TICKET_CHANNEL_ID = "c";
  process.env.WELCOME_CHANNEL_ID = "c";
  process.env.AUTO_ROLE_ID_1 = "r";
  process.env.AUTO_ROLE_ID_2 = "r";
  process.env.AUTO_ROLE_ID_3 = "r";
  process.env.AUTO_ROLE_ID_4 = "r";
  process.env.PANEL_ADMIN_ROLE_ID = "r";

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
