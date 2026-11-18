import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ChannelType, Collection, Events, MessageFlags, PermissionsBitField } from "discord.js";
import { handleChatInputCommand } from "../src/interactions/slashHandlers.js";
import { getAffectedBotFeatures } from "../src/commands/nukeCommand.js";
import { getDestinationId, getDestinationOverride, getPreviousTicketParent, initializeDestinations } from "../src/config/destinations.js";
import { setupHoneypot } from "../src/handlers/honeypotHandler.js";

const guildId = "100000000000000001";
const otherGuild = "100000000000000002";
const userId = "100000000000000003";
const asId = offset => String(100000000000000010n + BigInt(offset));
const allPermissions = new PermissionsBitField(PermissionsBitField.All);
const noPermissions = new PermissionsBitField(0n);

function env(t, name, value) {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "trackerbot-destinations-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "destinations.json");
  await initializeDestinations(path);
  env(t, "NIKITA_X_GUILD_ID", guildId);
  env(t, "NIKITA_X_STATE_FILE", join(dir, "nikita.json"));
  env(t, "NIKITA_X_BEARER_TOKEN", "synthetic");
  env(t, "NIKITA_X_TRANSLATE_URL", "https://translator.example.test/translate");

  const channels = new Collection();
  const sent = [];
  const guild = {
    id: guildId,
    channels: {
      cache: channels,
      async fetch(id, options) {
        if (!id) return channels;
        const { force } = options;
        assert.equal(force, true);
        return channels.get(id);
      }
    },
    members: {
      async fetch({ user, force }) {
        assert.equal(user, userId);
        assert.equal(force, true);
        return { permissions: guild.memberPermissions };
      },
      async fetchMe() { return { id: asId(90), permissions: allPermissions }; }
    },
    memberPermissions: allPermissions
  };
  function addChannel(id, type = ChannelType.GuildText, properties = {}) {
    channels.set(id, {
      id, type, guildId, name: "destination",
      permissionsFor: () => allPermissions,
      messages: { fetch: async () => new Collection() },
      send: async text => sent.push([id, text]),
      ...properties
    });
    return channels.get(id);
  }
  async function run(action, key, channel, { confirm = false, admin = true } = {}) {
    const responses = [];
    const interaction = {
      commandName: "destinations", guild, guildId, user: { id: userId },
      isChatInputCommand: () => true, inCachedGuild: () => true,
      memberPermissions: admin ? allPermissions : noPermissions,
      options: {
        getSubcommand: () => action, getString: name => { assert.equal(name, "destination"); return key; },
        getChannel: name => { assert.equal(name, "channel"); return channel; },
        getBoolean: name => { assert.equal(name, "confirm_honeypot"); return confirm; }
      },
      async reply(options) { assert.equal(options.flags, MessageFlags.Ephemeral); responses.push(options); },
      async deferReply(options) { assert.equal(options.flags, MessageFlags.Ephemeral); },
      async editReply(options) { responses.push(options); }
    };
    assert.equal(await handleChatInputCommand(interaction), true);
    return responses[0]?.content;
  }
  return { path, guild, channels, sent, addChannel, run };
}

test("administrator selections cover every configured destination and survive a restart", async t => {
  const bot = await fixture(t);
  const text = ChannelType.GuildText;
  const category = ChannelType.GuildCategory;
  const destinations = [
    ["welcome", text], ["honeypot", text], ["archive", category], ["tickets", category],
    ["support-tracker", text], ["support-scanner", text], ["support-monitor", text],
    ["support-account", category], ["support-moderation", category], ["nikita", ChannelType.GuildAnnouncement]
  ];
  for (const [index, [key, type]] of destinations.entries()) {
    const id = asId(index);
    assert.match(await bot.run("set", key, bot.addChannel(id, type), { confirm: true }), new RegExp(id));
    assert.equal(getDestinationOverride(guildId, key), id);
    assert.equal(getDestinationOverride(otherGuild, key), undefined);
  }
  assert.equal(bot.sent.length, 1);
  assert.match(bot.sent[0][1], /BANNED/);
  await initializeDestinations(bot.path);
  for (const [index, [key]] of destinations.entries()) assert.equal(getDestinationOverride(guildId, key), asId(index));
  assert.match(await bot.run("list"), /Nikita X feed.*100000000000000019/);
  assert.deepEqual(getAffectedBotFeatures(asId(0), guildId), ["welcome messages (WELCOME_CHANNEL_ID)"]);
});

