// Command roles can be overridden via ALLOWED_COMMAND_ROLE_IDS (comma-separated).
// Falls back to the default role ID below when the env var is not set.
const DEFAULT_COMMAND_ROLE_IDS = ["1433391726051197020"];

export const allowedCommandRoles = new Set(
  (process.env.ALLOWED_COMMAND_ROLE_IDS || DEFAULT_COMMAND_ROLE_IDS.join(","))
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

// Admin-only commands (e.g. /wipe) require one of these roles.
// Configurable via ADMIN_ROLE_ID (comma-separated Discord role IDs).
export const adminRoles = new Set(
  (process.env.ADMIN_ROLE_ID || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

export function hasAdminRole(roleCache) {
  return roleCache.some(role => adminRoles.has(role.id));
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
