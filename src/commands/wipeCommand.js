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
  info: 0x7f8cff,
  warning: 0xffb347
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

  const requested = interaction.options?.getInteger("count") ?? 100;
  if (!Number.isInteger(requested) || requested < 1 || requested > 1000) {
    await interaction.reply({ content: "Choose a message count from 1 to 1000.", flags: MessageFlags.Ephemeral });
    return;
  }

  const confirmButton = new ButtonBuilder()
    .setCustomId("confirm_wipe")
    .setLabel(`Delete up to ${requested}`)
    .setStyle(ButtonStyle.Danger);

  const cancelButton = new ButtonBuilder()
    .setCustomId("cancel_wipe")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

  await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "Confirm Message Purge",
        description:
          `Delete up to **${requested}** recent message(s) in this channel?\n\n` +
          "This will bulk-delete messages up to 14 days old (Discord API limit). " +
          "Older messages cannot be bulk-deleted and will be skipped.\n\n" +
          "This action cannot be undone.",
        color: colors.warning
      })
    ],
    components: [row],
    flags: MessageFlags.Ephemeral
  });

  const filter = i =>
    i.user.id === interaction.user.id &&
    (i.customId === "confirm_wipe" || i.customId === "cancel_wipe");

  let totalDeleted = 0;
  try {
    const reply = await interaction.fetchReply();
    const buttonInteraction = await reply.awaitMessageComponent({
      filter,
      time: CONFIRM_TIMEOUT_MS
    });

    if (buttonInteraction.customId === "cancel_wipe") {
      await buttonInteraction.update({
        embeds: [
          createCardEmbed({
            title: "Purge Cancelled",
            description: "Message purge was cancelled.",
            color: colors.info
          })
        ],
        components: []
      });
      return;
    }

    await buttonInteraction.deferUpdate();

    // Authority may have changed while the confirmation was open; bypass cache.
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!hasAdminRole(member.roles.cache)) {
      await interaction.editReply({
        embeds: [createCardEmbed({
          title: "Permission Required",
          description: "Your admin access has changed. Nothing was deleted.",
          color: colors.error
        })],
        components: []
      });
      return;
    }

    let batches = 0;

    while (totalDeleted < requested && batches < MAX_DELETE_BATCHES) {
      const messages = await channel.messages.fetch({ limit: Math.min(100, requested - totalDeleted) });
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
          title: "Message Purge Complete",
          description: `Deleted ${totalDeleted} of up to ${requested} message(s).\n\nMessages older than 14 days cannot be bulk-deleted and were skipped.${hitCap ? "\n\nBatch limit reached — run /channel purge again to continue." : ""}`,
          color: colors.success
        })
      ],
      components: []
    });
  } catch (err) {
    // awaitMessageComponent rejects with InteractionCollectorError on timeout
    if (err?.code === "InteractionCollectorError") {
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "Purge Timed Out",
            description: "Confirmation timed out. Please run /channel purge again.",
            color: colors.error
          })
        ],
        components: []
      }).catch(() => {});
      return;
    }

    console.error("Error during channel wipe:", { name: err?.name ?? "unknown", code: err?.code ?? "unknown" });
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Message Purge Failed",
          description: `Purge stopped after deleting ${totalDeleted} message(s). Check the channel and bot permissions before trying again.`,
          color: colors.error
        })
      ],
      components: []
    }).catch(() => {});
  }
}
