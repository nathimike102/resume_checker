import { ChannelAdapter } from './base.js';

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
  }

  get enabled() {
    return Boolean(this.token);
  }

  async call(method, body) {
    const response = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description}`);
    return data.result;
  }

  async receive(onMessage) {
    if (!this.enabled) throw new Error('telegram: TELEGRAM_BOT_TOKEN is not set');
    const me = await this.call('getMe', {});
    this.username = me.username;
    this.connected = true;
    this.running = true;
    console.log(`[telegram] connected as @${me.username} — open https://t.me/${me.username} and send /start`);

    while (this.running) {
      try {
        const updates = await this.call('getUpdates', { offset: this.offset, timeout: 25 });
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
            console.error('[telegram] handler failed:', error.message);
            // The user always hears back, even when we broke.
            await this.send(chatId, { text: `Something went wrong on my side: ${error.message}` });
          }
        }
      } catch (error) {
        console.error('[telegram] poll failed:', error.message);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  /** Documents arrive as a file_id; getFile turns it into a download path. */
  async download(document) {
    const file = await this.call('getFile', { file_id: document.file_id });
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, filename: document.file_name || file.file_path };
  }

  async send(chatId, payload) {
    const text = typeof payload === 'string' ? payload : payload?.text || '';
    // Telegram caps a message at 4096 characters.
    for (const chunk of chunkText(text, 3900)) {
      await this.call('sendMessage', { chat_id: chatId, text: chunk });
    }
  }

  async stop() {
    this.running = false;
    this.connected = false;
  }

  /** What /api/health reports. */
  status() {
    return { enabled: this.enabled, connected: this.connected, username: this.username };
  }
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
