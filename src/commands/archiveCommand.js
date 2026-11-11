import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { adminRoles, hasAdminRole } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { noMentions } from "../utils/messageReply.js";

export async function executeArchive(interaction) {
  if (!hasAdminRole(interaction.member.roles.cache)) {
    await interaction.reply({ content: "Only configured admins can archive channels.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.channel?.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "Only server text channels can be archived.", flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guild = interaction.guild;
    const channels = await guild.channels.fetch();
    const categoryId = process.env.ARCHIVE_CATEGORY_ID?.trim();
    const category = categoryId ? channels.get(categoryId) : channels.find(channel =>
      channel?.type === ChannelType.GuildCategory && channel.name.trim().toLowerCase() === "archive"
    );
    if (category?.type !== ChannelType.GuildCategory) {
      console.warn("Archive category unavailable", { categoryId: categoryId || "legacy Archive category" });
      await interaction.editReply({ content: "Staff must configure a valid archive category in this server. Nothing changed." });
      return;
    }
    const confirmId = `archive_channel:${interaction.id}`;
    const cancelId = `cancel_archive:${interaction.id}`;
    const preview = await interaction.editReply({
      embeds: [createCardEmbed({
        title: "Archive for staff review?",
        description: "This will move the channel and **replace its permission overwrites** so only configured admin roles and the bot can view it. Discord administrators always retain access.\n\nHistory is kept; nothing is deleted. Existing private thread memberships are not revoked. Record original permissions before archiving if you may need to restore them. The bot does not save previous overwrites. Audit logs are only a limited aid, not a permission backup."
      })],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(confirmId).setLabel("Archive privately").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      )],
      allowedMentions: noMentions
    });
    const button = await preview.awaitMessageComponent({
      filter: candidate => candidate.user.id === interaction.user.id && [confirmId, cancelId].includes(candidate.customId),
      time: 60_000
    });
    await button.deferUpdate();
    if (button.customId === cancelId) {
      await interaction.editReply({ content: "Archive cancelled. Nothing changed.", embeds: [], components: [] });
      return;
    }
    const member = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!hasAdminRole(member.roles.cache)) {
      await interaction.editReply({ content: "Your admin access has changed. Nothing changed.", embeds: [], components: [] });
      return;
    }
    const roles = await guild.roles.fetch();
    if (!adminRoles.size || [...adminRoles].some(id => id === guild.id || !roles.has(id))) {
      throw Object.assign(new Error("Configured archive admin roles are invalid in this guild"), { code: "ARCHIVE_ADMIN_ROLES_INVALID" });
    }
    const bot = await guild.members.fetchMe();
    const channel = await guild.channels.fetch(interaction.channelId, { force: true });
    if (channel?.type !== ChannelType.GuildText) {
      throw Object.assign(new Error("Archive source is no longer a text channel"), { code: "ARCHIVE_SOURCE_INVALID" });
    }
    const staffAccess = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    const botAccess = [...staffAccess, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles];
    if (!channel.permissionsFor(bot)?.has(botAccess)) {
      await interaction.editReply({
        content: "The bot needs View Channel, Send Messages, Read Message History, Manage Channels and Manage Roles here. Nothing changed; ask a server administrator to review its permissions.",
        embeds: [], components: []
      });
      return;
    }
    // One atomic channel edit: never inherit a public category's overwrites.
    await channel.edit({
      parent: category.id,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: bot.id, allow: botAccess },
        ...[...adminRoles].map(id => ({ id, allow: staffAccess }))
      ],
      reason: `Private audit archive requested by ${interaction.user.id}`
    });
    await interaction.editReply({ content: "Channel archived for staff review. History was retained; no messages were deleted.", embeds: [], components: [] }).catch(err => {
      console.warn("Archive applied but confirmation notice failed", { code: err.code ?? "unknown" });
    });
  } catch (err) {
    console.error("Channel archive failed", { code: err.code ?? "unknown" });
    await interaction.editReply({
      content: err.code === "InteractionCollectorError"
        ? "Archive confirmation expired. Nothing changed."
        : "Archive could not be confirmed. Check the channel and bot permissions before retrying.",
      embeds: [], components: []
    });
  }
}
