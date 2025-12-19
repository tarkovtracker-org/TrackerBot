module.exports = {
  apps: [
    {
      name: "TrackerBot:bot",
      cwd: __dirname,
      script: "npm",
      args: "run start:bot",
      autorestart: true
    },
    {
      name: "TrackerBot:web",
      cwd: __dirname,
      script: "npm",
      args: "run start:web",
      autorestart: true
    },
    {
      name: "TrackerBot:admin",
      cwd: __dirname,
      script: "npm",
      args: "run start:admin",
      autorestart: true
    }
  ]
};
