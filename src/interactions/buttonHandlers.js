import { ChannelType, PermissionFlagsBits } from "discord.js";
import { reactionRoleNameMap } from "../config/constants.js";

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
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "ticket"
  );

  if (!ticketCategory) {
    await interaction.reply({
      content: "Ticket category does not exist.",
      flags: 64
    });
    return;
  }

  const existingTicket = guild.channels.cache.find(
    c => c.parentId === ticketCategory.id && c.topic === `Ticket for ${member.id}`
  );

  if (existingTicket) {
    await interaction.reply({
      content: `You already have a ticket: ${existingTicket}.`,
      flags: 64
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
      `${member} your ticket has been created.\nA member of the <@&${adminRole?.id || ""}> team will assist you shortly.`
    );

    await interaction.reply({
      content: `Your ticket has been created: ${ticketChannel}.`,
      flags: 64
    });
  } catch (err) {
    console.error("Error creating ticket:", err);
    await interaction.reply({
      content: "Failed to create ticket. Check bot permissions.",
      flags: 64
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
      content: "Role unavailable. Please contact an admin.",
      flags: 64
    });
    return;
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await interaction.reply({ content: `Role removed: ${role.name}`, flags: 64 });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: `Role added: ${role.name}`, flags: 64 });
    }
  } catch (err) {
    console.error("Role error:", err);
    await interaction.reply({ content: "Failed to update role.", flags: 64 });
  }
}
