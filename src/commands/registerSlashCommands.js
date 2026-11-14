import {
  SlashCommandBuilder, Routes, REST, InteractionContextType, ApplicationIntegrationType
} from "discord.js";

function command(name, description, admin = false) {
  const builder = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
  // Server owners explicitly grant configured staff roles access in Integrations.
  // Runtime checks remain authoritative even if the UI permission is overridden.
  if (admin) builder.setDefaultMemberPermissions(0n);
  return builder;
}

function shareOptions(builder) {
  return builder
    .addBooleanOption(opt => opt.setName("private").setDescription("Only show the resource to you"))
    .addStringOption(opt => opt.setName("reply_to").setDescription("Reply to a message ID or link in this channel"));
}

const slashCommands = [
  command("tt", "Share TarkovTracker links and discover useful commands")
    .addSubcommand(sub => shareOptions(sub.setName("url").setDescription("Share the TarkovTracker website")))
    .addSubcommand(sub => shareOptions(sub.setName("resources").setDescription("Share maintained guides and community tools")))
    .addSubcommand(sub => sub.setName("help").setDescription("Show a private command guide")),
  command("message", "Preview and send a bot announcement or reply", true)
    .addStringOption(opt => opt.setName("content").setDescription("Message text (use \\n for new lines)").setRequired(true).setMinLength(1).setMaxLength(2000))
    .addStringOption(opt => opt.setName("title").setDescription("Optional title to send a styled embed instead of plain text").setMaxLength(256))
    .addStringOption(opt => opt.setName("reply_to").setDescription("Reply to a message ID or link in this channel"))
    .addBooleanOption(opt => opt.setName("preview").setDescription("Preview with Send/Cancel buttons first (default: true)")),
  command("channel", "Manage channel history and private audit archives", true)
    .addSubcommand(sub => sub.setName("purge").setDescription("Delete a chosen number of recent messages after confirmation")
      .addIntegerOption(opt => opt.setName("count").setDescription("Maximum messages to delete; messages over 14 days old are skipped")
        .setRequired(true).setMinValue(1).setMaxValue(1000)))
    .addSubcommand(sub => sub.setName("archive").setDescription("Hide this text channel for staff review without deleting its history")),
  command("ticket", "Close or reopen a managed private support ticket")
    .addSubcommand(sub => sub.setName("close").setDescription("Close this ticket without deleting history"))
    .addSubcommand(sub => sub.setName("reopen").setDescription("Reopen this ticket (configured queue staff only)")),
  command("support", "Check help-desk configuration or publish its panel", true)
    .addSubcommand(sub => sub.setName("check").setDescription("Privately validate support destinations and bot permissions"))
    .addSubcommand(sub => sub.setName("panel").setDescription("Preview and publish or update the help-desk panel")
      .addStringOption(opt => opt.setName("message_id").setDescription("Existing help-desk message ID in this channel to update"))),
  command("nuke", "Confirm a channel reset: clone settings, then permanently delete its history", true)
];

const slashCommandData = slashCommands.map(builder => builder.toJSON());

export async function registerSlashCommands(client) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  // Replaces obsolete commands on the next bot startup; never run by local tests.
  await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommandData });
}
