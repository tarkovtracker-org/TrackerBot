module.exports = {
  apps: [
    {
      name: "trackerbot-dev",
      cwd: __dirname,
      script: "npm",
      args: "run dev",
      interpreter: "bash"
    },
    {
      name: "trackerbot-web",
      cwd: __dirname,
      script: "node",
      args: "webserver.js"
    },
    {
      name: "trackerbot-admin",
      cwd: __dirname,
      script: "node",
      args: "adminserver.js"
    }
  ]
}
