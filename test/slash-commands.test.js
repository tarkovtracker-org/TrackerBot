import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, Collection, MessageFlags, PermissionsBitField, PermissionFlagsBits } from "discord.js";
import { adminRoles, allowedCommandRoles } from "../src/config/constants.js";
import { getResourceLinks } from "../src/config/resources.js";
import { messageReference } from "../src/utils/messageReply.js";
import { handleChatInputCommand } from "../src/interactions/slashHandlers.js";

const envNames = ["TT_SITE_URL", "TT_RESOURCES_URL", "ARCHIVE_CATEGORY_ID"];
const originalEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const originalAdmins = [...adminRoles];
const originalAllowed = [...allowedCommandRoles];
beforeEach(t => {
  for (const name of envNames) delete process.env[name];
  adminRoles.clear(); adminRoles.add("staff"); allowedCommandRoles.clear();
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "error", () => {});
});
afterEach(() => {
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
  adminRoles.clear(); for (const id of originalAdmins) adminRoles.add(id);
  allowedCommandRoles.clear(); for (const id of originalAllowed) allowedCommandRoles.add(id);
});

const guildId = "111111111111111111";
const channelId = "222222222222222222";
const messageId = "333333333333333333";
const categoryId = "444444444444444444";

function fixture(name, options = {}, { admin = true, canPost = true, cancel = false, timeout = false, revokedOn = Infinity, sendError = false, editError = false } = {}) {
  const replies = [], edits = [], sent = [], channelEdits = [], messageFetches = [];
  let memberFetches = 0;
  let acknowledged = false;
  const roles = new Collection(admin ? [["staff", { id: "staff" }]] : []);
  const category = { id: categoryId, type: ChannelType.GuildCategory, name: "Archive" };
  const channel = {
    id: channelId, type: ChannelType.GuildText,
    messages: { fetch: async reference => { messageFetches.push(reference); return { id: reference }; } },
    send: async data => { assert.ok(acknowledged); if (sendError) throw new Error("Discord unavailable"); sent.push(data); return { id: "sent" }; },
    edit: async data => { if (editError) throw new Error("Missing permissions"); channelEdits.push(data); }
  };
  const interaction = {
    id: "interaction", commandName: name, guildId, channelId,
    user: { id: "actor" }, member: { roles: { cache: roles } },
    memberPermissions: new PermissionsBitField(canPost ? [PermissionFlagsBits.SendMessages] : []),
    isChatInputCommand: () => true, inCachedGuild: () => true,
    channel,
    options: {
      getSubcommand: () => options.action ?? "url",
      getString: key => options[key] ?? null,
      getBoolean: key => options[key] ?? null,
      getInteger: key => options[key] ?? null
    },
    guild: {
      id: guildId,
      channels: { fetch: async id => { assert.ok(acknowledged); return id ? channel : new Collection([[category.id, category]]); } },
      roles: { fetch: async () => new Collection([["staff", { id: "staff" }]]) },
      members: {
        fetch: async input => {
          assert.ok(acknowledged, "acknowledge before network work");
          assert.deepEqual(input, { user: "actor", force: true });
          memberFetches++;
          return { roles: { cache: memberFetches >= revokedOn ? new Collection() : roles } };
        },
        fetchMe: async () => ({ id: "bot" })
      }
    },
    reply: async data => { acknowledged = true; replies.push(data); },
    deferReply: async data => { assert.equal(data.flags, MessageFlags.Ephemeral); acknowledged = true; },
    editReply: async data => {
      assert.ok(acknowledged, "a real response must exist before editing or collecting");
      edits.push(data);
      return { awaitMessageComponent: async config => {
        const buttons = data.components[0].toJSON().components;
        const customId = buttons[cancel ? 1 : 0].custom_id;
        const button = { customId, user: interaction.user, deferUpdate: async () => {} };
        assert.equal(config.filter({ ...button, user: { id: "stranger" } }), false);
        assert.equal(config.filter({ ...button, customId: "unrelated" }), false);
        assert.equal(config.filter(button), true);
        if (timeout) throw Object.assign(new Error("timeout"), { code: "InteractionCollectorError" });
        return button;
      } };
    }
  };
  return { interaction, replies, edits, sent, channelEdits, messageFetches };
}

