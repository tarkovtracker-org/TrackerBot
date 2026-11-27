import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { ChannelType, PermissionFlagsBits as Permission } from "discord.js";
import { writeJsonAtomically } from "../utils/writeJsonAtomically.js";
import { getConfigPath } from "./configPath.js";
import { preferences } from "./preferences.js";

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
export const isSubscriptionId = value => typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value);
export const ticketDestinationKeys = new Set(["tickets", "support-account", "support-moderation"]);

let file;
let settings = {};
let previousTickets = {};
let honeypotActivations = {};
let guildPreferences = {};
let nikitaSubscriptions = {};
let supportActivations;
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

export async function initializeDestinations(path) {
  if (path === undefined) {
    path = getConfigPath();
    if (!process.env.TRACKERBOT_DESTINATIONS_FILE?.trim()) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    }
  }
  if (!path) {
    file = undefined;
    settings = {};
    previousTickets = {};
    honeypotActivations = {};
    guildPreferences = {};
    nikitaSubscriptions = {};
    supportActivations = undefined;
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
    if (parsed?.version !== 1 || !isGuildMap(parsed.guilds, (key, value) =>
      Object.hasOwn(destinations, key) && isDiscordId(value))) {
      throw new Error("The Discord destination settings file is invalid.");
    }
    const history = parsed.previousTickets ?? {};
    const activations = parsed.honeypotActivations ?? {};
    const savedPreferences = parsed.preferences ?? {};
    const subscriptions = parsed.nikitaSubscriptions ?? {};
    const activeSupport = parsed.supportActivations;
    if (activeSupport !== undefined && (!activeSupport || typeof activeSupport !== "object" || Array.isArray(activeSupport) ||
        !Object.entries(activeSupport).every(([guild, state]) => isDiscordId(guild) && [true, null, "review"].includes(state)))) {
      throw new Error("The help-desk activations in the Discord settings file are invalid.");
    }
    if (typeof subscriptions !== "object" || Array.isArray(subscriptions) ||
      !Object.entries(subscriptions).every(([guild, id]) => isDiscordId(guild)
        && (parsed.guilds[guild]?.nikita ? isSubscriptionId(id) : id === null))) {
      throw new Error("The Nikita subscriptions in the Discord settings file are invalid.");
    }
    if (!isGuildMap(savedPreferences, (key, value) =>
      Object.hasOwn(preferences, key) && preferences[key].parse(value) === value)) {
      throw new Error("The Discord preferences in the settings file are invalid.");
    }
    if (!isGuildMap(history, (key, ids) => ticketDestinationKeys.has(key) &&
      ids && typeof ids === "object" && !Array.isArray(ids) &&
      Object.entries(ids).every(([id, category]) => isDiscordId(id) && isDiscordId(category)))) {
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
    guildPreferences = savedPreferences;
    nikitaSubscriptions = subscriptions;
    supportActivations = activeSupport;
  } else {
    settings = {};
    previousTickets = {};
    honeypotActivations = {};
    guildPreferences = {};
    nikitaSubscriptions = {};
    supportActivations = undefined;
  }
  file = path;
}

export const canConfigureDestinations = () => Boolean(file);
export const isSupportActive = guildId => supportActivations?.[guildId] === true;
export const isSupportActivationPending = guildId => supportActivations?.[guildId] === null;
export const isSupportActivationBlocked = guildId =>
  isSupportActivationPending(guildId) || supportActivations?.[guildId] === "review";
