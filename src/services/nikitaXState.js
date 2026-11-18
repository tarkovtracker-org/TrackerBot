import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isPostId } from "./nikitaXApi.js";

const isTime = value => Number.isSafeInteger(value) && value >= 0;
const isMessageId = value => typeof value === "string" && /^\d{17,20}$/.test(value);

function stateError() {
  return Object.assign(new Error("Invalid Nikita X feed state or destination changed"), { code: "X_FEED_STATE" });
}

export async function loadNikitaXState(file, channelId) {
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
  if (state?.version !== 1 || state.channelId !== channelId || !isPostId(state.userId)
      || (state.sinceId !== null && !isPostId(state.sinceId))
      || !state.published || Array.isArray(state.published) || typeof state.published !== "object"
      || !Object.entries(state.published).every(([id, item]) => isPostId(id) && isMessageId(item?.messageId)
        && isPostId(item.versionId) && typeof item.mediaComplete === "boolean"
        && isTime(item.retryTranslationAt) && isTime(item.nextReviewAt))
      || (state.pending !== null && (!isPostId(state.pending?.id) || !isPostId(state.pending.sourceId)
        || !isPostId(state.pending.versionId) || !isTime(state.pending.startedAt)))) {
    throw stateError();
  }
  return state;
}

export async function saveNikitaXState(file, state) {
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(state), { flag: "wx", mode: 0o600, flush: true });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporaryFile, file);
        break;
      } catch (error) {
        // A concurrent reader can briefly prevent replacement on Windows.
        if (attempt === 4 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } finally {
    await unlink(temporaryFile).catch(() => {});
  }
}
