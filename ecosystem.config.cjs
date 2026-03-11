module.exports = {
  apps: [
    {
      name: 'agentos-orchestrator',
      script: 'bun',
      args: 'run server/orchestrator.ts',
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'agentos-server',
      script: 'bun',
      args: 'run server/index.ts',
      cwd: __dirname,
      restart_delay: 3000,
      max_restarts: 10,
      autorestart: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
