import { createHash } from "node:crypto";
import { ChannelType, OverwriteType, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { getDestinationId, getPreference, getPreviousTicketParent,
  initializeSupportActivations } from "./destinations.js";
import { supportLinks } from "./preferences.js";

export const supportMenuId = "support:route:v1";
export const supportProducts = {
  tracker: { label: "TarkovTracker.org", env: "SUPPORT_TRACKER_CHANNEL_ID" },
  scanner: { label: "RatScanner", env: "SUPPORT_SCANNER_CHANNEL_ID" },
  monitor: { label: "TarkovMonitor", env: "SUPPORT_MONITOR_CHANNEL_ID" }
};
export const supportTicketTypes = {
  account: { label: "Account / lost progress", prefix: "SUPPORT_ACCOUNT" },
  moderation: { label: "Harassment / unwanted DMs", prefix: "SUPPORT_MODERATION" }
};
export const conversationAccess = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks
];
export const ticketBotAccess = [...conversationAccess, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];

export class SupportConfigurationError extends Error {}

function id(value, name) {
  if (!/^\d{17,20}$/.test(value ?? "")) throw new SupportConfigurationError(`Configure valid Discord IDs in ${name}.`);
  return value;
}

function supportDestinationId(guildId, key, name) {
  const value = getDestinationId(guildId, `support-${key}`);
  if (!/^\d{17,20}$/.test(value ?? "")) {
    throw new SupportConfigurationError(`Choose the support destination with \`/config edit setting:support-${key} action:set channel:<channel-or-category>\` or configure ${name} on the host.`);
  }
  return value;
}

export function migrateSupportActivations(guilds) {
  return initializeSupportActivations(shouldAssess => Promise.all([...guilds]
    .filter(guild => shouldAssess(guild.id))
    .map(async guild => [guild.id, await assessExistingHelpDesk(guild)])));
}

function hasExistingSupportConfiguration(guildId) {
  // Match the settings that selected the help-desk route before explicit activation existed.
  return Object.values(supportTicketTypes).some(({ prefix }) => Boolean(process.env[`${prefix}_STAFF_ROLE_IDS`]?.trim()))
    || Object.keys(supportLinks).some(key => Boolean(getPreference(guildId, key)))
    || [...Object.keys(supportProducts), ...Object.keys(supportTicketTypes)]
      .some(key => Boolean(getDestinationId(guildId, `support-${key}`)));
}

async function assessExistingHelpDesk(guild) {
  if (guild.available === false) return null;
  // A managed ticket is evidence of previous use even if the configuration has since broken.
  if (guild.channels.cache.some(channel => {
    const ticket = channel.type === ChannelType.GuildText && parseTicketTopic(channel.topic);
    if (!ticket || !channel.parentId) return false;
    const key = `support-${ticket.type}`;
    return channel.parentId === getDestinationId(guild.id, key)
      || channel.parentId === getPreviousTicketParent(guild.id, key, channel.id);
  })) return true;

  if (!hasExistingSupportConfiguration(guild.id)) return false;
  const { config, problems } = readSupportConfig(guild.id);
  if (problems.length) return "review";
  const bot = guild.members.me ?? await guild.members.fetchMe({ force: true }).catch(() => null);
  if (!bot) return null;
  checkSupportResources(problems, config, guild, guild.channels.cache, guild.roles.cache, bot);
  return problems.length ? "review" : true;
}

function contactUrl(guildId, key) {
  const { env, parse } = supportLinks[key];
  const url = parse(getPreference(guildId, key));
  if (!url) throw new SupportConfigurationError(`Set an HTTPS private-contact link with \`/config edit setting:${key} action:set url:<https-link>\` or configure ${env} on the host.`);
  return url;
}

function staffRoleIds(prefix) {
  const name = `${prefix}_STAFF_ROLE_IDS`;
  return [...new Set((process.env[name] ?? "").split(",").map(roleId => id(roleId.trim(), name)))];
}

function validateStaffRoles(guildId, roles, ticket) {
  for (const roleId of ticket.roleIds) {
    const role = roles.get(roleId);
    if (!role || role.id === guildId || role.managed || role.guild.id !== guildId) {
      throw new SupportConfigurationError(`A ${ticket.prefix}_STAFF_ROLE_IDS role is missing, managed, or @everyone.`);
    }
  }
}

function collectProblem(problems, read) {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof SupportConfigurationError)) throw error;
    problems.push(error.message);
  }
}

function readSupportConfig(guildId) {
  const problems = [];
  const read = callback => collectProblem(problems, callback);
  const products = Object.fromEntries(Object.entries(supportProducts).map(([key, value]) =>
    [key, { ...value, channelId: read(() => supportDestinationId(guildId, key, value.env)) }]
  ));
  const tickets = Object.fromEntries(Object.entries(supportTicketTypes).map(([key, value]) =>
    [key, { ...value, categoryId: read(() => supportDestinationId(guildId, key, `${value.prefix}_CATEGORY_ID`)),
      roleIds: read(() => staffRoleIds(value.prefix)) ?? [] }]
  ));
  if (tickets.account.categoryId && tickets.account.categoryId === tickets.moderation.categoryId) {
    problems.push("Account and moderation support need separate categories.");
  }
  if (tickets.account.roleIds.some(roleId => tickets.moderation.roleIds.includes(roleId))) {
    problems.push("Account and moderation support need non-overlapping staff roles.");
  }
  const config = { products, tickets, contactUrl: read(() => contactUrl(guildId, "contact")),
    escalationUrl: read(() => contactUrl(guildId, "escalation")) };
  return { config, problems };
}

