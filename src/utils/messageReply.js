// References stay in the invocation channel: never fetch or disclose messages
// from another guild/channel and never ping the original author implicitly.
export function messageReference(value, interaction) {
  if (!value?.trim()) return undefined;
  const input = value.trim();
  if (/^\d{17,20}$/.test(input)) return input;
  const match = /^https:\/\/(?:www\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(input);
  if (match && match[1] === interaction.guildId && match[2] === interaction.channelId) return match[3];
  throw new Error("Use a message ID or a Discord message link from this channel.");
}

export const noMentions = { parse: [], repliedUser: false };

export async function postInChannel(interaction, payload, reference) {
  if (reference) await interaction.channel.messages.fetch(reference);
  return interaction.channel.send({
    ...payload,
    allowedMentions: noMentions,
    ...(reference ? { reply: { messageReference: reference, failIfNotExists: true } } : {})
  });
}
