import { ChannelType, MessageFlags, PermissionFlagsBits as Permission } from "discord.js";
import { canConfigureDestinations, destinations, getPreference, updatePreference } from "../config/destinations.js";
import { isSafeNotificationRole } from "../config/constants.js";
import { notificationRoles, supportLinks } from "../config/preferences.js";
import { noMentions } from "../utils/messageReply.js";
import { editDestination, listDestinations } from "./destinationsCommand.js";

const sections = {
  destinations: { label: "Destinations", input: "channel", settings: destinations },
  support: { label: "Support links", input: "url", settings: supportLinks },
  notifications: { label: "Notifications", input: "role", settings: notificationRoles }
};

const settingSections = new Map(Object.values(sections).flatMap(section =>
  Object.keys(section.settings).map(key => [key, section])));

export function addConfigOptions(command) {
  return command.setDefaultMemberPermissions(Permission.Administrator)
    .addSubcommand(sub => sub.setName("view").setDescription("Show this server's TrackerBot settings")
      .addStringOption(input => input.setName("section").setDescription("Settings to view").setRequired(true)
        .addChoices(...Object.entries(sections).map(([value, { label }]) => ({ name: label, value })))))
    .addSubcommand(sub => sub.setName("edit").setDescription("Set or reset one TrackerBot setting")
      .addStringOption(input => input.setName("setting").setDescription("Setting to change").setRequired(true)
        .addChoices(...[...settingSections].map(([value, { label, settings }]) =>
          ({ name: `${label} · ${settings[value].label}`, value }))))
      .addStringOption(input => input.setName("action").setDescription("Save a value or restore its default").setRequired(true)
        .addChoices({ name: "Set", value: "set" }, { name: "Reset (pauses the Nikita feed)", value: "reset" }))
      .addChannelOption(input => input.setName("channel").setDescription("New channel or category for a destination")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildCategory))
      .addRoleOption(input => input.setName("role").setDescription("New role for a notification button"))
      .addStringOption(input => input.setName("url").setDescription("New HTTPS support contact link").setMaxLength(512))
      .addBooleanOption(input => input.setName("confirm_honeypot").setDescription("Confirm that posting in the honeypot can ban users")));
}

class ConfigError extends Error {}

export async function executeConfig(interaction) {
  const reply = content => interaction.reply({ content, allowedMentions: noMentions, flags: MessageFlags.Ephemeral });
  if (!interaction.memberPermissions?.has(Permission.Administrator)) {
    await reply("Only Discord server administrators can configure TrackerBot.");
    return;
  }

  const { guild, options } = interaction;
  const command = options.getSubcommand();
  if (command === "view") {
    const name = options.getString("section", true);
    if (!Object.hasOwn(sections, name)) throw new Error("Unexpected configuration section");
    if (name === "destinations") return reply(listDestinations(guild));
    const lines = Object.entries(sections[name].settings).map(([key, { label, parse }]) => {
      const raw = getPreference(guild.id, key);
      const value = parse(raw);
      const display = value ? (name === "support" ? `<${value}>` : `<@&${value}>`)
        : raw ? "Invalid default" : name === "support" ? "Unset" : "Default role name";
      return `**${label}** ${display}`;
    });
    return reply(lines.join("\n"));
  }
  if (command !== "edit") return reply("Use /config view to see settings or /config edit to change them.");
  if (!canConfigureDestinations()) return reply("TrackerBot's settings storage is unavailable. Ask the operator to check the data directory.");

  const key = options.getString("setting", true);
  const section = settingSections.get(key);
  const action = options.getString("action", true);
  if (!section || !["set", "reset"].includes(action)) throw new Error("Unexpected configuration action or setting");

  const { input, settings } = section;
  const values = { channel: options.getChannel("channel")?.id, role: options.getRole("role")?.id, url: options.getString("url") };
  const supplied = Object.keys(values).filter(name => values[name] != null);
  if (action === "reset" && supplied.length) return reply("To reset a setting, leave channel, role, and url blank.");
  if (action === "set" && (supplied.length !== 1 || supplied[0] !== input)) {
    return reply(`To set ${settings[key].label}, fill in only the \`${input}\` value.`);
  }
  const confirmed = options.getBoolean("confirm_honeypot");
  if (confirmed && key !== "honeypot") return reply("Use confirm_honeypot only for the honeypot setting.");
  const raw = action === "reset" ? null : values[input];
  if (input === "channel") return editDestination(interaction, key, raw, confirmed);

  const { label, parse } = settings[key];
  const value = raw === null ? null : parse(raw);
  if (value === undefined) return reply(input === "url"
    ? "Enter an HTTPS link without embedded credentials (512 characters max)." : "Choose a valid role.");

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const durable = await updatePreference(guild.id, key, value, async () => {
      const role = input === "role" && value ? await guild.roles.fetch(value, { force: true }) : null;
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (!member.permissions.has(Permission.Administrator)) throw new ConfigError("Your server administrator access changed.");
      if (input === "role" && value) {
        if (!role || !isSafeNotificationRole(role, guild.id)) {
          throw new ConfigError("Choose a dedicated notification role below TrackerBot with only basic communication permissions.");
        }
        if (member.id !== guild.ownerId && role.comparePositionTo(member.roles.highest) >= 0) {
          throw new ConfigError("Choose a notification role below your highest role.");
        }
      }
    });
    const status = durable ? "" : " TrackerBot could not confirm it will survive a crash.";
    await interaction.editReply({ content: `${label} ${value === null ? "reset to its default" : "saved"}.${status}`,
      allowedMentions: noMentions });
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    await interaction.editReply({ content: error.message, allowedMentions: noMentions });
  }
}
