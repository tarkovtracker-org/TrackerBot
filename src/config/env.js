import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { defaultConfigDirectory, getConfigPath } from "./configPath.js";

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

function canonicalStatePath(file, useDefaultDirectory = false) {
  let directory;
  try {
    directory = realpathSync.native(dirname(file));
  } catch (error) {
    if (!useDefaultDirectory || error.code !== "ENOENT") throw error;
    directory = resolve(realpathSync.native("."), defaultConfigDirectory);
  }
  const canonical = resolve(directory, basename(file));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function getNikitaXFeedConfig(env = process.env) {
  const channelId = env.NIKITA_X_CHANNEL_ID?.trim();
  const guildId = env.NIKITA_X_GUILD_ID?.trim();
  if (!channelId && !guildId) return null;

  const bearerToken = env.NIKITA_X_BEARER_TOKEN?.trim();
  const stateFile = env.NIKITA_X_STATE_FILE?.trim();
  const destinationsFile = getConfigPath(env);
  const translateUrl = URL.parse(env.NIKITA_X_TRANSLATE_URL?.trim() ?? "");
  if ((channelId && !/^\d{17,20}$/.test(channelId)) || (guildId && !/^\d{17,20}$/.test(guildId))
      || !bearerToken || !stateFile || !isAbsolute(stateFile)
      || translateUrl?.protocol !== "https:" || translateUrl.username || translateUrl.password
      || translateUrl.search || translateUrl.hash) {
    throw new Error("Invalid Nikita X feed configuration. Check the NIKITA_X_* settings.");
  }
  if (!isAbsolute(destinationsFile)) {
    throw new Error("Invalid Nikita X feed configuration. Set TRACKERBOT_DESTINATIONS_FILE to an absolute path.");
  }
  try {
    if (canonicalStatePath(destinationsFile, !env.TRACKERBOT_DESTINATIONS_FILE?.trim()) === canonicalStatePath(stateFile)) throw new Error();
  } catch {
    throw new Error("Invalid Nikita X feed configuration. NIKITA_X_STATE_FILE and TRACKERBOT_DESTINATIONS_FILE must use separate files in existing directories.");
  }

  return { channelId, guildId, bearerToken, stateFile, translateUrl, translateKey: env.NIKITA_X_TRANSLATE_API_KEY?.trim() };
}

export { requiredEnvVars, requiredWebEnvVars };
