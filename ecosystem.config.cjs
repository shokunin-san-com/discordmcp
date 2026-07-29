// PM2 ecosystem config for Discord MCP Server
module.exports = {
  apps: [
    {
      name: "discord-mcp",
      script: "build/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        MCP_TRANSPORT: "http",
        MCP_PORT: "3100",
      },
      // PM2 options
      instances: 1, // MCP server is stateful, must be single instance
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
    },
    {
      // Anthropic API 使用量監視（毎日 9:00 / 15:00 / 21:00 に実行）
      // 閾値（デフォルト $80）超過時に #executive へ白電伝虫から通知。
      name: "anthropic-usage-check",
      script: "build/scripts/check-anthropic-usage.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      autorestart: false, // 単発実行してそのまま終了
      watch: false,
      cron_restart: "0 9,15,21 * * *",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "logs/usage-check-error.log",
      out_file: "logs/usage-check-out.log",
      merge_logs: true,
    },
  ],
};