export function getSupportConfig(guildId) {
  const { config, problems } = readSupportConfig(guildId);
  if (problems.length) throw new SupportConfigurationError(problems.join("\n"));
  return config;
}

function checkSupportDestination(problems, guild, channel, type, bot, required, env, label) {
  if (channel?.type !== type || channel.guildId !== guild.id) {
    problems.push(`${label} (${env}): choose a ${type === ChannelType.GuildCategory ? "category" : "text channel"} in this server.`);
    return;
  }
  const permissions = channel.permissionsFor(bot);
  const missing = new PermissionsBitField(required.filter(permission => !permissions?.has(permission)));
  if (missing.bitfield) {
    const names = missing.toArray().map(name => name.replace(/([a-z])([A-Z])/g, "$1 $2"));
    problems.push(`${label} (${env}): give TrackerBot ${names.join(", ")} in <#${channel.id}>.`);
  }
}

function checkSupportResources(problems, config, guild, channels, roles, bot) {
  for (const product of Object.values(config.products)) {
    if (!product.channelId) continue;
    checkSupportDestination(problems, guild, channels.get(product.channelId), ChannelType.GuildText, bot,
      [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], product.env, product.label);
  }
  for (const ticket of Object.values(config.tickets)) {
    if (ticket.categoryId) {
      checkSupportDestination(problems, guild, channels.get(ticket.categoryId), ChannelType.GuildCategory, bot,
        ticketBotAccess, `${ticket.prefix}_CATEGORY_ID`, ticket.label);
    }
    collectProblem(problems, () => validateStaffRoles(guild.id, roles, ticket));
  }
}

export async function loadSupportContext(guild) {
  const { config, problems } = readSupportConfig(guild.id);
  const [channels, roles, bot] = await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe({ force: true })]);
  checkSupportResources(problems, config, guild, channels, roles, bot);
  if (problems.length) throw new SupportConfigurationError(problems.map(problem => `• ${problem}`).join("\n"));
  return { config, channels, roles, bot };
}

export async function loadSupportTicket(guild, channelId) {
  const channel = await guild.channels.fetch(channelId, { force: true });
  const metadata = parseTicketTopic(channel?.topic);
  if (channel?.type !== ChannelType.GuildText || channel.guildId !== guild.id || !metadata || !channel.parentId) return null;
  const key = `support-${metadata.type}`;
  if (channel.parentId !== getDestinationId(guild.id, key)
      && channel.parentId !== getPreviousTicketParent(guild.id, key, channel.id)) return null;
  const type = supportTicketTypes[metadata.type];
  const ticket = { ...type, roleIds: staffRoleIds(type.prefix) };
  const other = metadata.type === "account" ? supportTicketTypes.moderation : supportTicketTypes.account;
  if ((process.env[`${other.prefix}_STAFF_ROLE_IDS`] ?? "").split(",").some(roleId => ticket.roleIds.includes(roleId.trim()))) {
    throw new SupportConfigurationError("Account and moderation support need non-overlapping staff roles.");
  }
  const [roles, bot] = await Promise.all([guild.roles.fetch(), guild.members.fetchMe({ force: true })]);
  validateStaffRoles(guild.id, roles, ticket);
  return { channel, metadata, ticket, bot };
}

export function ticketConfirmationId(type, config) {
  const ticket = config.tickets[type];
  const fingerprint = createHash("sha256").update(JSON.stringify({
    categoryId: ticket.categoryId, roleIds: [...ticket.roleIds].sort(), escalationUrl: config.escalationUrl
  })).digest("hex").slice(0, 16);
  return `support:open:${type}:${fingerprint}`;
}

export function ticketTopic(type, ownerId, state) {
  return `trackerbot:ticket:v1:${type}:${ownerId}:${state}`;
}

export function parseTicketTopic(topic) {
  const match = /^trackerbot:ticket:v1:(account|moderation):(\d{17,20}):(open|closed)$/.exec(topic ?? "");
  return match ? { type: match[1], ownerId: match[2], state: match[3] } : null;
}

export function ticketOverwrites(guildId, botId, ticket, ownerId, state) {
  return [
    { id: guildId, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ownerId, type: OverwriteType.Member, allow: conversationAccess.filter(bit => state === "open" || bit !== PermissionFlagsBits.SendMessages),
      deny: state === "closed" ? [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads] : [] },
    { id: botId, type: OverwriteType.Member, allow: ticketBotAccess },
    ...ticket.roleIds.map(roleId => ({ id: roleId, type: OverwriteType.Role, allow: conversationAccess }))
  ];
}