test("runtime permission checks reject ordinary members, revoked admins and channels in another guild", async t => {
  const bot = await fixture(t);
  const valid = bot.addChannel(asId(1));
  assert.match(await bot.run("set", "welcome", valid, { admin: false }), /Only Discord/);
  bot.guild.memberPermissions = noPermissions;
  assert.match(await bot.run("set", "welcome", valid), /access changed/);
  bot.guild.memberPermissions = allPermissions;
  const foreign = bot.addChannel(asId(2), ChannelType.GuildText, { guildId: otherGuild });
  assert.match(await bot.run("set", "welcome", foreign), /in this server/);
  const unreadable = bot.addChannel(asId(3), ChannelType.GuildText, { permissionsFor: () => noPermissions });
  assert.match(await bot.run("set", "welcome", unreadable), /required permissions/);
  assert.equal(getDestinationOverride(guildId, "welcome"), undefined);
  await assert.rejects(readFile(bot.path), { code: "ENOENT" });
});

test("honeypot changes require confirmation, reject shared destinations and prepare a warning before saving", async t => {
  const bot = await fixture(t);
  const channel = bot.addChannel(asId(1));
  assert.match(await bot.run("set", "honeypot", channel), /confirm_honeypot/);
  assert.equal(bot.sent.length, 0);
  assert.match(await bot.run("set", "welcome", channel), /now uses/);
  assert.match(await bot.run("set", "honeypot", channel, { confirm: true }), /dedicated channel/);
  const separate = bot.addChannel(asId(2));
  separate.send = async () => { throw new Error("Cannot post warning"); };
  await assert.rejects(bot.run("set", "honeypot", separate, { confirm: true }), /Cannot post warning/);
  assert.equal(getDestinationOverride(guildId, "honeypot"), undefined);
});

test("reset uses the host fallback and account and moderation keep their historical categories separate", async t => {
  const bot = await fixture(t);
  env(t, "SUPPORT_ACCOUNT_CATEGORY_ID", asId(1));
  env(t, "SUPPORT_MODERATION_CATEGORY_ID", asId(2));
  const account = bot.addChannel(asId(1), ChannelType.GuildCategory);
  bot.addChannel(asId(2), ChannelType.GuildCategory);
  const next = bot.addChannel(asId(3), ChannelType.GuildCategory);
  const existing = bot.addChannel(asId(4), ChannelType.GuildText, {
    parentId: account.id, topic: `trackerbot:ticket:v1:account:${userId}:open`
  });
  assert.match(await bot.run("set", "support-account", next), /now uses/);
  assert.equal(getPreviousTicketParent(guildId, "support-account", existing.id), account.id);
  assert.match(await bot.run("set", "support-moderation", account), /separate categories/);
  assert.match(await bot.run("reset", "support-account"), /host default/);
  await initializeDestinations(bot.path);
  assert.equal(getDestinationId(guildId, "support-account"), account.id);
  assert.equal(getPreviousTicketParent(guildId, "support-account", existing.id), account.id);
});

test("simultaneous writes retain both changes and X settings stay in the host-enabled server", async t => {
  const bot = await fixture(t);
  const welcome = bot.addChannel(asId(1));
  const help = bot.addChannel(asId(2));
  process.env.NIKITA_X_GUILD_ID = otherGuild;
  assert.match(await bot.run("set", "nikita", welcome), /enable the Nikita feed for this server/);
  await Promise.all([bot.run("set", "welcome", welcome), bot.run("set", "support-tracker", help)]);
  const saved = JSON.parse(await readFile(bot.path, "utf8"));
  assert.deepEqual(saved.guilds[guildId], { welcome: welcome.id, "support-tracker": help.id });
});

test("honeypot enforcement follows the new channel without restarting the bot", async t => {
  const bot = await fixture(t);
  t.mock.method(console, "log", () => {});
  const handlers = new Map();
  setupHoneypot({ once() {}, on: (event, handler) => handlers.set(event, handler) });
  const first = bot.addChannel(asId(1));
  const second = bot.addChannel(asId(2));
  const bans = [];
  bot.guild.bans = { create: async id => bans.push(id) };
  const removals = [];
  const send = channelId => handlers.get(Events.MessageCreate)({
    channelId, guild: bot.guild, author: { id: userId }, member: { roles: { cache: new Collection() } },
    delete: async () => removals.push(channelId)
  });
  await bot.run("set", "honeypot", first, { confirm: true });
  await bot.run("set", "honeypot", second, { confirm: true });
  await send(first.id);
  await send(second.id);
  assert.deepEqual(removals, [second.id]);
  assert.deepEqual(bans, [userId]);
});
