import { readFile } from "node:fs/promises";
import { isPostId } from "./nikitaXApi.js";
import { writeJsonAtomically } from "../utils/writeJsonAtomically.js";

const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isMessageId = value => typeof value === "string" && /^\d{17,20}$/.test(value);

const isPending = item => isPostId(item?.id) && isPostId(item.sourceId) && isPostId(item.versionId)
  && (item.channelId === undefined || isMessageId(item.channelId)) && isTime(item.startedAt);

function stateError() {
  return Object.assign(new Error("Invalid Nikita X feed state or destination changed"), { code: "X_FEED_STATE" });
}

export async function loadNikitaXState(file, channelId, guildId) {
  const contents = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (contents === null) return null;

  let state;
  try {
    state = JSON.parse(contents);
  } catch {
    throw stateError();
  }
  if (state?.version !== 1 || !isMessageId(state.channelId)
      || (state.guildId !== undefined && state.guildId !== guildId)
      || (!guildId && state.channelId !== channelId) || !isPostId(state.userId)
      || (state.sinceId !== null && !isPostId(state.sinceId))
      || !state.published || Array.isArray(state.published) || typeof state.published !== "object"
      || !Object.entries(state.published).every(([id, item]) => isPostId(id) && isMessageId(item?.messageId)
        && isPostId(item.versionId) && typeof item.mediaComplete === "boolean"
        && (item.channelId === undefined || isMessageId(item.channelId))
        && isTime(item.retryTranslationAt) && isTime(item.nextReviewAt))
      || (state.pending !== null && !isPending(state.pending))
      || (state.recoveries !== undefined && (!state.recoveries || typeof state.recoveries !== "object"
        || Array.isArray(state.recoveries) || !Object.entries(state.recoveries).every(([id, item]) =>
          isPending(item) && id === item.sourceId && isMessageId(item.channelId))))) {
    throw stateError();
  }
  return state;
}

export const saveNikitaXState = writeJsonAtomically;
