module.exports = {
  apps: [
    {
      name: "TrackerBot-bot",
      cwd: __dirname,
      script: "bot.js",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    },
    {
      name: "TrackerBot-web",
      cwd: __dirname,
      script: "webserver.js",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    }
  ]
};
