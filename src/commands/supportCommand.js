import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder } from "discord.js";
import { hasAdminRole } from "../config/constants.js";
import { loadSupportContext, SupportConfigurationError, supportMenuId } from "../config/support.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { noMentions } from "../utils/messageReply.js";

const panelOperations = new Set();

export function supportPanel(config, guildId) {
  const products = Object.entries(config.products);
  const link = (label, url) => new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
  return {
    embeds: [createCardEmbed({ title: "How can we help?",
      description: "Choose a tool for public help, or request a private account-support/moderation ticket. Ticket access is explained before you open one. Never post passwords, tokens, or personal evidence here.\n\nThe links below work even when the bot is offline. Use Alternative contact if your concern involves someone who handles tickets. Discord administrators inherently retain ticket access." })],
    components: [
      new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(supportMenuId)
        .setPlaceholder("What do you need help with?").addOptions(
          ...products.map(([value, product]) => ({ label: product.label, value })),
          ...Object.entries(config.tickets).map(([value, ticket]) => ({ label: ticket.label, value }))
        )),
      new ActionRowBuilder().addComponents(
        ...products.map(([, product]) => link(product.label, `https://discord.com/channels/${guildId}/${product.channelId}`)),
        link("Tracker bug report", "https://github.com/tarkovtracker-org/TarkovTracker/issues/new/choose")
      ),
      new ActionRowBuilder().addComponents(link("Private contact", config.contactUrl), link("Alternative contact", config.escalationUrl))
    ], allowedMentions: noMentions
  };
}

async function requireAdmin(interaction) {
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (!hasAdminRole(member.roles.cache)) throw new Error("Configured admin access required.");
}

async function panelTarget(interaction, bot, messageId) {
  const channel = await interaction.guild.channels.fetch(interaction.channelId, { force: true });
  if (channel?.type !== ChannelType.GuildText || channel.guildId !== interaction.guildId ||
      !channel.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks])) {
    throw new Error("Panel destination must be an accessible server text channel.");
  }
  let message;
  if (messageId) {
    if (!/^\d{17,20}$/.test(messageId)) throw new Error("Provide a message ID from this channel.");
    message = await channel.messages.fetch({ message: messageId, force: true });
    if (message.author.id !== bot.id || !message.components.some(row => row.components.some(component => component.customId === supportMenuId))) {
      throw new Error("Only an existing TrackerBot help-desk panel can be updated.");
    }
  }
  return { channel, message };
}

export async function executeSupport(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const key = `${interaction.guildId}:${interaction.channelId}`;
  let ownsLock = false;
  let mutationStarted = false;
  try {
    await requireAdmin(interaction);
    const context = await loadSupportContext(interaction.guild);
    if (interaction.options.getSubcommand() === "check") {
      await interaction.editReply({ content: "Support configuration checks passed: product channels, separate ticket categories/staff roles, contact links, and required bot permissions. This does not verify member-role visibility, contact responsiveness, or production topology; complete the documented live smoke tests.", allowedMentions: noMentions });
      return;
    }
    if (panelOperations.has(key)) {
      await interaction.editReply({ content: "Another panel operation is in progress in this channel." });
      return;
    }
    panelOperations.add(key);
    ownsLock = true;
    const suppliedMessageId = interaction.options.getString("message_id");
    const messageId = suppliedMessageId?.trim();
    if (suppliedMessageId != null && !messageId) throw new Error("An update requires a nonblank message ID.");
    await panelTarget(interaction, context.bot, messageId);
    const payload = supportPanel(context.config, interaction.guildId);
    const sendId = `support_publish:${interaction.id}`;
    const cancelId = `support_cancel:${interaction.id}`;
    const preview = await interaction.editReply({ ...payload,
      content: messageId ? "Preview: update the existing panel?" : "Preview: publish a new help-desk panel? Use message_id to update an existing panel instead.",
      components: [...payload.components, new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(sendId).setLabel(messageId ? "Update panel" : "Publish panel").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      )]
    });
    const button = await preview.awaitMessageComponent({
      filter: candidate => candidate.user.id === interaction.user.id && [sendId, cancelId].includes(candidate.customId), time: 60_000
    });
    await button.deferUpdate();
    if (button.customId === cancelId) {
      await interaction.editReply({ content: "Panel cancelled. Nothing published.", embeds: [], components: [] });
      return;
    }
    await requireAdmin(interaction);
    const fresh = await loadSupportContext(interaction.guild);
    // Do not publish a different configuration from the one the admin previewed.
    if (JSON.stringify(fresh.config) !== JSON.stringify(context.config)) throw new Error("Support configuration changed; preview again.");
    const target = await panelTarget(interaction, fresh.bot, messageId);
    mutationStarted = true;
    const message = target.message ? await target.message.edit(payload) : await target.channel.send(payload);
    await interaction.editReply({ content: `Help-desk panel ${messageId ? "updated" : "published"}. Message ID: ${message.id}. Save this ID for /support panel message_id:${message.id}.`, embeds: [], components: [], allowedMentions: noMentions })
      .catch(err => console.warn("Panel confirmation failed", { code: err?.code ?? "unknown" }));
  } catch (err) {
    console.warn("Support panel/check failed", { name: err?.name ?? "unknown", code: err?.code ?? "unknown" });
    await interaction.editReply({ content: mutationStarted
      ? "Panel delivery could not be confirmed. Check this channel before repeating; it may already have applied."
      : err?.code === "InteractionCollectorError" ? "Preview expired. Nothing published."
        : err instanceof SupportConfigurationError ? `${err.message} Nothing published.`
          : "Support checks failed or admin access changed. Review the support configuration, destination, message ID, and bot permissions. Nothing published.",
      embeds: [], components: [], allowedMentions: noMentions });
  } finally {
    if (ownsLock) panelOperations.delete(key);
  }
}
