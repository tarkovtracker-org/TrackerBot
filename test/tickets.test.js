import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits } from "discord.js";
import { handleButtonInteraction } from "../src/interactions/buttonHandlers.js";

const originalCategoryId = process.env.TICKET_CATEGORY_ID;
afterEach(() => {
  if (originalCategoryId === undefined) delete process.env.TICKET_CATEGORY_ID;
  else process.env.TICKET_CATEGORY_ID = originalCategoryId;
});

const support = { id: "1536562632289689673", type: ChannelType.GuildCategory, name: "🆘 --- Support ---" };
const category = (overrides = {}) => ({ ...support, ...overrides });

function fixture(channels = [support], { fetchError, createError } = {}) {
  delete process.env.TICKET_CATEGORY_ID;
  const events = [];
  const created = [];
  const replies = [];
  const sent = [];
  const fetched = new Collection(channels.map(channel => [channel.id, channel]));
  const interaction = {
    customId: "create_ticket",
    isButton: () => true,
    member: { id: "member-id", user: { username: "Example User" } },
    guild: {
      id: "guild-id",
      members: { me: { id: "bot-id" } },
      roles: { cache: new Collection([["admin-id", { id: "admin-id", name: "Discord Admin" }]]) },
      channels: {
        // Deliberately cold: routing and duplicate checks must use the fetched snapshot.
        cache: new Collection(),
        fetch: async () => {
          events.push("fetch");
          if (fetchError) throw fetchError;
          return fetched;
        },
        create: async options => {
          events.push("create");
          created.push(options);
          if (createError) throw createError;
          return { send: async message => sent.push(message), toString: () => "<#ticket-id>" };
        }
      }
    },
    deferReply: async options => {
      events.push("defer");
      assert.deepEqual(options, { flags: MessageFlags.Ephemeral });
    },
    editReply: async options => {
      events.push("edit");
      assert.equal(options.flags, undefined, "deferred replies retain their ephemeral visibility");
      replies.push(options);
    },
    reply: async () => assert.fail("ticket responses must edit the deferred reply")
  };
  return { interaction, events, created, replies, sent };
}

async function run(f) {
  assert.equal(await handleButtonInteraction(f.interaction), true);
  return f;
}

function title(f) {
  return f.replies.at(-1)?.embeds[0].toJSON().title;
}

test("existing Support category works without new configuration, even with a cold cache", async () => {
  const f = await run(fixture());
  assert.equal(title(f), "Ticket ready");
  assert.deepEqual(f.events, ["defer", "fetch", "create", "edit"]);
  assert.equal(f.created[0].parent, support.id);
  assert.equal(f.created[0].topic, "Ticket for member-id");
  assert.equal(f.created[0].name, "ticket-example-user");
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.created[0].permissionOverwrites, [
    { id: "guild-id", deny: [PermissionFlagsBits.ViewChannel] },
    { id: "member-id", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: "bot-id", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] },
    { id: "admin-id", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels] }
  ]);
});

test("legacy category matching tolerates case and surrounding whitespace", async () => {
  const f = await run(fixture([category({ name: "  🆘 --- SUPPORT ---  " })]));
  assert.equal(title(f), "Ticket ready");
});

test("configured category ID takes precedence and survives arbitrary names", async () => {
  const destination = category({ id: "1536428726756311110", name: "Private help" });
  const f = fixture([support, destination]);
  process.env.TICKET_CATEGORY_ID = ` ${destination.id} `;
  await run(f);
  assert.equal(f.created[0].parent, destination.id);
});

test("blank category configuration keeps the legacy fallback", async () => {
  const f = fixture();
  process.env.TICKET_CATEGORY_ID = "   ";
  await run(f);
  assert.equal(f.created[0].parent, support.id);
});

for (const configuredId of ["missing-id", "not-a-snowflake", "text-id"]) {
  test(`invalid configured destination fails closed without falling back: ${configuredId}`, async () => {
    const f = fixture([support, { id: "text-id", type: ChannelType.GuildText, name: "ticket" }]);
    process.env.TICKET_CATEGORY_ID = configuredId;
    await run(f);
    assert.equal(title(f), "Ticket support unavailable");
    assert.equal(f.created.length, 0);
    assert.doesNotMatch(f.replies[0].embeds[0].toJSON().description, /create a category/i);
  });
}

test("missing legacy destination gives an actionable staff-contact message", async () => {
  const f = await run(fixture([]));
  assert.equal(title(f), "Ticket support unavailable");
  assert.match(f.replies[0].embeds[0].toJSON().description, /staff|administrator/i);
  assert.equal(f.created.length, 0);
});

test("a text channel with the legacy category name is never accepted", async () => {
  const f = await run(fixture([category({ type: ChannelType.GuildText })]));
  assert.equal(f.created.length, 0);
  assert.equal(title(f), "Ticket support unavailable");
});

test("existing tickets from the fetched destination prevent another creation", async () => {
  const f = await run(fixture([support, {
    id: "existing-id", type: ChannelType.GuildText, parentId: support.id,
    topic: "Ticket for member-id", toString: () => "<#existing-id>"
  }]));
  assert.equal(title(f), "Ticket already open");
  assert.equal(f.created.length, 0);
  assert.match(f.replies[0].embeds[0].toJSON().description, /existing-id/);
});

test("channel-fetch failure does not create a ticket or claim the category is missing", async t => {
  t.mock.method(console, "error", () => {});
  const f = await run(fixture([], { fetchError: new Error("Discord unavailable") }));
  assert.equal(title(f), "Ticket failed");
  assert.equal(f.created.length, 0);
  assert.deepEqual(f.events, ["defer", "fetch", "edit"]);
});

test("channel-creation failure edits the private deferred response", async t => {
  t.mock.method(console, "error", () => {});
  const f = await run(fixture([support], { createError: new Error("Missing permissions") }));
  assert.equal(title(f), "Ticket failed");
  assert.equal(f.sent.length, 0);
  assert.deepEqual(f.events, ["defer", "fetch", "create", "edit"]);
});

test("unrelated buttons remain unhandled", async () => {
  const f = fixture();
  f.interaction.customId = "unrelated";
  assert.equal(await handleButtonInteraction(f.interaction), false);
  assert.deepEqual(f.events, []);
});
