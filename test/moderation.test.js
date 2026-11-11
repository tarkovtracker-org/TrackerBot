import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, Collection, MessageFlags } from "discord.js";
import { adminRoles } from "../src/config/constants.js";
import { executeNuke } from "../src/commands/nukeCommand.js";
import { executeWipe } from "../src/commands/wipeCommand.js";

beforeEach(t => {
  adminRoles.add("staff");
  t.mock.method(console, "error", () => {});
});
afterEach(() => adminRoles.delete("staff"));

function fixture(command, { cancel = false, timeout = false, revoked = false, memberError = false, cloneError = false, deleteError = false, bulkError = false } = {}) {
  const events = [];
  const edits = [];
  const notices = [];
  const roles = new Collection([["staff", { id: "staff" }]]);
  let fetchedMessages = false;
  const channel = {
    id: "channel", type: ChannelType.GuildText, name: "general", topic: "topic",
    parentId: "parent", position: 3, nsfw: false, rateLimitPerUser: 5,
    permissionOverwrites: { cache: new Collection() },
    delete: async () => { events.push("delete"); if (deleteError) throw new Error("Missing permissions"); },
    messages: { fetch: async () => {
      events.push("messages");
      if (fetchedMessages) return new Collection();
      fetchedMessages = true;
      return new Collection([["message", { id: "message" }]]);
    } },
    bulkDelete: async (messages, filterOld) => {
      events.push("bulkDelete");
      assert.equal(filterOld, true);
      if (bulkError) throw new Error("Missing permissions");
      return messages;
    }
  };
  const button = {
    customId: `${cancel ? "cancel" : "confirm"}_${command}`,
    user: { id: "actor" },
    deferUpdate: async () => events.push("ack-button"),
    update: async data => { events.push("cancel"); edits.push(data); }
  };
  const interaction = {
    user: { id: "actor", tag: "actor" },
    member: { roles: { cache: roles } },
    channel,
    guild: {
      members: { fetch: async options => {
        events.push("fetch-member");
        assert.deepEqual(options, { user: "actor", force: true });
        if (memberError) throw new Error("Discord unavailable");
        return { roles: { cache: revoked ? new Collection() : roles } };
      } },
      channels: { create: async options => {
        events.push("clone");
        assert.equal(options.parent, "parent");
        assert.equal(options.permissionOverwrites, channel.permissionOverwrites.cache);
        if (cloneError) throw new Error("Missing permissions");
        return {
          id: "new-channel",
          setPosition: async () => events.push("position"),
          send: async data => { notices.push(data); events.push("notice"); }
        };
      } }
    },
    // Matches discord.js: reply without withResponse/fetchReply resolves undefined.
    reply: async data => {
      events.push("reply");
      assert.equal(data.flags, MessageFlags.Ephemeral);
      return undefined;
    },
    fetchReply: async () => {
      assert.ok(events.includes("reply"), "a real confirmation must be sent before fetching it");
      events.push("fetch-reply");
      return { awaitMessageComponent: async options => {
        assert.equal(options.filter({ ...button, user: { id: "stranger" } }), false);
        assert.equal(options.filter({ ...button, customId: "unrelated" }), false);
        assert.equal(options.filter(button), true);
        if (timeout) throw Object.assign(new Error("Timed out"), { code: "InteractionCollectorError" });
        return button;
      } };
    },
    editReply: async data => { edits.push(data); events.push("edit"); }
  };
  return { interaction, events, edits, notices };
}

for (const [name, execute, operation] of [["nuke", executeNuke, "clone"], ["wipe", executeWipe, "bulkDelete"]]) {
  test(`${name}: confirmation uses a fetched Message, not reply's undefined return`, async () => {
    const f = fixture(name);
    await execute(f.interaction);
    assert.ok(f.events.includes(operation));
    assert.ok(f.events.indexOf("fetch-reply") < f.events.indexOf("ack-button"));
    assert.ok(f.events.indexOf("ack-button") < f.events.indexOf("fetch-member"));
    assert.ok(f.events.indexOf("fetch-member") < f.events.indexOf(operation));
    if (name === "nuke") assert.ok(f.events.indexOf("clone") < f.events.indexOf("delete"));
    else assert.match(f.edits.at(-1).embeds[0].toJSON().description, /Deleted 1\b/);
  });

  test(`${name}: cancel does not mutate the channel`, async () => {
    const f = fixture(name, { cancel: true });
    await execute(f.interaction);
    assert.ok(f.events.includes("cancel"));
    assert.equal(f.events.includes(operation), false);
    assert.equal(f.events.includes("fetch-member"), false);
  });

  test(`${name}: timeout does not mutate the channel`, async () => {
    const f = fixture(name, { timeout: true });
    await execute(f.interaction);
    assert.match(f.edits.at(-1).embeds[0].toJSON().title, /Timed Out/);
    assert.deepEqual(f.edits.at(-1).components, []);
    assert.equal(f.events.includes(operation), false);
  });

  test(`${name}: revoked configured role blocks the confirmed action`, async () => {
    const f = fixture(name, { revoked: true });
    await execute(f.interaction);
    assert.equal(f.events.includes(operation), false, "revoked authority must prevent mutation");
    assert.equal(f.edits.at(-1).embeds[0].toJSON().title, "Permission Required");
    assert.deepEqual(f.edits.at(-1).components, []);
  });

  test(`${name}: member refresh failure fails closed`, async () => {
    const f = fixture(name, { memberError: true });
    await execute(f.interaction);
    assert.ok(f.events.includes("fetch-member"));
    assert.equal(f.events.includes(operation), false);
  });

  test(`${name}: non-admin cannot open a confirmation`, async () => {
    const f = fixture(name);
    f.interaction.member.roles.cache = new Collection();
    await execute(f.interaction);
    assert.deepEqual(f.events, ["reply"]);
  });
}

test("wipe: bulk deletion failure reports failure and removes confirmation buttons", async () => {
  const f = fixture("wipe", { bulkError: true });
  await executeWipe(f.interaction);
  assert.ok(f.events.includes("bulkDelete"));
  assert.equal(f.edits.at(-1).embeds[0].toJSON().title, "Wipe Failed");
  assert.deepEqual(f.edits.at(-1).components, []);
});

test("nuke: clone failure never deletes the original", async () => {
  const f = fixture("nuke", { cloneError: true });
  await executeNuke(f.interaction);
  assert.ok(f.events.includes("clone"));
  assert.equal(f.events.includes("delete"), false);
  assert.match(f.edits.at(-1).embeds[0].toJSON().description, /original channel is untouched/);
});

for (const slowmode of [0, 42]) {
  test(`nuke preserves the default thread slowmode (${slowmode})`, async () => {
    const f = fixture("nuke");
    f.interaction.channel.defaultThreadRateLimitPerUser = slowmode;
    const create = f.interaction.guild.channels.create;
    let options;
    f.interaction.guild.channels.create = async input => { options = input; return create(input); };
    await executeNuke(f.interaction);
    assert.equal(options.defaultThreadRateLimitPerUser, slowmode);
  });
}

test("nuke: deletion failure reports partial completion in the clone", async () => {
  const f = fixture("nuke", { deleteError: true });
  await executeNuke(f.interaction);
  assert.equal(f.notices.at(-1).embeds[0].toJSON().title, "Nuke Partially Complete");
});
