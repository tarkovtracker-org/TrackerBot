module.exports = {
  apps: [
    {
      name: "trackerbot-dev",
      cwd: __dirname,
      script: "/bin/bash",
      args: "-lc 'npm run dev'",
      autorestart: true
    },
    {
      name: "trackerbot-web",
      cwd: __dirname,
      script: "node",
      args: "webserver.js",
      autorestart: true
    },
    {
      name: "trackerbot-admin",
      cwd: __dirname,
      script: "node",
      args: "adminserver.js",
      autorestart: true
    }
  ]
}
