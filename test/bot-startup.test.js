import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function startup(mode) {
  // Exercise the real entrypoint without a token, Gateway connection, or REST calls.
  const script = `
    import { Client, Events } from "discord.js";
    import { requiredEnvVars } from "./src/config/env.js";
    for (const name of requiredEnvVars) process.env[name] = "synthetic-test-value";
    delete process.env.HONEYPOT_CHANNEL_ID;
    Client.prototype.login = async function () {
      if (${JSON.stringify(mode)} === "null-failure") throw null;
      if (${JSON.stringify(mode)}.startsWith("failure")) throw Object.assign(new Error("synthetic-sensitive-detail"), { code: "TOKEN_INVALID" });
      if (${JSON.stringify(mode)} === "client-error") this.emit(Events.Error, Object.assign(new Error("synthetic-sensitive-detail"), { code: "GATEWAY_TEST" }));
    };
    Client.prototype.destroy = async function () {
      console.log("CLIENT_DESTROYED");
      if (${JSON.stringify(mode)} === "failure-cleanup") throw new Error("synthetic-sensitive-detail");
    };
    await import("./bot.js");
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 });
}

test("failed login is caught, safely logged, closes the client and exits nonzero", () => {
  const result = startup("failure");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLIENT_DESTROYED/);
  assert.match(result.stderr, /Bot login failed/);
  assert.match(result.stderr, /TOKEN_INVALID/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});

test("null login rejection is caught and cleans up the client", () => {
  const result = startup("null-failure");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CLIENT_DESTROYED/);
  assert.match(result.stderr, /Bot login failed/);
});

test("cleanup rejection after a failed login remains safely handled", () => {
  const result = startup("failure-cleanup");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bot cleanup failed/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});

test("normal mocked startup succeeds without network or unhandled rejections", () => {
  const result = startup("success");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /CLIENT_DESTROYED/);
});

test("client error events are handled without leaking error payloads or crashing", () => {
  const result = startup("client-error");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /GATEWAY_TEST/);
  assert.doesNotMatch(result.stderr, /synthetic-sensitive-detail/);
});

function startWithPendingHelpDesk(scenario) {
  const script = `
    import assert from "node:assert/strict";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { ChannelType, Client, Collection, Events, MessageFlags, REST } from "discord.js";
    import { requiredEnvVars } from "./src/config/env.js";
    import { isSupportActive, isSupportActivationPending } from "./src/config/destinations.js";

    const dir = await mkdtemp(join(tmpdir(), "trackerbot-startup-"));
    const guildId = "100000000000000001";
    const adminRole = "100000000000000002";
    for (const name of requiredEnvVars) process.env[name] = "synthetic-test-value";
    process.env.TRACKERBOT_DESTINATIONS_FILE = join(dir, "destinations.json");
    process.env.ADMIN_ROLE_ID = adminRole;
    const guild = { id: guildId, available: false };
    const admin = { roles: { cache: new Collection([[adminRole, { id: adminRole, guild }]]) } };
    const channels = new Collection();
    const roles = new Collection();
    for (const [i, [key, type]] of [
      ["TRACKER_CHANNEL_ID", ChannelType.GuildText], ["SCANNER_CHANNEL_ID", ChannelType.GuildText],
      ["MONITOR_CHANNEL_ID", ChannelType.GuildText], ["ACCOUNT_CATEGORY_ID", ChannelType.GuildCategory],
      ["MODERATION_CATEGORY_ID", ChannelType.GuildCategory]
    ].entries()) {
      const id = "10000000000000001" + i;
      process.env["SUPPORT_" + key] = id;
      channels.set(id, { id, guildId, type, permissionsFor: () => ({ has: () => true }) });
    }
    for (const [i, key] of ["ACCOUNT_STAFF_ROLE_IDS", "MODERATION_STAFF_ROLE_IDS"].entries()) {
      const id = "10000000000000002" + i;
      process.env["SUPPORT_" + key] = id;
      roles.set(id, { id, guild });
    }
    process.env.SUPPORT_CONTACT_URL = "https://discord.com/users/100000000000000030";
    process.env.SUPPORT_ESCALATION_URL = "https://discord.com/users/100000000000000031";
    guild.channels = { cache: channels, fetch: async () => channels };
    guild.roles = { cache: roles, fetch: async () => roles };
    let restored = false;
    let fetches = 0;
    guild.members = {
      fetchMe: async () => {
        fetches++;
        if (!restored) throw new Error("temporary Discord failure");
        return { id: "100000000000000003", permissions: { has: () => true } };
      },
      fetch: async () => admin
    };

    let client;
    Client.prototype.login = async function () { client = this; };
    REST.prototype.put = async () => {};
    const originalSetTimeout = globalThis.setTimeout;
    try {
      await import("./bot.js");
      client.user = { id: "100000000000000003", tag: "test-bot" };
      client.guilds.cache.set(guildId, guild);
      await client.listeners(Events.ClientReady)[0]();
      assert.equal(isSupportActivationPending(guildId), true);
      guild.available = true;

      if (${JSON.stringify(scenario)} === "commands") {
        const dispatch = client.listeners(Events.InteractionCreate)[0];
        const base = { guildId, guild, user: { id: "100000000000000004" },
          inGuild: () => true, inCachedGuild: () => true, isRepliable: () => true };
        const replies = [];
        await dispatch({ ...base, commandName: "tt", isChatInputCommand: () => true,
          options: { getSubcommand: () => "help" }, reply: async payload => replies.push(payload) });
        assert.equal(replies[0]?.embeds?.[0].toJSON().title, "TrackerBot commands");
        await dispatch({ ...base, commandName: "support", isChatInputCommand: () => true,
          options: { getSubcommand: () => "check" },
          deferReply: async () => {}, editReply: async payload => replies.push(payload) });
        assert.match(replies[1]?.content, /ticket creation is paused/i);
        assert.match(replies[1]?.content, /Discord checks could not complete/i);
        await dispatch({ ...base, customId: "create_ticket", isChatInputCommand: () => false,
          isButton: () => true, deferReply: async () => {},
          editReply: async payload => replies.push(payload) });
        assert.match(replies[2]?.content, /ticket creation is paused/i);
        assert.equal(replies[0].flags, MessageFlags.Ephemeral);
      } else {
        const timers = [];
        globalThis.setTimeout = (run, delay) => {
          timers.push({ run, delay });
          return { unref() {} };
        };
        const available = client.listeners(Events.GuildAvailable)[0];
        await Promise.all([available(guild), available(guild)]);
        assert.equal(timers.length, 1, "a failed GuildAvailable assessment should schedule one retry");
        assert.equal(fetches, 1);
        assert.equal(isSupportActivationPending(guildId), true);
        if (${JSON.stringify(scenario)} === "retry") {
          restored = true;
          await timers.shift().run();
          assert.equal(fetches, 2);
          assert.equal(isSupportActive(guildId), true);
        } else {
          const delays = [];
          while (timers.length && delays.length < 4) {
            const { run, delay } = timers.shift();
            delays.push(delay);
            await run();
          }
          assert.deepEqual(delays, [1000, 5000, 30000]);
          assert.equal(fetches, 4);
          assert.equal(isSupportActivationPending(guildId), true);
        }
        assert.equal(timers.length, 0);
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      await rm(dir, { recursive: true, force: true });
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}

test("pending help-desk migration leaves Discord commands and staff diagnostics reachable", () => {
  startWithPendingHelpDesk("commands");
});

test("the bot recovers from a failed help-desk assessment without a second Gateway event", () => {
  startWithPendingHelpDesk("retry");
});

test("help-desk retry backoff stops after repeated failures and keeps ticket creation paused", () => {
  startWithPendingHelpDesk("exhaustion");
});
