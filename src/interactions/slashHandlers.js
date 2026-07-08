import { ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";
import { allowedCommandRoles } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { executeWipe } from "../commands/wipeCommand.js";

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
      flags: MessageFlags.Ephemeral
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
    case "archive":
      await handleArchiveChannel(interaction);
      return true;
    case "put-member-role":
      await handlePutMemberRole(interaction);
      return true;
    case "wipe":
      await executeWipe(interaction);
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
      flags: MessageFlags.Ephemeral
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
    flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handlePutMemberRole(interaction) {
  const panelAdminRoleId = process.env.PANEL_ADMIN_ROLE_ID;
  const autoRoleId = process.env.AUTO_ROLE_ID_4;

  // Check that the user has the PANEL_ADMIN_ROLE_ID role
  if (!interaction.member.roles.cache.has(panelAdminRoleId)) {
    await interaction.reply({
      embeds: [
        createCardEmbed({
          title: "Permission Denied",
          description: "Only Panel Admins can use this command.",
          color: colors.error
        })
      ],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    // Fetch all guild members
    const guild = interaction.guild;
    await guild.members.fetch();

    const role = await guild.roles.fetch(autoRoleId);
    if (!role) {
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "Role Not Found",
            description: `Role with ID ${autoRoleId} not found.`,
            color: colors.error
          })
        ]
      });
      return;
    }

    // Find members who don't have the role
    const membersWithoutRole = guild.members.cache.filter(
      member => !member.roles.cache.has(autoRoleId) && !member.user.bot
    );

    if (membersWithoutRole.size === 0) {
      await interaction.editReply({
        embeds: [
          createCardEmbed({
            title: "No Members to Update",
            description: "All members already have the role.",
            color: colors.info
          })
        ]
      });
      return;
    }

    let successCount = 0;
    let failCount = 0;

    // Add the role to each member
    for (const [, member] of membersWithoutRole) {
      try {
        await member.roles.add(autoRoleId);
        successCount++;
      } catch (err) {
        console.error(`Failed to add role to ${member.user.tag}:`, err);
        failCount++;
      }
    }

    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Role Assignment Complete",
          description: `✅ Successfully added role to ${successCount} member(s)\n${failCount > 0 ? `❌ Failed for ${failCount} member(s)` : ''}`,
          color: colors.success
        })
      ]
    });

  } catch (err) {
    console.error("Error in put-member-role:", err);
    await interaction.editReply({
      embeds: [
        createCardEmbed({
          title: "Error",
          description: "An error occurred while adding roles.",
          color: colors.error
        })
      ]
    });
  }
}

function hasDiscordAdminRole(roleCache) {
  return roleCache.some(role => role.name.toLowerCase() === "discord admin");
}
