import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs, { mkdtemp, readFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { ChannelType, Collection, Events, MessageFlags, PermissionsBitField } from "discord.js";
import { handleChatInputCommand } from "../src/interactions/slashHandlers.js";
import { getAffectedBotFeatures } from "../src/commands/nukeCommand.js";
import { canConfigureDestinations, destinations, getDestinationId, getDestinationOverride, getPreviousTicketParent, initializeDestinations, updateDestination, withDestinationReadLock } from "../src/config/destinations.js";
import { ensureHoneypotMessage, setupHoneypot } from "../src/handlers/honeypotHandler.js";
import { writeJsonAtomically } from "../src/utils/writeJsonAtomically.js";

const guildId = "100000000000000001";
const otherGuild = "100000000000000002";
const userId = "100000000000000003";
const asId = offset => String(100000000000000010n + BigInt(offset));
const allPermissions = new PermissionsBitField(PermissionsBitField.All);
const noPermissions = new PermissionsBitField(0n);

function env(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
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
  for (const { env: variable } of Object.values(destinations)) env(t, variable, undefined);
  env(t, "TRACKERBOT_DESTINATIONS_FILE", path);
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
    const history = new Collection();
    channels.set(id, {
      id, type, guildId, name: "destination",
      permissionsFor: () => allPermissions,
      messages: { fetch: async () => history },
      async send(content) {
        sent.push([id, content]);
        const messageId = asId(100 + sent.length);
        const message = { id: messageId, author: { id: asId(90), bot: true }, content,
          async delete() { history.delete(messageId); } };
        history.set(messageId, message);
        return message;
      },
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
  assert.deepEqual(getAffectedBotFeatures(asId(0), guildId), ["welcome messages (/destinations set destination:welcome)"]);
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

test("ticket category moves prune deleted history and preserve surviving historical tickets", async t => {
  const bot = await fixture(t);
  const old = bot.addChannel(asId(1), ChannelType.GuildCategory);
  const active = bot.addChannel(asId(2), ChannelType.GuildCategory);
  const next = bot.addChannel(asId(3), ChannelType.GuildCategory);
  const surviving = bot.addChannel(asId(4), ChannelType.GuildText, { parentId: old.id });
  const deleted = asId(5);
  await updateDestination(guildId, "support-account", active.id,
    () => ({ categoryId: old.id, ticketIds: [surviving.id, deleted] }));
  assert.equal(getPreviousTicketParent(guildId, "support-account", deleted), old.id);
  assert.match(await bot.run("set", "support-account", next), new RegExp(next.id));
  await initializeDestinations(bot.path);
  assert.equal(getPreviousTicketParent(guildId, "support-account", deleted), undefined);
  assert.equal(getPreviousTicketParent(guildId, "support-account", surviving.id), old.id);
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
  assert.match(await bot.run("set", "honeypot", first, { confirm: true }), new RegExp(first.id));
  await send(first.id);
  assert.deepEqual(removals, [first.id]);
  assert.match(await bot.run("set", "honeypot", second, { confirm: true }), new RegExp(second.id));
  assert.equal((await first.messages.fetch()).size, 0);
  await send(first.id);
  await send(second.id);
  assert.deepEqual(removals, [first.id, second.id]);
  assert.deepEqual(bans, [userId, userId]);
});

test("reset verifies a host honeypot outside the cache before activating it", async t => {
  const bot = await fixture(t);
  const first = bot.addChannel(asId(1));
  const fallback = bot.addChannel(asId(2));
  await bot.run("set", "honeypot", first, { confirm: true });
  env(t, "HONEYPOT_CHANNEL_ID", fallback.id);
  bot.channels.delete(fallback.id);
  const fetch = bot.guild.channels.fetch;
  bot.guild.channels.fetch = async (id, options) => {
    if (id !== fallback.id) return fetch(id, options);
    assert.equal(options.force, true);
    return fallback;
  };
  assert.match(await bot.run("reset", "honeypot"), /confirm_honeypot/);
  assert.equal(getDestinationOverride(guildId, "honeypot"), first.id);
  assert.match(await bot.run("reset", "honeypot", undefined, { confirm: true }), /host default/);
  assert.deepEqual(bot.sent.map(([id]) => id), [first.id, fallback.id]);
});

test("a deleted host honeypot can be reset while an uncertain lookup leaves enforcement in place", async t => {
  const bot = await fixture(t);
  const first = bot.addChannel(asId(1));
  await bot.run("set", "honeypot", first, { confirm: true });
  env(t, "HONEYPOT_CHANNEL_ID", asId(2));
  const fetch = bot.guild.channels.fetch;
  let code = 50001;
  bot.guild.channels.fetch = async (id, options) => {
    if (id === asId(2)) throw Object.assign(new Error("Unavailable"), { code });
    return fetch(id, options);
  };
  assert.match(await bot.run("reset", "honeypot"), /could not verify/);
  assert.equal(getDestinationOverride(guildId, "honeypot"), first.id);
  code = 10003;
  assert.match(await bot.run("reset", "honeypot"), /host default is unavailable/);
  assert.equal(getDestinationOverride(guildId, "honeypot"), undefined);
  assert.equal((await first.messages.fetch()).size, 0);
});

test("an old history sweep cannot write a warning after the honeypot moves", async t => {
  const bot = await fixture(t);
  const old = bot.addChannel(asId(1));
  const next = bot.addChannel(asId(2));
  await bot.run("set", "honeypot", old, { confirm: true });
  const scanned = Promise.withResolvers();
  const fetch = old.messages.fetch;
  old.messages.fetch = () => scanned.promise;
  const sweep = ensureHoneypotMessage(old, asId(90), () => getDestinationId(guildId, "honeypot") === old.id);
  old.messages.fetch = fetch;
  await bot.run("set", "honeypot", next, { confirm: true });
  scanned.resolve(new Collection());
  await sweep;
  assert.deepEqual(bot.sent.map(([id]) => id), [old.id, next.id]);
});

test("a honeypot move waits for an in-flight ban and its kick fallback", async t => {
  const bot = await fixture(t);
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const handlers = new Map();
  setupHoneypot({ once() {}, on: (event, handler) => handlers.set(event, handler) });
  const old = bot.addChannel(asId(1));
  const next = bot.addChannel(asId(2));
  await bot.run("set", "honeypot", old, { confirm: true });
  const started = Promise.withResolvers();
  const finishBan = Promise.withResolvers();
  const order = [];
  const send = next.send.bind(next);
  next.send = async content => { order.push("warning"); return send(content); };
  bot.guild.bans = { create: async () => {
    started.resolve();
    await finishBan.promise;
    throw new Error("Ban denied");
  } };
  const fetch = bot.guild.members.fetch;
  bot.guild.members.fetch = (value) => typeof value === "string"
    ? Promise.resolve({ kick: async () => order.push("kick") }) : fetch(value);
  const action = handlers.get(Events.MessageCreate)({
    channelId: old.id, guild: bot.guild, author: { id: userId }, member: { roles: { cache: new Collection() } },
    delete: async () => {}
  });
  await started.promise;
  const moving = bot.run("set", "honeypot", next, { confirm: true }).then(() => order.push("move"));
  await nextTurn();
  finishBan.resolve();
  await Promise.all([action, moving]);
  assert.deepEqual(order, ["kick", "warning", "move"]);
});

test("destination readers can run in parallel but cannot overtake a queued setting change", async t => {
  const bot = await fixture(t);
  const channel = bot.addChannel(asId(1));
  const release = Promise.withResolvers();
  const order = [];
  const first = withDestinationReadLock(guildId, () => release.promise);
  const second = withDestinationReadLock(guildId, () => order.push("second reader"));
  const write = bot.run("set", "welcome", channel).then(() => order.push("write"));
  await nextTurn();
  const before = [...order];
  const third = withDestinationReadLock(guildId, () => {
    assert.equal(getDestinationId(guildId, "welcome"), channel.id);
    order.push("third reader");
  });
  release.resolve();
  await Promise.all([first, second, write, third]);
  assert.deepEqual(before, ["second reader"]);
  assert.deepEqual(order.slice(1).sort(), ["third reader", "write"]);
});

test("clearing the destination store drops its overrides and prevents further writes", async t => {
  const bot = await fixture(t);
  const channel = bot.addChannel(asId(1));
  await bot.run("set", "welcome", channel);
  assert.equal(getDestinationOverride(guildId, "welcome"), channel.id);
  await initializeDestinations(null);
  assert.equal(canConfigureDestinations(), false);
  assert.equal(getDestinationOverride(guildId, "welcome"), undefined);
  assert.match(await bot.run("set", "welcome", channel), /configure persistent destination storage/);
});

test("atomic writes sync the parent directory after replacing the file on POSIX", async t => {
  const { path } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const operations = [];
  t.mock.method(fs, "open", async (directory, flags) => {
    assert.equal(directory, dirname(path));
    assert.equal(flags, "r");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).test, true);
    operations.push("open");
    return { sync: async () => operations.push("sync"), close: async () => operations.push("close") };
  });
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    syncBuiltinESMExports();
    await writeJsonAtomically(path, { test: true }, () => {
      assert.equal(JSON.parse(readFileSync(path, "utf8")).test, true);
      operations.push("replaced");
    });
    assert.deepEqual(operations, ["replaced", "open", "sync", "close"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).test, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
});

test("a directory sync error reports the active setting and preserves the new warning", async t => {
  const bot = await fixture(t);
  const channel = bot.addChannel(asId(1));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.mock.method(console, "warn", () => {});
  t.mock.method(fs, "open", async () => ({
    async sync() { throw Object.assign(new Error("Failed sync"), { code: "EIO" }); },
    async close() {}
  }));
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    syncBuiltinESMExports();
    await assert.doesNotReject(async () => {
      assert.match(await bot.run("set", "honeypot", channel, { confirm: true }), /could not confirm it will survive a crash/);
    });
    assert.equal(getDestinationId(guildId, "honeypot"), channel.id);
    assert.equal((await channel.messages.fetch()).size, 1);
    assert.equal(JSON.parse(await readFile(bot.path, "utf8")).guilds[guildId].honeypot, channel.id);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  }
});

test("missing destination storage directory fails closed while a new file is allowed", async t => {
  const { path } = await fixture(t);
  await initializeDestinations(null);
  await assert.rejects(initializeDestinations(join(dirname(path), "missing", "destinations.json")), { code: "ENOENT" });
  assert.equal(canConfigureDestinations(), false);
  await initializeDestinations(path);
  assert.equal(canConfigureDestinations(), true);
});

test("one server's channel validation does not delay another server's write", async t => {
  const { path } = await fixture(t);
  const validating = Promise.withResolvers();
  const validate = Promise.withResolvers();
  const first = updateDestination(guildId, "welcome", asId(1), async () => {
    validating.resolve();
    await validate.promise;
  });
  await validating.promise;
  const second = updateDestination(otherGuild, "welcome", asId(2), () => {});
  const committed = await Promise.race([second.then(() => true), delay(500, false)]);
  validate.resolve();
  await Promise.all([first, second]);
  assert.equal(committed, true);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.guilds[guildId].welcome, asId(1));
  assert.equal(saved.guilds[otherGuild].welcome, asId(2));
});

test("honeypot activation checks the exact bot warning and rolls back only its new message on a failed write", async t => {
  const bot = await fixture(t);
  const previous = bot.addChannel(asId(1));
  const target = bot.addChannel(asId(2));
  await bot.run("set", "honeypot", previous, { confirm: true });
  const [, warning] = bot.sent[0];
  const fromOtherBot = await target.send(warning);
  fromOtherBot.author.id = asId(91);
  const partial = await target.send(warning.slice(0, -3));
  t.mock.method(fs, "rename", async () => { throw Object.assign(new Error("Failed save"), { code: "EIO" }); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(bot.run("set", "honeypot", target, { confirm: true }), /Failed save/);
    assert.equal(bot.sent.length, 4);
    assert.equal((await target.messages.fetch()).size, 2);
    assert.deepEqual([...(await target.messages.fetch()).values()], [fromOtherBot, partial]);
    assert.equal(getDestinationOverride(guildId, "honeypot"), previous.id);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  const existing = await target.send(warning);
  await bot.run("set", "honeypot", target, { confirm: true });
  assert.deepEqual([...(await target.messages.fetch()).values()], [fromOtherBot, partial, existing]);
});

test("a move waits for cleanup deletion and stops further deletes in the old channel", async t => {
  const bot = await fixture(t);
  const old = bot.addChannel(asId(1));
  const next = bot.addChannel(asId(2));
  const now = Date.now();
  let clock = now - 20 * 24 * 60 * 60_000;
  t.mock.method(Date, "now", () => clock);
  await bot.run("set", "honeypot", old, { confirm: true });
  await initializeDestinations(bot.path);
  clock = now;
  const handlers = new Map();
  setupHoneypot({ user: { id: asId(90) }, guilds: { cache: new Map([[guildId, bot.guild]]) }, channels: { cache: bot.channels },
    once: (event, handler) => handlers.set(event, handler), on() {} });
  old.isTextBased = () => true;
  const started = Promise.withResolvers();
  const deleted = Promise.withResolvers();
  const messages = await old.messages.fetch();
  messages.set("1", { id: "1", author: { id: userId }, createdTimestamp: Date.now() - 24 * 60 * 60_000 });
  messages.set("2", { id: "2", author: { id: userId }, createdTimestamp: now - 15 * 24 * 60 * 60_000 });
  messages.set("3", { id: "3", author: { id: userId }, createdTimestamp: now - 21 * 24 * 60 * 60_000 });
  const removals = [];
  messages.get("2").delete = async () => removals.push("2");
  messages.get("3").delete = async () => removals.push("3");
  old.bulkDelete = async batch => { removals.push(...batch.map(msg => msg.id)); started.resolve(); await deleted.promise; };
  const sweep = handlers.get(Events.ClientReady)();
  await Promise.race([started.promise, sweep.then(() => assert.fail("Expected the cleanup to start"))]);
  const move = bot.run("set", "honeypot", next, { confirm: true });
  await nextTurn();
  const before = getDestinationId(guildId, "honeypot");
  deleted.resolve();
  await Promise.all([move, sweep]);
  assert.equal(before, old.id);
  assert.equal(getDestinationId(guildId, "honeypot"), next.id);
  assert.deepEqual(removals, ["1"]);
});

test("honeypot cleanup preserves conversation posted before activation across a restart", async t => {
  const bot = await fixture(t);
  const channel = bot.addChannel(asId(1));
  const now = Date.now();
  let clock = now - 2 * 24 * 60 * 60_000;
  t.mock.method(Date, "now", () => clock);
  await bot.run("set", "honeypot", channel, { confirm: true });
  await initializeDestinations(bot.path);
  clock = now;
  const handlers = new Map();
  setupHoneypot({ user: { id: asId(90) }, guilds: { cache: new Map([[guildId, bot.guild]]) },
    channels: { cache: bot.channels }, once: (event, handler) => handlers.set(event, handler), on() {} });
  channel.isTextBased = () => true;
  const messages = await channel.messages.fetch();
  messages.set("1", { id: "1", author: { id: userId }, createdTimestamp: now - 3 * 24 * 60 * 60_000 });
  messages.set("2", { id: "2", author: { id: userId }, createdTimestamp: now - 24 * 60 * 60_000 });
  const removed = [];
  channel.bulkDelete = async batch => removed.push(...batch.map(message => message.id));
  await handlers.get(Events.ClientReady)();
  assert.deepEqual(removed, ["2"]);
});

test("a support conflict cannot block welcome changes and stale ticket locations cannot hide a category conflict", async t => {
  const bot = await fixture(t);
  const category = bot.addChannel(asId(1), ChannelType.GuildCategory);
  const other = bot.addChannel(asId(2), ChannelType.GuildCategory);
  const target = bot.addChannel(asId(3), ChannelType.GuildCategory);
  env(t, "SUPPORT_ACCOUNT_CATEGORY_ID", category.id);
  env(t, "SUPPORT_MODERATION_CATEGORY_ID", category.id);
  const welcome = bot.addChannel(asId(4));
  env(t, "WELCOME_CHANNEL_ID", asId(99));
  assert.match(await bot.run("set", "welcome", welcome), new RegExp(welcome.id));
  assert.match(await bot.run("reset", "welcome"), /host default is unavailable/);
  await updateDestination(guildId, "support-account", other.id, () => ({ categoryId: category.id, ticketIds: [asId(5)] }));
  const fresh = new Collection(bot.channels);
  fresh.set(asId(5), { id: asId(5), parentId: category.id, type: ChannelType.GuildText });
  env(t, "SUPPORT_MODERATION_CATEGORY_ID", target.id);
  const fetch = bot.guild.channels.fetch;
  bot.guild.channels.fetch = async (...args) => args.length ? fetch(...args) : fresh;
  assert.match(await bot.run("set", "support-moderation", category), /separate categories/);
});
