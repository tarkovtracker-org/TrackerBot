import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Events, Collection } from "discord.js";
import { registerMemberHandlers } from "../src/handlers/memberHandlers.js";

const names = ["WELCOME_CHANNEL_ID", "AUTO_ROLE_ID_1", "AUTO_ROLE_ID_2", "AUTO_ROLE_ID_3", "AUTO_ROLE_ID_4"];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
beforeEach(t => {
  for (const name of names) process.env[name] = name === "WELCOME_CHANNEL_ID" ? "welcome" : "auto-role";
  t.mock.method(console, "error", () => {});
});
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
});

function fixture({ sendError = false, roleError = false } = {}) {
  const handlers = new Map();
  const messages = new Collection();
  const posts = [];
  const channel = {
    isTextBased: () => true,
    send: async options => {
      if (sendError) throw Object.assign(new Error("Missing permissions"), { code: 50013 });
      posts.push(options);
      const message = { id: "message", delete: async () => messages.delete("message") };
      messages.set(message.id, message);
      return message;
    },
    messages: { fetch: async id => messages.get(id) }
  };
  const member = {
    id: "member", toString: () => "<@member>",
    roles: { add: async () => { if (roleError) throw new Error("Role hierarchy"); } },
    guild: {
      roles: { cache: new Collection([["auto-role", { id: "auto-role", name: "Member" }]]) },
      channels: { cache: new Collection([["welcome", channel]]) }
    }
  };
  registerMemberHandlers({ on: (event, listener) => handlers.set(event, listener) });
  return { join: () => handlers.get(Events.GuildMemberAdd)(member), leave: () => handlers.get(Events.GuildMemberRemove)(member), messages, posts };
}

test("failed welcome send is contained at the event boundary", async () => {
  const f = fixture({ sendError: true });
  await assert.doesNotReject(f.join());
  assert.equal(console.error.mock.calls.length, 1);
  assert.equal(f.messages.size, 0);
});

test("missing runtime join configuration cannot reject the event listener", async () => {
  const f = fixture();
  delete process.env.AUTO_ROLE_ID_1;
  await assert.doesNotReject(f.join());
  assert.equal(console.error.mock.calls.length, 1);
});

test("missing runtime leave configuration cannot reject the event listener", async () => {
  const f = fixture();
  delete process.env.WELCOME_CHANNEL_ID;
  await assert.doesNotReject(f.leave());
  assert.equal(console.error.mock.calls.length, 1);
});

test("welcome only notifies the joining member and can be cleaned up on leave", async () => {
  const f = fixture();
  await f.join();
  assert.deepEqual(f.posts[0].allowedMentions, { parse: [], users: ["member"] });
  assert.equal(f.messages.size, 1);
  await f.leave();
  assert.equal(f.messages.size, 0);
});

test("role assignment failure does not suppress a successful welcome", async () => {
  const f = fixture({ roleError: true });
  await assert.doesNotReject(f.join());
  assert.equal(f.posts.length, 1);
});
