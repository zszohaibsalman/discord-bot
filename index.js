'use strict';

/**
 * Discord.js v14 bot with an Express keep-alive web server.
 *
 * Designed for Render free-tier "Web Service" deployments, which spin down
 * after 15 minutes of no incoming HTTP traffic. Pair this with an external
 * monitor (e.g. UptimeRobot) hitting GET / every 5 minutes to stay awake.
 */

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Events,
} = require('discord.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Environment variable validation
// ─────────────────────────────────────────────────────────────────────────────
const { DISCORD_TOKEN } = process.env;

if (!DISCORD_TOKEN || DISCORD_TOKEN.trim() === '') {
  console.error('[FATAL] DISCORD_TOKEN environment variable is required.');
  console.error('        Set it in your local .env file or in the Render dashboard under Environment.');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Express keep-alive server
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => {
  // Required route: returns 200 OK so Render (and uptime monitors) see the
  // service as healthy and keep it from spinning down.
  res.status(200).type('text/plain').send('Discord bot is awake. 💚');
});

app.get('/health', (_req, res) => {
  // Bonus route: useful for debugging and richer monitoring.
  res.status(200).json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    discord: client.isReady() ? 'connected' : 'connecting',
    timestamp: new Date().toISOString(),
  });
});

// Bind the port BEFORE attempting Discord login so a slow / failing login
// never causes Render to mark the deploy as failed.
const server = app.listen(PORT, () => {
  console.log(`[HTTP] Keep-alive server listening on port ${PORT}`);
  console.log('[HINT] Point an external monitor (UptimeRobot, cron-job.org, ...)');
  console.log('       at https://<your-app>.onrender.com/ every 5 minutes.');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Discord client
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in the Developer Portal
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[DISCORD] Logged in as ${c.user.tag} (id: ${c.user.id})`);
  console.log(`[DISCORD] Watching ${c.guilds.cache.size} guild(s).`);
  c.user.setPresence({
    activities: [{ name: 'with keep-alive pings', type: 3 }], // type 3 = Watching
    status: 'online',
  });
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots and DMs without content (webhooks, system messages, etc.)
  if (message.author.bot || !message.content) return;
  if (message.content !== '!ping') return;

  try {
    const sent = await message.reply({ content: 'Pinging...' });
    const roundtrip = sent.createdTimestamp - message.createdTimestamp;
    const wsLatency = Math.round(client.ws.ping);

    await sent.edit({
      content:
        `🏓 Pong!\n` +
        `• Message roundtrip: **${roundtrip}ms**\n` +
        `• WebSocket latency: **${wsLatency}ms**`,
    });
  } catch (err) {
    console.error('[DISCORD] Failed to handle !ping:', err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Discord error handling
// ─────────────────────────────────────────────────────────────────────────────
client.on(Events.Error, (err) => {
  console.error('[DISCORD] Client error:', err);
});

client.on(Events.Warn, (msg) => {
  console.warn('[DISCORD] Warning:', msg);
});

client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  console.warn(
    `[DISCORD] Shard ${shardId} disconnected (code ${closeEvent.code}). ` +
      'discord.js will attempt to reconnect automatically.'
  );
});

client
  .login(DISCORD_TOKEN)
  .then(() => {
    console.log('[DISCORD] Login request sent, awaiting ready event...');
  })
  .catch((err) => {
    console.error('[DISCORD] Login failed:', err.message);
    console.error(
      '[DISCORD] Common causes: invalid/rotated token, MessageContent intent ' +
        'not enabled in the Developer Portal, or network restrictions.'
    );
    // Intentionally do NOT exit: keep the web server alive so health checks
    // still pass and Render keeps the instance warm for a retry.
  });

// ─────────────────────────────────────────────────────────────────────────────
// 5. Process-level safety nets + graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err);
  // Render restarts the service on exit, so exit non-zero for fatal errors.
  // For transient errors, comment out the line below.
  process.exit(1);
});

const shutdown = (signal) => {
  console.log(`\n[PROCESS] ${signal} received, shutting down gracefully...`);
  server.close(() => console.log('[HTTP] Server closed.'));
  client
    .destroy()
    .then(() => {
      console.log('[DISCORD] Client destroyed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[PROCESS] Error during shutdown:', err);
      process.exit(1);
    });

  // Hard exit if cleanup takes longer than 10s (Render sends SIGKILL after that).
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
