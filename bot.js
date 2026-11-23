import "dotenv/config";
import { Events } from "discord.js";
import { createClient } from "./src/client/createClient.js";
import { ensureEnvVars } from "./src/config/env.js";
import { initializeDestinations } from "./src/config/destinations.js";
import { migrateSupportActivations } from "./src/config/support.js";
import { registerSlashCommands } from "./src/commands/registerSlashCommands.js";
import { registerInteractionHandler } from "./src/handlers/interactionHandler.js";
import { registerMemberHandlers } from "./src/handlers/memberHandlers.js";
import { setupHoneypot } from "./src/handlers/honeypotHandler.js";
import { setupNikitaXFeed } from "./src/handlers/nikitaXFeed.js";

ensureEnvVars();
await initializeDestinations();

const client = createClient();

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
    process.exitCode = 1;
    await client.destroy().catch(cleanupError => {
      console.warn("Bot cleanup failed", { code: cleanupError?.code ?? "unknown" });
    });
    return;
  }
  registerInteractionHandler(client);

  try {
    await registerSlashCommands(client);
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

registerMemberHandlers(client);
setupHoneypot(client);
setupNikitaXFeed(client);

try {
  await client.login(process.env.DISCORD_TOKEN);
} catch (err) {
  console.error("Bot login failed", { code: err?.code ?? "unknown" });
  try {
    await client.destroy();
  } catch (cleanupError) {
    console.warn("Bot cleanup failed", { code: cleanupError?.code ?? "unknown" });
  }
  process.exitCode = 1;
}
