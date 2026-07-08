const requiredEnvVars = [
  "DISCORD_TOKEN",
  "BUG_REPORT_CHANNEL_ID",
  "TICKET_CHANNEL_ID",
  "WELCOME_CHANNEL_ID",
  "AUTO_ROLE_ID_1",
  "AUTO_ROLE_ID_2",
  "AUTO_ROLE_ID_3",
  "AUTO_ROLE_ID_4",
  "PANEL_ADMIN_ROLE_ID",
  "ADMIN_ROLE_ID"
];

export function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function ensureEnvVars(vars = requiredEnvVars) {
  vars.forEach(getRequiredEnv);
}

export { requiredEnvVars };
