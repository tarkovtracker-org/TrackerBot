import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { isSupportConfigured, loadSupportContext, parseTicketTopic, supportMenuId, ticketBotAccess, ticketConfirmationId, ticketOverwrites, ticketTopic } from "../config/support.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { noMentions } from "../utils/messageReply.js";

const operations = new Set();
const bugUrl = "https://github.com/tarkovtracker-org/TarkovTracker/issues/new/choose";

export function ticketControls() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("support:close:v1").setLabel("Close ticket").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("support:reopen:v1").setLabel("Reopen (staff)").setStyle(ButtonStyle.Primary)
  );
}

export async function handleSupportInteraction(interaction) {
  const lifecycleCommand = interaction.isChatInputCommand?.() && interaction.commandName === "ticket";
  const actionId = lifecycleCommand ? `support:${interaction.options.getSubcommand()}:v1` : interaction.customId;
  const legacy = interaction.customId === "create_ticket" && isSupportConfigured();
  const menu = interaction.isStringSelectMenu?.() && interaction.customId === supportMenuId;
  const button = interaction.isButton?.() && (legacy || [
    "support:close:v1", "support:reopen:v1"
  ].includes(interaction.customId) || /^support:open:(account|moderation):[a-f0-9]{16}$/.test(interaction.customId));
  if (!menu && !button && !lifecycleCommand) return false;
  if (!interaction.inGuild()) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let key;
  let ownsLock = false;
  let mutationStarted = false;
  try {
    const context = await loadSupportContext(interaction.guild);
    const { config, channels, bot } = context;
    if (menu || legacy) {
      const value = legacy ? "account" : interaction.values.length === 1 ? interaction.values[0] : "";
      const product = Object.hasOwn(config.products, value) ? config.products[value] : null;
      if (product) {
        const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        if (!channels.get(product.channelId).permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel)) {
          await interaction.editReply({ content: "You cannot view that help channel. Ask staff to review your channel access.", allowedMentions: noMentions });
          return true;
        }
        await interaction.editReply({
          content: `${product.label} help: <#${product.channelId}>. ${value === "monitor" ? "We support the TarkovTracker integration; unrelated app issues belong with its maintainers. " : ""}Never post passwords, API tokens, or private account details.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open help channel").setURL(`https://discord.com/channels/${interaction.guildId}/${product.channelId}`),
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Tracker bug report").setURL(bugUrl)
          )], allowedMentions: noMentions
        });
      } else if (Object.hasOwn(config.tickets, value)) {
        const ticket = config.tickets[value];
        await interaction.editReply({
          content: `${ticket.label}: a private channel will be visible to you, the bot, and ${ticket.roleIds.map(roleId => `<@&${roleId}>`).join(", ")}. Discord administrators always retain access.\n${value === "moderation" ? "Share what happened, message/user links, and screenshots inside the ticket. If your report concerns someone with ticket access, use the alternative contact instead. " : "Describe the account or progress problem inside the ticket. "}Never share passwords or tokens.`,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(ticketConfirmationId(value, config)).setLabel("Open private ticket").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Alternative private contact").setURL(config.escalationUrl)
          )], allowedMentions: noMentions
        });
      } else {
        await interaction.editReply({ content: "Unknown help option. Use the current help-desk panel." });
      }
      return true;
    }

    if (actionId.startsWith("support:open:")) {
      const type = actionId.split(":")[2];
      if (actionId !== ticketConfirmationId(type, config)) {
        await interaction.editReply({ content: "The ticket audience or destination changed. Select your support option again to review the current privacy notice before opening a ticket." });
        return true;
      }
      key = `${interaction.guildId}:${interaction.user.id}:${type}`;
      if (operations.has(key)) {
        await interaction.editReply({ content: "Your ticket action is already in progress. Check its result before trying again." });
        return true;
      }
      operations.add(key);
      ownsLock = true;
      const ticket = config.tickets[type];
      // Fetch inside the lock: a prior create may have completed during configuration checks.
      const currentChannels = await interaction.guild.channels.fetch();
      const existing = currentChannels.find(channel => channel?.parentId === ticket.categoryId &&
        (parseTicketTopic(channel.topic)?.ownerId === interaction.user.id && parseTicketTopic(channel.topic)?.type === type ||
          type === "account" && channel.topic === `Ticket for ${interaction.user.id}`));
      if (existing) {
        await interaction.editReply({ content: `You already have a ticket: <#${existing.id}>. If closed, ask its staff to reopen it.`, allowedMentions: noMentions });
        return true;
      }
      mutationStarted = true;
      const created = await interaction.guild.channels.create({
        name: `${type}-ticket`, type: ChannelType.GuildText, parent: ticket.categoryId,
        topic: ticketTopic(type, interaction.user.id, "open"),
        permissionOverwrites: ticketOverwrites(interaction.guildId, bot.id, ticket, interaction.user.id, "open"),
        reason: "Member requested private support"
      });
      await created.send({
        embeds: [createCardEmbed({ title: ticket.label,
          description: `<@${interaction.user.id}> describe the issue here; include relevant links/screenshots. Do not share passwords or tokens.\nVisible to you, the bot, ${ticket.roleIds.map(roleId => `<@&${roleId}>`).join(", ")}, and Discord administrators.\nAlternative private contact: ${config.escalationUrl}` })],
        components: [ticketControls()], allowedMentions: noMentions
      }).catch(err => console.warn("Support ticket opening notice failed", { code: err?.code ?? "unknown" }));
      await interaction.editReply({ content: `Your private ticket is ready: <#${created.id}>.`, allowedMentions: noMentions })
        .catch(err => console.warn("Support ticket confirmation failed", { code: err?.code ?? "unknown" }));
      return true;
    }

    key = `${interaction.guildId}:channel:${interaction.channelId}`;
    if (operations.has(key)) {
      await interaction.editReply({ content: "A ticket action is already in progress here. Check its result before trying again." });
      return true;
    }
    operations.add(key);
    ownsLock = true;
    const channel = await interaction.guild.channels.fetch(interaction.channelId, { force: true });
    const metadata = parseTicketTopic(channel?.topic);
    const ticket = metadata && config.tickets[metadata.type];
    if (channel?.type !== ChannelType.GuildText || !ticket || channel.parentId !== ticket.categoryId || channel.guildId !== interaction.guildId) {
      await interaction.editReply({ content: "This is not a managed support ticket. Nothing changed." });
      return true;
    }
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    const staff = ticket.roleIds.some(roleId => member.roles.cache.has(roleId));
    const state = actionId === "support:close:v1" ? "closed" : "open";
    if (!staff && !(state === "closed" && member.id === metadata.ownerId)) {
      await interaction.editReply({ content: "Only this ticket's staff can reopen it; the requester or its staff can close it. Nothing changed." });
      return true;
    }
    if (metadata.state === state) {
      await interaction.editReply({ content: `This ticket is already ${state}. Nothing changed.` });
      return true;
    }
    if (!channel.permissionsFor(bot)?.has(ticketBotAccess)) throw new Error("Bot ticket permissions need review.");
    // Topic and explicit overwrites change together; never inherit category grants.
    mutationStarted = true;
    await channel.edit({
      topic: ticketTopic(metadata.type, metadata.ownerId, state),
      permissionOverwrites: ticketOverwrites(interaction.guildId, bot.id, ticket, metadata.ownerId, state),
      reason: `Support ticket ${state}`
    });
    await interaction.editReply({ content: `Ticket ${state}. History retained; ${state === "closed" ? "the requester can still read it but cannot send messages. Staff can reopen it." : "the requester can send messages again."}` })
      .catch(err => console.warn("Support lifecycle confirmation failed", { code: err?.code ?? "unknown" }));
  } catch (err) {
    console.warn("Support interaction failed", { name: err?.name ?? "unknown", code: err?.code ?? "unknown" });
    await interaction.editReply({ content: mutationStarted
      ? "The ticket action could not be confirmed. It may already have applied. Check the channel and contact staff before retrying."
      : "Support is unavailable or its configuration needs staff review. Use the permanent private-contact links in the help desk. No ticket change was attempted.",
      allowedMentions: noMentions });
  } finally {
    // Never release another request's lock after rejecting a concurrent action.
    if (ownsLock) operations.delete(key);
  }
  return true;
}
