import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const excludedDirectories = new Set(["node_modules", ".git"]);

async function javaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(...await javaScriptFiles(filename));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(filename);
    }
  }
  return files;
}

const files = (await javaScriptFiles(root)).sort();
if (!files.length) throw new Error("No JavaScript files found for syntax checking.");
for (const filename of files) {
  const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Syntax check failed: ${path.relative(root, filename)}`);
    console.error(result.stderr);
    process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`Syntax checked ${files.length} JavaScript files.`);
