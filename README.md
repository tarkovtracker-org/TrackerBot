<div align="center">

<table border="0"><tr>
<td valign="middle"><img src="https://tarkovtracker.org/img/logos/tarkovtrackerlogo-light.webp" alt="TarkovTracker logo" width="120" /></td>
<td valign="middle"><h1>TrackerBot</h1></td>
</tr></table>

The Discord companion for the [TarkovTracker.org](https://tarkovtracker.org) community: slash commands, reaction roles, welcome automation, ticket creation, and a public bug-intake portal that forwards reports straight to GitHub.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.17%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/tarkovtracker-org/trackerbot/pulls)
</div>

## Overview

TrackerBot runs two services side by side:

| Service | Entry point | Responsibility |
| --- | --- | --- |
| **Discord bot** | `bot.js` | Slash commands, reaction roles, welcome automation, and ticket creation. |
| **Bug intake web server** | `webserver.js` | Serves the public issue forms and forwards submissions to GitHub. |

### Reporting limits and errors

`POST /data` and `POST /issue` share one reporting policy for each client IP
(with the existing IPv6 `/56` grouping). The allowance is **20 delivered reports
in a rolling 12 hours**, with **at least 10 minutes between deliveries**. A
delivery exactly 12 hours old leaves the allowance; a new report is admitted
exactly at the 10-minute boundary. IPv4-mapped addresses use the same key as IPv4,
including dotted and hexadecimal IPv6 representations. Switching forms does not
reset either limit. Users sharing an IP or IPv6 prefix share these limits.

The server reserves a slot before awaiting GitHub, so concurrent requests cannot
both pass. Confirmed GitHub issue creation (`201`) consumes the allowance and
starts the cooldown at delivery completion. Validation, origin/parser errors,
honeypot submissions and proven delivery rejections do not count as delivered
reports. A separate shared **five-attempt rolling minute** budget runs before
body parsing and includes rejected/invalid requests. Denials return the longest
active attempt/window/cooldown wait rather than an earlier partial reset.

Timeouts, connection resets, unexpected provider responses and GitHub `5xx`
responses are **unconfirmed delivery**, not proof that no issue was created.
They conservatively reserve allowance and cooldown. A hash of the same report is
held against automatic repetition for 12 hours, bounded by the same retention
window; this is not a durable idempotency guarantee. Check the published issue
list or contact support before repeating it. Different reports may be sent after
the ordinary cooldown if allowance remains. No automatic GitHub retry occurs.

Both forms preserve their entered fields on failure, disable double submission,
and display safe typed server errors. Unknown network/proxy/success responses
keep the draft and stop automatic repetition in that page. The displayed wait is
advisory; every new request is checked by the server. Length limits are visible
and enforced without silently truncating evidence: title 200, Discord handle 64,
category 64, reference 500, details 8,000 characters; request bodies are capped at
32 KiB. Successful submission resets the form. Drafts remain in the open page,
not persistent browser storage; copy them before reloading.

Errors use `{ error: { code, message }, retryAfterSeconds?, resetAt? }`.
Admission errors use HTTP `429` (`report_cooldown`, `report_window_limit`,
`attempt_limit`, `report_in_progress`), capacity uses `503`, and uncertain repeat
delivery uses `409`. Wait errors include numeric `Retry-After` seconds and an ISO
`resetAt`. Validation/parser/origin errors use `400`/`413`/`415`/`403`. Proven provider
rejections/connectivity failures use `502`/`503`; unconfirmed delivery uses `504`.
Provider throttling honors full `Retry-After` and exhausted-primary
`x-ratelimit-reset` waits, taking the longer when both apply. Secondary throttles
without timing headers use GitHub's minimum one-minute guidance. Neither server
nor browser truncates a valid provider wait. Known client parser failures,
including parameter overflow, excessive nesting and unsupported formats, return
retryable typed `4xx` errors; they are not uncertain GitHub delivery.
See [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit)
and [body-parser errors](https://expressjs.com/en/resources/middleware/body-parser/#errors).
Provider bodies, tokens, IPs
and report descriptions are never included in error output or delivery logs.

**Rollout limitation: these controls are process-local memory, not durable or
shared across workers/hosts.** A restart clears allowances, cooldowns and
uncertain-report holds. There is no existing persistent limiter store or hosting
manifest in this repository. State is capped at 10,000 clients and stale entries
are removed; at capacity, new clients receive a safe busy response instead of
evicting active limits. Strict enforcement across restarts or multiple processes
needs an operator-approved persistent/shared store after hosting is established.
This change adds no infrastructure or production settings and is not evidence
that the deployed topology is ready for strict enforcement.

`trust proxy = 1` remains unchanged. Before rollout, operators must verify that
the origin is reachable only through the intended trusted proxy and that it
overwrites client forwarding headers, and confirm the actual process topology.
Otherwise clients may spoof the limiter key or unrelated users may share one.
Do not fix that by trusting arbitrary forwarded headers. The deployed form origin
must also match the existing `ALLOWED_ORIGINS` setting. Credential, proxy-trust and
production configuration changes require separate approval.

Requires **Node.js 18.17+**.

## Features

- Ticket creation flow with private support channels
- Reaction-role assignment and a `put-member-role` bulk role command
- Automated welcome messages and auto-roles for new members
- Quick announcement helpers (`/message`, `/faq1`, `/utd`)
- One-command channel archiving (`/archive`)
- Honeypot anti-spam channel that auto-bans anyone who posts in it
- Public web forms that open GitHub issues for bug and data reports

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

- **Discord bot basics:** `DISCORD_TOKEN`, `ADMIN_ROLE_ID` (comma-separated Discord role IDs granting admin-only commands such as `/wipe`)
- **GitHub issue routing:** `GITHUB_TOKEN`, `REPO_DEV`, `REPO_DATA_REPORT`
- **Channel IDs for automated posts:** `WELCOME_CHANNEL_ID`; optional `HONEYPOT_CHANNEL_ID` (a hidden channel — anyone who posts in it is banned on sight, with a kick fallback; messages older than 16h are swept hourly)
- **Role IDs:** `PANEL_ADMIN_ROLE_ID`, `AUTO_ROLE_ID_1`–`AUTO_ROLE_ID_4` (auto-roles for new members); optional `ALLOWED_COMMAND_ROLE_IDS` (comma-separated role IDs allowed to use member commands, falls back to a built-in default)
- **Web server:** `PORT`, `ALLOWED_ORIGINS` (comma-separated origins, exact match)

> `GITHUB_TOKEN` needs `repo` scope (or equivalent granular access) to create issues in the configured repositories. For production, prefer a fine-grained PAT scoped to `issues:write` on the two target repos only.

### 3. Run the services locally

Start everything at once:

```bash
npm start
```

This launches the bot and issue intake web server in parallel. Logs for each service are prefixed with `bot` or `web`.

Or run a single service:

```bash
npm run start:bot   # Discord bot
npm run start:web   # Public issue forms (http://localhost:3000)
```

- Bot login success is logged as soon as Discord authenticates the token.
- `webserver.js` serves `http://localhost:3000` (issue portal), plus `http://localhost:3000/issue` and `http://localhost:3000/data` (forms).

## Slash commands

| Command | Description |
| --- | --- |
| `/message` | Send a message as the bot (Discord Admin only). |
| `/faq1` | Post the FAQ notice about site stability. |
| `/utd` | Post the update-in-progress notice. |
| `/archive` | Archive the current channel and move it to the Archive category. |
| `/put-member-role` | Add the member auto-role to everyone missing it (Admin only). |
| `/wipe` | Confirmed bulk-delete of recent messages in the current channel (Admin only, 14-day Discord API limit). |
| `/nuke` | Clone the current channel with all permissions/settings and delete the old one (Admin only, confirm with warning). |

## Project structure

```text
trackerbot/
├── bot.js              # Discord bot entry point
├── webserver.js        # Public bug/data intake server
├── src/
│   ├── client/         # Discord client setup
│   ├── commands/       # Slash command registration
│   ├── config/         # Env validation and constants
│   ├── handlers/       # Interaction and member event handlers
│   ├── interactions/   # Slash and button handlers
│   └── utils/          # Shared helpers (e.g. card embeds)
└── web/                # Static issue/data report forms
```

## Contributing

Issues and pull requests are welcome. Please open an issue to discuss substantial changes before submitting a PR.

## License

Released under the [MIT License](LICENSE).