async function run(f) { assert.equal(await handleChatInputCommand(f.interaction), true); return f; }

test("resource defaults are live HTTPS website destinations; overrides validate and blanks fall back", () => {
  assert.deepEqual(getResourceLinks(), { site: "https://tarkovtracker.org/", resources: "https://tarkovtracker.org/resources" });
  assert.deepEqual(getResourceLinks({ TT_SITE_URL: " https://example.com ", TT_RESOURCES_URL: " " }), { site: "https://example.com/", resources: "https://example.com/resources" });
  for (const url of ["http://example.com", "https://user:password@example.com", "javascript:alert(1)", "not a URL"]) {
    assert.throws(() => getResourceLinks({ TT_SITE_URL: url }));
  }
});

test("message references accept IDs and same-channel links, rejecting other channels/guilds and malformed URLs", () => {
  const context = { guildId, channelId };
  assert.equal(messageReference(messageId, context), messageId);
  assert.equal(messageReference(`https://discord.com/channels/${guildId}/${channelId}/${messageId}`, context), messageId);
  for (const input of ["bad-id", `https://discord.com/channels/${guildId}/${messageId}/${messageId}`, `https://discord.com/channels/${messageId}/${channelId}/${messageId}`, `https://evil.example/channels/${guildId}/${channelId}/${messageId}`]) {
    assert.throws(() => messageReference(input, context));
  }
});

for (const action of ["url", "resources"]) {
  test(`/tt ${action} shares a professional link without requiring an admin role`, async () => {
    const f = await run(fixture("tt", { action }, { admin: false }));
    assert.equal(f.replies[0].flags, undefined);
    const embed = f.replies[0].embeds[0].toJSON();
    assert.equal(embed.url, action === "url" ? "https://tarkovtracker.org/" : "https://tarkovtracker.org/resources");
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [], repliedUser: false });
    assert.equal(f.sent.length, 0);
  });
}

test("read-only channel users can get a private resource but cannot make the bot publish", async () => {
  const publicRequest = await run(fixture("tt", {}, { admin: false, canPost: false }));
  assert.equal(publicRequest.replies[0].flags, MessageFlags.Ephemeral);
  assert.match(publicRequest.replies[0].content, /cannot post/);
  const privateRequest = await run(fixture("tt", { private: true }, { admin: false, canPost: false }));
  assert.equal(privateRequest.replies[0].flags, MessageFlags.Ephemeral);
  assert.equal(privateRequest.replies[0].embeds.length, 1);
});

test("resource role allowlist is independent of administrative authorization", async () => {
  allowedCommandRoles.add("support");
  const denied = await run(fixture("tt", {}, { admin: false }));
  assert.match(denied.replies[0].content, /role cannot/);
  const admin = await run(fixture("tt"));
  assert.equal(admin.replies[0].embeds.length, 1);
  const permitted = fixture("tt", {}, { admin: false });
  permitted.interaction.member.roles.cache.set("support", { id: "support" });
  await run(permitted);
  assert.equal(permitted.replies[0].embeds.length, 1);
});

test("resource replies fetch the same-channel message and never notify its author", async () => {
  const f = await run(fixture("tt", { action: "resources", reply_to: messageId }, { admin: false }));
  assert.deepEqual(f.messageFetches, [messageId]);
  assert.deepEqual(f.sent[0].reply, { messageReference: messageId, failIfNotExists: true });
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
});

test("private resource/reply conflict and invalid configuration fail without public posts", async () => {
  const conflict = await run(fixture("tt", { private: true, reply_to: messageId }));
  assert.match(conflict.replies[0].content, /Replies to messages are public/);
  assert.equal(conflict.sent.length, 0);
  process.env.TT_SITE_URL = "http://invalid.example";
  const invalid = await run(fixture("tt"));
  assert.match(invalid.replies[0].content, /staff attention/);
  assert.equal(invalid.sent.length, 0);
});