export function getNikitaSubscription(guildId) {
  const channelId = settings[guildId]?.nikita;
  const subscriptionId = nikitaSubscriptions[guildId];
  if (channelId) return { channelId, subscriptionId };
  return subscriptionId === null ? null : undefined;
}
export const getNikitaGuildIds = () => Object.keys(settings).filter(id => settings[id].nikita);
export const getDestinationOverride = (guildId, key) => settings[guildId]?.[key];
export function getHostDestinationId(guildId, key) {
  if (key === "nikita") {
    const legacyGuild = process.env.NIKITA_X_GUILD_ID?.trim();
    if (legacyGuild && legacyGuild !== guildId) return undefined;
  }
  return process.env[destinations[key].env]?.trim();
}
export function getDestinationId(guildId, key) {
  if (key === "nikita" && nikitaSubscriptions[guildId] === null) return undefined;
  return getDestinationOverride(guildId, key) ?? getHostDestinationId(guildId, key);
}
export const getPreference = (guildId, key) => guildPreferences[guildId]?.[key] ?? process.env[preferences[key].env]?.trim();
export function getAffectedBotFeatures(channelId, guildId) {
  return Object.entries(destinations).filter(([key]) => getDestinationId(guildId, key) === channelId)
    .map(([key, { label, env }]) => {
      const setting = getDestinationOverride(guildId, key) ? `/config edit setting:${key} action:set` : env;
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

function isGuildMap(value, validEntry) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.entries(value).every(([guild, entries]) => isDiscordId(guild) && entries &&
      typeof entries === "object" && !Array.isArray(entries) &&
      Object.entries(entries).every(([key, entry]) => validEntry(key, entry)));
}

function withGuildSetting(map, guildId, entries) {
  const next = { ...map };
  if (Object.keys(entries).length) next[guildId] = entries;
  else delete next[guildId];
  return next;
}

function queueWrite(buildState) {
  let replaced = false;
  const update = writes.then(async () => {
    const next = buildState({ version: 1, guilds: settings, previousTickets, honeypotActivations,
      preferences: guildPreferences, nikitaSubscriptions, supportActivations });
    await writeJsonAtomically(file, next, () => {
      replaced = true;
      settings = next.guilds;
      previousTickets = next.previousTickets;
      honeypotActivations = next.honeypotActivations;
      guildPreferences = next.preferences;
      nikitaSubscriptions = next.nikitaSubscriptions;
      supportActivations = next.supportActivations;
    });
    return true;
  }).catch(error => {
    if (!replaced) throw error;
    console.warn("Could not sync the Discord settings directory", { code: error?.code ?? "unknown" });
    return false;
  });
  writes = update.catch(() => {});
  return update;
}

export async function initializeSupportActivations(assessGuilds) {
  const firstStartup = supportActivations === undefined;
  const assessed = await assessGuilds(guildId => firstStartup || isSupportActivationPending(guildId));
  if (!firstStartup && !assessed.length) return;
  return queueWrite(state => {
    const activations = { ...state.supportActivations };
    for (const [guildId, active] of assessed) {
      if (state.supportActivations !== undefined && activations[guildId] !== null) continue;
      if (active === false) delete activations[guildId];
      else activations[guildId] = active;
    }
    return { ...state, supportActivations: activations };
  });
}

export function activateSupport(guildId, validate) {
  if (!file || supportActivations === undefined || !isDiscordId(guildId)) {
    throw new Error("Help-desk activation storage is unavailable.");
  }
  return withDestinationLock(guildId, async () => {
    await validate();
    if (isSupportActive(guildId)) return null;
    return queueWrite(state => ({
      ...state, supportActivations: { ...state.supportActivations, [guildId]: true }
    }));
  }, true);
}

export function updatePreference(guildId, key, value, validate) {
  if (!file || !isDiscordId(guildId) || !Object.hasOwn(preferences, key)
      || (value !== null && (typeof value !== "string" || preferences[key].parse(value) !== value))) {
    throw new Error("Invalid Discord preference update.");
  }
  return withDestinationLock(guildId, async () => {
    await validate();
    return queueWrite(state => {
      const next = { ...state.preferences[guildId] };
      if (value === null) delete next[key];
      else next[key] = value;
      return { ...state, preferences: withGuildSetting(state.preferences, guildId, next) };
    });
  }, true);
}

export function updateDestination(guildId, key, channelId, validate) {
  if (!file || !isDiscordId(guildId) || !Object.hasOwn(destinations, key)
      || channelId !== null && !isDiscordId(channelId)) {
    throw new Error("Invalid Discord destination update.");
  }
  return withDestinationLock(guildId, async () => {
    const next = { ...settings[guildId] };
    const previousNikita = getNikitaSubscription(guildId);
    if (channelId === null) delete next[key];
    else next[key] = channelId;
    let rollback;
    try {
      const paused = key === "nikita" ? channelId === null : previousNikita === null;
      const proposed = paused ? { ...next, nikita: null } : next;
      const previous = await validate(proposed, undo => { rollback = undo; });
      return await queueWrite(state => {
        const history = { ...state.previousTickets };
        const activations = { ...state.honeypotActivations };
        const subscriptions = { ...state.nikitaSubscriptions };
        if (key === "nikita") {
          // A missing delivery state seeds on its first poll. Only resuming after a pause needs a new ID.
          if (paused) subscriptions[guildId] = null;
          else if (previousNikita === null) subscriptions[guildId] = randomUUID();
        }
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
        return { ...state, guilds: withGuildSetting(state.guilds, guildId, next),
          previousTickets: history, honeypotActivations: activations, nikitaSubscriptions: subscriptions };
      });
    } catch (error) {
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
