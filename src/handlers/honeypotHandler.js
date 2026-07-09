import { Events } from "discord.js";

// Honeypot channel: a hidden channel that real users should never post in.
// Bots/spam accounts that find it and send a message are banned on sight.
// Activates only when HONEYPOT_CHANNEL_ID is set; otherwise this is a no-op.

const HONEYPOT_CHANNEL_ID = process.env.HONEYPOT_CHANNEL_ID;

// Stable marker embedded in the bot's warning message so we can detect it
// across restarts without persisting state.
const HONEYPOT_MARKER = "<!-- trackerbot-honeypot-message -->";

const HONEYPOT_WARNING = `${HONEYPOT_MARKER}\n**⚠️ Honeypot channel** — do not post here.`;

const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // Discord bulk-delete window

export function setupHoneypot(client) {
  if (!HONEYPOT_CHANNEL_ID) return;

  client.on(Events.ClientReady, async () => {
    try {
      const channel = client.channels.cache.get(HONEYPOT_CHANNEL_ID);
      if (!channel?.isTextBased()) {
        console.warn(`Honeypot channel not found or not text-based: ${HONEYPOT_CHANNEL_ID}`);
        return;
      }

      await ensureHoneypotMessage(channel);
      await cleanupOldMessages(channel);

      // Recurring sweep for messages older than 16h.
      setInterval(() => {
        cleanupOldMessages(channel).catch(err =>
          console.error("Honeypot cleanup failed:", err)
        );
      }, CLEANUP_INTERVAL_MS);
    } catch (err) {
      console.error("Failed to set up honeypot:", err);
    }
  });

  client.on(Events.MessageCreate, async message => {
    if (message.channelId !== HONEYPOT_CHANNEL_ID) return;
    if (message.author.bot) return;

    try {
      await message.delete();
    } catch (err) {
      console.error("Failed to delete honeypot trigger message:", err);
    }

    await punishAuthor(message);
  });
}

// Send the warning message only if no existing bot message carries the marker.
async function ensureHoneypotMessage(channel) {
  const recent = await channel.messages.fetch({ limit: 50 });
  const exists = recent.some(
    msg => msg.author.bot && msg.content?.includes(HONEYPOT_MARKER)
  );
  if (!exists) {
    await channel.send(HONEYPOT_WARNING);
  }
}

// Delete messages older than 16h, preserving the honeypot warning message.
// Uses bulk delete for messages within Discord's 14-day window, individual
// delete otherwise.
async function cleanupOldMessages(channel) {
  const now = Date.now();
  const recent = await channel.messages.fetch({ limit: 100 });

  const toDelete = recent.filter(
    msg => now - msg.createdTimestamp > SIXTEEN_HOURS_MS &&
      !(msg.author.bot && msg.content?.includes(HONEYPOT_MARKER))
  );

  if (toDelete.size === 0) return;

  const bulkable = toDelete.filter(
    msg => now - msg.createdTimestamp <= BULK_DELETE_LIMIT_MS
  );
  const individual = toDelete.filter(
    msg => now - msg.createdTimestamp > BULK_DELETE_LIMIT_MS
  );

  if (bulkable.size > 0) {
    try {
      await channel.bulkDelete([...bulkable.values()]);
    } catch (err) {
      console.error("Honeypot bulk delete failed:", err);
    }
  }

  for (const msg of individual.values()) {
    try {
      await msg.delete();
    } catch (err) {
      console.error("Honeypot individual delete failed:", err);
    }
  }
}

// Ban the offender; fall back to kick if the ban fails (permissions/hierarchy).
async function punishAuthor(message) {
  const { author, guild } = message;
  const reason = "Posted in the honeypot channel";

  try {
    await guild.bans.create(author.id, { reason });
    console.log(`Honeypot: banned ${author.tag} (${author.id})`);
  } catch (err) {
    console.error(`Honeypot: ban failed for ${author.tag} (${author.id}), trying kick:`, err);
    try {
      const member = await guild.members.fetch(author.id);
      await member.kick(reason);
      console.log(`Honeypot: kicked ${author.tag} (${author.id})`);
    } catch (kickErr) {
      console.error(`Honeypot: kick also failed for ${author.tag} (${author.id}):`, kickErr);
    }
  }
}
