import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function startup(mode) {
  // Exercise the real entrypoint without a token, Gateway connection, or REST calls.
  const script = `
    import { Client, Events } from "discord.js";
    import { requiredEnvVars } from "./src/config/env.js";
    for (const name of requiredEnvVars) process.env[name] = "synthetic-test-value";
    delete process.env.HONEYPOT_CHANNEL_ID;
    Client.prototype.login = async function () {
      if (${JSON.stringify(mode)} === "null-failure") throw null;
      if (${JSON.stringify(mode)}.startsWith("failure")) throw Object.assign(new Error("synthetic-sensitive-detail"), { code: "TOKEN_INVALID" });
      if (${JSON.stringify(mode)} === "client-error") this.emit(Events.Error, Object.assign(new Error("synthetic-sensitive-detail"), { code: "GATEWAY_TEST" }));
    };
    Client.prototype.destroy = async function () {
      console.log("CLIENT_DESTROYED");
      if (${JSON.stringify(mode)} === "failure-cleanup") throw new Error("synthetic-sensitive-detail");
    };
    await import("./bot.js");
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 });
}

test("failed login is caught, safely logged, closes the client and exits nonzero", () => {
  const result = startup("failure");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLIENT_DESTROYED/);
  assert.match(result.stderr, /Bot login failed/);
  assert.match(result.stderr, /TOKEN_INVALID/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});

test("null login rejection is caught and cleans up the client", () => {
  const result = startup("null-failure");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLIENT_DESTROYED/);
  assert.match(result.stderr, /Bot login failed/);
});

test("cleanup rejection after a failed login remains safely handled", () => {
  const result = startup("failure-cleanup");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bot cleanup failed/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});

test("normal mocked startup succeeds without network or unhandled rejections", () => {
  const result = startup("success");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CLIENT_DESTROYED/);
});

test("client error events are handled without leaking error payloads or crashing", () => {
  const result = startup("client-error");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GATEWAY_TEST/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});
