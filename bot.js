//
// bot.js
//
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Partials,
  SlashCommandBuilder,
  Routes,
  Events,
  ChannelType,
  PermissionFlagsBits
} from "discord.js";
import { REST } from "@discordjs/rest";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const welcomeMessages = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  //
  // Register slash commands
  //
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  const commandData = [
    new SlashCommandBuilder()
      .setName("message")
      .setDescription("Send a message as the bot (Discord Admin only)")
      .addStringOption(opt =>
        opt.setName("content")
          .setDescription("Message content (use \\n for new lines)")
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("ticket-close")
      .setDescription("Close this ticket and move it to Archive")
  ].map(c => c.toJSON());

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandData });
    console.log("Slash commands registered.");
  } catch (err) {
    console.error(err);
  }

  //
  // Environment Variables Check
  //
  const bugReportChannelId = process.env.BUG_REPORT_CHANNEL_ID;
  const roleChannelId = process.env.ROLE_CHANNEL_ID;
  const ticketChannelId = process.env.TICKET_CHANNEL_ID;

  if (!bugReportChannelId || !roleChannelId || !ticketChannelId) {
    console.error("Missing channel IDs in .env. Please add BUG_REPORT_CHANNEL_ID, ROLE_CHANNEL_ID, TICKET_CHANNEL_ID.");
    return;
  }

  //
  // Fetch Channels
  //
  const bugReportChannel = await client.channels.fetch(bugReportChannelId);
  const roleChannel = await client.channels.fetch(roleChannelId);
  const ticketChannel = await client.channels.fetch(ticketChannelId);

  if (!bugReportChannel?.isTextBased() || !roleChannel?.isTextBased() || !ticketChannel?.isTextBased()) {
    console.error("One of the configured channels is not text-based.");
    return;
  }

  const guild = bugReportChannel.guild;

  //
  // Reaction Role Setup
  //
  const roles = {
    site: guild.roles.cache.find(r => r.name.toLowerCase() === "site"),
    monitor: guild.roles.cache.find(r => r.name.toLowerCase() === "monitor"),
    polls: guild.roles.cache.find(r => r.name.toLowerCase() === "polls"),
    news: guild.roles.cache.find(r => r.name.toLowerCase() === "news"),
    notifs: guild.roles.cache.find(r => r.name.toLowerCase() === "notifs")
  };

  if (!roles.site || !roles.monitor || !roles.polls || !roles.news || !roles.notifs) {
    console.error("Missing reaction roles in Discord. Check role names.");
    return;
  }

  //
  // BUG REPORT MESSAGE
  //
  const oldBugMsg = (await bugReportChannel.messages.fetch({ limit: 50 }))
    .find(msg => msg.author.id === client.user.id);
  if (oldBugMsg) await oldBugMsg.delete();

  const bugEmbed = new EmbedBuilder()
    .setTitle("Bug Report")
    .setDescription("If you want to report a bug, click the button below.")
    .setColor(0x00ff00);

  const bugButton = new ButtonBuilder()
    .setLabel("Create a report")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org");

  await bugReportChannel.send({
    embeds: [bugEmbed],
    components: [new ActionRowBuilder().addComponents(bugButton)]
  });

  //
  // REACTION ROLES MESSAGE
  //
  const oldRoleMsg = (await roleChannel.messages.fetch({ limit: 50 }))
    .find(msg => msg.author.id === client.user.id);
  if (oldRoleMsg) await oldRoleMsg.delete();

  const roleEmbed = new EmbedBuilder()
    .setTitle("Reaction Roles")
    .setColor(0x0099ff)
    .setDescription(
`Click a button to get a notification role.

🌐 Site Updates  
🖥️ Monitor Updates  
📋 Community Polls  
📰 News  
🔔 Notifications`
    );

  const roleButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("role_site").setLabel("🌐 Site").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_monitor").setLabel("🖥️ Monitor").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_polls").setLabel("📋 Polls").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_news").setLabel("📰 News").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_notifs").setLabel("🔔 Notifs").setStyle(ButtonStyle.Primary)
  );

  await roleChannel.send({ embeds: [roleEmbed], components: [roleButtons] });

  //
  // TICKET MESSAGE
  //
  const oldTicketMsg = (await ticketChannel.messages.fetch({ limit: 50 }))
    .find(msg => msg.author.id === client.user.id);
  if (oldTicketMsg) await oldTicketMsg.delete();

  const ticketEmbed = new EmbedBuilder()
    .setTitle("Support Tickets")
    .setDescription("Click the button below to create a private support ticket.")
    .setColor(0xffaa00);

  const ticketRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("create_ticket")
      .setLabel("Create Ticket")
      .setStyle(ButtonStyle.Success)
  );

  try {
    await ticketChannel.send({ embeds: [ticketEmbed], components: [ticketRow] });
  } catch (err) {
    console.error("Failed to send ticket message:", err);
  }

  console.log("Messages sent.");
});

