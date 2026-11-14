import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChannelType, Collection, MessageFlags, OverwriteType, PermissionOverwrites, PermissionFlagsBits as P } from "discord.js";
import { adminRoles, isSafeNotificationRole } from "../src/config/constants.js";
import { getSupportConfig, loadSupportContext, parseTicketTopic, supportMenuId, ticketBotAccess, ticketConfirmationId, ticketTopic } from "../src/config/support.js";
import { handleSupportInteraction } from "../src/interactions/supportHandlers.js";
import { executeSupport, supportPanel } from "../src/commands/supportCommand.js";
import { registerInteractionHandler } from "../src/handlers/interactionHandler.js";
import { handleChatInputCommand } from "../src/interactions/slashHandlers.js";

const ids = {
  guild: "100000000000000001", bot: "100000000000000002", member: "100000000000000003",
  tracker: "100000000000000004", scanner: "100000000000000005", monitor: "100000000000000006",
  account: "100000000000000007", moderation: "100000000000000008",
  accountRole: "100000000000000009", moderationRole: "100000000000000010",
  panel: "100000000000000011", ticket: "100000000000000012", message: "100000000000000013",
  admin: "100000000000000014", other: "100000000000000015"
};
const settings = {
  SUPPORT_TRACKER_CHANNEL_ID: ids.tracker, SUPPORT_SCANNER_CHANNEL_ID: ids.scanner, SUPPORT_MONITOR_CHANNEL_ID: ids.monitor,
  SUPPORT_ACCOUNT_CATEGORY_ID: ids.account, SUPPORT_ACCOUNT_STAFF_ROLE_IDS: ids.accountRole,
  SUPPORT_MODERATION_CATEGORY_ID: ids.moderation, SUPPORT_MODERATION_STAFF_ROLE_IDS: ids.moderationRole,
  SUPPORT_CONTACT_URL: "https://discord.com/users/100000000000000020",
  SUPPORT_ESCALATION_URL: "https://discord.com/users/100000000000000021"
};
let previous;
beforeEach(t => {
  previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  adminRoles.add(ids.admin);
  t.mock.method(console, "warn", () => {});
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  adminRoles.delete(ids.admin);
});

