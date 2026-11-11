import { ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";
import { reactionRoleNameMap, getTicketStaffRoleIds, getNotificationRoleId, isSafeNotificationRole } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";

const colors = {
  success: 0x4ade80,
  error: 0xff6b81,
  info: 0x7f8cff
};

// Serialize same-member ticket creation and notification toggles independently.
// Like the rest of the bot, this lock is process-local, not distributed.
const activeButtons = new Set();

export async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return false;
  const ticket = interaction.customId === "create_ticket";
  const roleName = reactionRoleNameMap[interaction.customId];
  if (!ticket && !roleName) return false;
  if (!interaction.guild || !interaction.member?.id) {
    await interaction.reply({ content: "Use this button in a server where the bot is available.", flags: MessageFlags.Ephemeral });
    return true;
  }
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.warn("Unable to acknowledge button interaction", { code: err?.code ?? "unknown" });
    return true;
  }
  const key = `${interaction.guild.id}:${interaction.member.id}:${ticket ? "ticket" : "roles"}`;
  if (activeButtons.has(key)) {
    await interaction.editReply({ content: "Your previous action is already in progress. Wait for its result before trying again." });
    return true;
  }
  activeButtons.add(key);
  try {
    if (ticket) await handleTicketCreation(interaction);
    else await toggleReactionRole(interaction, roleName);
  } finally {
    activeButtons.delete(key);
  }
  return true;
}

async function handleTicketCreation(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  let channels;
  try {
    channels = await guild.channels.fetch();
  } catch (err) {
    console.error("Error fetching ticket channels:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket failed",
          description: "Unable to load support channels. Please try again later or contact staff.",
          color: colors.error
        })
      ]
    });
    return;
  }

  const categoryId = process.env.TICKET_CATEGORY_ID?.trim();
  const ticketCategory = categoryId
    ? channels.get(categoryId)
    : channels.find(c =>
      c?.type === ChannelType.GuildCategory &&
      c.name.trim().toLowerCase() === "🆘 --- support ---"
    );

  // An explicit but invalid destination must not silently route private tickets elsewhere.
  if (ticketCategory?.type !== ChannelType.GuildCategory) {
    console.warn("Ticket category unavailable", {
      categoryId: categoryId || "legacy Support category",
      channelType: ticketCategory?.type ?? null
    });
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket support unavailable",
          description: "Staff need to configure the ticket category. Please contact a server administrator.",
          color: colors.error
        })
      ]
    });
    return;
  }

  const existingTicket = channels.find(
    c => c?.parentId === ticketCategory.id && c.topic === `Ticket for ${member.id}`
  );

  if (existingTicket) {
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket already open",
          description: `You already have a ticket: ${existingTicket}.`,
          color: colors.info
        })
      ]
    });
    return;
  }

  const configuredStaffIds = getTicketStaffRoleIds();
  let staffRoles;
  let bot;
  try {
    if (configuredStaffIds) {
      const roles = await guild.roles.fetch();
      staffRoles = configuredStaffIds.map(id => roles.get(id));
      if (!staffRoles.length || staffRoles.some(role => !role || role.id === guild.id || role.name === "@everyone")) {
        throw Object.assign(new Error("Invalid ticket staff configuration"), { code: "TICKET_STAFF_ROLES_INVALID" });
      }
    } else {
      const legacy = guild.roles.cache.find(role => role.name.trim().toLowerCase() === "discord admin");
      staffRoles = legacy ? [legacy] : [];
    }
    bot = guild.members.me ?? await guild.members.fetchMe();
  } catch (err) {
    console.warn("Ticket staff configuration unavailable", { code: err?.code ?? "unknown" });
    await interaction.editReply({
      embeds: [createCardEmbed({
        title: "Ticket support unavailable",
        description: "Staff need to review the ticket support role configuration. Please contact a server administrator.",
        color: colors.error
      })]
    });
    return;
  }

  const overwrites = [
    {
      id: guild.id,
      deny: [PermissionFlagsBits.ViewChannel]
    },
    {
      id: member.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ]
    },
    {
      id: bot.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  for (const role of staffRoles) {
    const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory];
    // Preserve the legacy overwrite; explicit staff IDs get only conversation access.
    if (!configuredStaffIds) allow.push(PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels);
    overwrites.push({ id: role.id, allow });
  }

  try {
    const ticketChannel = await guild.channels.create({
      name: `ticket-${member.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      type: ChannelType.GuildText,
      parent: ticketCategory.id,
      topic: `Ticket for ${member.id}`,
      permissionOverwrites: overwrites
    });

    await ticketChannel.send(
      {
        embeds: [
          createCardEmbed({
            title: "Ticket created",
            description: `<@${member.id}> we opened a private channel for you.\n${staffRoles.length ? `The ${staffRoles.map(role => `<@&${role.id}>`).join(", ")} team can assist here.` : "A server administrator can assist here."}`,
            color: colors.info
          })
        ]
      }
    ).catch(err => {
      console.warn("Ticket created but opening notice failed", { code: err?.code ?? "unknown" });
    });

    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket ready",
          description: `Your ticket has been created: ${ticketChannel}.`,
          color: colors.success
        })
      ]
    }).catch(err => {
      console.warn("Ticket created but confirmation notice failed", { code: err?.code ?? "unknown" });
    });
  } catch (err) {
    console.error("Error creating ticket:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket failed",
          description: "Failed to create ticket. Please try again later or contact staff.",
          color: colors.error
        })
      ]
    });
  }
}

async function toggleReactionRole(interaction, roleName) {
  const guild = interaction.guild;
  try {
    const roles = await guild.roles.fetch();
    const roleId = getNotificationRoleId(interaction.customId);
    const role = roleId ? roles.get(roleId) : roles.find(candidate =>
      candidate.name.trim().toLowerCase() === roleName.toLowerCase()
    );
    if (!role) {
      await interaction.editReply({
        embeds: [createCardEmbed({
          title: "Role missing",
          description: "Notification role unavailable. Please contact an admin.",
          color: colors.error
        })]
      });
      return;
    }
    if (!isSafeNotificationRole(role, guild.id)) {
      console.warn("Notification role rejected", { roleId: role.id });
      await interaction.editReply({
        embeds: [createCardEmbed({
          title: "Role unavailable",
          description: "Staff must configure a dedicated, safe notification role below the bot's role.",
          color: colors.error
        })]
      });
      return;
    }
    const member = await guild.members.fetch({ user: interaction.member.id, force: true });
    const remove = member.roles.cache.has(role.id);
    if (remove) await member.roles.remove(role.id);
    else await member.roles.add(role.id);
    await interaction.editReply({
      embeds: [createCardEmbed({
        title: remove ? "Role removed" : "Role added",
        description: `${role.name} notifications ${remove ? "disabled" : "enabled"}.`,
        color: remove ? colors.info : colors.success
      })],
      allowedMentions: { parse: [] }
    }).catch(err => {
      console.warn("Notification role changed but confirmation notice failed", { code: err?.code ?? "unknown" });
    });
  } catch (err) {
    console.error("Notification role update failed", { code: err?.code ?? "unknown" });
    await interaction.editReply({
      embeds: [createCardEmbed({
        title: "Role update failed",
        description: "The update could not be confirmed. Check your roles before trying again or contact staff.",
        color: colors.error
      })]
    });
  }
}
