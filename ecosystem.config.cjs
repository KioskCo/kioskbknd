/**
 * PM2 process configs for the Kiosk API server.
 *
 * Two modes:
 *
 *   DEVELOPMENT (no build needed — tsx runs TypeScript directly and
 *   auto-restarts on every file save):
 *     pm2 start ecosystem.config.cjs --only kiosk-api-dev
 *     pm2 logs kiosk-api-dev
 *
 *   PRODUCTION (compiled dist/, used when hosting):
 *     npm run build
 *     pm2 start ecosystem.config.cjs --only kiosk-api
 */
module.exports = {
  apps: [
    // ── Development ──────────────────────────────────────────────────────────
    // Uses `npm run dev` so npm resolves the correct Windows tsx executable.
    // Auto-restarts on crash; tsx itself handles hot-reload on file save.
    {
      name: "kiosk-api-dev",
      script: "./node_modules/tsx/dist/cli.mjs",
      args: "src/index.ts",
      cwd: __dirname,
      node_args: "--env-file=.env",
      autorestart: true,
      restart_delay: 1000,
      max_restarts: 20,
      max_memory_restart: "500M",
      watch: false,
    },
    // ── ngrok tunnel ─────────────────────────────────────────────────────────
    // Keeps the stable public URL alive. Start with:
    //   pm2 start ecosystem.config.cjs --only kiosk-tunnel
    {
      name: "kiosk-tunnel",
      script: "C:\\ngrok\\ngrok.exe",
      args: "http --url=drastic-cruelty-arise.ngrok-free.dev 3000",
      autorestart: true,
      watch: false,
    },
    // ── Production ───────────────────────────────────────────────────────────
    {
      name: "kiosk-api",
      script: "./dist/index.mjs",
      cwd: __dirname,
      node_args: "--env-file=.env --enable-source-maps",
      autorestart: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: "500M",
      watch: false,
    },
    // ── Production worker (BullMQ) ────────────────────────────────────────────
    // Consumes the payment/escrow/abandoned-cart queues. Run alongside kiosk-api.
    // Requires REDIS_URL. Same .env as the web app.
    {
      name: "kiosk-api-worker",
      script: "./dist/workers.mjs",
      cwd: __dirname,
      node_args: "--env-file=.env --enable-source-maps",
      autorestart: true,
      restart_delay: 3000,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: "500M",
      watch: false,
    },
  ],
};
