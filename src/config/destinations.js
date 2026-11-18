import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
let writes = Promise.resolve();
const ticketOperations = new Map();

export function withTicketDestinationLock(guildId, run) {
  if (!file) return run();
  const operation = (ticketOperations.get(guildId) ?? Promise.resolve()).then(run);
  const settled = operation.catch(() => {});
  ticketOperations.set(guildId, settled);
  void settled.then(() => {
    if (ticketOperations.get(guildId) === settled) ticketOperations.delete(guildId);
  });
  return operation;
}

export async function initializeDestinations(path = process.env.TRACKERBOT_DESTINATIONS_FILE?.trim()) {
  if (!path) return;
  if (!isAbsolute(path)) throw new Error("TRACKERBOT_DESTINATIONS_FILE must be absolute.");
  const data = await readFile(path, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (data !== null) {
    const parsed = JSON.parse(data);
    if (parsed?.version !== 1 || !parsed.guilds || Array.isArray(parsed.guilds) || typeof parsed.guilds !== "object"
        || !Object.entries(parsed.guilds).every(([guild, values]) => isDiscordId(guild) && values
          && typeof values === "object" && !Array.isArray(values) && Object.entries(values).every(([key, value]) =>
            Object.hasOwn(destinations, key) && isDiscordId(value)))) {
      throw new Error("The Discord destination settings file is invalid.");
    }
    const history = parsed.previousTickets ?? {};
    if (typeof history !== "object" || !history || Array.isArray(history)
        || !Object.entries(history).every(([guild, values]) => isDiscordId(guild) && values
          && typeof values === "object" && !Array.isArray(values) && Object.entries(values).every(([key, ids]) =>
            ticketDestinationKeys.has(key) && ids && typeof ids === "object" && !Array.isArray(ids)
            && Object.entries(ids).every(([id, category]) => isDiscordId(id) && isDiscordId(category))))) {
      throw new Error("The Discord ticket destination history is invalid.");
    }
    settings = parsed.guilds;
    previousTickets = history;
  } else {
    settings = {};
    previousTickets = {};
  }
  file = path;
}

export const canConfigureDestinations = () => Boolean(file);
export const getDestinationOverride = (guildId, key) => settings[guildId]?.[key];
export const getDestinationId = (guildId, key) => getDestinationOverride(guildId, key) ?? process.env[destinations[key].env]?.trim();
export const getPreviousTicketParent = (guildId, key, channelId) => previousTickets[guildId]?.[key]?.[channelId];
export const getPreviousTickets = (guildId, key) => Object.entries(previousTickets[guildId]?.[key] ?? {});

export function updateDestination(guildId, key, channelId, validate) {
  if (!file || !isDiscordId(guildId) || !Object.hasOwn(destinations, key)
      || channelId !== null && !isDiscordId(channelId)) {
    throw new Error("Invalid Discord destination update.");
  }
  function enqueueUpdate() {
    const update = writes.then(async () => {
      const next = { ...settings[guildId] };
      if (channelId === null) delete next[key];
      else next[key] = channelId;
      const previous = await validate(next);
      const history = { ...previousTickets };
      if (previous?.ticketIds.length && ticketDestinationKeys.has(key)) {
        const guildHistory = { ...history[guildId] };
        guildHistory[key] = {
          ...guildHistory[key], ...Object.fromEntries(previous.ticketIds.map(id => [id, previous.categoryId]))
        };
        history[guildId] = guildHistory;
      }
      const guilds = { ...settings };
      if (Object.keys(next).length) guilds[guildId] = next;
      else delete guilds[guildId];
      await writeJsonAtomically(file, { version: 1, guilds, previousTickets: history });
      settings = guilds;
      previousTickets = history;
    });
    writes = update.catch(() => {});
    return update;
  }
  return ticketDestinationKeys.has(key) ? withTicketDestinationLock(guildId, enqueueUpdate) : enqueueUpdate();
}
