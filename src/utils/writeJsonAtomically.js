import { randomUUID } from "node:crypto";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function syncParentDirectory(file) {
  if (process.platform === "win32") return;
  try {
    const directory = await open(dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error;
  }
}

export async function writeJsonAtomically(file, value, onReplace) {
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
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
    onReplace?.();
    await syncParentDirectory(file);
  } finally {
    await unlink(temporaryFile).catch(() => {});
  }
}
