const requiredEnvVars = [
  "DISCORD_TOKEN",
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

const requiredWebEnvVars = ["GITHUB_TOKEN", "REPO_DEV"];

export function ensureWebEnvVars(env = process.env) {
  const missing = requiredWebEnvVars.filter(name => !env[name]?.trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables for webserver: ${missing.join(", ")}`);
  }
}

export { requiredEnvVars, requiredWebEnvVars };
