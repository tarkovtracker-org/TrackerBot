import { MessageFlags, PermissionFlagsBits as Permission } from "discord.js";
import { canConfigureDestinations, getPreference, updatePreference } from "../config/destinations.js";
import { isSafeNotificationRole } from "../config/constants.js";
import { notificationRoles, supportLinks } from "../config/preferences.js";
import { noMentions } from "../utils/messageReply.js";
import { addDestinationOptions, executeDestinations } from "./destinationsCommand.js";

const preferenceGroups = {
  support: { description: "Manage help desk contact links", option: "link", choices: supportLinks },
  notifications: { description: "Manage roles used by notification buttons", option: "notification", choices: notificationRoles }
};

export function addConfigOptions(command) {
  command.setDefaultMemberPermissions(Permission.Administrator).addSubcommandGroup(addDestinationOptions);
  for (const [name, { description, option, choices }] of Object.entries(preferenceGroups)) {
    const select = subcommand => subcommand.addStringOption(input => input.setName(option)
      .setDescription("Setting to change").setRequired(true)
      .addChoices(...Object.entries(choices).map(([value, { label }]) => ({ name: label, value }))));
    command.addSubcommandGroup(group => group.setName(name).setDescription(description)
      .addSubcommand(sub => sub.setName("list").setDescription("Show current settings"))
      .addSubcommand(sub => {
        select(sub.setName("set").setDescription("Save a setting for this server"));
        return name === "support"
          ? sub.addStringOption(input => input.setName("url").setDescription("HTTPS private-contact link").setMaxLength(512).setRequired(true))
          : sub.addRoleOption(input => input.setName("role").setDescription("Dedicated notification role").setRequired(true));
      })
      .addSubcommand(sub => select(sub.setName("reset").setDescription("Restore the default for a setting"))));
  }
  return command;
}

class ConfigError extends Error {}

export async function executeConfig(interaction) {
  const reply = content => interaction.reply({ content, allowedMentions: noMentions, flags: MessageFlags.Ephemeral });
  if (!interaction.memberPermissions?.has(Permission.Administrator)) {
    await reply("Only Discord server administrators can configure TrackerBot.");
    return;
  }

  const action = interaction.options.getSubcommand();
  if (action !== "list" && !canConfigureDestinations()) {
    await reply("TrackerBot's settings storage is unavailable. Ask the operator to check the data directory.");
    return;
  }
  const name = interaction.options.getSubcommandGroup(true);
  if (name === "destinations") return executeDestinations(interaction);
  if (!Object.hasOwn(preferenceGroups, name)) throw new Error("Unexpected configuration group");

  const { guild } = interaction;
  const { option, choices } = preferenceGroups[name];
  if (action === "list") {
    const lines = Object.entries(choices).map(([key, { label, parse }]) => {
      const raw = getPreference(guild.id, key);
      const value = parse(raw);
      const display = value ? (name === "support" ? `<${value}>` : `<@&${value}>`)
        : raw ? "Invalid default" : name === "support" ? "Unset" : "Default role name";
      return `**${label}** ${display}`;
    });
    await reply(lines.join("\n"));
    return;
  }

  const key = interaction.options.getString(option, true);
  if (!Object.hasOwn(choices, key) || !["set", "reset"].includes(action)) throw new Error("Unexpected configuration action");
  const { label, parse } = choices[key];
  const value = action === "reset" ? null : parse(name === "support"
    ? interaction.options.getString("url", true) : interaction.options.getRole("role", true).id);
  if (value === undefined) {
    await reply(name === "support" ? "Enter an HTTPS link without embedded credentials (512 characters max)." : "Choose a valid role.");
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const durable = await updatePreference(guild.id, key, value, async () => {
      const role = name === "notifications" && value ? await guild.roles.fetch(value, { force: true }) : null;
      const member = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (!member.permissions.has(Permission.Administrator)) throw new ConfigError("Your server administrator access changed.");
      if (name === "notifications" && value) {
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
