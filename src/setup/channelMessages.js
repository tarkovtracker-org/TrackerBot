import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";
import { getRequiredEnv } from "../config/env.js";
import { createCardEmbed } from "../utils/cardEmbed.js";

export async function publishSetupMessages(client) {
  const channelEnvMap = {
    bugReport: "BUG_REPORT_CHANNEL_ID",
    dataBug: "DATA_BUG_CHANNEL_ID",
    ticket: "TICKET_CHANNEL_ID",
    devBug: "DEV_BUG_CHANNEL_ID"
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
  await sendDevBugMessage(channels.devBug);
  await sendTicketMessage(channels.ticket);
}

async function sendBugReportMessage(channel) {
  await clearPreviousBotMessage(channel);

  const bugEmbed = createCardEmbed({
    title: "Bug Report",
    description: "Found a UI or feature issue on TarkovTracker.org? Use the button below to open our web report form and file a GitHub issue.",
    color: 0x25d6a2,
    footer: "TarkovTracker Team"
  });

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

  const dataBugEmbed = createCardEmbed({
    title: "Data Bug Report",
    description: "Report problems that affect Tarkov data, overlays, or items directly. These posts route to the data repository so the telemetry team can fix them quickly.",
    color: 0xff6b81,
    footer: "TarkovTracker Team"
  });

  const dataBugButton = new ButtonBuilder()
    .setLabel("Data Bug Report")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org/bug-report-data");

  await channel.send({
    embeds: [dataBugEmbed],
    components: [new ActionRowBuilder().addComponents(dataBugButton)]
  });
}

async function sendDevBugMessage(channel) {
  await clearPreviousBotMessage(channel);

  const dataBugEmbed = createCardEmbed({
    title: "Dev Bug Report",
    description: "Report problems that affect dev.tarkovtracker.org, the Nuxt version of TarkovTracker.",
    color: 0xff6b81,
    footer: "TarkovTracker Team"
  });

  const dataBugButton = new ButtonBuilder()
    .setLabel("Dev Bug Report")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org/bug-report-dev");

  await channel.send({
    embeds: [dataBugEmbed],
    components: [new ActionRowBuilder().addComponents(dataBugButton)]
  });
}

async function sendTicketMessage(channel) {
  await clearPreviousBotMessage(channel);

  const ticketEmbed = createCardEmbed({
    title: "Support Tickets",
    description: "Need direct help? Open a private ticket and the admin team will follow up in DMs.",
    color: 0xffb347
  });

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
