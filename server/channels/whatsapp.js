import { ChannelAdapter } from './base.js';

/**
 * STUB — deliberately not wired up.
 *
 * WhatsApp needs a Meta Business account, phone-number verification and
 * message-template approval. That is days of waiting, not hours of work, so it
 * could not be in this build. The interface is implemented, the send/receive
 * shapes are the same as Telegram's, and the remaining work is the two Graph
 * API calls below plus a webhook route — roughly forty lines once the account
 * exists. Keeping the stub honest is better than pretending it ships.
 */
export class WhatsAppAdapter extends ChannelAdapter {
  constructor() {
    super('whatsapp');
    this.enabled = false;
  }

  async receive() {
    throw new Error('whatsapp: not enabled — requires Meta Business verification');
  }

  async send() {
    // TODO: Meta Business API
    // POST https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/messages
    //   headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    //   body: { messaging_product: 'whatsapp', to, type: 'text', text: { body } }
    // Inbound arrives on a verified webhook; documents come as a media id that
    // needs a second GET to resolve to a download URL.
    throw new Error('whatsapp: not enabled — requires Meta Business verification');
  }
}
