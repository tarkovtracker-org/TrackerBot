import { ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";
import { reactionRoleNameMap } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";

const colors = {
  success: 0x4ade80,
  error: 0xff6b81,
  info: 0x7f8cff
};

export async function handleButtonInteraction(interaction) {
  if (!interaction.isButton()) return false;

  if (interaction.customId === "create_ticket") {
    await handleTicketCreation(interaction);
    return true;
  }

  if (reactionRoleNameMap[interaction.customId]) {
    await toggleReactionRole(interaction, reactionRoleNameMap[interaction.customId]);
    return true;
  }

  return false;
}

async function handleTicketCreation(interaction) {
  const guild = interaction.guild;
  const member = interaction.member;

  // Acknowledge before fetching channels or creating a ticket (Discord allows 3 seconds).
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
    c => c.parentId === ticketCategory.id && c.topic === `Ticket for ${member.id}`
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

  const adminRole = guild.roles.cache.find(
    role => role.name.toLowerCase() === "discord admin"
  );

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
      id: guild.members.me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
      ]
    }
  ];

  if (adminRole) {
    overwrites.push({
      id: adminRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels
      ]
    });
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
            description: `${member} we opened a private channel for you.\nA member of the <@&${adminRole?.id || ""}> team will assist shortly.`,
            color: colors.info
          })
        ]
      }
    );

    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket ready",
          description: `Your ticket has been created: ${ticketChannel}.`,
          color: colors.success
        })
      ]
    });
  } catch (err) {
    console.error("Error creating ticket:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Ticket failed",
          description: "Failed to create ticket. Check bot permissions.",
          color: colors.error
        })
      ]
    });
  }
}

async function toggleReactionRole(interaction, roleName) {
  const guild = interaction.guild;
  const member = interaction.member;

  const role = guild.roles.cache.find(
    guildRole => guildRole.name.toLowerCase() === roleName.toLowerCase()
  );

  if (!role) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Role missing",
          description: "Role unavailable. Please contact an admin.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await interaction.reply({
        embeds: [
          createCardEmbed({
            title: "Role removed",
            description: `${role.name} notifications disabled.`,
            color: colors.info
          })
        ],
        flags: MessageFlags.Ephemeral
      });
    } else {
      await member.roles.add(role);
      await interaction.reply({
        embeds: [
          createCardEmbed({
            title: "Role added",
            description: `${role.name} notifications enabled.`,
            color: colors.success
          })
        ],
        flags: MessageFlags.Ephemeral
      });
    }
  } catch (err) {
    console.error("Role error:", err);
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Role update failed",
          description: "Failed to update role.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
  }
}
