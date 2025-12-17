module.exports = {
  apps: [
    {
      name: "TrackerBot-Prod",
      cwd: __dirname,
      script: "node",
      args: "bot.js",
      autorestart: true
    },
    {
      name: "TrackerBot-Web",
      cwd: __dirname,
      script: "node",
      args: "webserver.js",
      autorestart: true
    },
    {
      name: "TrackerBot-Admin",
      cwd: __dirname,
      script: "node",
      args: "adminserver.js",
      autorestart: true
    }
  ]
}
