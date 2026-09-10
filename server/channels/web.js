import express from 'express';
import { ChannelAdapter } from './base.js';

/**
 * The web widget is a channel like any other: it implements the same
 * interface, and the conversation logic cannot tell it apart from Telegram.
 * It exists as the fallback for the day the venue wifi blocks api.telegram.org.
 */
export class WebAdapter extends ChannelAdapter {
  constructor() {
    super('web');
    this.enabled = true;
    this.router = express.Router();
  }

  async receive(onMessage) {
    this.router.post('/', async (req, res) => {
      const chatId = String(req.body?.session_id || 'web-anonymous');
      try {
        const payload = req.body?.file
          ? { chatId, file: { buffer: Buffer.from(req.body.file, 'base64'), filename: req.body.filename || '' } }
          : { chatId, text: req.body?.text || '' };
        const reply = await onMessage(payload);
        res.json(reply);
      } catch (error) {
        console.error('[web] handler failed:', error);
        res.status(500).json({ text: `Something went wrong on my side: ${error.message}` });
      }
    });
    console.log('[web] chat adapter mounted at /api/chat');
  }

  /** HTTP request/response — the reply already went back in receive(). */
  async send() {}
}
