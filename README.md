# TrackerBot

<div align="center">

<table border="0"><tr>
<td valign="middle"><img src="https://tarkovtracker.org/img/logos/tarkovtrackerlogo-light.webp" alt="TarkovTracker logo" width="120" /></td>
<td valign="middle"><h1>TrackerBot</h1></td>
</tr></table>

The Discord companion for the [TarkovTracker.org](https://tarkovtracker.org) community: slash commands, reaction roles, welcome automation, ticket creation, and a public bug-intake portal that forwards reports straight to GitHub.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/tarkovtracker-org/trackerbot/pulls)
</div>

## Overview

TrackerBot runs two services side by side:

| Service | Entry point | Responsibility |
| --- | --- | --- |
| **Discord bot** | `bot.js` | Slash commands, reaction roles, welcome automation, and ticket creation. |
| **Bug intake web server** | `webserver.js` | Serves the public issue forms and forwards submissions to GitHub. |

Requires **Node.js 18+**.

## Features

- Ticket creation flow with private support channels
- Reaction-role assignment and a `put-member-role` bulk role command
- Automated welcome messages and auto-roles for new members
- Quick announcement helpers (`/message`, `/faq1`, `/utd`)
- One-command channel archiving (`/archive`)
- Public web forms that open GitHub issues for bug and data reports

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

- **Discord bot basics:** `DISCORD_TOKEN`, `GUILD_ID`, `ADMIN_IDS` (comma-separated Discord user IDs)
- **GitHub issue routing:** `GITHUB_TOKEN`, `REPO_DEV`, `REPO_DATA_REPORT`
- **Channel IDs for automated posts:** `BUG_REPORT_CHANNEL_ID`, `TICKET_CHANNEL_ID`, `WELCOME_CHANNEL_ID`
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
