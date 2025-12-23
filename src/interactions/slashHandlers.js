import { ChannelType, PermissionFlagsBits } from "discord.js";
import { allowedCommandRoles } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";

const colors = {
  success: 0x4ade80,
  error: 0xff6b81,
  info: 0x7f8cff
};

export async function handleChatInputCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const canUseCommands = interaction.member.roles.cache.some(role =>
    allowedCommandRoles.has(role.id)
  );

  if (!canUseCommands) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Permission Required",
          description: "You do not have permission to use this command.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return true;
  }

  switch (interaction.commandName) {
    case "message":
      await handleMessageCommand(interaction);
      return true;
    case "faq1":
      await handleFaqCommand(interaction);
      return true;
    case "utd":
      await handleUtdCommand(interaction);
      return true;
    case "ticket-close":
      await handleTicketClose(interaction);
      return true;
    case "archive":
      await handleArchiveChannel(interaction);
      return true;
    default:
      return false;
  }
}

async function handleMessageCommand(interaction) {
  const isAdmin = hasDiscordAdminRole(interaction.member.roles.cache);
  if (!isAdmin) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Permission Required",
          description: "You do not have permission to use this command.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return;
  }

  const content = interaction.options.getString("content").replace(/\\n/g, "\n");
  await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "Message sent",
        description: "Your announcement was posted in this channel.",
        color: colors.success
      })
    ],
    flags: 64
  });
  await interaction.channel.send(content);
}

async function handleFaqCommand(interaction) {
  await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "FAQ #1 – Website Stability",
        description: "TarkovTracker.org is actively updated and may have issues, bugs, or downtime at any moment. Expect things to break or data loss while we iterate.",
        color: colors.info
      })
    ]
  });
}

async function handleUtdCommand(interaction) {
  await interaction.reply({
    embeds: [
      createCardEmbed({
        title: "Update In Progress",
        description: "We are updating TarkovTracker to the latest patch. Please be patient and report notable changes in <#1439311904479772833> so we can adjust quickly.",
        color: 0xffb347
      })
    ]
  });
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;

  if (!channel.topic || !channel.topic.startsWith("Ticket for ")) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Wrong channel",
          description: "This command can only be used inside a ticket channel.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return;
  }

  const ticketUserId = channel.topic.replace("Ticket for ", "").trim();

  const isAdmin = hasDiscordAdminRole(interaction.member.roles.cache);
  const isOwner = interaction.user.id === ticketUserId;

  if (!isAdmin && !isOwner) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Permission Required",
          description: "Only the ticket owner or Discord Admins can close this ticket.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return;
  }

  const guild = interaction.guild;
  const archiveCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "archive"
  );

  if (!archiveCategory) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Missing Archive",
          description: "Archive category does not exist. Please create it inside the guild.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return;
  }

  try {
    await channel.setParent(archiveCategory.id);
    await channel.send({
      embeds: [
        createCardEmbed({
          title: "Ticket archived",
          description: "This conversation has been archived for reference.",
          color: colors.info
        })
      ]
    });
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Ticket closed",
          description: "Ticket successfully archived.",
          color: colors.success
        })
      ],
      flags: 64
    });
  } catch (err) {
    console.error("Error closing ticket:", err);
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Archive failed",
          description: "Failed to archive ticket. Check bot permissions.",
          color: colors.error
        })
      ],
      flags: 64
    });
  }
}

async function handleArchiveChannel(interaction) {
  const channel = interaction.channel;
  const guild = interaction.guild;
  const archiveCategory = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "archive"
  );

  if (!archiveCategory) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Missing Archive",
          description: "Archive category does not exist. Please create it inside the guild.",
          color: colors.error
        })
      ],
      flags: 64
    });
    return;
  }

  try {
    await channel.setParent(archiveCategory.id);
    await channel.send({
      embeds: [
        createCardEmbed({
          title: "Channel archived",
          description: "This channel has been archived.",
          color: colors.info
        })
      ]
    });
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Channel archived",
          description: "Channel successfully archived.",
          color: colors.success
        })
      ],
      flags: 64
    });
  } catch (err) {
    console.error("Error archiving channel:", err);
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Archive failed",
          description: "Failed to archive channel. Check bot permissions.",
          color: colors.error
        })
      ],
      flags: 64
    });
  }
}

function hasDiscordAdminRole(roleCache) {
  return roleCache.some(role => role.name.toLowerCase() === "discord admin");
}
