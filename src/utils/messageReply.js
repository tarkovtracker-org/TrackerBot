// References stay in the invocation channel: never fetch or disclose messages
// from another guild/channel and never ping the original author implicitly.
export function messageReference(value, interaction) {
  if (!value?.trim()) return undefined;
  const input = value.trim();
  if (/^\d{17,20}$/.test(input)) return input;
  const match = /^https:\/\/(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})\/?$/.exec(input);
  if (match && match[1] === interaction.guildId && match[2] === interaction.channelId) return match[3];
  throw new Error("Use a message ID or a Discord message link from this channel.");
}

export const noMentions = { parse: [], repliedUser: false };

export async function validateReplyTarget(interaction, reference) {
  if (!reference) return;
  try {
    await interaction.channel.messages.fetch({ message: reference, force: true });
  } catch {
    // This failed before any send: unlike a failed POST, delivery is not uncertain.
    throw Object.assign(new Error("Reply target unavailable"), { code: "REPLY_TARGET_UNAVAILABLE" });
  }
}

export async function postInChannel(interaction, payload, reference) {
  await validateReplyTarget(interaction, reference);
  return interaction.channel.send({
    ...payload,
    allowedMentions: noMentions,
    ...(reference ? { reply: { messageReference: reference, failIfNotExists: true } } : {})
  });
}