test("/tt help is private and retired commands never perform their old actions", async () => {
  const help = await run(fixture("tt", { action: "help" }, { admin: false }));
  assert.equal(help.replies[0].flags, MessageFlags.Ephemeral);
  for (const command of ["faq1", "utd", "put-member-role", "archive", "wipe"]) {
    const f = await run(fixture(command));
    assert.match(f.replies[0].content, /retired/);
    assert.equal(f.sent.length + f.channelEdits.length, 0);
  }
});

test("/message previews by default, refreshes authority, and sends without mention amplification", async () => {
  const f = await run(fixture("message", { content: "Hello\\n@everyone" }));
  assert.match(f.edits[0].content, /nothing has been sent/);
  assert.equal(f.sent[0].content, "Hello\n@everyone");
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], repliedUser: false });
  assert.equal(f.edits.at(-1).content, "Message sent.");
});

for (const mode of [{ cancel: true }, { timeout: true }, { revokedOn: 2 }]) {
  test(`/message never posts on ${JSON.stringify(mode)}`, async () => {
    const f = await run(fixture("message", { content: "Not sent" }, mode));
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.edits.at(-1).components, []);
  });
}

test("/message supports explicitly skipping preview, styled embeds, and safe replies", async () => {
  const f = await run(fixture("message", { content: "Welcome", title: "News", preview: false, reply_to: messageId }));
  assert.equal(f.sent[0].embeds[0].toJSON().title, "News");
  assert.equal(f.sent[0].reply.messageReference, messageId);
  assert.deepEqual(f.messageFetches, [messageId]);
});

test("/message denies non-admins and does not claim success when delivery errors", async () => {
  const denied = await run(fixture("message", { content: "test" }, { admin: false }));
  assert.equal(denied.sent.length, 0);
  assert.match(denied.replies[0].content, /Only configured admins/);
  const failed = await run(fixture("message", { content: "test", preview: false }, { sendError: true }));
  assert.equal(failed.sent.length, 0);
  assert.match(failed.edits.at(-1).content, /could not be confirmed/);
});

test("archive atomically hides the channel from previous users/roles while preserving history", async () => {
  const f = await run(fixture("channel", { action: "archive" }));
  assert.equal(f.channelEdits.length, 1);
  const edit = f.channelEdits[0];
  assert.equal(edit.parent, categoryId);
  assert.equal(edit.permissionOverwrites[0].id, guildId);
  assert.deepEqual(edit.permissionOverwrites[0].deny, [PermissionFlagsBits.ViewChannel]);
  assert.deepEqual(edit.permissionOverwrites.slice(1).map(overwrite => overwrite.id), ["bot", "staff"]);
  assert.match(f.edits.at(-1).content, /no messages were deleted/);
  assert.equal(f.sent.length, 0, "no public archive notice is posted");
});

for (const mode of [{ cancel: true }, { timeout: true }, { revokedOn: 1 }, { admin: false }, { editError: true }]) {
  test(`archive fails safely with ${JSON.stringify(mode)}`, async () => {
    const f = await run(fixture("channel", { action: "archive" }, mode));
    assert.equal(f.channelEdits.length, 0);
    assert.equal(f.sent.length, 0);
  });
}

test("archive category IDs are configurable and invalid values never fall back", async () => {
  process.env.ARCHIVE_CATEGORY_ID = "missing";
  const invalid = await run(fixture("channel", { action: "archive" }));
  assert.equal(invalid.channelEdits.length, 0);
  assert.match(invalid.edits.at(-1).content, /configure a valid archive category/);
  process.env.ARCHIVE_CATEGORY_ID = categoryId;
  const valid = await run(fixture("channel", { action: "archive" }));
  assert.equal(valid.channelEdits[0].parent, categoryId);
});

