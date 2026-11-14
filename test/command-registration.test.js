import test from "node:test";
import assert from "node:assert/strict";
import { REST, Routes } from "discord.js";
import { registerSlashCommands } from "../src/commands/registerSlashCommands.js";

async function catalog(t) {
  let data;
  t.mock.method(REST.prototype, "put", async (route, options) => {
    assert.equal(route, Routes.applicationCommands("111111111111111111"));
    data = options.body;
  });
  await registerSlashCommands({ user: { id: "111111111111111111" } });
  assert.ok(Array.isArray(data));
  return data;
}

test("one modern catalog replaces numbered FAQs, stale status notices and one-off bulk roles", async t => {
  const commands = await catalog(t);
  assert.deepEqual(commands.map(command => command.name), ["tt", "message", "channel", "ticket", "support", "nuke"]);
  assert.deepEqual(commands[0].options.map(option => option.name), ["url", "resources", "help"]);
  assert.deepEqual(commands.find(command => command.name === "channel").options.map(option => option.name), ["purge", "archive"]);
});

test("commands are guild-installed/guild-only with restrictive administrative defaults", async t => {
  for (const command of await catalog(t)) {
    assert.deepEqual(command.contexts, [0]);
    assert.deepEqual(command.integration_types, [0]);
    if (!["tt", "ticket"].includes(command.name)) assert.equal(command.default_member_permissions, "0");
    assert.equal(command.dm_permission, undefined, "do not use deprecated DM permissions");
  }
});

test("command options bound content and deletion counts and expose reply/preview choices", async t => {
  const commands = await catalog(t);
  const message = commands.find(command => command.name === "message");
  assert.equal(message.options.find(option => option.name === "content").max_length, 2000);
  assert.ok(message.options.find(option => option.name === "preview"));
  assert.ok(message.options.find(option => option.name === "reply_to"));
  const purge = commands.find(command => command.name === "channel")?.options.find(option => option.name === "purge");
  const count = purge?.options.find(option => option.name === "count");
  assert.equal(count?.required, true);
  assert.equal(count?.min_value, 1);
  assert.equal(count?.max_value, 1000);
});
