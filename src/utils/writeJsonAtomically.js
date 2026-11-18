import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function writeJsonAtomically(file, value) {
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
  } finally {
    await unlink(temporaryFile).catch(() => {});
  }
}
