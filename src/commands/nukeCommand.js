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

// Returns human-readable feature names tied to a channel ID, so the confirm
// warning can tell the admin exactly which bot features will break.
export function getAffectedBotFeatures(channelId) {
  const features = [];
  if (process.env.WELCOME_CHANNEL_ID === channelId) features.push("welcome messages (WELCOME_CHANNEL_ID)");
  if (process.env.HONEYPOT_CHANNEL_ID === channelId) features.push("honeypot (HONEYPOT_CHANNEL_ID)");
  return features;
}

export async function executeNuke(interaction) {
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

  const affectedFeatures = getAffectedBotFeatures(channel.id);
  const isBotChannel = affectedFeatures.length > 0;

  const warningLines = [
    "This will **clone** this channel (with all permissions and settings) and then **delete the current channel**.",
    "The new channel will have a **different ID** — anything referencing this channel by ID will break.",
    "This action **cannot be undone**."
  ];

  if (isBotChannel) {
    warningLines.push(
      "",
      `⚠️ **This channel is used by the bot** for: ${affectedFeatures.join(", ")}.`,
      "Nuking it will break those bot features. Update the relevant env var(s) to the new channel ID afterward."
    );
  }

  const confirmButton = new ButtonBuilder()
    .setCustomId("confirm_nuke")
    .setLabel("Confirm Nuke")
    .setStyle(ButtonStyle.Danger);

  const cancelButton = new ButtonBuilder()
    .setCustomId("cancel_nuke")
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(confirmButton, cancelButton);

  const reply = await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "Confirm Channel Nuke",
        description: warningLines.join("\n"),
        color: colors.warning
      })
    ],
    components: [row],
    flags: MessageFlags.Ephemeral
  });

  const filter = i =>
    i.user.id === interaction.user.id &&
    (i.customId === "confirm_nuke" || i.customId === "cancel_nuke");

  try {
    const buttonInteraction = await reply.awaitMessageComponent({
      filter,
      time: CONFIRM_TIMEOUT_MS
    });

    if (buttonInteraction.customId === "cancel_nuke") {
      await buttonInteraction.update({
        embeds: [
          createCardEmbed({
            title: "Nuke Cancelled",
            description: "Channel nuke was cancelled.",
            color: colors.info
          })
        ],
        components: []
      });
      return;
    }

    await buttonInteraction.deferUpdate();

    const oldChannel = channel;
    const guild = interaction.guild;

    // Clone the channel with all carry-over properties.
    const cloneOptions = {
      name: oldChannel.name,
      type: oldChannel.type,
      topic: oldChannel.topic,
      nsfw: oldChannel.nsfw,
      rateLimitPerUser: oldChannel.rateLimitPerUser,
      parent: oldChannel.parentId,
      permissionOverwrites: oldChannel.permissionOverwrites.cache,
      reason: `/nuke by ${interaction.user.tag}`
    };

    if (oldChannel.defaultAutoArchiveDuration) {
      cloneOptions.defaultAutoArchiveDuration = oldChannel.defaultAutoArchiveDuration;
    }

    let clonedChannel;
    try {
      clonedChannel = await guild.channels.create(cloneOptions);
    } catch (err) {
      console.error("Nuke: failed to clone channel:", err);
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "Nuke Failed",
            description: "Failed to clone the channel. The original channel is untouched. Check bot permissions (Manage Channels).",
            color: colors.error
          })
        ],
        components: []
      }).catch(() => {});
      return;
    }

    // Place the clone at the old channel's position so it sits in the same spot.
    try {
      await clonedChannel.setPosition(oldChannel.position, { reason: `/nuke by ${interaction.user.tag}` });
    } catch (err) {
      // Non-fatal: the clone exists, just not at the exact position.
      console.warn("Nuke: could not restore channel position:", err);
    }

    // Delete the old channel now that the clone is in place.
    let oldChannelDeleted = true;
    try {
      await oldChannel.delete(`/nuke by ${interaction.user.tag}`);
    } catch (err) {
      console.error("Nuke: failed to delete old channel:", err);
      oldChannelDeleted = false;
    }

    // Post a fresh-chat notice in the new channel.
    await clonedChannel.send({
      embeds: [
        createCardEmbed({
          title: "Channel Nuked",
          description: `This channel was nuked by ${interaction.user}.\nAll permissions and settings were carried over from the previous channel.${isBotChannel ? "\n\n⚠️ **This was a bot-related channel** — update the bot's env configuration to use the new channel ID." : ""}`,
          color: colors.success
        })
      ]
    }).catch(() => {});

    // The original ephemeral reply lived in the deleted channel, so report the
    // final outcome in the new channel as a visible message.
    await clonedChannel.send({
      embeds: [
        createCardEmbed({
          title: oldChannelDeleted ? "Nuke Complete" : "Nuke Partially Complete",
          description: oldChannelDeleted
            ? `Channel cloned and the old one deleted. New channel ID: \`${clonedChannel.id}\`.`
            : `Channel cloned, but **the old channel could not be deleted** (check bot permissions). Two channels now exist — delete the old one manually. New channel ID: \`${clonedChannel.id}\`.`,
          color: oldChannelDeleted ? colors.success : colors.warning
        })
      ]
    }).catch(() => {});
  } catch (err) {
    if (err.code === "InteractionCollectorError") {
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "Nuke Timed Out",
            description: "Confirmation timed out. Please run /nuke again.",
            color: colors.error
          })
        ],
        components: []
      }).catch(() => {});
      return;
    }

    console.error("Error during channel nuke:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Nuke Failed",
          description: "Failed to nuke the channel. Check bot permissions.",
          color: colors.error
        })
      ],
      components: []
    }).catch(() => {});
  }
}
