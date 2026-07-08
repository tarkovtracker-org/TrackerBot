import { SlashCommandBuilder, Routes, REST } from "discord.js";

const slashCommands = [
  new SlashCommandBuilder()
    .setName("message")
    .setDescription("Send a message as the bot (Discord Admin only)")
    .addStringOption(opt =>
      opt.setName("content")
        .setDescription("Message content (use \\n for new lines)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("faq1")
    .setDescription("Post the FAQ notice about site stability"),
  new SlashCommandBuilder()
    .setName("utd")
    .setDescription("Post the update-in-progress notice"),
  new SlashCommandBuilder()
    .setName("archive")
    .setDescription("Archive this channel and move it to Archive"),
  new SlashCommandBuilder()
    .setName("put-member-role")
    .setDescription("Add AUTO_ROLE_ID_4 to all members who don't have it (Admin only)"),
  new SlashCommandBuilder()
    .setName("wipe")
    .setDescription("Bulk-delete recent messages in this channel (Admin only, 14-day limit)")
];

const slashCommandData = slashCommands.map(command => command.toJSON());

export async function registerSlashCommands(client) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(client.user.id), {
    body: slashCommandData
  });
}
