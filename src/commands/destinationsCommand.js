import { ChannelType, MessageFlags, PermissionFlagsBits as Permission } from "discord.js";
import {
  destinations, canConfigureDestinations, getDestinationId, getDestinationOverride,
  getPreviousTickets, ticketDestinationKeys, updateDestination
} from "../config/destinations.js";
import { getNikitaXFeedConfig } from "../config/env.js";
import { parseTicketTopic } from "../config/support.js";
import { ensureHoneypotMessage } from "../handlers/honeypotHandler.js";
import { noMentions } from "../utils/messageReply.js";

class DestinationError extends Error {}

export function addDestinationOptions(command) {
  function chooseDestination(subcommand) {
    return subcommand.addStringOption(option => option.setName("destination")
      .setDescription("Where TrackerBot sends messages or creates channels")
      .setRequired(true).addChoices(...Object.entries(destinations).map(([value, { label: name }]) => ({ name, value }))));
  }

  function confirmHoneypot(subcommand) {
    return subcommand.addBooleanOption(option => option.setName("confirm_honeypot")
      .setDescription("Confirm that posting in the selected honeypot can ban users"));
  }

  return command.setDefaultMemberPermissions(Permission.Administrator)
    .addSubcommand(subcommand => subcommand.setName("list").setDescription("Show this server's bot destinations"))
    .addSubcommand(subcommand => confirmHoneypot(chooseDestination(subcommand.setName("set")
      .setDescription("Set a bot destination for this server"))
      .addChannelOption(option => option.setName("channel").setDescription("Destination channel or category")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory).setRequired(true))))
    .addSubcommand(subcommand => confirmHoneypot(chooseDestination(subcommand.setName("reset")
      .setDescription("Restore the host default for a bot destination"))));
}

export async function executeDestinations(interaction) {
  if (!interaction.memberPermissions?.has(Permission.Administrator)) {
    await interaction.reply({ content: "Only Discord server administrators can configure bot destinations.", flags: MessageFlags.Ephemeral });
    return;
  }
  const action = interaction.options.getSubcommand();
  const guild = interaction.guild;
  if (action === "list") {
    const lines = Object.entries(destinations).map(([key, { label }]) => {
      const id = getDestinationId(guild.id, key);
      if (id && guild.channels.cache.has(id)) return `**${label}** <#${id}>`;
      if (getDestinationOverride(guild.id, key)) return `**${label}** Configured channel unavailable`;
      return `**${label}** No channel ID set for this server`;
    });
    await interaction.reply({ content: lines.join("\n"), allowedMentions: noMentions, flags: MessageFlags.Ephemeral });
    return;
  }

  if (!canConfigureDestinations()) {
    await interaction.reply({ content: "The bot host must configure persistent destination storage first.", flags: MessageFlags.Ephemeral });
    return;
  }
  const key = interaction.options.getString("destination", true);
  if (!Object.hasOwn(destinations, key) || !["set", "reset"].includes(action)) throw new Error("Unexpected destination action");
  const { label, types, permissions } = destinations[key];
  const id = action === "set" ? interaction.options.getChannel("channel", true).id : null;
  const confirmed = interaction.options.getBoolean("confirm_honeypot");
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    await updateDestination(guild.id, key, id, async settings => {
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (!member.permissions.has(Permission.Administrator)) throw new DestinationError("Your server administrator access changed.");

      if (key === "nikita" && getNikitaXFeedConfig()?.guildId !== guild.id) {
        throw new DestinationError("The bot host must enable the Nikita feed for this server first.");
      }
      const configured = Object.fromEntries(Object.entries(destinations).map(([name, { env }]) =>
        [name, settings[name] ?? process.env[env]?.trim()]));
      if (configured.honeypot && Object.entries(configured).some(([name, value]) => name !== "honeypot" && value === configured.honeypot)) {
        throw new DestinationError("Use a dedicated channel for the honeypot. It cannot share another bot destination.");
      }
      function categoriesFor(name) {
        const past = getPreviousTickets(guild.id, name)
          .filter(([ticketId, category]) => guild.channels.cache.get(ticketId)?.parentId === category)
          .map(([, category]) => category);
        return [configured[name], ...past].filter(Boolean);
      }
      const accountCategories = categoriesFor("support-account");
      const moderationCategories = categoriesFor("support-moderation");
      if (accountCategories.some(category => moderationCategories.includes(category))) {
        throw new DestinationError("Account and moderation tickets require separate categories.");
      }
      const target = id ?? (key === "honeypot" ? configured.honeypot : null);
      if (target && (id || guild.channels.cache.has(target))) {
        const [channel, bot] = await Promise.all([
          guild.channels.fetch(target, { force: true }),
          guild.members.fetchMe({ force: true })
        ]);
        if (!channel || channel.guildId !== guild.id || !types.includes(channel.type) || !channel.permissionsFor(bot)?.has(permissions)) {
          throw new DestinationError("Choose a channel or category in this server where TrackerBot has the required permissions.");
        }
        if (key === "honeypot") {
          if (!confirmed) throw new DestinationError("Use confirm_honeypot to confirm that this channel can ban members who post.");
          if (!bot.permissions.any([Permission.BanMembers, Permission.KickMembers])) {
            throw new DestinationError("TrackerBot needs Ban Members or Kick Members for the honeypot.");
          }
          await ensureHoneypotMessage(channel);
        }
      }
      if (!ticketDestinationKeys.has(key)) return;
      const current = getDestinationId(guild.id, key);
      const previous = current ? guild.channels.cache.get(current) : key === "tickets"
        ? guild.channels.cache.find(channel => channel.type === ChannelType.GuildCategory
          && channel.name.trim().toLowerCase() === "🆘 --- support ---")
        : null;
      if (previous?.type === ChannelType.GuildCategory && previous.id !== configured[key]) {
        const channels = await guild.channels.fetch();
        const ticketIds = [...channels.values()].filter(channel => {
          if (channel?.type !== ChannelType.GuildText || channel.parentId !== previous.id) return false;
          if (["tickets", "support-account"].includes(key) && /^Ticket for \d{17,20}$/.test(channel.topic ?? "")) return true;
          return `support-${parseTicketTopic(channel.topic)?.type}` === key;
        }).map(channel => channel.id);
        return { categoryId: previous.id, ticketIds };
      }
    });
    const content = id ? `${label} now uses <#${id}>.` : `${label} now uses the host default.`;
    await interaction.editReply({ content, allowedMentions: noMentions });
  } catch (error) {
    if (error instanceof DestinationError) {
      await interaction.editReply({ content: error.message, allowedMentions: noMentions });
      return;
    }
    throw error;
  }
}
