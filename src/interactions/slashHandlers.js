import { MessageFlags } from "discord.js";
import { executeResource } from "../commands/resourceCommand.js";
import { executeMessage } from "../commands/messageCommand.js";
import { executeArchive } from "../commands/archiveCommand.js";
import { executeWipe } from "../commands/wipeCommand.js";
import { executeNuke } from "../commands/nukeCommand.js";
import { executeSupport } from "../commands/supportCommand.js";
import { handleSupportInteraction } from "./supportHandlers.js";

// One in-flight moderation action per guild/channel, including its confirmation.
// This bot is one process; a second worker requires a distributed lock.
const channelOperations = new Set();

export async function handleChatInputCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "Use this command in a server where the bot is available.", flags: MessageFlags.Ephemeral });
    return true;
  }
  if (interaction.commandName === "tt") {
    await executeResource(interaction);
    return true;
  }
  if (interaction.commandName === "ticket") {
    return handleSupportInteraction(interaction);
  }
  if (interaction.commandName === "support") {
    await executeSupport(interaction);
    return true;
  }
  if (interaction.commandName === "message") {
    await executeMessage(interaction);
    return true;
  }
  if (["channel", "nuke"].includes(interaction.commandName)) {
    const key = `${interaction.guildId}:${interaction.channelId}`;
    if (channelOperations.has(key)) {
      await interaction.reply({ content: "Another moderation action is already open in this channel. Finish or cancel it first.", flags: MessageFlags.Ephemeral });
      return true;
    }
    channelOperations.add(key);
    try {
      if (interaction.commandName === "nuke") await executeNuke(interaction);
      else {
        const action = interaction.options.getSubcommand();
        if (action === "purge") await executeWipe(interaction);
        else if (action === "archive") await executeArchive(interaction);
        else throw new Error("Unknown channel action");
      }
    } finally {
      channelOperations.delete(key);
    }
    return true;
  }
  await interaction.reply({ content: "This command was retired. Use /tt help for the current command guide.", flags: MessageFlags.Ephemeral });
  return true;
}
