module.exports = {
  apps: [
    {
      name: 'calendar-task-app',
      script: 'server/index.js',
      cwd: __dirname,
      watch: false,
      env: { NODE_ENV: 'production', PORT: 3001 }
    }
  ]
};
