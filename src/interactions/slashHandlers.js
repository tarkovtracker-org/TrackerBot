import { EmbedBuilder, ChannelType, PermissionFlagsBits } from "discord.js";
import { allowedCommandRoles } from "../config/constants.js";

export async function handleChatInputCommand(interaction) {
  if (!interaction.isChatInputCommand()) return false;

  const canUseCommands = interaction.member.roles.cache.some(role =>
    allowedCommandRoles.has(role.id)
  );

  if (!canUseCommands) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
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
    default:
      return false;
  }
}

async function handleMessageCommand(interaction) {
  const isAdmin = hasDiscordAdminRole(interaction.member.roles.cache);
  if (!isAdmin) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
      flags: 64
    });
    return;
  }

  const content = interaction.options.getString("content").replace(/\\n/g, "\n");
  await interaction.reply({ content: "Message sent.", flags: 64 });
  await interaction.channel.send(content);
}

async function handleFaqCommand(interaction) {
  const embed = new EmbedBuilder()
    .setTitle("FAQ #1")
    .setColor(0x0099ff)
    .setDescription(
      "TarkovTracker.org - Is being updated & fixed but will have problems, issues, bugs, downtime, at anytime. (We try to avoid it, but no guarantees. It's changing/updating so you should expect things to break/not work + potential loss of all account data.)"
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleUtdCommand(interaction) {
  const embed = new EmbedBuilder()
    .setTitle("Update In Progress")
    .setColor(0xffaa00)
    .setDescription(
      "We are in the process of getting the website updated to the latest patch. Please be patient and feel free to report any changes you notice in the https://discord.com/channels/1433379620648124451/1439311904479772833"
    );

  await interaction.reply({ embeds: [embed] });
}

async function handleTicketClose(interaction) {
  const channel = interaction.channel;

  if (!channel.topic || !channel.topic.startsWith("Ticket for ")) {
    await interaction.reply({
      content: "This command can only be used inside a ticket channel.",
      flags: 64
    });
    return;
  }

  const ticketUserId = channel.topic.replace("Ticket for ", "").trim();

  const isAdmin = hasDiscordAdminRole(interaction.member.roles.cache);
  const isOwner = interaction.user.id === ticketUserId;

  if (!isAdmin && !isOwner) {
    await interaction.reply({
      content: "You are not allowed to close this ticket.",
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
      content: "Archive category does not exist.",
      flags: 64
    });
    return;
  }

  try {
    await channel.setParent(archiveCategory.id);
    await channel.send("Ticket has been closed and moved to Archive.");
    await interaction.reply({
      content: "Ticket successfully archived.",
      flags: 64
    });
  } catch (err) {
    console.error("Error closing ticket:", err);
    await interaction.reply({
      content: "Failed to archive ticket. Check bot permissions.",
      flags: 64
    });
  }
}

function hasDiscordAdminRole(roleCache) {
  return roleCache.some(role => role.name.toLowerCase() === "discord admin");
}
