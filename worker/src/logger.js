// Core state and API for one user. Wrapped by a Durable Object in index.js;
// `storage` only needs get(key) and put(key, value), so tests can pass a Map.

import { DEFAULT_SETTINGS, GRACE_MINUTES, currentSlot, sanitizeSettings } from './schedule.js';
import { sendPush } from './webpush.js';
import { QUESTION, randomToken } from './util.js';
import { TEMPLATE, WINDOW_MS, WhatsApp, incomingMessages } from './whatsapp.js';

const MAX_LOG = 20000;
const MAX_SUBS = 10;
const MAX_ANSWER = 2000;

export class LoggerCore {
  constructor(storage, env, { fetchImpl = (...args) => fetch(...args), clock = () => new Date() } = {}) {
    this.storage = storage;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.clock = clock;
  }

  async settings() { return (await this.storage.get('settings')) ?? DEFAULT_SETTINGS; }
  async state() { return (await this.storage.get('state')) ?? { pending: null, lastSlot: null, log: [] }; }
  async subs() { return (await this.storage.get('subs')) ?? []; }
  async whatsapp() { return (await this.storage.get('whatsapp')) ?? null; }
  wa(w) { return new WhatsApp(w, this.fetchImpl); }

  /** What the app may see about WhatsApp (never the access token). */
  whatsappInfo(w) {
    if (!w) return { configured: false };
    const digits = String(w.displayNumber || '').replace(/\D/g, '');
    return {
      configured: true,
      displayNumber: w.displayNumber,
      verifiedName: w.verifiedName,
      linked: Boolean(w.waId),
      alsoPush: Boolean(w.alsoPush),
      webhookUrl: `${w.origin}/whatsapp/webhook/${w.pathSecret}`,
      verifyToken: w.verifyToken,
      webhookVerified: Boolean(w.webhookVerified),
      template: w.wabaId ? (w.templateStatus || 'UNKNOWN') : null,
      linkUrl: w.waId ? null : `https://wa.me/${digits}?text=${encodeURIComponent('connect ' + w.linkCode)}`,
    };
  }

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
    const now = this.clock().toISOString();
    // With no open question, the entry is logged on its own (asked = answered = now).
    this.addLog(state, { asked: state.pending?.asked ?? now, answered: now, response: text, status: 'answered' });
    state.pending = null;
    await this.storage.put('state', state);
    return { ok: true };
  }

  async notifyAll(at) {
    const w = await this.whatsapp();
    const waOn = Boolean(w?.waId);
    // App notifications go out when WhatsApp isn't connected, or when asked for as well.
    const [whatsapp, push] = await Promise.all([
      waOn ? this.askWhatsApp(w).then(() => true, () => false) : false,
      !waOn || w.alsoPush ? this.pushAll(at) : { sent: 0 },
    ]);
    return { ...push, whatsapp };
  }

  async askWhatsApp(w) {
    const api = this.wa(w);
    if (w.lastInbound && this.clock().getTime() - w.lastInbound < WINDOW_MS) return api.text(w.waId, QUESTION);
    // Outside WhatsApp's 24-hour window only a pre-approved template may be sent.
    let status = w.templateStatus;
    if (w.wabaId && status !== 'APPROVED') {
      status = await api.templateStatus().catch(() => status);
      const fresh = await this.whatsapp();
      if (fresh) { fresh.templateStatus = status; await this.storage.put('whatsapp', fresh); }
    }
    return api.template(w.waId, status === 'APPROVED' ? TEMPLATE : 'hello_world');
  }

  async pushAll(at) {
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

  // ---- WhatsApp --------------------------------------------------------

  async setupWhatsApp(body, origin) {
    const token = String(body?.token ?? '').trim();
    const phoneNumberId = String(body?.phoneNumberId ?? '').trim();
    const wabaId = String(body?.wabaId ?? '').trim();
    if (!/^\d{6,}$/.test(phoneNumberId)) return { error: 'The phone number ID is a long number shown under your test number in Meta’s API Setup page.', status: 400 };
    if (wabaId && !/^\d{6,}$/.test(wabaId)) return { error: 'The WhatsApp Business Account ID is a long number shown in Meta’s API Setup page.', status: 400 };
    if (token.length < 40 || /\s/.test(token)) return { error: 'Paste the whole access token. It’s a long string with no spaces.', status: 400 };
    const api = new WhatsApp({ token, phoneNumberId, wabaId }, this.fetchImpl);
    let info;
    try { info = await api.phoneInfo(); }
    catch (err) {
      if (err.code === 190 || err.status === 401) return { error: 'Meta says this access token isn’t valid or has expired. Make a permanent token (step 3).', status: 400 };
      if (err.code === 100 || err.status === 404 || err.status === 400) return { error: 'Meta couldn’t find that phone number ID with this token. Check both, and that the token has WhatsApp permissions.', status: 400 };
      return { error: err.status ? `Meta error: ${err.message}` : `Couldn’t reach Meta: ${err.message}`, status: 502 };
    }
    let templateStatus = null;
    if (wabaId) {
      await api.createTemplate().catch(() => {}); // fine if it already exists
      templateStatus = await api.templateStatus().catch(() => null);
    }
    const old = await this.whatsapp();
    const same = old && old.phoneNumberId === phoneNumberId;
    const w = {
      token, phoneNumberId, wabaId: wabaId || null, origin,
      displayNumber: info.display_phone_number, verifiedName: info.verified_name,
      pathSecret: old?.pathSecret ?? randomToken(), verifyToken: old?.verifyToken ?? randomToken(12),
      webhookVerified: old?.webhookVerified ?? false,
      linkCode: randomToken(6), waId: same ? old.waId : null, lastInbound: same ? old.lastInbound : null,
      alsoPush: old?.alsoPush ?? false, templateStatus,
    };
    await this.storage.put('whatsapp', w);
    return { whatsapp: this.whatsappInfo(w) };
  }

  async updateWhatsApp(body) {
    const w = await this.whatsapp();
    if (!w) return { error: 'WhatsApp isn’t set up', status: 404 };
    if (typeof body?.alsoPush === 'boolean') w.alsoPush = body.alsoPush;
    await this.storage.put('whatsapp', w);
    return { whatsapp: this.whatsappInfo(w) };
  }

  async removeWhatsApp() {
    await this.storage.put('whatsapp', null);
    return { whatsapp: this.whatsappInfo(null) };
  }

  /** Meta's webhook: GET verifies the URL, POST delivers messages. */
  async whatsappWebhook(request, url, payload) {
    const w = await this.whatsapp();
    if (!w || url.pathname !== `/whatsapp/webhook/${w.pathSecret}`) return { error: 'Not found', status: 404 };
    if (request.method === 'GET') {
      const q = url.searchParams;
      if (q.get('hub.mode') !== 'subscribe' || q.get('hub.verify_token') !== w.verifyToken) return { error: 'Forbidden', status: 403 };
      w.webhookVerified = true;
      await this.storage.put('whatsapp', w);
      return { raw: q.get('hub.challenge') ?? '' };
    }
    const api = this.wa(w);
    for (const m of incomingMessages(payload, w.phoneNumberId)) {
      const text = m.type === 'text' ? String(m.text?.body ?? '').trim() : '';
      if (!w.waId) {
        const code = /^connect\s+(\S+)$/i.exec(text)?.[1];
        if (code && code === w.linkCode) {
          Object.assign(w, { waId: m.from, linkCode: null, lastInbound: this.clock().getTime(), webhookVerified: true });
          await this.storage.put('whatsapp', w);
          await api.text(m.from, 'Connected. I’ll ask what you’re doing at your scheduled times. Reply to log it: press and hold the notification and type.').catch(() => {});
        }
        continue;
      }
      if (m.from !== w.waId) continue; // not the connected person
      w.lastInbound = this.clock().getTime(); // keeps WhatsApp's 24-hour reply window open
      await this.storage.put('whatsapp', w);
      if (/^stop$/i.test(text)) {
        Object.assign(w, { waId: null, linkCode: randomToken(6) });
        await this.storage.put('whatsapp', w);
        await api.text(m.from, 'Disconnected from Activity Logger.').catch(() => {});
        continue;
      }
      if (!text) { await api.text(m.from, 'I can only log text replies.').catch(() => {}); continue; }
      const result = await this.answer(text);
      if (result.ok) await api.react(m.from, m.id).catch(() => {});
    }
    return { ok: true };
  }

  async handle(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/whatsapp/webhook/')) {
      const payload = request.method === 'POST' ? await request.json().catch(() => ({})) : null;
      return this.whatsappWebhook(request, url, payload);
    }
    const route = `${request.method} ${url.pathname}`;
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => ({}));
    switch (route) {
      case 'POST /tick': return this.tick();
      case 'GET /api/state': {
        const [settings, state, subs, w] = await Promise.all([this.settings(), this.state(), this.subs(), this.whatsapp()]);
        return { settings, pending: state.pending, log: state.log, devices: subs.length, whatsapp: this.whatsappInfo(w) };
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
      case 'POST /api/whatsapp': return this.setupWhatsApp(body, url.origin);
      case 'PUT /api/whatsapp': return this.updateWhatsApp(body);
      case 'DELETE /api/whatsapp': return this.removeWhatsApp();
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
