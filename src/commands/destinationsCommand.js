import { ChannelType, MessageFlags, PermissionFlagsBits as Permission } from "discord.js";
import {
  destinations, getDestinationId, getDestinationOverride,
  getPreviousTickets, ticketDestinationKeys, updateDestination, withDestinationReadLock
} from "../config/destinations.js";
import { getNikitaXFeedConfig } from "../config/env.js";
import { parseTicketTopic } from "../config/support.js";
import { ensureHoneypotMessage, removeHoneypotWarnings } from "../handlers/honeypotHandler.js";
import { noMentions } from "../utils/messageReply.js";

class DestinationError extends Error {}

export function listDestinations(guild) {
  return Object.entries(destinations).map(([key, { label }]) => {
    const id = getDestinationId(guild.id, key);
    if (id && guild.channels.cache.has(id)) return `**${label}** <#${id}>`;
    if (getDestinationOverride(guild.id, key)) return `**${label}** Configured channel unavailable`;
    return `**${label}** No channel ID set for this server`;
  }).join("\n");
}

export async function editDestination(interaction, key, id, confirmed) {
  const guild = interaction.guild;
  const { label, types, permissions } = destinations[key];
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let unusedWarningChannel;
  try {
    let restoredChannel;
    let unavailableDefault = false;
    let previousHoneypot;
    let honeypotBotId;
    const durable = await updateDestination(guild.id, key, id, async (settings, onRollback) => {
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
      const target = id ?? configured[key];
      if (key === "honeypot") previousHoneypot = getDestinationId(guild.id, key);
      if (target) {
        let channel;
        let bot;
        let unavailable = false;
        try {
          channel = await guild.channels.fetch(target, { force: true });
          if (channel) bot = await guild.members.fetchMe({ force: true });
        } catch (error) {
          if (id) throw error;
          unavailable = ["GuildChannelUnowned", 10003].includes(error?.code);
          if (key === "honeypot" && !unavailable) {
            throw new DestinationError("The bot could not verify the host honeypot. The current destination is still active.");
          }
        }
        const usable = bot && channel.guildId === guild.id && types.includes(channel.type) && channel.permissionsFor(bot)?.has(permissions);
        if (!usable && (id || key === "honeypot" && channel)) {
          throw new DestinationError("Choose a channel or category in this server where TrackerBot has the required permissions.");
        }
        if (!id && key === "honeypot" && !channel && !unavailable) {
          throw new DestinationError("The bot could not verify the host honeypot. The current destination is still active.");
        }
        if (usable && key === "honeypot") {
          if (!confirmed) throw new DestinationError("Use confirm_honeypot to confirm that this channel can ban members who post.");
          if (!bot.permissions.any([Permission.BanMembers, Permission.KickMembers])) {
            throw new DestinationError("TrackerBot needs Ban Members or Kick Members for the honeypot.");
          }
          const warning = await ensureHoneypotMessage(channel, bot.id);
          honeypotBotId = bot.id;
          if (warning) onRollback(async () => {
            try {
              await warning.delete();
            } catch (error) {
              if (error?.code === 10008) return;
              unusedWarningChannel = channel.id;
              throw error;
            }
          });
        }
        if (!id) {
          restoredChannel = usable ? target : undefined;
          unavailableDefault = !usable;
        }
      }
      if (key === "honeypot") return { honeypotChannelId: id ?? restoredChannel };
      if (!ticketDestinationKeys.has(key)) return;
      const current = getDestinationId(guild.id, key);
      if (current === configured[key]) return;
      const channels = await guild.channels.fetch();
      const previous = current ? channels.get(current) : key === "tickets"
        ? channels.find(channel => channel.type === ChannelType.GuildCategory
          && channel.name.trim().toLowerCase() === "🆘 --- support ---") : null;
      if (key !== "tickets") {
        const other = key === "support-account" ? "support-moderation" : "support-account";
        const otherCategories = new Set([configured[other], ...getPreviousTickets(guild.id, other)
          .filter(([id, category]) => channels.get(id)?.parentId === category).map(([, category]) => category)]);
        if (configured[key] && otherCategories.has(configured[key])) {
          throw new DestinationError("Account and moderation tickets require separate categories.");
        }
      }
      const liveChannelIds = new Set(channels.keys());
      if (previous?.type !== ChannelType.GuildCategory || previous.id === configured[key]) return { liveChannelIds };
      const ticketIds = [...channels.values()].filter(channel => {
        if (channel?.type !== ChannelType.GuildText || channel.parentId !== previous.id) return false;
        if (["tickets", "support-account"].includes(key) && /^Ticket for \d{17,20}$/.test(channel.topic ?? "")) return true;
        return `support-${parseTicketTopic(channel.topic)?.type}` === key;
      }).map(channel => channel.id);
      return { categoryId: previous.id, ticketIds, liveChannelIds };
    });
    let content = id ? `${label} now uses <#${id}>.` : restoredChannel ? `${label} now uses the host default <#${restoredChannel}>.`
      : `${label} reset. ${unavailableDefault ? "The host default is unavailable in this server." : "No host default is set."}`;
    if (previousHoneypot && previousHoneypot !== (id ?? restoredChannel)) {
      try {
        await withDestinationReadLock(guild.id, async () => {
          if (getDestinationId(guild.id, "honeypot") === previousHoneypot) return;
          const channel = await guild.channels.fetch(previousHoneypot, { force: true });
          if (channel?.guildId !== guild.id || channel.type !== ChannelType.GuildText) return;
          const botId = honeypotBotId ?? (await guild.members.fetchMe({ force: true })).id;
          await removeHoneypotWarnings(channel, botId);
        });
      } catch (error) {
        if (!["GuildChannelUnowned", 10003].includes(error?.code)) {
          content += ` Check <#${previousHoneypot}> for TrackerBot's old honeypot warning.`;
        }
      }
    }
    if (!durable) content += " The reset or change is active. The bot could not confirm it will survive a crash.";
    await interaction.editReply({ content, allowedMentions: noMentions });
  } catch (error) {
    if (unusedWarningChannel) {
      await interaction.editReply({ content: `The honeypot setting could not be saved. Check <#${unusedWarningChannel}> for the unused warning.`, allowedMentions: noMentions });
      return;
    }
    if (error instanceof DestinationError) {
      await interaction.editReply({ content: error.message, allowedMentions: noMentions });
      return;
    }
    throw error;
  }
}
