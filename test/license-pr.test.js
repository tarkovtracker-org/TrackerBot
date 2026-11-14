import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { licensePullRequest, updateLicenseYear } from "../scripts/license-pr.js";

const sha = "a".repeat(40);
const env = {
  LICENSE_PR_AUTOMATION_ENABLED: "true", GITHUB_REPOSITORY: "tarkovtracker-org/TrackerBot",
  GITHUB_EVENT_NAME: "schedule", DEFAULT_BRANCH: "main", GITHUB_REF: "refs/heads/main", GITHUB_SHA: sha
};
const source = "MIT License\n\nCopyright (c) 2026 TarkovTracker.org\n\nLicense body.\n";
function fixture({ existing = false, prs = [], changes = "LICENSE", dirty = false, transportError = false, pushError = false,
  licenseMismatch = false, createResult = "https://github.com/tarkovtracker-org/TrackerBot/pull/999", createError = false } = {}) {
  const calls = [];
  const writes = [];
  const options = {
    env: { ...env }, year: 2027, read: async () => source, write: async text => { writes.push(text); },
    run: (command, args) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "rev-parse") return sha;
      if (command === "git" && args[0] === "status") return dirty ? " M other.js" : "";
      if (command === "git" && args.includes("ls-remote")) {
        if (transportError) throw Object.assign(new Error("secret transport body"), { status: 128 });
        if (!existing) throw Object.assign(new Error("no matching ref"), { status: 2 });
        return `${sha}\trefs/heads/automation/license-year-2027`;
      }
      if (command === "git" && args.includes("--name-only")) return changes;
      if (command === "git" && args.includes("push") && pushError) throw new Error("unconfirmed push");
      if (command === "git" && args.includes("--quiet") && licenseMismatch) throw Object.assign(new Error("LICENSE differs"), { status: 1 });
      if (command === "gh" && args[1] === "list") return JSON.stringify(prs.map(pr => ({ isCrossRepository: false, ...pr })));
      if (command === "gh" && args[1] === "create") {
        if (createError) throw new Error("unconfirmed PR creation");
        return createResult;
      }
      return "";
    }
  };
  return { calls, writes, options };
}

test("license updates preserve the original start year, range and unrelated bytes", () => {
  assert.equal(updateLicenseYear(source, 2026), source);
  const updated = source.replace("2026 Tarkov", "2026-2027 Tarkov");
  assert.equal(updateLicenseYear(source, 2027), updated);
  assert.equal(updateLicenseYear(updated, 2027), updated);
  assert.equal(updateLicenseYear(updated, 2028), source.replace("2026 Tarkov", "2026-2028 Tarkov"));
  assert.equal(updateLicenseYear(source.replaceAll("\n", "\r\n"), 2027), updated.replaceAll("\n", "\r\n"));
});

test("unrecognized/duplicate notices, backward ranges and invalid years fail closed", () => {
  for (const text of ["", source + source, source.replace("TarkovTracker.org", "Other"), source.replace("2026", "2028"), source.replace("2026", "2028-2026")]) {
    assert.throws(() => updateLicenseYear(text, 2027));
  }
  for (const year of [1999, 10000, 2027.5, NaN, "2027"]) assert.throws(() => updateLicenseYear(source, year));
});

