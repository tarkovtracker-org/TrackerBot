import { test } from "node:test";
import assert from "node:assert/strict";

// honeypotHandler reads HONEYPOT_CHANNEL_ID at module load. We re-import with
// cache busting per scenario so the env state is respected.

async function importHoneypot() {
  const url = new URL("../src/handlers/honeypotHandler.js", import.meta.url).href + "?t=" + Date.now();
  return import(url);
}

test("setupHoneypot is a no-op when HONEYPOT_CHANNEL_ID is unset", async () => {
  delete process.env.HONEYPOT_CHANNEL_ID;
  const { setupHoneypot } = await importHoneypot();

  // A fake client with spies; if setupHoneypot registers anything it would
  // call .on(). With the env var unset it must return early.
  let registered = false;
  const fakeClient = {
    on: () => { registered = true; },
    once: () => { registered = true; }
  };

  setupHoneypot(fakeClient);
  assert.equal(registered, false, "no listeners should be registered when disabled");
});

test("setupHoneypot registers listeners when enabled", async () => {
  process.env.HONEYPOT_CHANNEL_ID = "123";
  const { setupHoneypot } = await importHoneypot();

  const onEvents = {};
  const onceEvents = {};
  const fakeClient = {
    on: (evt, fn) => { onEvents[evt] = fn; },
    once: (evt, fn) => { onceEvents[evt] = fn; }
  };

  setupHoneypot(fakeClient);
  assert.ok(onEvents.messageCreate, "MessageCreate listener should be registered via .on");
  // ClientReady must be registered via .once (not .on) to avoid timer leaks on reconnect.
  assert.ok(onceEvents.clientReady, "ClientReady handler should be registered via .once");
  assert.equal(onEvents.clientReady, undefined, "ClientReady must not use .on");

  delete process.env.HONEYPOT_CHANNEL_ID;
});