//
// Slash Commands
//
client.on("interactionCreate", async interaction => {

  //
  // /message (ONLY Discord Admin role)
  //
  if (interaction.isChatInputCommand() && interaction.commandName === "message") {
    const isAdmin = interaction.member.roles.cache.some(
      r => r.name.toLowerCase() === "discord admin"
    );

    if (!isAdmin) {
      return interaction.reply({ content: "You do not have permission to use this command.", flags: 64 });
    }

    const content = interaction.options.getString("content").replace(/\\n/g, "\n");
    await interaction.reply({ content: "Message sent.", flags: 64 });
    return interaction.channel.send(content);
  }

  //
  // /ticket-close — moves ticket to Archive
  //
  if (interaction.isChatInputCommand() && interaction.commandName === "ticket-close") {
    const channel = interaction.channel;

    // Check this is a ticket
    if (!channel.topic || !channel.topic.startsWith("Ticket for ")) {
      return interaction.reply({
        content: "This command can only be used inside a ticket channel.",
        flags: 64
      });
    }

    const ticketUserId = channel.topic.replace("Ticket for ", "").trim();

    const isAdmin = interaction.member.roles.cache.some(
      r => r.name.toLowerCase() === "discord admin"
    );
    const isOwner = interaction.user.id === ticketUserId;

    if (!isAdmin && !isOwner) {
      return interaction.reply({
        content: "You are not allowed to close this ticket.",
        flags: 64
      });
    }

    const guild = interaction.guild;

    const archiveCategory = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "archive"
    );

    if (!archiveCategory) {
      return interaction.reply({
        content: "Archive category does not exist.",
        flags: 64
      });
    }

    try {
      await channel.setParent(archiveCategory.id);
      await channel.send("Ticket has been closed and moved to Archive.");
      return interaction.reply({
        content: "Ticket successfully archived.",
        flags: 64
      });
    } catch (err) {
      console.error("Error closing ticket:", err);
      return interaction.reply({
        content: "Failed to archive ticket. Check bot permissions.",
        flags: 64
      });
    }
  }

  //
  // BUTTON INTERACTIONS
  //
  if (!interaction.isButton()) return;

  const guild = interaction.guild;
  const member = interaction.member;

  //
  // CREATE TICKET BUTTON
  //
  if (interaction.customId === "create_ticket") {

    const ticketCategory = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === "ticket"
    );

    if (!ticketCategory) {
      return interaction.reply({
        content: "Ticket category does not exist.",
        flags: 64
      });
    }

    // Check if user already has a ticket
    const existingTicket = guild.channels.cache.find(
      c =>
        c.parentId === ticketCategory.id &&
        c.topic === `Ticket for ${member.id}`
    );

    if (existingTicket) {
      return interaction.reply({
        content: `You already have a ticket: ${existingTicket}.`,
        flags: 64
      });
    }

    // Admin Role
    const adminRole = guild.roles.cache.find(
      r => r.name.toLowerCase() === "discord admin"
    );

    //
    // PERMISSIONS (User + Admin + Bot)
    //
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
        id: guild.members.me.id, // BOT
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

      return interaction.reply({
        content: `Your ticket has been created: ${ticketChannel}.`,
        flags: 64
      });

    } catch (err) {
      console.error("Error creating ticket:", err);
      return interaction.reply({
        content: "Failed to create ticket. Check bot permissions.",
        flags: 64
      });
    }
  }

  //
  // ROLE BUTTON HANDLING
  //
  const roleMap = {
    role_site: guild.roles.cache.find(r => r.name.toLowerCase() === "site"),
    role_monitor: guild.roles.cache.find(r => r.name.toLowerCase() === "monitor"),
    role_polls: guild.roles.cache.find(r => r.name.toLowerCase() === "polls"),
    role_news: guild.roles.cache.find(r => r.name.toLowerCase() === "news"),
    role_notifs: guild.roles.cache.find(r => r.name.toLowerCase() === "notifs")
  };

  const role = roleMap[interaction.customId];
  if (!role) return;

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      if (!interaction.replied) {
        await interaction.reply({ content: `Role removed: ${role.name}`, flags: 64 });
      }
    } else {
      await member.roles.add(role);
      if (!interaction.replied) {
        await interaction.reply({ content: `Role added: ${role.name}`, flags: 64 });
      }
    }
  } catch (err) {
    console.error("Role error:", err);
    if (!interaction.replied) {
      await interaction.reply({ content: "Failed to update role.", flags: 64 });
    }
  }
});

//
// MEMBER JOIN / LEAVE
//
client.on("guildMemberAdd", async member => {
  const guild = member.guild;

  // Assign User role
  const userRole = guild.roles.cache.find(r => r.name.toLowerCase() === "user");
  if (userRole) {
    try {
      await member.roles.add(userRole);
    } catch (err) {
      console.error("Error assigning user role:", err);
    }
  }

  const channel = guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const msg = await channel.send(
    `Welcome to the **TarkovTracker.org** Discord server ${member}.`
  );

  welcomeMessages.set(member.id, msg.id);
});

client.on("guildMemberRemove", async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const msgId = welcomeMessages.get(member.id);
  if (!msgId) return;

  try {
    const msg = await channel.messages.fetch(msgId);
    await msg.delete();
  } catch {}

  welcomeMessages.delete(member.id);
});

client.login(process.env.DISCORD_TOKEN);
