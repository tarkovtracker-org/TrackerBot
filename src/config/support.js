import { createHash } from "node:crypto";
import { ChannelType, OverwriteType, PermissionFlagsBits } from "discord.js";

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

export function isSupportConfigured() {
  const names = [
    ...Object.values(supportProducts).map(product => product.env),
    ...Object.values(supportTicketTypes).flatMap(({ prefix }) => [`${prefix}_CATEGORY_ID`, `${prefix}_STAFF_ROLE_IDS`]),
    "SUPPORT_CONTACT_URL", "SUPPORT_ESCALATION_URL"
  ];
  return names.some(name => Boolean(process.env[name]?.trim()));
}

function contactUrl(name) {
  let url;
  try { url = new URL(process.env[name]?.trim()); } catch { throw new SupportConfigurationError(`Configure ${name} as an HTTPS private-contact link.`); }
  if (url.protocol !== "https:" || url.username || url.password || url.href.length > 512) {
    throw new SupportConfigurationError(`Configure ${name} as an HTTPS private-contact link.`);
  }
  return url.href;
}

export function getSupportConfig() {
  const products = Object.fromEntries(Object.entries(supportProducts).map(([key, value]) =>
    [key, { ...value, channelId: id(process.env[value.env]?.trim(), value.env) }]
  ));
  const tickets = Object.fromEntries(Object.entries(supportTicketTypes).map(([key, value]) => {
    const roleIds = [...new Set((process.env[`${value.prefix}_STAFF_ROLE_IDS`] ?? "").split(",").map(roleId => id(roleId.trim(), `${value.prefix}_STAFF_ROLE_IDS`)))];
    return [key, { ...value, categoryId: id(process.env[`${value.prefix}_CATEGORY_ID`]?.trim(), `${value.prefix}_CATEGORY_ID`), roleIds }];
  }));
  if (tickets.account.categoryId === tickets.moderation.categoryId ||
      tickets.account.roleIds.some(roleId => tickets.moderation.roleIds.includes(roleId))) {
    throw new SupportConfigurationError("Account and moderation support need separate categories and non-overlapping staff roles.");
  }
  return { products, tickets, contactUrl: contactUrl("SUPPORT_CONTACT_URL"), escalationUrl: contactUrl("SUPPORT_ESCALATION_URL") };
}

export async function loadSupportContext(guild) {
  const config = getSupportConfig();
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
    for (const roleId of ticket.roleIds) {
      const role = roles.get(roleId);
      if (!role || role.id === guild.id || role.managed || role.guild.id !== guild.id) {
        throw new SupportConfigurationError(`A ${ticket.prefix}_STAFF_ROLE_IDS role is missing, managed, or @everyone.`);
      }
    }
  }
  return { config, channels, roles, bot };
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
