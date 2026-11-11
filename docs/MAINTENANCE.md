# Dependency and runtime maintenance

- Pin direct production dependencies and security overrides to exact versions;
  commit the lockfile. Tests verify pins against actual lock resolution.
- Pin external GitHub Actions to full upstream commit SHAs. Dependabot maintains
  action pins and npm dependencies weekly, one dependency chain per PR.
- Ordinary version updates have a seven-day cooldown. Dependabot security updates
  are deliberately exempt from that delay. Do not disable security updates or
  ignore advisories merely to make CI pass.
- For an early security release, verify publisher/provenance, registry integrity
  and the corresponding upstream tag; inspect runtime changes and install scripts.
  Keep evidence in the PR and prove the regression fails with the old dependency.
- `npm run audit:prod` blocks advisories at **low and above**, on Linux and Windows.
  The same CI runs weekly even without commits. Keep Socket/Snyk checks enabled;
  investigate their findings rather than weakening gates or granting exceptions.
- Exact transitive overrides may need manual updates when Dependabot cannot change
  them. A clean audit must cover the resolved lockfile, not only package.json.
- CI uses an exact supported Node 24 LTS patch. Review Node security announcements
  and refresh that pin through tested PRs; Dependabot's action updates do not update
  the `node-version` argument automatically. Never treat an npm audit as a runtime
  or operating-system vulnerability scan.

## Production runtime

Use a patched, supported Node 24 LTS release for the bot and web server. Node 18
and Node 20 are end-of-life and must not be used in production. The package's
`engines` floor (18.17) records API compatibility only, **not security support**;
this maintenance PR does not force an unknown hosting runtime to change at install.
CI's pin does not update the deployed bot or web server. The hosting operator must
verify both actual process versions, update them through their trusted deployment
procedure, and check bot login plus the separate web health endpoint afterward.

No hosting manifest exists in this repository, so deployment/process versions and
proxy isolation cannot be certified from source. The public web `/health` endpoint
does not establish Gateway readiness. Multi-process rate limits/locks require an
operator-approved shared store; do not silently run extra workers or evict active
security budgets to increase capacity.

## Review and rollout

Run `npm ci`, `npm test`, `npm run build` and `npm run audit:prod`. Require both CI
platforms to pass and review every changed dependency/artifact. Do not auto-merge
major upgrades, command/permission changes or hosting migrations. No automatic
production deploy or command-registration smoke test is run by these workflows.
Keep the existing least-privilege checkout and token settings; do not use trusted
write credentials on untrusted PR code.

References:
- [Dependabot configuration and cooldown](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#cooldown)
- [Node end-of-life status](https://nodejs.org/en/about/eol)
- [Node release schedule](https://nodejs.org/en/about/previous-releases)
