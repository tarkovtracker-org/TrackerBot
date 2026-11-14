import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repository = "tarkovtracker-org/TrackerBot";
export class LicenseAutomationError extends Error {}

export function updateLicenseYear(source, year) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new LicenseAutomationError("Invalid UTC license year.");
  const pattern = /^Copyright \(c\) (\d{4})(?:-(\d{4}))? TarkovTracker\.org\r?$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new LicenseAutomationError("Expected exactly one project copyright line.");
  const [, start, end = start] = matches[0];
  if (Number(start) > Number(end) || year < Number(end)) throw new LicenseAutomationError("Refusing to roll the copyright year backward.");
  const years = Number(start) === year ? start : `${start}-${year}`;
  return source.replace(pattern, match => `Copyright (c) ${years} TarkovTracker.org${match.endsWith("\r") ? "\r" : ""}`);
}

export async function licensePullRequest({
  env = process.env, year = new Date().getUTCFullYear(),
  read = () => readFile("LICENSE", "utf8"), write = source => writeFile("LICENSE", source),
  run = (command, args) => execFileSync(command, args, { encoding: "utf8", env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] }).trim()
} = {}) {
  if (env.LICENSE_PR_AUTOMATION_ENABLED !== "true" || env.GITHUB_REPOSITORY !== repository ||
      !["schedule", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) ||
      !env.DEFAULT_BRANCH || env.GITHUB_REF !== `refs/heads/${env.DEFAULT_BRANCH}` ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "")) {
    throw new LicenseAutomationError("License writes require an enabled, trusted default-branch schedule/manual run.");
  }
  run("git", ["check-ref-format", `refs/heads/${env.DEFAULT_BRANCH}`]);
  if (run("git", ["rev-parse", "HEAD"]) !== env.GITHUB_SHA || run("git", ["status", "--porcelain"])) {
    throw new LicenseAutomationError("Expected a clean checkout of the trusted workflow revision.");
  }
  const source = await read();
  const updated = updateLicenseYear(source, year);
  if (source === updated) return { status: "unchanged" };
  const branch = `automation/license-year-${year}`;
  const prs = JSON.parse(run("gh", ["pr", "list", "--repo", repository, "--head", branch, "--base", env.DEFAULT_BRANCH,
    "--state", "all", "--limit", "100", "--json", "number,state,url"]));
  if (!Array.isArray(prs)) throw new LicenseAutomationError("Unable to establish existing license PR state.");
  let exists = false;
  try {
    run("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    exists = true;
  } catch (error) {
    if (error.status !== 2) throw error; // A transport error is not proof that the branch is absent.
  }
  if (exists) {
    if (prs.length !== 1 || prs[0].state !== "OPEN") {
      throw new LicenseAutomationError("An existing license branch needs owner inspection; it will not be overwritten.");
    }
    run("git", ["fetch", "--no-tags", "origin", `refs/heads/${branch}`]);
    if (run("git", ["diff", "--name-only", `${env.GITHUB_SHA}...FETCH_HEAD`, "--"]) !== "LICENSE") {
      throw new LicenseAutomationError("Existing license branch contains unexpected changes.");
    }
    await write(updated);
    run("git", ["diff", "--quiet", "FETCH_HEAD", "--", "LICENSE"]);
    return { status: "existing", branch, url: prs[0].url };
  }
  if (prs.length) throw new LicenseAutomationError("A previous license PR exists; inspect it before creating another.");
  await write(updated);
  if (run("git", ["diff", "--name-only"]) !== "LICENSE") throw new LicenseAutomationError("Only LICENSE may change.");
  run("git", ["switch", "-c", branch]);
  run("git", ["add", "--", "LICENSE"]);
  run("git", ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "commit", "-m", `chore: update license year to ${year}`, "--", "LICENSE"]);
  // Authentication is scoped to this one command, never persisted by checkout.
  // No force push, default-branch push, auto-merge, approval, or dispatch bypass.
  run("git", ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "origin", `HEAD:refs/heads/${branch}`]);
  const url = run("gh", ["pr", "create", "--repo", repository, "--head", branch, "--base", env.DEFAULT_BRANCH,
    "--title", `chore: update license year to ${year}`,
    "--body", "Updates only the project copyright year. Human review and the normal CI/security checks are required. Approve any automation-created workflow runs after inspecting this license-only diff; do not bypass branch protections."]);
  if (!new RegExp(`^https://github\\.com/${repository}/pull/\\d+$`).test(url)) {
    throw new LicenseAutomationError("PR creation outcome is unconfirmed; inspect GitHub before repeating.");
  }
  return { status: "created", branch, url };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await licensePullRequest();
    console.log(`License automation: ${result.status}${result.url ? ` (${result.url})` : ""}`);
  } catch (error) {
    // CLI errors may contain private request data. Never dump their objects/bodies.
    console.error(error instanceof LicenseAutomationError ? error.message : "License PR operation failed or is unconfirmed. Inspect the branch/PR and repository automation permissions before retrying.");
    process.exitCode = 1;
  }
}
