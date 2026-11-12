// Core state and API for one user. Wrapped by a Durable Object in index.js;
// `storage` only needs get(key) and put(key, value), so tests can pass a Map.

import { DEFAULT_SETTINGS, GRACE_MINUTES, currentSlot, sanitizeSettings } from './schedule.js';
import { sendPush } from './webpush.js';

const MAX_LOG = 20000;
const MAX_SUBS = 10;
const MAX_ANSWER = 2000;

export class LoggerCore {
  constructor(storage, env, { fetchImpl = fetch, clock = () => new Date() } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  async settings() { return (await this.storage.get('settings')) ?? DEFAULT_SETTINGS; }
  async state() { return (await this.storage.get('state')) ?? { pending: null, lastSlot: null, log: [] }; }
  async subs() { return (await this.storage.get('subs')) ?? []; }

  /** Called every minute: opens a new prompt and sends reminders when a slot is due. */
  async tick() {
    const now = this.clock();
    const slot = currentSlot(await this.settings(), now);
    const state = await this.state();
    if (!slot || slot.key === state.lastSlot) return { sent: 0 };
    state.lastSlot = slot.key;
    if (slot.late > GRACE_MINUTES) { await this.storage.put('state', state); return { sent: 0 }; }
    this.openPrompt(state, slot.at);
    await this.storage.put('state', state);
    return this.notifyAll(slot.at);
  }

  /** "Ask me now": open a prompt immediately and send a reminder. */
  async askNow() {
    const now = this.clock();
    const state = await this.state();
    this.openPrompt(state, now);
    await this.storage.put('state', state);
    return this.notifyAll(now);
  }

  openPrompt(state, at) {
    if (state.pending) this.addLog(state, { asked: state.pending.asked, answered: null, response: '', status: 'missed' });
    state.pending = { asked: at.toISOString() };
  }

  addLog(state, entry) {
    state.log.push(entry);
    if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  }

  async answer(text) {
    text = String(text ?? '').trim().slice(0, MAX_ANSWER);
    if (!text) return { error: 'Answer is empty', status: 400 };
    const state = await this.state();
    if (!state.pending) return { error: 'Nothing to answer', status: 409 };
    this.addLog(state, { asked: state.pending.asked, answered: this.clock().toISOString(), response: text, status: 'answered' });
    state.pending = null;
    await this.storage.put('state', state);
    return { ok: true };
  }

  async notifyAll(at) {
    const subs = await this.subs();
    if (!subs.length) return { sent: 0 };
    const vapid = {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT || 'https://example.com',
    };
    const time = at.toISOString();
    const results = await Promise.all(subs.map((s) =>
      sendPush(s, { title: 'Activity Logger', body: 'What are you doing right now?', asked: time }, vapid, this.fetchImpl)
        .catch((err) => ({ ok: false, status: 0, gone: false, error: String(err) }))));
    const gone = new Set(subs.filter((_, i) => results[i].gone).map((s) => s.endpoint));
    if (gone.size) {
      const current = await this.subs();
      await this.storage.put('subs', current.filter((s) => !gone.has(s.endpoint)));
    }
    return { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).map((r) => r.status) };
  }

  async subscribe(sub) {
    if (!sub?.endpoint || (!/^https:\/\//.test(sub.endpoint) && !this.env.ALLOW_HTTP_PUSH)) return { error: 'Bad subscription', status: 400 };
    if (!sub.keys?.p256dh || !sub.keys?.auth) return { error: 'Bad subscription', status: 400 };
    const clean = { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    const subs = (await this.subs()).filter((s) => s.endpoint !== clean.endpoint);
    subs.push(clean);
    await this.storage.put('subs', subs.slice(-MAX_SUBS));
    return { ok: true, devices: Math.min(subs.length, MAX_SUBS) };
  }

  async unsubscribe(endpoint) {
    await this.storage.put('subs', (await this.subs()).filter((s) => s.endpoint !== endpoint));
    return { ok: true };
  }

  async handle(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => ({}));
    switch (route) {
      case 'POST /tick': return this.tick();
      case 'GET /api/state': {
        const [settings, state, subs] = await Promise.all([this.settings(), this.state(), this.subs()]);
        return { settings, pending: state.pending, log: state.log, devices: subs.length };
      }
      case 'PUT /api/settings': {
        const settings = sanitizeSettings(body);
        await this.storage.put('settings', settings);
        return { settings };
      }
      case 'POST /api/subscribe': return this.subscribe(body?.subscription);
      case 'POST /api/unsubscribe': return this.unsubscribe(String(body?.endpoint ?? ''));
      case 'POST /api/answer': return this.answer(body?.text);
      case 'POST /api/ask': return this.askNow();
      case 'DELETE /api/log': {
        const state = await this.state();
        state.log = [];
        await this.storage.put('state', state);
        return { ok: true };
      }
      default: return { error: 'Not found', status: 404 };
    }
  }
}
