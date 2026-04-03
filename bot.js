import "dotenv/config";
import { Events } from "discord.js";
import { createClient } from "./src/client/createClient.js";
import { ensureEnvVars } from "./src/config/env.js";
import { registerSlashCommands } from "./src/commands/registerSlashCommands.js";
import { registerInteractionHandler } from "./src/handlers/interactionHandler.js";
import { registerMemberHandlers } from "./src/handlers/memberHandlers.js";

ensureEnvVars();

const client = createClient();

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

client.login(process.env.DISCORD_TOKEN);
