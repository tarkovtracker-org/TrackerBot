//
//  bot.js
//
import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once("clientReady", async () => {
  console.log(`Tracker Bot connected as ${client.user.tag}`);

  try {
    const channelId = "1433399244924129375"; // #support channel ID
    const channel = await client.channels.fetch(channelId);

    if (!channel || !channel.isTextBased()) {
      console.error("The specified channel is not text-based or cannot be found!");
      return;
    }

    // Delete the last message sent by the bot
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessage = messages.find(msg => msg.author.id === client.user.id);
    if (botMessage) await botMessage.delete();

    // Create a link button (will appear blue)
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Create a request")
        .setStyle(ButtonStyle.Link)
        .setURL("https://issue.tarkovtracker.org")
    );

    // Create an embed
    const embed = new EmbedBuilder()
      .setTitle("Create an issue")
      .setDescription("To create an issue, click the button below to go to our page.")
      .setColor(0x00ff00); // green

    // Send the message with embed and button
    await channel.send({
      embeds: [embed],
      components: [row]
    });

    console.log("New embed message sent with button");
  } catch (err) {
    console.error("Error sending message:", err);
  }
});

client.login(process.env.DISCORD_TOKEN);
