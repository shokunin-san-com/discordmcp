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
  ],
};
