function parseContactLink(value) {
  if (typeof value !== "string") return undefined;
  const url = URL.parse(value.trim());
  if (url?.protocol !== "https:" || url.username || url.password || url.href.length > 512) return undefined;
  return url.href;
}

function parseRoleId(value) {
  return typeof value === "string" && /^\d{17,20}$/.test(value) ? value : undefined;
}

export const supportLinks = {
  contact: { label: "Private support contact", env: "SUPPORT_CONTACT_URL", parse: parseContactLink },
  escalation: { label: "Independent escalation contact", env: "SUPPORT_ESCALATION_URL", parse: parseContactLink }
};

export const notificationRoles = Object.fromEntries(
  ["Site", "Monitor", "Polls", "News", "Notifs"].map(label => [
    label.toLowerCase(), { label, env: `REACTION_ROLE_${label.toUpperCase()}_ID`, parse: parseRoleId }
  ])
);

export const preferences = { ...supportLinks, ...notificationRoles };
