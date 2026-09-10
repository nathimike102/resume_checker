import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectMongo, cacheStats } from './lib/cache.js';
import { modelInfo, USE_STUB, checkCredentials } from './lib/model.js';
import { router as parseRouter } from './routes/parse.js';
import { router as matchRouter } from './routes/match.js';
import { router as matrixRouter, MAX_SIDE } from './routes/matrix.js';
import { router as evalRouter } from './routes/eval.js';
import { router as exportRouter } from './routes/export.js';
import { WebAdapter } from './channels/web.js';
import { TelegramAdapter } from './channels/telegram.js';
import { WhatsAppAdapter } from './channels/whatsapp.js';
import { handleMessage, sessionCount } from './lib/conversation.js';
import { COURSES } from './lib/courses.js';

const app = express();
const PORT = process.env.PORT || 3001;

const telegram = new TelegramAdapter();
const whatsapp = new WhatsAppAdapter();

app.use(cors());
app.use(express.json({ limit: '12mb' })); // base64 PDFs arrive in the body

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: USE_STUB ? 'stub (no network, heuristic parser)' : 'live',
    model: { ...modelInfo, credentials: credentials.ok ? 'ok' : credentials.reason },
    cache: cacheStats(),
    catalogue_size: COURSES.length,
    matrix_cap: `${MAX_SIDE}x${MAX_SIDE}`,
    channels: {
      web: true,
      telegram: telegram.status(), // connected=true only once Telegram accepts the token
      whatsapp: { enabled: false, reason: 'requires Meta Business verification' },
    },
    sessions: sessionCount(),
  });
});

app.use('/api/parse', parseRouter);
app.use('/api/match', matchRouter);
app.use('/api/matrix', matrixRouter);
app.use('/api/eval', evalRouter);
app.use('/api/export', exportRouter);

// Both chat channels drive the same conversation state machine.
const web = new WebAdapter();
await web.receive(handleMessage);
app.use('/api/chat', web.router);

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[unhandled]', error);
  res.status(500).json({ error: 'Something broke on our side.', code: 'internal' });
});

const credentials = checkCredentials();

await connectMongo();

const server = app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT} — mode: ${USE_STUB ? 'STUB' : 'live'} (${modelInfo.model})`);
});

// Without this, a port clash exits with a raw Node stack trace, which reads
// like the app is broken when the actual problem is "it is already running".
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — the server is probably already running.\n`);
    console.error(`  Use the one that is running:  http://localhost:${PORT}/api/health`);
    console.error('  Or stop it and try again:     pkill -f "node server/index.js"');
    console.error(`  Or run this one elsewhere:    PORT=${Number(PORT) + 1} npm run dev\n`);
  } else {
    console.error(`\n  The server could not start: ${error.message}\n`);
  }
  process.exit(1);
});

// Telegram runs alongside the HTTP server, polling. No token, no bot, no crash.
if (telegram.enabled) {
  telegram.receive(handleMessage).catch((error) => {
    console.error(`[telegram] NOT connected: ${error.message}`);
    if (/unauthorized/i.test(error.message)) {
      console.error('[telegram] that token was rejected — re-copy it from @BotFather (format 123456789:AA...)');
    }
  });
} else {
  console.log('[telegram] TELEGRAM_BOT_TOKEN not set — web chat only');
}

console.log(`[whatsapp] adapter present, enabled=${whatsapp.enabled} (requires Meta Business verification)`);

process.on('SIGINT', async () => {
  await telegram.stop();
  process.exit(0);
});
