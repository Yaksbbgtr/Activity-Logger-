// Small Telegram Bot API client. The bot token lives in Durable Object storage,
// entered by the user in the app, so it never has to pass through anyone else.

export const QUESTION = 'What are you doing right now?';

export function randomToken(bytes = 18) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class Telegram {
  constructor(token, fetchImpl = (...args) => fetch(...args)) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call(method, params = {}) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) throw Object.assign(new Error(data.description || 'Telegram error'), { code: data.error_code });
    return data.result;
  }

  getMe() { return this.call('getMe'); }
  setWebhook(url, secret) {
    return this.call('setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: true }); }
  send(chatId, text, extra = {}) { return this.call('sendMessage', { chat_id: chatId, text, ...extra }); }
  react(chatId, messageId, emoji = '👍') {
    return this.call('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
  }
}

/** Telegram bot tokens look like 123456789:AA... */
export const looksLikeToken = (t) => /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(t);
