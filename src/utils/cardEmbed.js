import { EmbedBuilder } from "discord.js";

const defaultColor = 0x7f8cff;

export function createCardEmbed({
  title,
  description,
  color = defaultColor,
  footer,
  fields
} = {}) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp(new Date());

  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (Array.isArray(fields) && fields.length) {
    embed.addFields(fields);
  }
  if (footer) embed.setFooter({ text: footer });

  return embed;
}