function fixture({ actor = ids.member, actorRoles = [], action = "menu", value = "tracker", type = "moderation", state = "open" } = {}) {
  const events = [];
  const replies = [];
  const publicMessages = [];
  const created = [];
  const edits = [];
  const guild = { id: ids.guild };
  const permissions = { has: () => true };
  const member = { id: actor, roles: { cache: new Collection(actorRoles.map(id => [id, { id, guild }])) } };
  const bot = { id: ids.bot };
  const channels = new Collection();
  const roles = new Collection([ids.accountRole, ids.moderationRole, ids.admin].map(id => [id, { id, guild, managed: false }]));
  const channel = (id, type) => ({ id, type, guildId: ids.guild, permissionsFor: () => permissions });
  for (const key of ["tracker", "scanner", "monitor", "panel"]) channels.set(ids[key], channel(ids[key], ChannelType.GuildText));
  for (const key of ["account", "moderation"]) channels.set(ids[key], channel(ids[key], ChannelType.GuildCategory));
  const controls = [{ components: [{ customId: supportMenuId }] }];
  let existingMessage = { id: ids.message, author: bot, components: controls, edit: async payload => {
    events.push("panel-edit"); publicMessages.push(payload); return existingMessage;
  } };
  const panel = channels.get(ids.panel);
  panel.messages = { fetch: async options => {
    assert.deepEqual(options, { message: ids.message, force: true });
    return existingMessage;
  } };
  panel.send = async payload => { events.push("panel-send"); publicMessages.push(payload); return existingMessage; };
  const ticket = { ...channel(ids.ticket, ChannelType.GuildText), parentId: ids[type], topic: ticketTopic(type, ids.member, state),
    edit: async payload => { events.push("ticket-edit"); edits.push(payload); Object.assign(ticket, payload); return ticket; },
    send: async payload => { events.push("ticket-notice"); publicMessages.push(payload); }
  };
  if (["close", "reopen"].includes(action)) channels.set(ids.ticket, ticket);
  guild.channels = {
    fetch: async (id) => { events.push("channel-fetch"); return id ? channels.get(id) : channels; },
    create: async payload => {
      events.push("ticket-create"); created.push(payload);
      Object.assign(ticket, payload, { parentId: payload.parent });
      channels.set(ticket.id, ticket);
      return ticket;
    }
  };
  guild.roles = { fetch: async () => roles };
  guild.members = { fetchMe: async options => {
    assert.deepEqual(options, { force: true });
    return bot;
  }, fetch: async () => { events.push("member-fetch"); return member; } };
  let subcommand = "panel";
  let messageId = null;
  let confirmation = "send";
  const interaction = {
    id: "preview-id", guildId: ids.guild, guild, user: { id: actor }, member,
    channelId: ["close", "reopen"].includes(action) ? ids.ticket : ids.panel,
    channel: panel, customId: action === "menu" ? supportMenuId : action === "legacy" ? "create_ticket" :
      ["close", "reopen"].includes(action) ? `support:${action}:v1` : ticketConfirmationId(value, getSupportConfig()),
    values: [value],
    inGuild: () => true, inCachedGuild: () => true,
    isStringSelectMenu: () => action === "menu", isButton: () => action !== "menu",
    isChatInputCommand: () => false,
    options: { getSubcommand: () => subcommand, getString: () => messageId },
    deferReply: async payload => { events.push("defer"); assert.equal(payload.flags, MessageFlags.Ephemeral); },
    editReply: async payload => {
      events.push("reply"); replies.push(payload);
      return { awaitMessageComponent: async options => {
        assert.equal(options.time, 60_000);
        const candidate = { user: { id: actor }, customId: `support_${confirmation === "cancel" ? "cancel" : "publish"}:preview-id`, deferUpdate: async () => {} };
        assert.equal(options.filter({ ...candidate, user: { id: ids.other } }), false);
        assert.equal(options.filter({ ...candidate, customId: "wrong" }), false);
        assert.equal(options.filter(candidate), true);
        return candidate;
      } };
    }
  };
  return { interaction, guild, channels, roles, member, ticket, panel, replies, events, created, edits, publicMessages,
    setSubcommand: value => { subcommand = value; }, setMessageId: value => { messageId = value; },
    setConfirmation: value => { confirmation = value; }, setExistingMessage: value => { existingMessage = value; }
  };
}
const last = f => f.replies.at(-1)?.content;

for (const value of ["tracker", "scanner", "monitor"]) {
  test(`${value} routes privately to the configured channel without creating a ticket`, async () => {
    const f = fixture({ value });
    assert.equal(await handleSupportInteraction(f.interaction), true);
    assert.match(last(f), new RegExp(ids[value]));
    assert.equal(f.created.length, 0);
    assert.equal(f.publicMessages.length, 0);
    assert.equal(f.events[0], "defer");
    assert.equal(f.replies[0].components[0].toJSON().components[0].url, `https://discord.com/channels/${ids.guild}/${ids[value]}`);
    assert.deepEqual(f.replies[0].allowedMentions, { parse: [], repliedUser: false });
  });
}

test("routing checks current member visibility and never leaks an inaccessible channel link", async () => {
  const f = fixture();
  f.channels.get(ids.tracker).permissionsFor = who => ({ has: () => who.id !== ids.member });
  await handleSupportInteraction(f.interaction);
  assert.match(last(f), /cannot view/);
  assert.doesNotMatch(last(f), new RegExp(ids.tracker));
  assert.equal(f.created.length, 0);
});

