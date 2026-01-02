import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";
import { getRequiredEnv } from "../config/env.js";
import { createCardEmbed } from "../utils/cardEmbed.js";

export async function publishSetupMessages(client) {
  const channelEnvMap = {
    portal: "BUG_REPORT_CHANNEL_ID",
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

  await sendPortalMessage(channels.portal);
  await sendTicketMessage(channels.ticket);
}

async function sendPortalMessage(channel) {
  await clearPreviousBotMessage(channel);

  const portalEmbed = createCardEmbed({
    title: "Issue Portal",
    description: "Use the portal to report dev or data issues. Choose the right form and your report will be routed to the correct repository.",
    color: 0xff6b81,
    footer: "TarkovTracker Team"
  });

  const portalButton = new ButtonBuilder()
    .setLabel("Open issue portal")
    .setStyle(ButtonStyle.Link)
    .setURL("https://issue.tarkovtracker.org/");

  await channel.send({
    embeds: [portalEmbed],
    components: [new ActionRowBuilder().addComponents(portalButton)]
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
