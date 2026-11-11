import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { hasAdminRole } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { messageReference, noMentions, postInChannel, validateReplyTarget } from "../utils/messageReply.js";

async function currentAdmin(interaction) {
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  return hasAdminRole(member.roles.cache);
}

export async function executeMessage(interaction) {
  if (!hasAdminRole(interaction.member.roles.cache)) {
    await interaction.reply({ content: "Only configured admins can send bot messages.", flags: MessageFlags.Ephemeral });
    return;
  }
  const content = interaction.options.getString("content", true).replace(/\\n/g, "\n").trim();
  const title = interaction.options.getString("title")?.trim();
  let reference;
  try {
    reference = messageReference(interaction.options.getString("reply_to"), interaction);
  } catch (err) {
    await interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!content || content.length > 2000 || (title && title.length > 256)) {
    await interaction.reply({ content: "Provide 1–2000 characters of text and at most 256 characters for the title.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!await currentAdmin(interaction)) {
      await interaction.editReply({ content: "Your admin access has changed. Nothing was sent." });
      return;
    }
    const payload = title ? { embeds: [createCardEmbed({ title, description: content })] } : { content };
    if (interaction.options.getBoolean("preview") !== false) {
      await validateReplyTarget(interaction, reference);
      const sendId = `send_message:${interaction.id}`;
      const cancelId = `cancel_message:${interaction.id}`;
      const preview = await interaction.editReply({
        ...payload,
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(sendId).setLabel("Send message").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
        )],
        allowedMentions: noMentions
      });
      const button = await preview.awaitMessageComponent({
        filter: candidate => candidate.user.id === interaction.user.id && [sendId, cancelId].includes(candidate.customId),
        time: 60_000
      });
      await button.deferUpdate();
      if (button.customId === cancelId) {
        await interaction.editReply({ content: "Message cancelled. Nothing was sent.", embeds: [], components: [] });
        return;
      }
      if (!await currentAdmin(interaction)) {
        await interaction.editReply({ content: "Your admin access has changed. Nothing was sent.", embeds: [], components: [] });
        return;
      }
    }
    await postInChannel(interaction, payload, reference);
    await interaction.editReply({ content: "Message sent.", embeds: [], components: [], allowedMentions: noMentions }).catch(err => {
      console.warn("Message sent but confirmation notice failed", { code: err.code ?? "unknown" });
    });
  } catch (err) {
    console.error("Bot message failed", { code: err.code ?? "unknown" });
    await interaction.editReply({
      content: err.code === "REPLY_TARGET_UNAVAILABLE"
        ? "The reply target could not be loaded in this channel. Nothing was sent. Check the message link or ID."
        : err.code === "InteractionCollectorError"
          ? "Preview expired. Nothing was sent; run /message again."
          : "Message could not be confirmed. Check the channel before sending again; contact staff if needed.",
      embeds: [], components: []
    });
  }
}
