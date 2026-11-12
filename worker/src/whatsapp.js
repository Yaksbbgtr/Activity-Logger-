// Small WhatsApp Cloud API client (Meta Graph API). Credentials live in
// Durable Object storage, entered by the user in the app.

export const GRAPH = 'https://graph.facebook.com/v23.0';
export const TEMPLATE = 'activity_check';
export const TEMPLATE_TEXT = 'What are you doing right now? Reply here to log it.';
// Free-form messages are only allowed within 24 h of the user's last message.
export const WINDOW_MS = 23.5 * 3600 * 1000;

export class WhatsApp {
  constructor({ token, phoneNumberId, wabaId }, fetchImpl = (...args) => fetch(...args)) {
    this.token = token;
    this.phoneNumberId = phoneNumberId;
    this.wabaId = wabaId;
    this.fetchImpl = fetchImpl;
  }

  async call(method, path, body) {
    const res = await this.fetchImpl(`${GRAPH}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const e = data.error || {};
      throw Object.assign(new Error(e.message || `HTTP ${res.status}`), { code: e.code, status: res.status });
    }
    return data;
  }

  phoneInfo() { return this.call('GET', `${this.phoneNumberId}?fields=display_phone_number,verified_name`); }

  send(to, payload) {
    return this.call('POST', `${this.phoneNumberId}/messages`, { messaging_product: 'whatsapp', to, ...payload });
  }
  text(to, body) { return this.send(to, { type: 'text', text: { body } }); }
  template(to, name, lang = 'en_US') { return this.send(to, { type: 'template', template: { name, language: { code: lang } } }); }
  react(to, messageId, emoji = '👍') { return this.send(to, { type: 'reaction', reaction: { message_id: messageId, emoji } }); }

  createTemplate() {
    return this.call('POST', `${this.wabaId}/message_templates`, {
      name: TEMPLATE, category: 'UTILITY', language: 'en_US',
      components: [{ type: 'BODY', text: TEMPLATE_TEXT }],
    });
  }
  async templateStatus() {
    const r = await this.call('GET', `${this.wabaId}/message_templates?name=${TEMPLATE}&fields=name,status`);
    return r.data?.find((t) => t.name === TEMPLATE)?.status ?? 'MISSING';
  }
}

/** Text messages from a Cloud API webhook payload for one phone number. */
export function incomingMessages(payload, phoneNumberId) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (change.field !== 'messages' || v?.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const m of v.messages ?? []) out.push(m);
    }
  }
  return out;
}
