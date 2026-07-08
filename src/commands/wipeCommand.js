import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  ChannelType
} from "discord.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { hasAdminRole } from "../config/constants.js";

const colors = {
  success: 0x4ade80,
  error: 0xff6b81,
  info: 0x7f8cff
};

const CONFIRM_TIMEOUT_MS = 15_000;
const MAX_DELETE_BATCHES = 50;

export async function executeWipe(interaction) {
  if (!hasAdminRole(interaction.member.roles.cache)) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Permission Required",
          description: "Only admins can use this command.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Invalid Channel",
          description: "This command can only be used in a text channel.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const confirmButton = new ButtonBuilder()
    .setCustomId("confirm_wipe")
    .setLabel("Confirm Wipe")
    .setStyle(ButtonStyle.Danger);

  const cancelButton = new ButtonBuilder()
    .setCustomId("cancel_wipe")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

  const reply = await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "Confirm Channel Wipe",
        description:
          "Are you sure you want to delete all recent messages in this channel?\n\n" +
          "This will bulk-delete messages up to 14 days old (Discord API limit). " +
          "Older messages cannot be bulk-deleted and will be skipped.\n\n" +
          "This action cannot be undone.",
        color: 0xffb347
      })
    ],
    components: [row],
    flags: MessageFlags.Ephemeral
  });

  const filter = i =>
    i.user.id === interaction.user.id &&
    (i.customId === "confirm_wipe" || i.customId === "cancel_wipe");

  try {
    const buttonInteraction = await reply.awaitMessageComponent({
      filter,
      time: CONFIRM_TIMEOUT_MS
    });

    if (buttonInteraction.customId === "cancel_wipe") {
      await buttonInteraction.update({
        embeds: [
          createCardEmbed({
            title: "Wipe Cancelled",
            description: "Channel wipe was cancelled.",
            color: colors.info
          })
        ],
        components: []
      });
      return;
    }

    await buttonInteraction.deferUpdate();

    let totalDeleted = 0;
    let batches = 0;

    while (batches < MAX_DELETE_BATCHES) {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) break;

      // bulkDelete with filterOld=true silently skips messages older than 14
      // days instead of throwing.
      const deleted = await channel.bulkDelete(messages, true);
      totalDeleted += deleted.size;

      // If nothing was deletable in this batch, stop — remaining messages are
      // all older than 14 days.
      if (deleted.size === 0) break;

      batches++;
    }

    const hitCap = batches >= MAX_DELETE_BATCHES;
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Channel Wiped",
          description: `Deleted ${totalDeleted} message(s).\n\nMessages older than 14 days cannot be bulk-deleted and were skipped.${hitCap ? "\n\nBatch limit reached — run /wipe again to continue." : ""}`,
          color: colors.success
        })
      ],
      components: []
    });
  } catch (err) {
    // awaitMessageComponent rejects with InteractionCollectorError on timeout
    if (err.code === "InteractionCollectorError") {
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "Wipe Timed Out",
            description: "Confirmation timed out. Please run /wipe again.",
            color: colors.error
          })
        ],
        components: []
      }).catch(() => {});
      return;
    }

    console.error("Error during channel wipe:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Wipe Failed",
          description: "Failed to delete messages. Check bot permissions.",
          color: colors.error
        })
      ],
      components: []
    }).catch(() => {});
  }
}
