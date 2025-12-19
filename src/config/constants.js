export const allowedCommandRoles = new Set([
  "1433391726051197020",
  "1433391010532163644",
  "1434775970044186655",
  "1433390879640653864"
]);

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
