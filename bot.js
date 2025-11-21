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
  Partials
} from "discord.js";
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

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  const bugReportChannelId = process.env.BUG_REPORT_CHANNEL_ID;
  const roleChannelId = process.env.ROLE_CHANNEL_ID;
  const bugChannel = await client.channels.fetch(bugReportChannelId);
  const roleChannel = await client.channels.fetch(roleChannelId);
  if (!bugChannel?.isTextBased() || !roleChannel?.isTextBased()) return;

  const guild = bugChannel.guild;

  const roles = {
    site: guild.roles.cache.find(r => r.name.toLowerCase() === "site"),
    monitor: guild.roles.cache.find(r => r.name.toLowerCase() === "monitor"),
    polls: guild.roles.cache.find(r => r.name.toLowerCase() === "polls"),
    notifs: guild.roles.cache.find(r => r.name.toLowerCase() === "notifs")
  };

  if (!roles.site || !roles.monitor || !roles.polls || !roles.notifs) return;

  const bugMessages = await bugChannel.messages.fetch({ limit: 50 });
  const bugOldMsg = bugMessages.find(m => m.author.id === client.user.id);
  if (bugOldMsg) await bugOldMsg.delete();

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

  await bugChannel.send({
    embeds: [bugEmbed],
    components: [bugButton]
  });

  const roleMessages = await roleChannel.messages.fetch({ limit: 50 });
  const roleOldMsg = roleMessages.find(m => m.author.id === client.user.id);
  if (roleOldMsg) await roleOldMsg.delete();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("role_site").setLabel("Site").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_monitor").setLabel("Monitor").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_polls").setLabel("Polls").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("role_notifs").setLabel("Notifications").setStyle(ButtonStyle.Primary)
  );

  const roleEmbed = new EmbedBuilder()
    .setTitle("Available Roles")
    .setDescription("Click the buttons below to add or remove a role.")
    .setColor(0x00aaff);

  await roleChannel.send({
    embeds: [roleEmbed],
    components: [row]
  });

  console.log("Both messages sent");
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isButton()) return;

  const member = interaction.member;
  const guild = interaction.guild;

  const roleMap = {
    role_site: guild.roles.cache.find(r => r.name.toLowerCase() === "site"),
    role_monitor: guild.roles.cache.find(r => r.name.toLowerCase() === "monitor"),
    role_polls: guild.roles.cache.find(r => r.name.toLowerCase() === "polls"),
    role_notifs: guild.roles.cache.find(r => r.name.toLowerCase() === "notifs")
  };

  const role = roleMap[interaction.customId];
  if (!role) return interaction.reply({ content: "Role not found.", ephemeral: true });

  if (member.roles.cache.has(role.id)) {
    await member.roles.remove(role);
    return interaction.reply({ content: `Removed role: ${role.name}`, ephemeral: true });
  } else {
    await member.roles.add(role);
    return interaction.reply({ content: `Added role: ${role.name}`, ephemeral: true });
  }
});

client.on("guildMemberAdd", async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const msg = await channel.send(`Welcome to **TarkovTracker.org** Discord server ${member}.`);
  welcomeMessages.set(member.id, msg.id);
});

client.on("guildMemberRemove", async member => {
  const channel = member.guild.channels.cache.get(process.env.WELCOME_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const msgId = welcomeMessages.get(member.id);
  if (!msgId) return;

  try {
    const msg = await channel.messages.fetch(msgId);
    await msg.delete();
  } catch (e) {}

  welcomeMessages.delete(member.id);
});

client.login(process.env.DISCORD_TOKEN);

