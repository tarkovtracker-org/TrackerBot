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

  const ticketCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "🆘 --- Support ---"
  );

  if (!ticketCategory) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Missing ticket category",
          description: "Ticket category does not exist. Please create a category named **ticket**.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const existingTicket = guild.channels.cache.find(
    c => c.parentId === ticketCategory.id && c.topic === `Ticket for ${member.id}`
  );

  if (existingTicket) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Ticket already open",
          description: `You already have a ticket: ${existingTicket}.`,
          color: colors.info
        })
      ],
      flags: MessageFlags.Ephemeral
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

    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Ticket ready",
          description: `Your ticket has been created: ${ticketChannel}.`,
          color: colors.success
        })
      ],
      flags: MessageFlags.Ephemeral
    });
  } catch (err) {
    console.error("Error creating ticket:", err);
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Ticket failed",
          description: "Failed to create ticket. Check bot permissions.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
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
