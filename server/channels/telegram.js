import { ChannelAdapter } from './base.js';
import { scorecardSvg, matrixSvg } from '../lib/scorecard.js';
import { svgToPng } from '../lib/render.js';
import { buildPdf, buildDocx, fileBase } from '../lib/export.js';

const TELEGRAM_MAX_FILE_BYTES = 20 * 1024 * 1024; // Bot API hard limit on getFile
const POLL_TIMEOUT_S = 25;
const POLL_ABORT_MS = (POLL_TIMEOUT_S + 5) * 1000; // give the long-poll room to close cleanly before we force it
const MAX_CONNECT_RETRIES = 3;

/**
 * Long polling via getUpdates — deliberately. A webhook needs a public HTTPS
 * URL, which means ngrok, which means trusting venue wifi and a tunnel service
 * during a live demo. Polling only needs outbound HTTPS.
 *
 * Raw fetch instead of a wrapper library: it is two endpoints, and I would
 * rather be able to explain every line of it than import 4,000 lines I cannot.
 */
export class TelegramAdapter extends ChannelAdapter {
  constructor(token = process.env.TELEGRAM_BOT_TOKEN) {
    super('telegram');
    this.token = token;
    this.api = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this.running = false;
    // Distinct from `enabled`: enabled means a token exists, connected means
    // Telegram accepted it and we are actually polling. /api/health shows the
    // second one, because a typo'd token would otherwise read as "on".
    this.connected = false;
    this.username = null;
    // How many consecutive poll failures we've seen. Drives backoff so a
    // real outage doesn't turn into a tight retry loop hammering Telegram.
    this.consecutiveFailures = 0;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async call(method, body, { signal } = {}) {
    const response = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    // Telegram returns JSON even on errors, but a proxy/outage in between
    // can return an HTML error page instead — guard the parse so that
    // shows up as a clear error, not a confusing JSON.parse crash.
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`telegram ${method}: non-JSON response (HTTP ${response.status})`);
    }
    if (!data.ok) {
      const err = new Error(`telegram ${method}: ${data.description}`);
      err.telegramErrorCode = data.error_code;
      throw err;
    }
    return data.result;
  }

  /** True for errors that will never fix themselves on retry (bad token, revoked bot). */
  isFatal(error) {
    return error.telegramErrorCode === 401 || error.telegramErrorCode === 404;
  }

  async receive(onMessage) {
    if (!this.enabled) throw new Error('telegram: TELEGRAM_BOT_TOKEN is not set');

    // Retry the initial handshake a few times before giving up — a
    // transient network blip on startup shouldn't take the whole channel
    // down, but a genuinely bad token should fail fast and loud rather
    // than retry forever.
    let me;
    for (let attempt = 1; attempt <= MAX_CONNECT_RETRIES; attempt++) {
      try {
        me = await this.call('getMe', {});
        break;
      } catch (error) {
        if (this.isFatal(error) || attempt === MAX_CONNECT_RETRIES) {
          throw new Error(`telegram: could not connect after ${attempt} attempt(s): ${error.message}`);
        }
        console.warn(`[telegram] connect attempt ${attempt} failed, retrying:`, error.message);
        await sleep(1000 * attempt);
      }
    }

    this.username = me.username;
    this.connected = true;
    this.running = true;
    this.consecutiveFailures = 0;
    console.log(`[telegram] connected as @${me.username} — open https://t.me/${me.username} and send /start`);

    while (this.running) {
      try {
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), POLL_ABORT_MS);
        let updates;
        try {
          updates = await this.call(
            'getUpdates',
            { offset: this.offset, timeout: POLL_TIMEOUT_S },
            { signal: controller.signal }
          );
        } finally {
          clearTimeout(abortTimer);
        }

        this.consecutiveFailures = 0; // a successful poll resets backoff

        for (const update of updates) {
          this.offset = update.update_id + 1;
          const message = update.message;
          if (!message) continue;
          const chatId = String(message.chat.id);
          try {
            await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
            const payload = message.document
              ? { chatId, file: await this.download(message.document) }
              : { chatId, text: message.text || message.caption || '' };
            const reply = await onMessage(payload);
            await this.send(chatId, reply);
          } catch (error) {
            // Full detail server-side for debugging; the user gets a plain,
            // non-leaky message. Internal error text (stack fragments,
            // occasionally sensitive URLs) should never reach the chat.
            console.error('[telegram] handler failed:', error);
            await this.send(chatId, {
              text: "Sorry, something went wrong processing that. Mind trying again?",
            });
          }
        }
      } catch (error) {
        this.connected = !this.isFatal(error) && this.connected;
        this.consecutiveFailures += 1;
        console.error('[telegram] poll failed:', error.message);
        if (this.isFatal(error)) {
          console.error('[telegram] fatal auth error, stopping poll loop.');
          this.running = false;
          break;
        }
        // Capped exponential backoff: 3s, 6s, 12s, ... up to 30s. Avoids
        // hammering Telegram during a real outage while still recovering
        // quickly from a one-off blip.
        const delay = Math.min(3000 * 2 ** (this.consecutiveFailures - 1), 30000);
        await sleep(delay);
      }
    }
  }

  /** Documents arrive as a file_id; getFile turns it into a download path. */
  async download(document) {
    if (document.file_size && document.file_size > TELEGRAM_MAX_FILE_BYTES) {
      const mb = (document.file_size / (1024 * 1024)).toFixed(1);
      throw new Error(`That file is ${mb}MB — Telegram bots can only download files up to 20MB. Try a smaller export of your resume.`);
    }

    const file = await this.call('getFile', { file_id: document.file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) {
      throw new Error(`telegram file download failed: HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, filename: document.file_name || file.file_path };
  }

  async send(chatId, payload) {
    // A picture first, then the detail. The image is built here rather than in
    // conversation.js: the state machine stays channel-agnostic, and a channel
    // that cannot show images simply never asks for one.
    // An explicit /pdf or /docx request: send the file, not a picture.
    if (typeof payload === 'object' && payload?.document) {
      const sent = await this.sendDocument(chatId, payload.document);
      if (!sent) {
        await this.call('sendMessage', { chat_id: chatId, text: 'Sorry — I could not build that file. The report above still stands.' });
      }
      return;
    }

    const png = await this.buildImage(payload);
    if (png) {
      const caption = typeof payload === 'object' && payload.result
        ? `${payload.result.overall_score}/100 — ${payload.result.verdict} match`
        : 'Your fit grid';
      await this.sendPhoto(chatId, png, caption);
    }

    // Prefer the MarkdownV2 rendering: bold section headings and monospace
    // blocks that keep the score bars aligned on a phone. One unescaped
    // reserved character makes Telegram reject the whole message, so a parse
    // failure falls back to plain text — and that fallback must always have
    // real content, even if the caller only ever set `.markdown`.
    const markdown = typeof payload === 'object' ? payload?.markdown : null;
    if (markdown && (await this.sendFormatted(chatId, markdown))) return;

    const text = resolveFallbackText(payload, markdown);

    // Telegram caps a message at 4096 characters.
    for (const [i, chunk] of chunkText(text, 3900).entries()) {
      if (i > 0) await sleep(300); // stay under Telegram's ~1 msg/sec per-chat limit
      await this.call('sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  /** @returns {Promise<boolean>} true if the formatted send succeeded. */
  async sendFormatted(chatId, markdown) {
    const chunks = balanceFences(chunkText(markdown, 3900));
    try {
      for (const [i, chunk] of chunks.entries()) {
        if (i > 0) await sleep(300);
        await this.call('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'MarkdownV2' });
      }
      return true;
    } catch (error) {
      console.warn('[telegram] MarkdownV2 rejected, sending plain text:', error.message);
      return false;
    }
  }

  /** Returns PNG bytes for a scored result or a matrix, else null. */
  async buildImage(payload) {
    if (!payload || typeof payload !== 'object') return null;
    try {
      if (payload.result) return await svgToPng(scorecardSvg(payload.result), { width: 1080 });
      if (payload.matrix) return await svgToPng(matrixSvg(payload.matrix), { width: 1100 });
    } catch (error) {
      // An image is a bonus, never a reason the user gets nothing.
      console.warn('[telegram] could not build image:', error.message);
    }
    return null;
  }

  /** @returns {Promise<boolean>} */
  async sendDocument(chatId, { format, result }) {
    try {
      const file = format === 'docx' ? await buildDocx(result) : await buildPdf(result);
      if (!file) return false;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `${result.overall_score}/100 — ${result._meta?.role_title || 'fit report'}`);
      form.append('document', new Blob([file]), `${fileBase(result)}.${format}`);
      const response = await fetch(`${this.api}/sendDocument`, { method: 'POST', body: form });
      const data = await response.json();
      if (!data.ok) throw new Error(data.description);
      return true;
    } catch (error) {
      console.warn('[telegram] sendDocument failed:', error.message);
      return false;
    }
  }

  async sendPhoto(chatId, png, caption) {
    try {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', String(caption).slice(0, 1000));
      form.append('photo', new Blob([png], { type: 'image/png' }), 'fit-report.png');
      const response = await fetch(`${this.api}/sendPhoto`, { method: 'POST', body: form });
      const data = await response.json();
      if (!data.ok) throw new Error(data.description);
    } catch (error) {
      console.warn('[telegram] sendPhoto failed, text still sent:', error.message);
    }
  }

  async stop() {
    this.running = false;
    this.connected = false;
  }

  /** What /api/health reports. */
  status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      username: this.username,
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/**
 * Builds the plain-text fallback used when MarkdownV2 is rejected or wasn't
 * provided. Previously this read `payload.text` directly, which is empty
 * whenever a caller only set `.markdown` — meaning a MarkdownV2 rejection
 * would silently send an EMPTY message. If there's no `.text`, strip the
 * markdown down to readable plain text instead of sending nothing.
 */
function resolveFallbackText(payload, markdown) {
  if (typeof payload === 'string') return payload;
  if (payload?.text) return payload.text;
  if (markdown) return stripMarkdown(markdown);
  return "Here's your result.";
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1') // un-escape
    .replace(/```/g, '')
    .replace(/[*_~`]/g, '');
}

/**
 * Splitting a long message can cut a ``` block in half, and Telegram rejects
 * a chunk whose fence never closes. Close it at the break and reopen it at the
 * start of the next chunk, so the block survives the split.
 */
function balanceFences(chunks) {
  let carryOpen = false;
  return chunks.map((chunk) => {
    let out = carryOpen ? `\`\`\`\n${chunk}` : chunk;
    const open = (out.match(/```/g) || []).length % 2 === 1;
    if (open) out += '\n```';
    carryOpen = open;
    return out;
  });
}

function chunkText(text, size) {
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}