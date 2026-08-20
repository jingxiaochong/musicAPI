module.exports = {
  apps: [
    {
      name: 'musicAPI',
      script: './app.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      time: true,
      out_file: './log/musicAPI.out.log',
      error_file: './log/musicAPI.error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        CHECK_VERSION: 'false',
      },
    },
  ],
}
