import { Events } from "discord.js";
import { hasAdminRole } from "../config/constants.js";
import { canConfigureDestinations, getDestinationId, getDestinationOverride, getHoneypotCutoff, withDestinationReadLock } from "../config/destinations.js";

// Honeypot channel: a hidden channel that real users should never post in.
// Bots/spam accounts that find it and send a message are banned on sight.
// Active only when a host or server administrator sets its destination.

const HONEYPOT_WARNING = "# ⛔️⚠️ DO NOT SEND MESSAGES HERE, YOU WILL BE BANNED INSTANTLY ⚠️⛔️";
const isWarning = (message, botId) => message.author.id === botId && message.content === HONEYPOT_WARNING;

const SIXTEEN_HOURS_MS = 16 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
const BULK_DELETE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000; // Discord bulk-delete window
// Cap pagination so a runaway channel can't trigger unbounded API calls.
// A honeypot should hold ~1 message in steady state; 1000 is a generous ceiling.
const MAX_FETCH_PAGES = 10;
const PAGE_SIZE = 100;

export function setupHoneypot(client) {
  if (!getDestinationId(undefined, "honeypot") && !canConfigureDestinations()) return;
  let unavailable = new Set();

  function active(channel) {
    return channel.id === getDestinationId(channel.guildId, "honeypot");
  }

  async function sweep() {
    const missing = new Set();
    const ids = new Set([getDestinationId(undefined, "honeypot"), ...[...client.guilds.cache.keys()]
      .map(guildId => getDestinationOverride(guildId, "honeypot"))].filter(Boolean));
    for (const id of ids) {
      const channel = client.channels.cache.get(id);
      if (!channel?.isTextBased()) {
        missing.add(id);
        if (!unavailable.has(id)) console.warn("Honeypot destination is unavailable", { channelId: id });
        continue;
      }
      if (!active(channel)) continue;
      try {
        const cutoff = getHoneypotCutoff(channel.guildId, id);
        const currentActivation = () => active(channel) && getHoneypotCutoff(channel.guildId, id) === cutoff;
        const whileActive = run => withDestinationReadLock(channel.guildId, () => {
          if (currentActivation()) return run();
        });
        await ensureHoneypotMessage(channel, client.user.id, currentActivation, whileActive);
        await cleanupOldMessages(channel, client.user.id, cutoff, currentActivation, whileActive);
      } catch (err) {
        console.error("Honeypot cleanup failed", { code: err?.code ?? "unknown" });
      }
    }
    unavailable = missing;
  }

  async function tick() {
    try {
      await sweep();
    } catch (err) {
      console.error("Honeypot sweep failed", { code: err?.code ?? "unknown" });
    } finally {
      setTimeout(tick, CLEANUP_INTERVAL_MS).unref();
    }
  }
  client.once(Events.ClientReady, tick);

  client.on(Events.MessageCreate, async message => {
    if (message.channelId !== getDestinationId(message.guild?.id, "honeypot")) return;
    if (message.author.bot) return;

    try {
      // Fetch the member when Discord did not hydrate it in the event so the
      // admin exemption cannot be bypassed by a missing message.member value.
      const member = message.member ?? await message.guild.members.fetch(message.author.id);
      if (hasAdminRole(member.roles.cache)) return;
      await withDestinationReadLock(message.guild?.id, async () => {
        if (message.channelId !== getDestinationId(message.guild?.id, "honeypot")) return;
        try {
          await message.delete();
        } catch (err) {
          console.error("Failed to delete honeypot trigger message:", err);
        }
        await punishAuthor(message);
      });
    } catch (err) {
      // Fail safe: if member resolution or role inspection fails, do not risk
      // punishing an administrator.
      console.error("Failed to handle honeypot message:", err);
    }
  });
}

export async function ensureHoneypotMessage(channel, botId, active = () => true, whileActive = run => run()) {
  for await (const messages of fetchMessagePages(channel)) {
    if (!active() || messages.some(message => isWarning(message, botId))) return;
  }
  if (active()) return whileActive(() => channel.send(HONEYPOT_WARNING));
}

export async function removeHoneypotWarnings(channel, botId) {
  for await (const messages of fetchMessagePages(channel)) {
    for (const warning of messages.filter(message => isWarning(message, botId)).values()) {
      await warning.delete().catch(error => {
        if (error?.code !== 10008) throw error;
      });
    }
  }
}

// Delete messages older than 16h, preserving the honeypot warning message.
// Uses bulk delete for messages within Discord's 14-day window, individual
// delete otherwise. Paginates so older messages beyond the first page are swept.
async function cleanupOldMessages(channel, botId, cutoff, active, whileActive) {
  const now = Date.now();
  for await (const messages of fetchMessagePages(channel)) {
    if (!active()) return;
    const toDelete = messages.filter(
      msg => msg.createdTimestamp >= cutoff && now - msg.createdTimestamp > SIXTEEN_HOURS_MS && !isWarning(msg, botId)
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
        await whileActive(() => channel.bulkDelete([...bulkable.values()]));
      } catch (err) {
        console.error("Honeypot bulk delete failed:", err);
      }
    }

    for (const msg of individual.values()) {
      if (!active()) return;
      try {
        await whileActive(() => msg.delete());
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
