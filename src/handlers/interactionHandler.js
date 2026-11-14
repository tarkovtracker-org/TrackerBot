import { Events, MessageFlags } from "discord.js";
import { handleChatInputCommand } from "../interactions/slashHandlers.js";
import { handleButtonInteraction } from "../interactions/buttonHandlers.js";
import { handleSupportInteraction } from "../interactions/supportHandlers.js";

export function registerInteractionHandler(client) {
  client.on(Events.InteractionCreate, async interaction => {
    try {
      // Slash commands and buttons require a guild context —
      // interaction.member is null in DMs and would crash the handlers.
      if (!interaction.inGuild()) {
        if (interaction.isRepliable()) {
          await interaction.reply({
            content: "This command can only be used in the server.",
            flags: MessageFlags.Ephemeral
          });
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        await handleChatInputCommand(interaction);
        return;
      }

      if (await handleSupportInteraction(interaction)) return;
      if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
      }
    } catch (err) {
      // SDK errors may include callback tokens in URLs and private request bodies.
      console.error("Unhandled interaction error:", { name: err?.name ?? "unknown", code: err?.code ?? "unknown" });
      try {
        if (interaction.deferred) {
          await interaction.editReply({
            content: "Something went wrong. Please try again or contact an admin."
          });
        } else if (interaction.isRepliable() && !interaction.replied) {
          await interaction.reply({
            content: "Something went wrong. Please try again or contact an admin.",
            flags: MessageFlags.Ephemeral
          });
        }
      } catch {
        // Reply may have already been sent or the interaction expired.
      }
    }
  });
}