for (const value of ["account", "moderation"]) {
  test(`${value} selection discloses actual staff access before requiring a separate open action`, async () => {
    const f = fixture({ value });
    await handleSupportInteraction(f.interaction);
    assert.match(last(f), new RegExp(ids[`${value}Role`]));
    assert.match(last(f), /administrators always retain access/);
    assert.equal(f.created.length, 0);
    const buttons = f.replies[0].components[0].toJSON().components;
    assert.equal(buttons[0].custom_id, ticketConfirmationId(value, getSupportConfig()));
    assert.equal(buttons[1].url, settings.SUPPORT_ESCALATION_URL);
  });
  test(`${value} ticket has explicit isolated staff access and durable metadata`, async () => {
    const f = fixture({ action: "open", value });
    await handleSupportInteraction(f.interaction);
    assert.equal(f.created.length, 1);
    const created = f.created[0];
    assert.equal(created.parent, ids[value]);
    assert.equal(created.topic, ticketTopic(value, ids.member, "open"));
    assert.equal(created.name, `${value}-ticket`, "names contain no usernames or report details");
    assert.deepEqual(created.permissionOverwrites.map(item => item.id), [ids.guild, ids.member, ids.bot, ids[`${value}Role`]]);
    assert.deepEqual(created.permissionOverwrites[0].deny, [P.ViewChannel]);
    assert.equal(created.permissionOverwrites.some(item => item.id === ids[value === "account" ? "moderationRole" : "accountRole"]), false);
    assert.deepEqual(created.permissionOverwrites[2].allow, ticketBotAccess);
    assert.equal(created.permissionOverwrites[3].allow.includes(P.ManageChannels), false);
    assert.equal(created.permissionOverwrites[1].allow.includes(P.AttachFiles), true);
    assert.equal(f.publicMessages[0].components[0].toJSON().components.length, 2);
    assert.match(last(f), /ready/);
  });
}

for (const value of ["unknown", "__proto__", "constructor"]) {
  test(`unrecognized menu value fails safely: ${value}`, async () => {
    const f = fixture({ value });
    await handleSupportInteraction(f.interaction);
    assert.match(last(f), /Unknown help option/);
    assert.equal(f.created.length, 0);
  });
}

test("legacy create_ticket uses the privacy disclosure when new support is configured", async () => {
  const f = fixture({ action: "legacy" });
  await handleSupportInteraction(f.interaction);
  assert.match(last(f), /Account/);
  assert.equal(f.created.length, 0);
  delete process.env.SUPPORT_ACCOUNT_CATEGORY_ID;
  await handleSupportInteraction(f.interaction);
  assert.match(last(f), /No ticket change was attempted/, "partial configuration must not fall back to legacy staff access");
  for (const key of Object.keys(settings)) delete process.env[key];
  assert.equal(await handleSupportInteraction(f.interaction), false, "unconfigured deployments retain the original handler");
});

test("duplicate detection uses fetched channels and recognizes legacy account tickets", async () => {
  for (const topic of [ticketTopic("account", ids.member, "open"), ticketTopic("account", ids.member, "closed"), `Ticket for ${ids.member}`]) {
    const f = fixture({ action: "open", value: "account" });
    f.channels.set(ids.ticket, { ...f.ticket, parentId: ids.account, topic });
    await handleSupportInteraction(f.interaction);
    assert.equal(f.created.length, 0);
    assert.match(last(f), /already have a ticket/);
  }
});

test("an old privacy confirmation cannot open a ticket for a changed staff audience", async () => {
  const f = fixture({ action: "open", value: "account" });
  process.env.SUPPORT_ACCOUNT_STAFF_ROLE_IDS = ids.admin;
  await handleSupportInteraction(f.interaction);
  assert.equal(f.created.length, 0);
  assert.match(last(f), /audience or destination changed/);
});

test("account tickets do not block independent moderation reports", async () => {
  const f = fixture({ action: "open", value: "moderation" });
  f.channels.set(ids.other, { parentId: ids.account, topic: ticketTopic("account", ids.member, "open") });
  await handleSupportInteraction(f.interaction);
  assert.equal(f.created.length, 1);
});

test("same-member overlapping opens never create two tickets and a later click finds the existing one", async () => {
  const f = fixture({ action: "open", value: "moderation" });
  const other = { ...f.interaction, editReply: async payload => f.replies.push(payload) };
  await Promise.all([handleSupportInteraction(f.interaction), handleSupportInteraction(other)]);
  assert.equal(f.created.length, 1);
  await handleSupportInteraction(other);
  assert.equal(f.created.length, 1);
  assert.match(last(f), /already have/);
});

