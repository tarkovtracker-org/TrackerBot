import { Events } from "discord.js";
import { handleChatInputCommand } from "../interactions/slashHandlers.js";
import { handleButtonInteraction } from "../interactions/buttonHandlers.js";

export function registerInteractionHandler(client) {
  client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand()) {
      await handleChatInputCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
  });
}
