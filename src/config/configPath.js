import { resolve } from "node:path";

export const defaultConfigDirectory = ".trackerbot-data";

export function getConfigPath(env = process.env) {
  return env.TRACKERBOT_DESTINATIONS_FILE?.trim() || resolve(defaultConfigDirectory, "discord-destinations.json");
}