test("failed opening notices do not report the created ticket as failed", async () => {
  const f = fixture({ action: "open", value: "account" });
  f.ticket.send = async () => { throw new Error("notice failed"); };
  await handleSupportInteraction(f.interaction);
  assert.equal(f.created.length, 1);
  assert.match(last(f), /ready/);
});

test("uncertain create does not retry and releases the process lock", async () => {
  const f = fixture({ action: "open", value: "account" });
  const create = f.guild.channels.create;
  let attempts = 0;
  f.guild.channels.create = async () => { attempts++; throw new Error("response lost"); };
  await handleSupportInteraction(f.interaction);
  assert.equal(attempts, 1);
  assert.match(last(f), /may already have applied/);
  f.guild.channels.create = create;
  await handleSupportInteraction(f.interaction);
  assert.equal(f.created.length, 1);
});

for (const action of ["close", "reopen"]) {
  test(`assigned moderation staff can ${action} using freshly fetched metadata and permissions`, async () => {
    const f = fixture({ action, actor: ids.other, actorRoles: [ids.moderationRole], state: action === "close" ? "open" : "closed" });
    await handleSupportInteraction(f.interaction);
    const state = action === "close" ? "closed" : "open";
    assert.equal(f.edits.length, 1);
    assert.equal(f.edits[0].topic, ticketTopic("moderation", ids.member, state));
    assert.deepEqual(f.edits[0].permissionOverwrites.map(item => item.id), [ids.guild, ids.member, ids.bot, ids.moderationRole]);
    const owner = f.edits[0].permissionOverwrites[1];
    assert.equal(owner.allow.includes(P.SendMessages), state === "open");
    assert.equal(owner.deny.includes(P.SendMessages), state === "closed");
    assert.equal(owner.deny.includes(P.CreatePublicThreads), state === "closed");
    assert.equal(owner.deny.includes(P.CreatePrivateThreads), state === "closed");
    assert.equal(owner.allow.includes(P.ViewChannel), true);
    assert.match(last(f), /History retained/);
  });
  for (const actorRoles of [[], [ids.accountRole], [ids.admin]]) {
    test(`unassigned staff cannot ${action} a moderation ticket: ${actorRoles}`, async () => {
      const f = fixture({ action, actor: ids.other, actorRoles, state: action === "close" ? "open" : "closed" });
      await handleSupportInteraction(f.interaction);
      assert.equal(f.edits.length, 0);
      assert.match(last(f), /Only this ticket's staff/);
    });
  }
}

test("requester can close but cannot reopen a closed ticket", async () => {
  const f = fixture({ action: "close" });
  await handleSupportInteraction(f.interaction);
  assert.equal(f.edits.length, 1);
  f.interaction.customId = "support:reopen:v1";
  await handleSupportInteraction(f.interaction);
  assert.equal(f.edits.length, 1);
  assert.match(last(f), /Only this ticket's staff/);
});

test("close is idempotent and same-channel operations are serialized", async () => {
  const f = fixture({ action: "close" });
  await Promise.all([handleSupportInteraction(f.interaction), handleSupportInteraction(f.interaction)]);
  assert.equal(f.edits.length, 1);
  await handleSupportInteraction(f.interaction);
  assert.equal(f.edits.length, 1);
  assert.match(last(f), /already closed/);
});

for (const mutate of [f => { f.ticket.topic = "Ticket for someone"; }, f => { f.ticket.parentId = ids.account; }, f => { f.ticket.type = ChannelType.GuildVoice; }]) {
  test("lifecycle refuses unmanaged, moved, or non-text channels", async () => {
    const f = fixture({ action: "close" }); mutate(f);
    await handleSupportInteraction(f.interaction);
    assert.equal(f.edits.length, 0);
    assert.match(last(f), /not a managed/);
  });
}

test("lifecycle refuses missing permissions and never claims an uncertain edit succeeded", async () => {
  const f = fixture({ action: "close" });
  f.ticket.permissionsFor = () => ({ has: () => false });
  await handleSupportInteraction(f.interaction);
  assert.equal(f.edits.length, 0);
  assert.match(last(f), /No ticket change was attempted/);
  f.ticket.permissionsFor = () => ({ has: () => true });
  f.ticket.edit = async () => { throw new Error("response lost"); };
  await handleSupportInteraction(f.interaction);
  assert.match(last(f), /may already have applied/);
});

test("durable ticket topic parsing is strict and contains no report content", () => {
  assert.deepEqual(parseTicketTopic(ticketTopic("account", ids.member, "closed")), { type: "account", ownerId: ids.member, state: "closed" });
  for (const value of [null, "", `trackerbot:ticket:v1:admin:${ids.member}:open`, `${ticketTopic("account", ids.member, "open")} extra`]) {
    assert.equal(parseTicketTopic(value), null);
  }
});

for (const [name, value] of [
  ["SUPPORT_TRACKER_CHANNEL_ID", ""], ["SUPPORT_ACCOUNT_CATEGORY_ID", "bad"],
  ["SUPPORT_MODERATION_CATEGORY_ID", ids.account], ["SUPPORT_MODERATION_STAFF_ROLE_IDS", ids.accountRole],
  ["SUPPORT_ACCOUNT_STAFF_ROLE_IDS", `${ids.accountRole},,`], ["SUPPORT_ACCOUNT_STAFF_ROLE_IDS", ""],
  ["SUPPORT_CONTACT_URL", "http://example.com"], ["SUPPORT_ESCALATION_URL", "https://secret@example.com"],
  ["SUPPORT_CONTACT_URL", `https://example.com/${"a".repeat(513)}`]
]) {
  test(`invalid support configuration fails closed: ${name} ${value.slice(0, 40)}`, async () => {
    const f = fixture({ action: "open", value: "account" });
    process.env[name] = value;
    assert.throws(getSupportConfig);
    await handleSupportInteraction(f.interaction);
    assert.equal(f.created.length, 0);
    assert.match(last(f), /No ticket change was attempted/);
  });
}

for (const mutate of [
  f => f.roles.delete(ids.moderationRole),
  f => { f.roles.get(ids.moderationRole).managed = true; },
  f => { process.env.SUPPORT_MODERATION_STAFF_ROLE_IDS = ids.guild; f.roles.set(ids.guild, { id: ids.guild, guild: f.guild }); },
  f => { f.channels.get(ids.account).type = ChannelType.GuildText; },
  f => { f.channels.get(ids.moderation).guildId = ids.other; },
  f => { f.channels.get(ids.tracker).type = ChannelType.GuildVoice; },
  f => { f.channels.get(ids.moderation).permissionsFor = () => ({ has: () => false }); }
]) {
  test("missing/invalid live roles, channels or bot permissions fail closed", async () => {
    const f = fixture({ action: "open", value: "account" }); mutate(f);
    await assert.rejects(loadSupportContext(f.guild));
    await handleSupportInteraction(f.interaction);
    assert.equal(f.created.length, 0);
    assert.match(last(f), /No ticket change was attempted/);
  });
}

test("both support staff sets are blocked from self-service notification-role assignment", () => {
  for (const roleId of [ids.accountRole, ids.moderationRole]) {
    assert.equal(isSafeNotificationRole({ id: roleId, name: "news", guild: { id: ids.guild }, managed: false, editable: true, permissions: { bitfield: 0n } }, ids.guild), false);
  }
});

test("panel payload is SDK-valid, contains five choices, and bot-independent fallback links", () => {
  const payload = supportPanel(getSupportConfig(), ids.guild);
  const rows = payload.components.map(row => row.toJSON());
  assert.equal(rows[0].components[0].custom_id, supportMenuId);
  assert.deepEqual(rows[0].components[0].options.map(option => option.value), ["tracker", "scanner", "monitor", "account", "moderation"]);
  assert.equal(rows.slice(1).flatMap(row => row.components).length, 6);
  assert.ok(rows.slice(1).flatMap(row => row.components).every(button => button.style === 5 && button.url.startsWith("https://")));
  assert.ok(payload.embeds[0].toJSON().description.includes("offline"));
});

test("support check is private and never publishes", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setSubcommand("check");
  await executeSupport(f.interaction);
  assert.match(last(f), /checks passed/);
  assert.equal(f.publicMessages.length, 0);
});

test("panel publish previews first, refreshes admin authority, and returns the message ID", async () => {
  const f = fixture({ actorRoles: [ids.admin] });
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 1);
  assert.match(last(f), new RegExp(ids.message));
  assert.ok(f.events.indexOf("reply") < f.events.indexOf("panel-send"));
  assert.equal(f.events.filter(event => event === "member-fetch").length, 2);
});

