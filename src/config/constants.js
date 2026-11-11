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
}, {});
