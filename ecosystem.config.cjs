module.exports = {
  apps: [
    {
      name: "TrackerBot-Prod_test",
      cwd: __dirname,
      script: "node",
      args: "bot.js",
      autorestart: true
    },
    {
      name: "TrackerBot-Web_test",
      cwd: __dirname,
      script: "node",
      args: "webserver.js",
      autorestart: true
    },
    {
      name: "TrackerBot-Admin_test",
      cwd: __dirname,
      script: "node",
      args: "adminserver.js",
      autorestart: true
    }
  ]
}
