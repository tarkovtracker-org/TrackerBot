const requiredEnvVars = [
  "DISCORD_TOKEN",
  "BUG_REPORT_CHANNEL_ID",
  "ROLE_CHANNEL_ID",
  "TICKET_CHANNEL_ID",
  "WELCOME_CHANNEL_ID",
  "DATA_BUG_CHANNEL_ID"
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
