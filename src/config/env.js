import { isAbsolute, resolve } from "node:path";

const requiredEnvVars = [
  "DISCORD_TOKEN",
  "AUTO_ROLE_ID_1",
  "AUTO_ROLE_ID_2",
  "AUTO_ROLE_ID_3",
  "AUTO_ROLE_ID_4",
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

export function getNikitaXFeedConfig(env = process.env) {
  const channelId = env.NIKITA_X_CHANNEL_ID?.trim();
  const guildId = env.NIKITA_X_GUILD_ID?.trim();
  if (!channelId && !guildId) return null;

  const bearerToken = env.NIKITA_X_BEARER_TOKEN?.trim();
  const stateFile = env.NIKITA_X_STATE_FILE?.trim();
  const destinationsFile = env.TRACKERBOT_DESTINATIONS_FILE?.trim();
  const translateUrl = URL.parse(env.NIKITA_X_TRANSLATE_URL?.trim() ?? "");
  if ((channelId && !/^\d{17,20}$/.test(channelId)) || (guildId && !/^\d{17,20}$/.test(guildId))
      || !bearerToken || !stateFile || !isAbsolute(stateFile)
      || destinationsFile && resolve(destinationsFile) === resolve(stateFile)
      || translateUrl?.protocol !== "https:" || translateUrl.username || translateUrl.password
      || translateUrl.search || translateUrl.hash) {
    throw new Error("Invalid Nikita X feed configuration");
  }

  return { channelId, guildId, bearerToken, stateFile, translateUrl, translateKey: env.NIKITA_X_TRANSLATE_API_KEY?.trim() };
}

export { requiredEnvVars, requiredWebEnvVars };
