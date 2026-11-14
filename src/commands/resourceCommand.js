import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } from "discord.js";
import { getResourceLinks } from "../config/resources.js";
import { allowedCommandRoles, hasAdminRole } from "../config/constants.js";
import { createCardEmbed } from "../utils/cardEmbed.js";
import { messageReference, noMentions, postInChannel } from "../utils/messageReply.js";

export async function executeResource(interaction) {
  const action = interaction.options.getSubcommand();
  if (action === "help") {
    await interaction.reply({
      embeds: [createCardEmbed({
        title: "TrackerBot commands",
        description: "**/tt url** — share the website\n**/tt resources** — share maintained guides and tools\nAdd **private:true** to keep a link to yourself, or **reply_to** to answer a message in this channel.\n\nIn a managed support ticket: **/ticket close** retains history; **/ticket reopen** requires membership in its configured queue staff roles.\nStaff: **/support check** validates help-desk settings; **/support panel** previews publishing/updating its panel. **/message** previews announcements/replies; **/channel purge** removes a chosen number of recent messages; **/channel archive** hides a channel for review; **/nuke** resets a channel after confirmation."
      })],
      flags: MessageFlags.Ephemeral,
      allowedMentions: noMentions
    });
    return;
  }
  if (!["url", "resources"].includes(action)) throw new Error("Unknown resource action");
  if (allowedCommandRoles.size && !hasAdminRole(interaction.member.roles.cache) &&
      !interaction.member.roles.cache.some(role =>
        role.id !== interaction.guildId && role.name !== "@everyone" && allowedCommandRoles.has(role.id)
      )) {
    await interaction.reply({ content: "Your role cannot share resources with this bot.", flags: MessageFlags.Ephemeral });
    return;
  }
  const privateReply = interaction.options.getBoolean("private") ?? false;
  const sendPermission = interaction.channel?.isThread?.()
    ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!privateReply && !interaction.memberPermissions?.has(sendPermission)) {
    await interaction.reply({ content: "You cannot post in this channel. Use private:true to view the link yourself.", flags: MessageFlags.Ephemeral });
    return;
  }
  let reference;
  let links;
  try {
    reference = messageReference(interaction.options.getString("reply_to"), interaction);
    if (reference && privateReply) throw new Error("Replies to messages are public; remove reply_to or set private:false.");
    links = getResourceLinks();
  } catch (err) {
    // Only our static validation messages are logged, never the full URL/error.
    console.warn("Resource command configuration or reference rejected", { reason: err.message });
    await interaction.reply({
      content: err.message.startsWith("Use a message") || err.message.startsWith("Replies to")
        ? err.message : "The resource links need staff attention. Please contact an administrator.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  const url = action === "url" ? links.site : links.resources;
  const title = action === "url" ? "TarkovTracker.org" : "TarkovTracker resources";
  const description = action === "url"
    ? "Track your Escape from Tarkov progress, tasks and hideout on TarkovTracker."
    : "Find maintained setup guides, companion apps and useful community tools on the website.";
  const payload = {
    embeds: [createCardEmbed({ title, description }).setURL(url)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setLabel(action === "url" ? "Open TarkovTracker" : "Browse resources").setStyle(ButtonStyle.Link).setURL(url)
    )]
  };
  if (!reference) {
    await interaction.reply({ ...payload, allowedMentions: noMentions, ...(privateReply ? { flags: MessageFlags.Ephemeral } : {}) });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await postInChannel(interaction, payload, reference);
    await interaction.editReply({ content: "Resource shared in reply to the selected message." }).catch(err => {
      console.warn("Resource shared but confirmation notice failed", { code: err.code ?? "unknown" });
    });
  } catch (err) {
    console.error("Resource reply failed", { code: err.code ?? "unknown" });
    await interaction.editReply({
      content: err.code === "REPLY_TARGET_UNAVAILABLE"
        ? "The reply target could not be loaded in this channel. Nothing was sent. Check the message link or ID."
        : "Resource delivery could not be confirmed. Check the channel before sending again."
    });
  }
}
