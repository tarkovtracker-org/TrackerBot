# Setup Guide

## Prerequisites

Make sure the following are installed on your system:

- Node.js
- npm

## Install Dependencies

Run the following command in the project directory:

```bash
npm install
```

## Configure Environment Variables

**1.** Edit the _.env.example_ file and fill in the required values.

**2.** Rename the file _.env.example_ to _.env_.

## Test the bot

Run the following command in the project directory:

```bash
npm run dev
```

If the bot starts without errors, continue to the next section.

## Run in Background with PM2

**1.** Install PM2 globally if you do not have it:

```bash
npm install -g pm2
```

**2.** Start the bot with PM2:

```bash
pm2 start bot.js --name TrackerBot
```

**3.** Save the PM2 process list so it restarts automatically on reboot:

```bash
pm2 save
```

**4.** Enable the PM2 startup script:

```bash
pm2 startup
```

Your bot will now run in the background and automatically restart if it stops or the system reboots.