test("panel cancellation sends nothing and releases its lock", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setConfirmation("cancel");
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
  assert.match(last(f), /cancelled/);
  f.setConfirmation("send");
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 1);
});

for (const messageId of ["", "   "]) {
  test(`supplied blank panel update ID never publishes a new panel: ${JSON.stringify(messageId)}`, async () => {
    const f = fixture({ actorRoles: [ids.admin] }); f.setMessageId(messageId);
    await executeSupport(f.interaction);
    assert.equal(f.publicMessages.length, 0);
    assert.match(last(f), /nonblank message ID/);
    assert.match(last(f), /Nothing published/);
  });
}

for (const action of ["close", "reopen"]) {
  test(`staff can ${action} after restart with an uncached requester (real SDK serialization)`, async () => {
    const f = fixture({ action, actor: ids.other, actorRoles: [ids.moderationRole], state: action === "close" ? "open" : "closed" });
    const coldGuild = { roles: { resolve: () => null }, client: { users: { resolve: () => null } } };
    let serialized;
    const edit = f.ticket.edit;
    f.ticket.edit = async payload => {
      serialized = payload.permissionOverwrites.map(overwrite => PermissionOverwrites.resolve(overwrite, coldGuild));
      return edit(payload);
    };
    await handleSupportInteraction(f.interaction);
    assert.equal(f.edits.length, 1);
    assert.deepEqual(serialized.map(overwrite => overwrite.type), [OverwriteType.Role, OverwriteType.Member, OverwriteType.Member, OverwriteType.Role]);
    assert.equal(serialized[1].id, ids.member);
    assert.match(last(f), /History retained/);
  });
}

