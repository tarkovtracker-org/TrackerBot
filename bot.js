import "dotenv/config";
import { Events } from "discord.js";
import { createClient } from "./src/client/createClient.js";
import { ensureEnvVars } from "./src/config/env.js";
import { registerSlashCommands } from "./src/commands/registerSlashCommands.js";
import { registerInteractionHandler } from "./src/handlers/interactionHandler.js";
import { registerMemberHandlers } from "./src/handlers/memberHandlers.js";
import { setupHoneypot } from "./src/handlers/honeypotHandler.js";

ensureEnvVars();

const client = createClient();

client.on(Events.Error, err => {
  // Discord errors can contain request payloads; log only the diagnostic code.
  console.error("Discord client error", { code: err?.code ?? "unknown" });
});

client.once(Events.ClientReady, async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  try {
    await registerSlashCommands(client);
    console.log("Slash commands registered.");
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }
});

registerInteractionHandler(client);
registerMemberHandlers(client);
setupHoneypot(client);

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
