import "dotenv/config";
import { Events } from "discord.js";
import { createClient } from "./src/client/createClient.js";
import { ensureEnvVars } from "./src/config/env.js";
import { initializeDestinations, isSupportActivationPending } from "./src/config/destinations.js";
import { migrateSupportActivations } from "./src/config/support.js";
import { registerSlashCommands } from "./src/commands/registerSlashCommands.js";
import { registerInteractionHandler } from "./src/handlers/interactionHandler.js";
import { registerMemberHandlers } from "./src/handlers/memberHandlers.js";
import { setupHoneypot } from "./src/handlers/honeypotHandler.js";
import { setupNikitaXFeed } from "./src/handlers/nikitaXFeed.js";

ensureEnvVars();
await initializeDestinations();

const client = createClient();
const supportRetryDelays = [1000, 5000, 30000];
const supportRetries = new Set();
let settingsReady = false;

async function stopClient() {
  process.exitCode = 1;
  try {
    await client.destroy();
  } catch (err) {
    console.warn("Bot cleanup failed", { code: err?.code ?? "unknown" });
  }
}

client.on(Events.Error, err => {
  // Discord errors can contain request payloads; log only the diagnostic code.
  console.error("Discord client error", { code: err?.code ?? "unknown" });
});

client.once(Events.ClientReady, async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  try {
    await migrateSupportActivations(client.guilds.cache.values());
  } catch (err) {
    console.error("Could not initialize help-desk activation", { code: err?.code ?? "unknown" });
    await stopClient();
    return;
  }
  settingsReady = true;
  for (const guild of client.guilds.cache.values()) {
    if (guild.available) void startSupportRetry(guild);
  }

  try {
    await registerSlashCommands(client);
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

function startSupportRetry(guild) {
  if (!settingsReady || !isSupportActivationPending(guild.id) || supportRetries.has(guild.id)) return;
  supportRetries.add(guild.id);
  return retryGuildActivation(guild.id, 0);
}

async function retryGuildActivation(guildId, attempt) {
  const guild = client.guilds.cache.get(guildId);
  if (guild?.available && isSupportActivationPending(guildId)) {
    try {
      await migrateSupportActivations([guild]);
    } catch (err) {
      console.warn("Could not retry help-desk activation", { guildId, code: err?.code ?? "unknown" });
    }
    if (guild.available && isSupportActivationPending(guildId)) {
      const delay = supportRetryDelays[attempt];
      if (delay !== undefined) {
        setTimeout(() => retryGuildActivation(guildId, attempt + 1), delay).unref();
        return;
      }
      console.warn("Help-desk activation still pending after retries", { guildId });
    }
  }
  supportRetries.delete(guildId);
}

client.on(Events.GuildAvailable, startSupportRetry);
registerInteractionHandler(client, () => settingsReady);
registerMemberHandlers(client);
setupHoneypot(client);
setupNikitaXFeed(client);

try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (err) {
  console.error("Bot login failed", { code: err?.code ?? "unknown" });
  await stopClient();
}
