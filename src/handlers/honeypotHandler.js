import { Events } from "discord.js";
import { hasAdminRole } from "../config/constants.js";

// Honeypot channel: a hidden channel that real users should never post in.
// Bots/spam accounts that find it and send a message are banned on sight.
// Activates only when HONEYPOT_CHANNEL_ID is set; otherwise this is a no-op.

const HONEYPOT_CHANNEL_ID = process.env.HONEYPOT_CHANNEL_ID;

// Stable marker embedded in the bot's warning message so we can detect it
// across restarts without persisting state.
const HONEYPOT_MARKER = "<!-- trackerbot-honeypot-message -->";

const HONEYPOT_WARNING = `${HONEYPOT_MARKER}\n# ⛔️⚠️ DO NOT SEND MESSAGES HERE, YOU WILL BE BANNED INSTANTLY ⚠️⛔️`;

const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // Discord bulk-delete window
// Cap pagination so a runaway channel can't trigger unbounded API calls.
// A honeypot should hold ~1 message in steady state; 1000 is a generous ceiling.
const MAX_FETCH_PAGES = 10;
const PAGE_SIZE = 100;

export function setupHoneypot(client) {
  if (!HONEYPOT_CHANNEL_ID) return;

  // Use `once`: discord.js re-emits ClientReady on reconnect, and `on` would
  // register a fresh setInterval each time, leaking cleanup timers.
  client.once(Events.ClientReady, async () => {
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
      // Fetch the member when Discord did not hydrate it in the event so the
      // admin exemption cannot be bypassed by a missing message.member value.
      const member = message.member ?? await message.guild.members.fetch(message.author.id);
      if (hasAdminRole(member.roles.cache)) return;

      try {
        await message.delete();
      } catch (err) {
        console.error("Failed to delete honeypot trigger message:", err);
      }

      await punishAuthor(message);
    } catch (err) {
      // Fail safe: if member resolution or role inspection fails, do not risk
      // punishing an administrator.
      console.error("Failed to handle honeypot message:", err);
    }
  });
}

// Send the warning message only if no existing bot message carries the marker.
// Paginates so an existing marker beyond the first page isn't missed.
async function ensureHoneypotMessage(channel) {
  for await (const messages of fetchMessagePages(channel)) {
    if (messages.some(msg => msg.author.bot && msg.content?.includes(HONEYPOT_MARKER))) {
      return; // marker found — no duplicate needed
    }
  }
  await channel.send(HONEYPOT_WARNING);
}

// Delete messages older than 16h, preserving the honeypot warning message.
// Uses bulk delete for messages within Discord's 14-day window, individual
// delete otherwise. Paginates so older messages beyond the first page are swept.
async function cleanupOldMessages(channel) {
  const now = Date.now();
  for await (const messages of fetchMessagePages(channel)) {
    const toDelete = messages.filter(
      msg => now - msg.createdTimestamp > SIXTEEN_HOURS_MS &&
        !(msg.author.bot && msg.content?.includes(HONEYPOT_MARKER))
    );

    if (toDelete.size === 0) continue;

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
}

// Yields pages of channel messages newest-first, using a `before` cursor.
// Bounded by MAX_FETCH_PAGES to prevent unbounded API calls on a runaway channel.
async function* fetchMessagePages(channel) {
  let before;
  for (let i = 0; i < MAX_FETCH_PAGES; i++) {
    const messages = await channel.messages.fetch({
      limit: PAGE_SIZE,
      ...(before ? { before } : {})
    });
    if (messages.size === 0) return;
    yield messages;
    before = messages.last().id; // oldest in this page → continue backwards
    if (messages.size < PAGE_SIZE) return; // exhausted history
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
