import { createHash } from "node:crypto";
import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";
import { getDestinationId, getPreference, getPreviousTicketParent } from "./destinations.js";
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

export function isSupportConfigured(guildId) {
  return Object.values(supportTicketTypes).some(({ prefix }) => Boolean(process.env[`${prefix}_STAFF_ROLE_IDS`]?.trim()))
    || Object.keys(supportLinks).some(key => Boolean(getPreference(guildId, key)))
    || [...Object.keys(supportProducts), ...Object.keys(supportTicketTypes)]
      .some(key => Boolean(getDestinationId(guildId, `support-${key}`)));
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

export function getSupportConfig(guildId) {
  const products = Object.fromEntries(Object.entries(supportProducts).map(([key, value]) =>
    [key, { ...value, channelId: supportDestinationId(guildId, key, value.env) }]
  ));
  const tickets = Object.fromEntries(Object.entries(supportTicketTypes).map(([key, value]) => {
    return [key, { ...value, categoryId: supportDestinationId(guildId, key, `${value.prefix}_CATEGORY_ID`), roleIds: staffRoleIds(value.prefix) }];
  }));
  if (tickets.account.categoryId === tickets.moderation.categoryId ||
      tickets.account.roleIds.some(roleId => tickets.moderation.roleIds.includes(roleId))) {
    throw new SupportConfigurationError("Account and moderation support need separate categories and non-overlapping staff roles.");
  }
  return { products, tickets, contactUrl: contactUrl(guildId, "contact"), escalationUrl: contactUrl(guildId, "escalation") };
}

export async function loadSupportContext(guild) {
  const config = getSupportConfig(guild.id);
  const [channels, roles, bot] = await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe({ force: true })]);
  for (const product of Object.values(config.products)) {
    const channel = channels.get(product.channelId);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== guild.id ||
        !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      throw new SupportConfigurationError(`The ${product.env} destination is missing, is not a server text channel, or is inaccessible to the bot.`);
    }
  }
  for (const ticket of Object.values(config.tickets)) {
    const category = channels.get(ticket.categoryId);
    if (category?.type !== ChannelType.GuildCategory || category.guildId !== guild.id ||
        !category.permissionsFor(bot)?.has(ticketBotAccess)) {
      throw new SupportConfigurationError(`The ${ticket.prefix}_CATEGORY_ID destination is missing or lacks the bot's required permissions.`);
    }
    validateStaffRoles(guild.id, roles, ticket);
  }
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
