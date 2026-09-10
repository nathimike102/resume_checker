import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectMongo, cacheStats } from './lib/cache.js';
import { modelInfo, USE_STUB } from './lib/model.js';
import { router as parseRouter } from './routes/parse.js';
import { router as matchRouter } from './routes/match.js';
import { router as matrixRouter, MAX_SIDE } from './routes/matrix.js';
import { router as evalRouter } from './routes/eval.js';
import { WebAdapter } from './channels/web.js';
import { TelegramAdapter } from './channels/telegram.js';
import { WhatsAppAdapter } from './channels/whatsapp.js';
import { handleMessage, sessionCount } from './lib/conversation.js';
import { COURSES } from './lib/courses.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '12mb' })); // base64 PDFs arrive in the body

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: USE_STUB ? 'stub (no network, heuristic parser)' : 'live',
    model: modelInfo,
    cache: cacheStats(),
    catalogue_size: COURSES.length,
    matrix_cap: `${MAX_SIDE}x${MAX_SIDE}`,
    channels: {
      web: true,
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      whatsapp: false, // requires Meta Business verification
    },
    sessions: sessionCount(),
  });
});

app.use('/api/parse', parseRouter);
app.use('/api/match', matchRouter);
app.use('/api/matrix', matrixRouter);
app.use('/api/eval', evalRouter);

// Both chat channels drive the same conversation state machine.
const web = new WebAdapter();
await web.receive(handleMessage);
app.use('/api/chat', web.router);

app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[unhandled]', error);
  res.status(500).json({ error: 'Something broke on our side.', code: 'internal' });
});

await connectMongo();

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT} — mode: ${USE_STUB ? 'STUB' : 'live'} (${modelInfo.model})`);
});

// Telegram runs alongside the HTTP server, polling. No token, no bot, no crash.
const telegram = new TelegramAdapter();
if (telegram.enabled) {
  telegram.receive(handleMessage).catch((error) => console.error('[telegram] stopped:', error.message));
} else {
  console.log('[telegram] TELEGRAM_BOT_TOKEN not set — web chat only');
}

const whatsapp = new WhatsAppAdapter();
console.log(`[whatsapp] adapter present, enabled=${whatsapp.enabled} (requires Meta Business verification)`);

process.on('SIGINT', async () => {
  await telegram.stop();
  process.exit(0);
});