for (const overrides of [
  { LICENSE_PR_AUTOMATION_ENABLED: "false" }, { GITHUB_REPOSITORY: "fork/TrackerBot" },
  { GITHUB_EVENT_NAME: "pull_request_target" }, { GITHUB_EVENT_NAME: "pull_request" },
  { GITHUB_REF: "refs/heads/untrusted" }, { GITHUB_SHA: "bad" }, { DEFAULT_BRANCH: "" }
]) {
  test(`untrusted or disabled automation makes no CLI calls or writes: ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(); Object.assign(f.options.env, overrides);
    await assert.rejects(licensePullRequest(f.options));
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.writes, []);
  });
}

test("an unchanged year does not create a branch or request write operations", async () => {
  const f = fixture(); f.options.year = 2026;
  assert.deepEqual(await licensePullRequest(f.options), { status: "unchanged" });
  assert.equal(f.writes.length, 0);
  assert.equal(f.calls.some(call => call.command === "gh"), false);
});

test("the annual topic can never equal a renamed default branch", async () => {
  const f = fixture();
  f.options.env.DEFAULT_BRANCH = "automation/license-year-2027";
  f.options.env.GITHUB_REF = "refs/heads/automation/license-year-2027";
  await assert.rejects(licensePullRequest(f.options));
  assert.equal(f.calls.some(call => call.command === "gh" || call.args.includes("push")), false);
  assert.equal(f.writes.length, 0);
});

test("the only push target is a new annual topic branch and creation requires a normal PR", async () => {
  const f = fixture();
  const result = await licensePullRequest(f.options);
  assert.equal(result.status, "created");
  assert.equal(f.writes[0], updateLicenseYear(source, 2027));
  const push = f.calls.find(call => call.command === "git" && call.args.includes("push"));
  assert.deepEqual(push.args, ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", "origin", "HEAD:refs/heads/automation/license-year-2027"]);
  assert.equal(f.calls.some(call => call.args.some(arg => /--force|--auto|--admin|approve/.test(arg))), false);
  const pr = f.calls.find(call => call.command === "gh" && call.args[1] === "create");
  assert.equal(pr.args[pr.args.indexOf("--base") + 1], "main");
});

test("an existing license-only open PR is reused without push or replacement", async () => {
  const f = fixture({ existing: true, prs: [{ number: 999, state: "OPEN", url: "https://github.com/tarkovtracker-org/TrackerBot/pull/999" }] });
  assert.equal((await licensePullRequest(f.options)).status, "existing");
  assert.equal(f.calls.some(call => call.args.includes("push")), false);
  assert.equal(f.calls.some(call => call.command === "gh" && call.args[1] === "create"), false);
  assert.ok(f.calls.some(call => call.args.join(" ") === "diff --quiet FETCH_HEAD -- LICENSE"));
});

for (const setup of [
  { existing: true }, { existing: true, prs: [{ state: "CLOSED" }] },
  { existing: true, prs: [{ state: "OPEN" }], changes: "LICENSE\nscripts/evil.js" },
  { existing: false, prs: [{ state: "CLOSED" }] }, { changes: "LICENSE\nother.js" }, { dirty: true }, { transportError: true }
]) {
  test(`ambiguous remote state or unexpected files never cause a push: ${JSON.stringify(setup)}`, async () => {
    const f = fixture(setup);
    await assert.rejects(licensePullRequest(f.options));
    assert.equal(f.calls.some(call => call.args.includes("push")), false);
  });
}

for (const metadata of [true, undefined]) {
  test(`an existing origin branch never reuses fork/unknown PR metadata: ${metadata}`, async () => {
    const f = fixture({ existing: true, prs: [{ state: "OPEN", isCrossRepository: metadata }] });
    await assert.rejects(licensePullRequest(f.options));
    assert.equal(f.writes.length, 0);
    assert.equal(f.calls.some(call => call.args.includes("push") || (call.command === "gh" && call.args[1] === "create")), false);
  });
}

test("a mismatched existing LICENSE rejects reuse without push or PR creation", async () => {
  const f = fixture({ existing: true, prs: [{ state: "OPEN" }], licenseMismatch: true });
  await assert.rejects(licensePullRequest(f.options), /LICENSE differs/);
  assert.equal(f.calls.some(call => call.args.includes("push") || (call.command === "gh" && call.args[1] === "create")), false);
});

for (const setup of [{ createResult: "" }, { createResult: "not-a-url" },
  { createResult: "https://github.com/fork/TrackerBot/pull/999" }, { createError: true }]) {
  test(`unconfirmed PR creation is never retried or reported successful: ${JSON.stringify(setup)}`, async () => {
    const f = fixture(setup);
    await assert.rejects(licensePullRequest(f.options));
    assert.equal(f.calls.filter(call => call.args.includes("push")).length, 1);
    assert.equal(f.calls.filter(call => call.command === "gh" && call.args[1] === "create").length, 1);
  });
}

test("all network Git commands use a nonpersistent scoped credential helper", async () => {
  for (const setup of [{}, { existing: true, prs: [{ state: "OPEN" }] }]) {
    const f = fixture(setup);
    await licensePullRequest(f.options);
    const network = f.calls.filter(call => call.command === "git" && call.args.some(arg => ["ls-remote", "fetch", "push"].includes(arg)));
    assert.equal(network.length, 2);
    for (const call of network) assert.deepEqual(call.args.slice(0, 4), ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]);
  }
});

test("real Git publishes only a license topic branch and safely reuses it (no GitHub writes)", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "trackerbot-license-git-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const work = path.join(directory, "work");
  const remote = path.join(directory, "remote.git");
  await mkdir(work);
  const git = args => execFileSync("git", ["-c", `core.hooksPath=${path.join(directory, "no-hooks")}`, ...args], {
    cwd: work, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"]
  }).trim();
  git(["init", "--bare", "--initial-branch=main", remote]);
  git(["init", "--initial-branch=main"]);
  await writeFile(path.join(work, "LICENSE"), source);
  await writeFile(path.join(work, "untouched.txt"), "keep me\n");
  git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "origin", "HEAD:refs/heads/main"]);
  const initial = git(["rev-parse", "HEAD"]);
  let prs = [];
  let pushes = 0;
  const options = {
    env: { ...env, GITHUB_SHA: initial }, year: 2027,
    read: () => readFile(path.join(work, "LICENSE"), "utf8"),
    write: text => writeFile(path.join(work, "LICENSE"), text),
    run: (command, args) => {
      if (command === "gh") return args[1] === "list" ? JSON.stringify(prs) : "https://github.com/tarkovtracker-org/TrackerBot/pull/999";
      if (args.includes("push")) pushes++;
      return git(args);
    }
  };
  assert.equal((await licensePullRequest(options)).status, "created");
  assert.equal(pushes, 1);
  assert.equal(git(["--git-dir", remote, "rev-parse", "main"]), initial);
  assert.equal(git(["diff", "--name-only", "main...automation/license-year-2027"]), "LICENSE");
  assert.match(git(["--git-dir", remote, "show", "automation/license-year-2027:LICENSE"]), /2026-2027 TarkovTracker/);
  const topic = git(["--git-dir", remote, "rev-parse", "automation/license-year-2027"]);
  git(["switch", "main"]);
  prs = [{ number: 999, state: "OPEN", isCrossRepository: false, url: "https://github.com/tarkovtracker-org/TrackerBot/pull/999" }];
  assert.equal((await licensePullRequest(options)).status, "existing");
  assert.equal(pushes, 1, "reusing a topic never pushes again");
  assert.equal(git(["--git-dir", remote, "rev-parse", "automation/license-year-2027"]), topic);
});

test("unconfirmed push is never retried and never followed by a PR creation claim", async () => {
  const f = fixture({ pushError: true });
  await assert.rejects(licensePullRequest(f.options));
  assert.equal(f.calls.filter(call => call.args.includes("push")).length, 1);
  assert.equal(f.calls.some(call => call.command === "gh" && call.args[1] === "create"), false);
});
