import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Collection, MessageFlags, PermissionFlagsBits as Permission, PermissionsBitField } from "discord.js";
import { getDestinationId, getPreference, initializeDestinations, updateDestination } from "../src/config/destinations.js";
import { getSupportConfig } from "../src/config/support.js";
import { handleChatInputCommand } from "../src/interactions/slashHandlers.js";
import { handleButtonInteraction } from "../src/interactions/buttonHandlers.js";

const guildId = "100000000000000001";
const otherGuild = "100000000000000002";
const userId = "100000000000000003";
const roleId = "100000000000000004";
const permissions = new PermissionsBitField(Permission.Administrator);

function botFixture() {
  const role = { id: roleId, name: "Renamed notifications", guild: { id: guildId }, editable: true,
    permissions: new PermissionsBitField(0n), comparePositionTo: () => -1 };
  const changes = [];
  const member = { id: userId, permissions, roles: { highest: {}, cache: new Collection(),
    async add(id) { changes.push(id); } } };
  const guild = { id: guildId, ownerId: otherGuild,
    roles: { async fetch(id) { return id ? role : new Collection([[roleId, role]]); } },
    members: { async fetch(options) { assert.deepEqual(options, { user: userId, force: true }); return member; } } };

  async function command(group, action, values = {}, memberPermissions = permissions) {
    let result;
    const interaction = { commandName: "config", guild, guildId, memberPermissions, user: { id: userId },
      isChatInputCommand: () => true, inCachedGuild: () => true,
      options: { getSubcommandGroup: () => group, getSubcommand: () => action,
        getString: name => values[name], getRole: () => role },
      async reply(options) { assert.equal(options.flags, MessageFlags.Ephemeral); result = options.content; },
      async deferReply(options) { assert.equal(options.flags, MessageFlags.Ephemeral); },
      async editReply(options) { result = options.content; }
    };
    assert.equal(await handleChatInputCommand(interaction), true);
    return result;
  }

  async function clickNotification() {
    await handleButtonInteraction({ customId: "role_site", isButton: () => true, guild, member,
      async deferReply() {}, async editReply() {} });
  }

  return { changes, member, role, command, clickNotification };
}

async function useDefaultStorage(t) {
  const dir = await mkdtemp(join(tmpdir(), "trackerbot-config-"));
  const cwd = process.cwd();
  const override = process.env.TRACKERBOT_DESTINATIONS_FILE;
  delete process.env.TRACKERBOT_DESTINATIONS_FILE;
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    if (override !== undefined) process.env.TRACKERBOT_DESTINATIONS_FILE = override;
    await initializeDestinations(null);
    await rm(dir, { recursive: true, force: true });
  });
  await initializeDestinations();
  return join(dir, ".trackerbot-data", "discord-destinations.json");
}

test("default storage saves support links without an env path and reloads them for the correct server", async t => {
  const path = await useDefaultStorage(t);
  const { command } = botFixture();
  const defaults = {
    SUPPORT_TRACKER_CHANNEL_ID: "100000000000000010", SUPPORT_SCANNER_CHANNEL_ID: "100000000000000011",
    SUPPORT_MONITOR_CHANNEL_ID: "100000000000000012", SUPPORT_ACCOUNT_CATEGORY_ID: "100000000000000013",
    SUPPORT_MODERATION_CATEGORY_ID: "100000000000000014", SUPPORT_ACCOUNT_STAFF_ROLE_IDS: "100000000000000015",
    SUPPORT_MODERATION_STAFF_ROLE_IDS: "100000000000000016", SUPPORT_ESCALATION_URL: "https://example.test/escalation",
    SUPPORT_CONTACT_URL: "https://example.test/default"
  };
  const original = Object.fromEntries(Object.keys(defaults).map(name => [name, process.env[name]]));
  Object.assign(process.env, defaults);
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const values = { link: "contact", url: "https://example.test/contact" };
  assert.match(await command("support", "set", values, new PermissionsBitField(0n)), /Only Discord server administrators/);
  assert.match(await command("support", "set", { ...values, url: "https://secret@example.test" }), /without embedded credentials/);
  assert.match(await command("support", "set", values), /saved/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).preferences[guildId].contact, values.url);
  await initializeDestinations(null);
  await initializeDestinations();
  assert.equal(getSupportConfig(guildId).contactUrl, values.url);
  assert.equal(getSupportConfig(otherGuild).contactUrl, defaults.SUPPORT_CONTACT_URL);
  assert.match(await command("support", "list"), /example\.test\/contact/);
  assert.match(await command("support", "reset", values), /reset/);
  assert.equal(getPreference(guildId, "contact"), defaults.SUPPORT_CONTACT_URL);
});

test("notification settings extend existing files and the button applies the saved role with live safety checks", async t => {
  const path = await useDefaultStorage(t);
  const { command, role, member, changes, clickNotification } = botFixture();
  await writeFile(path, JSON.stringify({ version: 1, guilds: { [guildId]: { welcome: roleId } } }));
  await initializeDestinations();
  const values = { notification: "site" };
  member.permissions = new PermissionsBitField(0n);
  assert.match(await command("notifications", "set", values), /administrator access changed/);
  member.permissions = permissions;
  role.comparePositionTo = () => 1;
  assert.match(await command("notifications", "set", values), /below your highest role/);
  role.comparePositionTo = () => -1;
  role.permissions = permissions;
  assert.match(await command("notifications", "set", values), /basic communication permissions/);
  role.permissions = new PermissionsBitField(0n);
  const [result] = await Promise.all([
    command("notifications", "set", values),
    updateDestination(otherGuild, "welcome", otherGuild, async () => {})
  ]);
  assert.match(result, /saved/);
  await initializeDestinations();
  assert.equal(getDestinationId(guildId, "welcome"), roleId);
  assert.equal(getDestinationId(otherGuild, "welcome"), otherGuild);
  assert.match(await command("notifications", "list"), new RegExp(roleId));
  await clickNotification();
  assert.deepEqual(changes, [roleId]);
  role.permissions = permissions;
  t.mock.method(console, "warn", () => {});
  await clickNotification();
  assert.deepEqual(changes, [roleId]);
  assert.match(await command("notifications", "reset", values), /reset/);
  assert.equal(JSON.parse(await readFile(path, "utf8")).preferences[guildId], undefined);
});

test("invalid saved preferences fail closed", async t => {
  const path = await useDefaultStorage(t);
  await writeFile(path, JSON.stringify({ version: 1, guilds: {}, preferences: { [guildId]: { contact: "http://example.test" } } }));
  await assert.rejects(initializeDestinations(), /preferences in the settings file are invalid/);
});
