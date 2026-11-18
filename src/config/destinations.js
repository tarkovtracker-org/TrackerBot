import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { ChannelType, PermissionFlagsBits as Permission } from "discord.js";
import { writeJsonAtomically } from "../utils/writeJsonAtomically.js";

const text = [ChannelType.GuildText];
const announcements = [...text, ChannelType.GuildAnnouncement];
const categories = [ChannelType.GuildCategory];
const view = [Permission.ViewChannel];
const send = [...view, Permission.SendMessages];
const history = [...view, Permission.ReadMessageHistory];
const manageCategory = [...view, Permission.ManageChannels, Permission.ManageRoles];
const supportCategory = [...manageCategory, Permission.SendMessages, Permission.ReadMessageHistory,
  Permission.EmbedLinks, Permission.AttachFiles];

export const destinations = Object.freeze({
  welcome: { label: "Welcome messages", env: "WELCOME_CHANNEL_ID", types: announcements, permissions: send },
  honeypot: { label: "Honeypot", env: "HONEYPOT_CHANNEL_ID", types: text,
    permissions: [...send, Permission.ReadMessageHistory, Permission.ManageMessages] },
  archive: { label: "Channel archives", env: "ARCHIVE_CATEGORY_ID", types: categories, permissions: manageCategory },
  tickets: { label: "Legacy tickets", env: "TICKET_CATEGORY_ID", types: categories, permissions: manageCategory },
  "support-tracker": { label: "TarkovTracker public help", env: "SUPPORT_TRACKER_CHANNEL_ID", types: text, permissions: history },
  "support-scanner": { label: "RatScanner public help", env: "SUPPORT_SCANNER_CHANNEL_ID", types: text, permissions: history },
  "support-monitor": { label: "TarkovMonitor public help", env: "SUPPORT_MONITOR_CHANNEL_ID", types: text, permissions: history },
  "support-account": { label: "Account tickets", env: "SUPPORT_ACCOUNT_CATEGORY_ID", types: categories, permissions: supportCategory },
  "support-moderation": { label: "Moderation tickets", env: "SUPPORT_MODERATION_CATEGORY_ID", types: categories, permissions: supportCategory },
  nikita: { label: "Nikita X feed", env: "NIKITA_X_CHANNEL_ID", types: announcements,
    permissions: [...send, Permission.ReadMessageHistory, Permission.EmbedLinks, Permission.AttachFiles] }
});

export const isDiscordId = value => typeof value === "string" && /^\d{17,20}$/.test(value);
export const ticketDestinationKeys = new Set(["tickets", "support-account", "support-moderation"]);

let file;
let settings = {};
let previousTickets = {};
let honeypotActivations = {};
let writes = Promise.resolve();
const guildOperations = new Map();

function withDestinationLock(guildId, run, exclusive) {
  if (!file) return run();
  let lock = guildOperations.get(guildId);
  if (!lock) {
    lock = { writer: Promise.resolve(), readers: new Set(), pending: 0 };
    guildOperations.set(guildId, lock);
  }
  const ready = exclusive ? Promise.all([lock.writer, ...lock.readers]) : lock.writer;
  const operation = ready.then(run);
  const settled = operation.then(() => {}, () => {});
  lock.pending++;
  if (exclusive) lock.writer = settled;
  else lock.readers.add(settled);
  void settled.then(() => {
    if (!exclusive) lock.readers.delete(settled);
    if (--lock.pending === 0) guildOperations.delete(guildId);
  });
  return operation;
}

export const withDestinationReadLock = (guildId, run) => withDestinationLock(guildId, run, false);

