import { test } from "node:test";
import assert from "node:assert/strict";

// honeypotHandler reads HONEYPOT_CHANNEL_ID at module load. We re-import with
// cache busting per scenario so the env state is respected.

async function importHoneypot() {
  const url = new URL("../src/handlers/honeypotHandler.js", import.meta.url).href + "?t=" + Date.now();
  return import(url);
}

function createFakeClient() {
  const onEvents = {};
  const onceEvents = {};
  return {
    onEvents,
    onceEvents,
    client: {
      on: (evt, fn) => { onEvents[evt] = fn; },
      once: (evt, fn) => { onceEvents[evt] = fn; }
    }
  };
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

  const { client, onEvents, onceEvents } = createFakeClient();

  setupHoneypot(client);
  assert.ok(onEvents.messageCreate, "MessageCreate listener should be registered via .on");
  // ClientReady must be registered via .once (not .on) to avoid timer leaks on reconnect.
  assert.ok(onceEvents.clientReady, "ClientReady handler should be registered via .once");
  assert.equal(onEvents.clientReady, undefined, "ClientReady must not use .on");

  delete process.env.HONEYPOT_CHANNEL_ID;
});

test("honeypot resolves a missing member before enforcing the admin exemption", async () => {
  process.env.HONEYPOT_CHANNEL_ID = "123";
  const { adminRoles } = await import("../src/config/constants.js");
  adminRoles.add("admin");
  const { setupHoneypot } = await importHoneypot();
  const { client, onEvents } = createFakeClient();
  setupHoneypot(client);

  let deleted = false;
  let banned = false;
  const adminMember = { roles: { cache: [{ id: "admin" }] } };
  await onEvents.messageCreate({
    channelId: "123",
    author: { id: "user", bot: false },
    member: null,
    guild: {
      members: { fetch: async () => adminMember },
      bans: { create: async () => { banned = true; } }
    },
    delete: async () => { deleted = true; }
  });

  assert.equal(deleted, false, "admin message should not be deleted");
  assert.equal(banned, false, "admin should not be banned");
  adminRoles.delete("admin");
  delete process.env.HONEYPOT_CHANNEL_ID;
});

test("honeypot fails safe when a missing member cannot be resolved", async () => {
  process.env.HONEYPOT_CHANNEL_ID = "123";
  const { setupHoneypot } = await importHoneypot();
  const { client, onEvents } = createFakeClient();
  setupHoneypot(client);

  let deleted = false;
  let banned = false;
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await onEvents.messageCreate({
      channelId: "123",
      author: { id: "user", bot: false },
      member: null,
      guild: {
        members: { fetch: async () => { throw new Error("unavailable"); } },
        bans: { create: async () => { banned = true; } }
      },
      delete: async () => { deleted = true; }
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(deleted, false, "message should remain when roles cannot be checked");
  assert.equal(banned, false, "author should not be punished when roles cannot be checked");
  delete process.env.HONEYPOT_CHANNEL_ID;
});