test("panel update edits only an existing bot-owned help panel in this channel", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setMessageId(ids.message);
  await executeSupport(f.interaction);
  assert.equal(f.events.includes("panel-edit"), true);
  assert.equal(f.events.includes("panel-send"), false);
  f.setExistingMessage({ id: ids.message, author: { id: ids.other }, components: [], edit: async payload => {
    f.publicMessages.push(payload); return { id: ids.message };
  } });
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 1);
  assert.match(last(f), /Nothing published/);
});

test("unrelated bot messages cannot be overwritten as panels", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setMessageId(ids.message);
  f.setExistingMessage({ id: ids.message, author: { id: ids.bot }, components: [], edit: async payload => {
    f.publicMessages.push(payload); return { id: ids.message };
  } });
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
});

test("panel cannot publish with missing configuration or lost admin authority", async () => {
  const f = fixture({ actorRoles: [ids.admin] });
  let fetches = 0;
  f.guild.members.fetch = async () => {
    if (++fetches === 2) f.member.roles.cache.clear();
    return f.member;
  };
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
  assert.match(last(f), /Nothing published/);
  f.member.roles.cache.set(ids.admin, { id: ids.admin, guild: f.guild });
  delete process.env.SUPPORT_CONTACT_URL;
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
});

test("unconfirmed panel delivery is not retried", async () => {
  const f = fixture({ actorRoles: [ids.admin] });
  let sends = 0;
  f.panel.send = async () => { sends++; throw new Error("response lost"); };
  await executeSupport(f.interaction);
  assert.equal(sends, 1);
  assert.match(last(f), /may already have applied/);
});

test("dispatcher handles persistent support menus without a temporary collector", async () => {
  const f = fixture();
  let handle;
  registerInteractionHandler({ on: (_event, callback) => { handle = callback; } });
  await handle(f.interaction);
  assert.match(last(f), new RegExp(ids.tracker));
  // Simulate a fresh dispatcher after restart against the same panel custom ID.
  registerInteractionHandler({ on: (_event, callback) => { handle = callback; } });
  await handle(f.interaction);
  assert.match(last(f), new RegExp(ids.tracker));
});

