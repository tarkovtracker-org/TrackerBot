module.exports = {
  apps: [
    {
      name: "TrackerBot",
      cwd: __dirname,
      script: "npm",
      args: "start",
      autorestart: true
    }
  ]
};
