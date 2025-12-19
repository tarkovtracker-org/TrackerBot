# TrackerBot

TrackerBot runs three services:

1. **Discord bot (`bot.js`)** – handles slash commands, reaction roles, welcome automation, and ticket creation.
2. **Bug intake web server (`webserver.js`)** – serves the public bug-report forms and forwards submissions to GitHub.
3. **Admin panel (`adminserver.js`)** – secured dashboard for Discord admins to push embeds and reaction-role cards.

The bot requires Node.js 18+.

## 1. Install dependencies

```bash
npm install
```

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

- Discord bot basics: `DISCORD_TOKEN`, `GUILD_ID`
- GitHub issue routing: `GITHUB_TOKEN`, `REPO_TARKOVTRACKER`, `REPO_DATA_REPORT`
- Channel IDs for the automated posts: `BUG_REPORT_CHANNEL_ID`, `DATA_BUG_CHANNEL_ID`, `ROLE_CHANNEL_ID`, `TICKET_CHANNEL_ID`, `WELCOME_CHANNEL_ID`
- Admin panel OAuth: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `PANEL_ADMIN_ROLE_ID`, `ADMIN_PANEL_PORT`
- Web server port overrides: `PORT`

> Tip: `GITHUB_TOKEN` needs `repo` scope (or equivalent granular access) to create issues in the configured repositories.

## 3. Run the services locally

### Quick start (all services)

```bash
npm start
```

This launches the bot, bug-report web server, and admin panel in parallel. Logs for each service are prefixed with `bot`, `web`, or `admin`.

### Run services individually

```bash
npm run start:bot   # Discord bot
npm run start:web   # Public bug-report forms (http://localhost:3000)
npm run start:admin # Admin panel (http://localhost:4001)
```

- Bot login success is logged as soon as Discord authenticates the token.
- `webserver.js` serves `http://localhost:3000` (main bug form) and `http://localhost:3000/bug-report-data/` (data-specific reports).
- `adminserver.js` requires Discord OAuth with the `PANEL_ADMIN_ROLE_ID`.

## 4. Optional: run the bot with PM2

```bash
npm install -g pm2
pm2 start bot.js --name TrackerBot
pm2 save
pm2 startup
```

## Deployment notes

- Use `deploy-test.sh` or `deploy-prod.sh` as references for installing dependencies and restarting the PM2 processes on servers.
- The bot registers global slash commands on startup. When adding commands, allow up to one hour for Discord to propagate them globally.
- When rotating credentials, restart all services so environment variables are reloaded.