test("slash routing reaches admin support checks and ticket lifecycle recovery", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setSubcommand("check");
  f.interaction.isChatInputCommand = () => true;
  f.interaction.commandName = "support";
  assert.equal(await handleChatInputCommand(f.interaction), true);
  assert.match(last(f), /checks passed/);
  const ticket = fixture({ action: "close" });
  ticket.interaction.isChatInputCommand = () => true;
  ticket.interaction.commandName = "ticket";
  ticket.setSubcommand("close");
  assert.equal(await handleChatInputCommand(ticket.interaction), true);
  assert.equal(ticket.edits.length, 1);
});

test("a rejected overlapping open cannot release the first request's lock", async () => {
  const f = fixture({ action: "open", value: "account" });
  let release;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const originalCreate = f.guild.channels.create;
  let attempts = 0;
  f.guild.channels.create = async payload => {
    attempts++;
    entered();
    await gate;
    return originalCreate(payload);
  };
  const first = handleSupportInteraction(f.interaction);
  await waiting;
  const second = handleSupportInteraction(f.interaction);
  const third = handleSupportInteraction(f.interaction);
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(attempts, 1);
  } finally {
    release();
    await Promise.all([first, second, third]);
  }
  assert.equal(f.created.length, 1);
});

test("live staff-role revocation defeats stale interaction role data", async () => {
  const f = fixture({ action: "reopen", actor: ids.other, actorRoles: [ids.moderationRole], state: "closed" });
  f.guild.members.fetch = async () => ({ id: ids.other, roles: { cache: new Collection() } });
  await handleSupportInteraction(f.interaction);
  assert.equal(f.edits.length, 0);
});

test("panel configuration changes after preview require a new preview", async () => {
  const f = fixture({ actorRoles: [ids.admin] });
  let checks = 0;
  f.guild.members.fetch = async () => {
    if (++checks === 2) process.env.SUPPORT_CONTACT_URL = "https://example.com/new-contact";
    return f.member;
  };
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
  assert.match(last(f), /Nothing published/);
});

test("panel failures show safe configuration diagnostics without leaking SDK error bodies", async () => {
  const f = fixture({ actorRoles: [ids.admin] }); f.setSubcommand("check");
  delete process.env.SUPPORT_TRACKER_CHANNEL_ID;
  await executeSupport(f.interaction);
  assert.match(last(f), /SUPPORT_TRACKER_CHANNEL_ID/);
  process.env.SUPPORT_TRACKER_CHANNEL_ID = ids.tracker;
  f.guild.roles.fetch = async () => { throw new Error("secret request body"); };
  await executeSupport(f.interaction);
  assert.doesNotMatch(last(f), /secret request body/);
  assert.doesNotMatch(JSON.stringify(console.warn.mock.calls), /secret request body/);
});

test("failed final confirmations do not repeat successful mutations", async () => {
  const f = fixture({ action: "open", value: "account" });
  f.interaction.editReply = async () => { throw new Error("reply lost"); };
  await assert.doesNotReject(handleSupportInteraction(f.interaction));
  assert.equal(f.created.length, 1);
  const panel = fixture({ actorRoles: [ids.admin] });
  const edit = panel.interaction.editReply;
  let replies = 0;
  panel.interaction.editReply = async payload => {
    if (++replies === 2) throw new Error("confirmation lost");
    return edit(payload);
  };
  await assert.doesNotReject(executeSupport(panel.interaction));
  assert.equal(panel.publicMessages.length, 1);
});

test("non-admin and DM panel requests cannot publish", async () => {
  const f = fixture();
  await executeSupport(f.interaction);
  assert.equal(f.publicMessages.length, 0);
  assert.match(last(f), /admin access changed/);
  const direct = fixture();
  direct.interaction.inGuild = () => false;
  assert.equal(await handleSupportInteraction(direct.interaction), false);
  assert.equal(direct.events.length, 0);
});

test("expired acknowledgements perform no support API work", async () => {
  const f = fixture({ action: "open", value: "account" });
  f.interaction.deferReply = async () => { throw new Error("expired"); };
  await assert.rejects(handleSupportInteraction(f.interaction));
  assert.equal(f.created.length, 0);
  assert.equal(f.events.length, 0);
});
