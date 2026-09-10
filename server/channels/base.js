/**
 * ChannelAdapter — the whole point of this interface is that the bot's
 * conversation logic lives in lib/conversation.js and knows nothing about
 * Telegram, WhatsApp or the web. A channel is transport and nothing else.
 *
 *   receive() — start listening; call onMessage({ chatId, text, file }) per message
 *   send(chatId, payload) — deliver { text, result? } back to the user
 *
 * A new channel is this interface plus the platform's two API calls.
 */
export class ChannelAdapter {
  constructor(name) {
    this.name = name;
  }

  /** @param {(msg: {chatId: string, text?: string, file?: {buffer: Buffer, filename: string}}) => Promise<void>} onMessage */
  async receive(onMessage) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}: receive() not implemented`);
  }

  async send(chatId, payload) { // eslint-disable-line no-unused-vars
    throw new Error(`${this.name}: send() not implemented`);
  }

  async stop() {}
}
