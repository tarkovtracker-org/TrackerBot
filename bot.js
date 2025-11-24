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
  Events
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

  // Register /message command
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const commandData = [
    new SlashCommandBuilder()
      .setName("message")
      .setDescription("Send a message as the bot")
      .addStringOption(opt =>
        opt.setName("content")
          .setDescription("Message content (use \\n for new lines)")
          .setRequired(true)
      ).toJSON()
  ];
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandData });
    console.log("Slash command registered.");
  } catch (err) {
    console.error(err);
  }

  // Channels
  const bugReportChannel = await client.channels.fetch(process.env.BUG_REPORT_CHANNEL_ID);
  const roleChannel = await client.channels.fetch(process.env.ROLE_CHANNEL_ID);

  if (!bugReportChannel?.isTextBased() || !roleChannel?.isTextBased()) return;

  const guild = bugReportChannel.guild;

  const roles = {
    site: guild.roles.cache.find(r => r.name.toLowerCase() === "site"),
    monitor: guild.roles.cache.find(r => r.name.toLowerCase() === "monitor"),
    polls: guild.roles.cache.find(r => r.name.toLowerCase() === "polls"),
    news: guild.roles.cache.find(r => r.name.toLowerCase() === "news"),
    notifs: guild.roles.cache.find(r => r.name.toLowerCase() === "notifs")
  };

  if (!roles.site || !roles.monitor || !roles.polls || !roles.news || !roles.notifs) {
    console.log("Missing roles. Fix role names in Discord.");
    return;
  }

  // BUG REPORT MESSAGE
  const oldBugMsg = (await bugReportChannel.messages.fetch({ limit: 50 }))
    .find(m => m.author.id === client.user.id);
  if (oldBugMsg) await oldBugMsg.delete();

  const bugEmbed = new EmbedBuilder()
    .setTitle("Bug Report")
    .setDescription("If you want to report a bug, click the button below.")
    .setColor(0x00ff00);

  const bugButton = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Create a report")
      .setStyle(ButtonStyle.Link)
      .setURL("https://issue.tarkovtracker.org")
  );

  await bugReportChannel.send({ embeds: [bugEmbed], components: [bugButton] });

  // ROLE REACTION MESSAGE
  const oldRoleMsg = (await roleChannel.messages.fetch({ limit: 50 }))
    .find(m => m.author.id === client.user.id);
  if (oldRoleMsg) await oldRoleMsg.delete();

  const roleEmbed = new EmbedBuilder()
    .setTitle("Reaction Roles")
    .setColor(0x0099ff)
    .setDescription(
`**@everyone** – Very important global notifications.  
(Major issues/changes affecting all users)

**@here** – Urgent short-term notifications (max 6h)

---

### React For Roles

🌐 = **@site** – Site updates  
🖥️ = **@monitor** – Tarkov Monitor updates  
📋 = **@polls** – Community polls  
📰 = **@news** – News & updates  
🔔 = **@notifs** – All notifications`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("role_site").setLabel("🌐 Site").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_monitor").setLabel("🖥️ Monitor").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_polls").setLabel("📋 Polls").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_news").setLabel("📰 News").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_notifs").setLabel("🔔 Notifs").setStyle(ButtonStyle.Primary)
  );

  await roleChannel.send({ embeds: [roleEmbed], components: [row] });

  console.log("Messages sent.");
});

client.on("interactionCreate", async interaction => {
  // SLASH COMMAND
  if (interaction.isChatInputCommand() && interaction.commandName === "message") {
    if (!interaction.member.permissions.has("Administrator")) {
      return interaction.reply({ content: "You do not have permission.", flags: 64 });
    }
    const content = interaction.options.getString("content").replace(/\\n/g, "\n");
    await interaction.reply({ content: "Message sent.", flags: 64 });
    return interaction.channel.send(content);
  }

  // BUTTONS
  if (!interaction.isButton()) return;

  const member = interaction.member;
  const guild = interaction.guild;

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
      if (!interaction.replied) await interaction.reply({ content: `Removed role: ${role.name}`, flags: 64 });
    } else {
      await member.roles.add(role);
      if (!interaction.replied) await interaction.reply({ content: `Added role: ${role.name}`, flags: 64 });
    }
  } catch (err) {
    console.error(err);
    if (!interaction.replied) await interaction.reply({ content: "Error assigning role.", flags: 64 });
  }
});

// WELCOME / GOODBYE
client.on("guildMemberAdd", async member => {
  const guild = member.guild;

  // === AJOUT AUTOMATIQUE DU RÔLE "User" ===
  const userRole = guild.roles.cache.find(r => r.name.toLowerCase() === "User");
  if (userRole) {
    try {
      await member.roles.add(userRole);
    } catch (err) {
      console.error("Erreur en ajoutant le rôle User :", err);
    }
  } else {
    console.warn('Rôle "User" introuvable sur ce serveur.');
  }

  // Message de bienvenue
  const channel = guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const msg = await channel.send(`Welcome to **TarkovTracker.org** Discord server ${member}.`);
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