export async function initializeDestinations(path = process.env.TRACKERBOT_DESTINATIONS_FILE?.trim()) {
  if (!path) {
    file = undefined;
    settings = {};
    previousTickets = {};
    honeypotActivations = {};
    return;
  }
  if (!isAbsolute(path)) throw new Error("TRACKERBOT_DESTINATIONS_FILE must be absolute.");
  const data = await readFile(path, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (data === null && !(await stat(dirname(path))).isDirectory()) {
    throw new Error("The Discord destination settings directory is unavailable.");
  }
  if (data !== null) {
    const parsed = JSON.parse(data);
    if (parsed?.version !== 1 || !parsed.guilds || Array.isArray(parsed.guilds) || typeof parsed.guilds !== "object"
        || !Object.entries(parsed.guilds).every(([guild, values]) => isDiscordId(guild) && values
          && typeof values === "object" && !Array.isArray(values) && Object.entries(values).every(([key, value]) =>
            Object.hasOwn(destinations, key) && isDiscordId(value)))) {
      throw new Error("The Discord destination settings file is invalid.");
    }
    const history = parsed.previousTickets ?? {};
    const activations = parsed.honeypotActivations ?? {};
    if (typeof history !== "object" || !history || Array.isArray(history)
        || !Object.entries(history).every(([guild, values]) => isDiscordId(guild) && values
          && typeof values === "object" && !Array.isArray(values) && Object.entries(values).every(([key, ids]) =>
            ticketDestinationKeys.has(key) && ids && typeof ids === "object" && !Array.isArray(ids)
            && Object.entries(ids).every(([id, category]) => isDiscordId(id) && isDiscordId(category))))) {
      throw new Error("The Discord ticket destination history is invalid.");
    }
    if (typeof activations !== "object" || Array.isArray(activations)
        || !Object.entries(activations).every(([guild, activation]) => isDiscordId(guild)
          && isDiscordId(activation?.channelId) && Number.isSafeInteger(activation.startedAt) && activation.startedAt >= 0)) {
      throw new Error("The Discord honeypot activation history is invalid.");
    }
    const missing = Object.entries(parsed.guilds).filter(([guild, values]) =>
      values.honeypot && activations[guild]?.channelId !== values.honeypot);
    if (missing.length) {
      const startedAt = Date.now();
      for (const [guild, values] of missing) activations[guild] = { channelId: values.honeypot, startedAt };
      await writeJsonAtomically(path, { ...parsed, honeypotActivations: activations });
    }
    settings = parsed.guilds;
    previousTickets = history;
    honeypotActivations = activations;
  } else {
    settings = {};
    previousTickets = {};
    honeypotActivations = {};
  }
  file = path;
}

export const canConfigureDestinations = () => Boolean(file);
export const getDestinationOverride = (guildId, key) => settings[guildId]?.[key];
export const getDestinationId = (guildId, key) => getDestinationOverride(guildId, key) ?? process.env[destinations[key].env]?.trim();
export function getAffectedBotFeatures(channelId, guildId) {
  return Object.entries(destinations).filter(([key]) => getDestinationId(guildId, key) === channelId)
    .map(([key, { label, env }]) => {
      const setting = getDestinationOverride(guildId, key) ? `/destinations set destination:${key}` : env;
      return `${label.toLowerCase()} (${setting})`;
    });
}

export const getPreviousTicketParent = (guildId, key, channelId) => previousTickets[guildId]?.[key]?.[channelId];
export const getPreviousTickets = (guildId, key) => Object.entries(previousTickets[guildId]?.[key] ?? {});
export function getHoneypotCutoff(guildId, channelId) {
  const activation = honeypotActivations[guildId];
  if (activation?.channelId === channelId) return activation.startedAt;
  return getDestinationOverride(guildId, "honeypot") ? Infinity : 0;
}

export function updateDestination(guildId, key, channelId, validate) {
  if (!file || !isDiscordId(guildId) || !Object.hasOwn(destinations, key)
      || channelId !== null && !isDiscordId(channelId)) {
    throw new Error("Invalid Discord destination update.");
  }
  return withDestinationLock(guildId, async () => {
    const next = { ...settings[guildId] };
    if (channelId === null) delete next[key];
    else next[key] = channelId;
    let rollback;
    let replaced = false;
    try {
      const previous = await validate(next, undo => { rollback = undo; });
      const update = writes.then(async () => {
        const history = { ...previousTickets };
        const activations = { ...honeypotActivations };
        if (key === "honeypot") {
          const activeId = previous?.honeypotChannelId;
          if (!activeId) delete activations[guildId];
          else if (activations[guildId]?.channelId !== activeId) {
            activations[guildId] = { channelId: activeId, startedAt: Date.now() };
          }
        }
        if (ticketDestinationKeys.has(key) && previous) {
          const guildHistory = { ...history[guildId] };
          const retained = Object.entries(guildHistory[key] ?? {})
            .filter(([id]) => !previous.liveChannelIds || previous.liveChannelIds.has(id));
          const added = (previous.ticketIds ?? []).map(id => [id, previous.categoryId]);
          if (retained.length || added.length) guildHistory[key] = Object.fromEntries([...retained, ...added]);
          else delete guildHistory[key];
          if (Object.keys(guildHistory).length) history[guildId] = guildHistory;
          else delete history[guildId];
        }
        const guilds = { ...settings };
        if (Object.keys(next).length) guilds[guildId] = next;
        else delete guilds[guildId];
        await writeJsonAtomically(file, { version: 1, guilds, previousTickets: history, honeypotActivations: activations }, () => {
          replaced = true;
          settings = guilds;
          previousTickets = history;
          honeypotActivations = activations;
        });
      });
      writes = update.catch(() => {});
      await update;
      return true;
    } catch (error) {
      if (replaced) {
        console.warn("Could not sync the Discord destination settings directory", { code: error?.code ?? "unknown" });
        return false;
      }
      if (rollback) {
        try {
          await rollback();
        } catch (cleanupError) {
          console.warn("Could not remove the unused honeypot warning", { code: cleanupError?.code ?? "unknown" });
        }
      }
      throw error;
    }
  }, true);
}
