import { PermissionFlagsBits } from "discord.js";

// Optional resource-sharing allowlist. Empty means any member who can post;
// it is independent of administrative authorization (ADMIN_ROLE_ID).
export const allowedCommandRoles = new Set(
  (process.env.ALLOWED_COMMAND_ROLE_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

// Administrative commands require one of these roles; never match by role name.
// Configurable via ADMIN_ROLE_ID (comma-separated Discord role IDs).
export const adminRoles = new Set(
  (process.env.ADMIN_ROLE_ID || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

export function hasAdminRole(roleCache) {
  return roleCache.some(role =>
    role.id !== role.guild?.id && role.name !== "@everyone" && adminRoles.has(role.id)
  );
}

export const reactionRoleButtonConfig = [
  { customId: "role_site", emoji: "🌐", label: "Site", roleName: "site" },
  { customId: "role_monitor", emoji: "🖥️", label: "Monitor", roleName: "monitor" },
  { customId: "role_polls", emoji: "📋", label: "Polls", roleName: "polls" },
  { customId: "role_news", emoji: "📰", label: "News", roleName: "news" },
  { customId: "role_notifs", emoji: "🔔", label: "Notifs", roleName: "notifs" }
];

export const reactionRoleNameMap = reactionRoleButtonConfig.reduce((map, config) => {
  map[config.customId] = config.roleName;
  return map;
}, Object.create(null));

export function getTicketStaffRoleIds() {
  const value = process.env.TICKET_STAFF_ROLE_IDS?.trim();
  if (!value) return undefined;
  return [...new Set(value.split(",").map(id => id.trim()).filter(Boolean))];
}

export function getNotificationRoleId(customId) {
  const name = reactionRoleNameMap[customId];
  return name ? process.env[`REACTION_ROLE_${name.toUpperCase()}_ID`]?.trim() || undefined : undefined;
}

// Dedicated notification roles may carry ordinary communication capabilities,
// never moderation/admin powers. Unknown future flags fail closed as well.
const safeNotificationPermissions = [
  PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.UseExternalEmojis, PermissionFlagsBits.UseExternalStickers,
  PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD,
  PermissionFlagsBits.Stream
].reduce((mask, permission) => mask | permission, 0n);

export function isSafeNotificationRole(role, guildId) {
  return role.id !== guildId && role.guild?.id === guildId && role.name !== "@everyone" &&
    role.name.trim().toLowerCase() !== "discord admin" &&
    !role.managed && role.editable && !adminRoles.has(role.id) &&
    !getTicketStaffRoleIds()?.includes(role.id) &&
    typeof role.permissions?.bitfield === "bigint" &&
    (role.permissions.bitfield & ~safeNotificationPermissions) === 0n;
}
