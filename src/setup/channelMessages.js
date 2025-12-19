import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder
} from "discord.js";
import { getRequiredEnv } from "../config/env.js";
import { reactionRoleButtonConfig } from "../config/constants.js";

export async function publishSetupMessages(client) {
  const channelEnvMap = {
    bugReport: "BUG_REPORT_CHANNEL_ID",
    dataBug: "DATA_BUG_CHANNEL_ID",
    role: "ROLE_CHANNEL_ID",
    ticket: "TICKET_CHANNEL_ID"
  };

  const channels = {};

  for (const [key, envName] of Object.entries(channelEnvMap)) {
    const channelId = getRequiredEnv(envName);
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Configured channel ${envName} (${channelId}) is not text-based.`);
    }
    channels[key] = channel;
  }

  await sendBugReportMessage(channels.bugReport);
  await sendDataBugMessage(channels.dataBug);
  await sendReactionRoleMessage(channels.role);
  await sendTicketMessage(channels.ticket);
}

async function sendBugReportMessage(channel) {
  await clearPreviousBotMessage(channel);

  const bugEmbed = new EmbedBuilder()
    .setTitle("Bug Report")
    .setDescription("If you want to report a bug, click the button below.")
    .setColor(0x00ff00);

  const bugButton = new ButtonBuilder()
    .setLabel("Create a report")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org");

  await channel.send({
    embeds: [bugEmbed],
    components: [new ActionRowBuilder().addComponents(bugButton)]
  });
}

async function sendDataBugMessage(channel) {
  await clearPreviousBotMessage(channel);

  const dataBugEmbed = new EmbedBuilder()
    .setTitle("Data Bug Report")
    .setDescription("Use the button below to flag an issue that specifically impacts Tarkov data or overlays.")
    .setColor(0xff3366);

  const dataBugButton = new ButtonBuilder()
    .setLabel("Data Bug Report")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org/bug-report");

  await channel.send({
    embeds: [dataBugEmbed],
    components: [new ActionRowBuilder().addComponents(dataBugButton)]
  });
}

async function sendReactionRoleMessage(channel) {
  await clearPreviousBotMessage(channel);

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

  const buttonRow = new ActionRowBuilder();
  reactionRoleButtonConfig.forEach(({ customId, emoji, label }) => {
    buttonRow.addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(`${emoji} ${label}`)
        .setStyle(ButtonStyle.Primary)
    );
  });

  await channel.send({ embeds: [roleEmbed], components: [buttonRow] });
}

async function sendTicketMessage(channel) {
  await clearPreviousBotMessage(channel);

  const ticketEmbed = new EmbedBuilder()
    .setTitle("Support Tickets")
    .setDescription("Click the button below to create a private support ticket.")
    .setColor(0xffaa00);

  const ticketButton = new ButtonBuilder()
    .setCustomId("create_ticket")
    .setLabel("Create Ticket")
    .setStyle(ButtonStyle.Success);

  await channel.send({
    embeds: [ticketEmbed],
    components: [new ActionRowBuilder().addComponents(ticketButton)]
  });
}

async function clearPreviousBotMessage(channel) {
  const oldMessage = (await channel.messages.fetch({ limit: 50 }))
    .find(msg => msg.author.id === channel.client.user.id);

  if (oldMessage) {
    await oldMessage.delete().catch(() => {});
  }
}
