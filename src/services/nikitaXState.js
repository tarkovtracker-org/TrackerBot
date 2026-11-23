import { readFile } from "node:fs/promises";
import { isDiscordId, isSubscriptionId } from "../config/destinations.js";
import { isPostId } from "./nikitaXApi.js";
import { writeJsonAtomically } from "../utils/writeJsonAtomically.js";

const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isMap = value => value && typeof value === "object" && !Array.isArray(value);

const isPending = item => isPostId(item?.id) && isPostId(item.sourceId) && isPostId(item.versionId)
  && (item.channelId === undefined || isDiscordId(item.channelId)) && isTime(item.startedAt)
  && (item.receiptOnly === undefined || item.receiptOnly === true);

function stateError() {
  return Object.assign(new Error("Invalid Nikita X feed state or destination changed"), { code: "X_FEED_STATE" });
}

function isDeliveryState(state) {
  return state?.version === 1 && isDiscordId(state.channelId)
    && (state.guildId === undefined || isDiscordId(state.guildId))
    && (state.subscriptionId === undefined || isSubscriptionId(state.subscriptionId))
    && isPostId(state.userId) && (state.sinceId === null || isPostId(state.sinceId))
    && isMap(state.published) && Object.entries(state.published).every(([id, item]) =>
      isPostId(id) && isDiscordId(item?.messageId)
      && isPostId(item.versionId) && typeof item.mediaComplete === "boolean"
      && (item.channelId === undefined || isDiscordId(item.channelId))
      && isTime(item.retryTranslationAt) && isTime(item.nextReviewAt))
    && (state.pending === null || isPending(state.pending))
    && (state.recoveries === undefined || isMap(state.recoveries)
      && Object.entries(state.recoveries).every(([id, item]) =>
        isPending(item) && id === item.sourceId && isDiscordId(item.channelId)));
}

export async function openNikitaXState(file) {
  const contents = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let state;
  try {
    state = contents === null ? { version: 2, guilds: {} } : JSON.parse(contents);
  } catch {
    throw stateError();
  }
  if (isDeliveryState(state)) state = { version: 2, guilds: {}, legacy: state };
  if (state?.version !== 2 || !isMap(state.guilds)
      || !Object.entries(state.guilds).every(([id, entry]) =>
        isDiscordId(id) && isDeliveryState(entry) && entry.guildId === id)
      || state.legacy !== undefined && !isDeliveryState(state.legacy)) {
    throw stateError();
  }

  let writes = Promise.resolve();
  function update(change) {
    const write = writes.then(async () => {
      const next = change(state);
      await writeJsonAtomically(file, next, () => { state = next; });
    });
    writes = write.catch(() => {});
    return write;
  }

  return {
    get legacy() { return structuredClone(state.legacy); },
    guildIds: () => Object.keys(state.guilds),
    load: id => structuredClone(state.guilds[id]),
    save(id, entry) {
      const snapshot = { ...structuredClone(entry), guildId: id };
      return update(current => ({ ...current, guilds: { ...current.guilds, [id]: snapshot } }));
    },
    saveLegacy(entry) {
      const legacy = structuredClone(entry);
      return update(current => ({ ...current, legacy }));
    },
    migrate(id) {
      return update(({ legacy, guilds, ...current }) => {
        const active = guilds[id];
        if (!active) return { ...current, guilds: { ...guilds, [id]: { ...legacy, guildId: id } } };
        // A guild may already have a second receipt for the same post by the time the old channel reappears.
        // Keep the legacy state for maintenance only so both messages remain tracked.
        const retired = { ...structuredClone(legacy), guildId: id };
        if (retired.pending) retired.pending.receiptOnly = true;
        for (const item of Object.values(retired.recoveries ?? {})) item.receiptOnly = true;
        return { ...current, guilds, legacy: retired };
      });
    }
  };
}