test("two overlapping channel operations cannot both open or mutate; the lock releases afterward", async () => {
  const first = fixture("channel", { action: "archive" });
  const running = handleChatInputCommand(first.interaction);
  const second = await run(fixture("channel", { action: "archive" }));
  assert.equal(second.channelEdits.length, 0, "overlapping moderation must not mutate twice");
  assert.match(second.replies[0].content, /already open/);
  await running;
  const third = await run(fixture("channel", { action: "archive" }));
  assert.equal(third.channelEdits.length, 1);
});

test("purge honors an explicit count across batches instead of deleting every recent message", async () => {
  const f = fixture("channel", { action: "purge", count: 150 });
  const limits = [];
  f.interaction.fetchReply = async () => ({ awaitMessageComponent: async () => ({ customId: "confirm_wipe", deferUpdate: async () => {} }) });
  f.interaction.channel.messages.fetch = async ({ limit }) => {
    limits.push(limit);
    return new Collection(Array.from({ length: limit }, (_, index) => [String(index), { id: String(index) }]));
  };
  f.interaction.channel.bulkDelete = async (messages, filterOld) => {
    assert.equal(filterOld, true);
    return messages;
  };
  await run(f);
  assert.deepEqual(limits, [100, 50]);
  assert.match(f.edits.at(-1).embeds[0].toJSON().description, /Deleted 150 of up to 150/);
});

test("archive rejects non-text sources and misconfigured @everyone admin access", async () => {
  const wrongType = fixture("channel", { action: "archive" });
  wrongType.interaction.channel.type = ChannelType.PublicThread;
  await run(wrongType);
  assert.equal(wrongType.channelEdits.length, 0);
  assert.match(wrongType.replies[0].content, /Only server text channels/);
  adminRoles.clear(); adminRoles.add(guildId);
  const everyone = fixture("channel", { action: "archive" });
  everyone.interaction.member.roles.cache.set(guildId, { id: guildId });
  everyone.interaction.guild.roles.fetch = async () => new Collection([[guildId, { id: guildId }]]);
  await run(everyone);
  assert.equal(everyone.channelEdits.length, 0);
  assert.match(everyone.edits.at(-1).content, /could not be confirmed/);
});

test("a failed archive releases its channel lock for the next operation", async () => {
  const failed = await run(fixture("channel", { action: "archive" }, { editError: true }));
  assert.equal(failed.channelEdits.length, 0);
  const next = await run(fixture("channel", { action: "archive" }));
  assert.equal(next.channelEdits.length, 1);
});

test("uncached guild interactions fail closed before inspecting member roles", async () => {
  const f = fixture("message", { content: "not sent" });
  f.interaction.inCachedGuild = () => false;
  f.interaction.member = null;
  await run(f);
  assert.equal(f.sent.length, 0);
  assert.equal(f.replies[0].flags, MessageFlags.Ephemeral);
});

test("message content limits and empty text are validated before any preview or send", async () => {
  for (const content of [" ", "x".repeat(2001)]) {
    const f = await run(fixture("message", { content }));
    assert.equal(f.sent.length + f.edits.length, 0);
    assert.match(f.replies[0].content, /1–2000/);
  }
});

test("purge failures report the actual partial deletion count", async () => {
  const f = fixture("channel", { action: "purge", count: 150 });
  f.interaction.fetchReply = async () => ({ awaitMessageComponent: async () => ({ customId: "confirm_wipe", deferUpdate: async () => {} }) });
  let calls = 0;
  f.interaction.channel.messages.fetch = async ({ limit }) => {
    if (calls++) throw new Error("Discord unavailable");
    return new Collection(Array.from({ length: limit }, (_, index) => [String(index), { id: String(index) }]));
  };
  f.interaction.channel.bulkDelete = async messages => messages;
  await run(f);
  assert.match(f.edits.at(-1).embeds[0].toJSON().description, /stopped after deleting 100/);
  assert.deepEqual(f.edits.at(-1).components, []);
});

test("purge rejects out-of-range counts before confirmation", async () => {
  for (const count of [0, -1, 1001, 1.5]) {
    const f = await run(fixture("channel", { action: "purge", count }));
    assert.match(f.replies[0].content, /1 to 1000/);
    assert.equal(f.edits.length, 0);
  }
});
