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

test("setupHoneypot registers a MessageCreate listener when enabled", async () => {
  process.env.HONEYPOT_CHANNEL_ID = "123";
  const { setupHoneypot } = await importHoneypot();

  const events = {};
  const fakeClient = {
    on: (evt, fn) => { events[evt] = fn; },
    once: () => {}
  };

  setupHoneypot(fakeClient);
  assert.ok(events.messageCreate, "MessageCreate listener should be registered when enabled");

  delete process.env.HONEYPOT_CHANNEL_ID;
});
