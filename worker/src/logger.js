// Core state and API for one user. Wrapped by a Durable Object in index.js;
// `storage` only needs get(key) and put(key, value), so tests can pass a Map.

import { DEFAULT_SETTINGS, GRACE_MINUTES, currentSlot, sanitizeSettings } from './schedule.js';
import { sendPush } from './webpush.js';
import { QUESTION, Telegram, looksLikeToken, randomToken } from './telegram.js';

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
  async telegram() { return (await this.storage.get('telegram')) ?? null; }
  bot(tg) { return new Telegram(tg.token, this.fetchImpl); }

  /** What the app may see about Telegram (never the token). */
  telegramInfo(tg) {
    if (!tg) return { configured: false };
    return {
      configured: true,
      username: tg.username,
      linked: Boolean(tg.chatId),
      alsoPush: Boolean(tg.alsoPush),
      linkUrl: tg.chatId ? null : `https://t.me/${tg.username}?start=${tg.linkCode}`,
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
    const tg = await this.telegram();
    const viaTelegram = Boolean(tg?.chatId);
    const [telegram, push] = await Promise.all([
      viaTelegram ? this.bot(tg).send(tg.chatId, QUESTION).then(() => true, () => false) : false,
      !viaTelegram || tg.alsoPush ? this.pushAll(at) : { sent: 0 },
    ]);
    return { ...push, telegram };
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

  // ---- Telegram --------------------------------------------------------

  async setupTelegram(token, origin) {
    token = String(token ?? '').trim();
    if (!looksLikeToken(token)) return { error: 'That doesn’t look like a bot token. It should look like 123456789:AA…', status: 400 };
    const bot = new Telegram(token, this.fetchImpl);
    let me;
    try { me = await bot.getMe(); }
    catch (err) {
      if (err.code === 401 || err.code === 404) return { error: 'Telegram says this token isn’t valid. Copy it again from BotFather, or send /token there to get a fresh one.', status: 400 };
      return { error: err.code ? `Telegram error: ${err.message}` : `Couldn’t reach Telegram: ${err.message}`, status: 502 };
    }
    const old = await this.telegram();
    const tg = { token, username: me.username, secret: randomToken(), linkCode: randomToken(9), chatId: null, alsoPush: old?.alsoPush ?? false };
    try { await bot.setWebhook(`${origin}/telegram/webhook`, tg.secret); }
    catch (err) { return { error: 'Couldn’t connect the bot: ' + err.message, status: 502 }; }
    await this.storage.put('telegram', tg);
    return { telegram: this.telegramInfo(tg) };
  }

  async updateTelegram(body) {
    const tg = await this.telegram();
    if (!tg) return { error: 'Telegram isn’t set up', status: 404 };
    if (typeof body?.alsoPush === 'boolean') tg.alsoPush = body.alsoPush;
    await this.storage.put('telegram', tg);
    return { telegram: this.telegramInfo(tg) };
  }

  async removeTelegram() {
    const tg = await this.telegram();
    if (tg) {
      if (tg.chatId) await this.bot(tg).send(tg.chatId, 'Disconnected from Activity Logger.').catch(() => {});
      await this.bot(tg).deleteWebhook().catch(() => {});
      await this.storage.put('telegram', null);
    }
    return { telegram: this.telegramInfo(null) };
  }

  /** Messages sent to the bot. Replies are logged as answers. */
  async telegramWebhook(request, update) {
    const tg = await this.telegram();
    if (!tg || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== tg.secret) return { error: 'Forbidden', status: 403 };
    const msg = update?.message;
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    const chatId = msg?.chat?.id;
    if (!msg || !chatId || msg.chat.type !== 'private') return { ok: true };
    const bot = this.bot(tg);

    if (!tg.chatId) {
      // Only someone holding the link from the app can connect.
      const code = /^\/start\s+(\S+)$/.exec(text)?.[1];
      if (code && code === tg.linkCode) {
        tg.chatId = chatId;
        tg.linkCode = null;
        await this.storage.put('telegram', tg);
        await bot.send(chatId, 'Connected. I’ll ask what you’re doing at your scheduled times. Reply to log it: from the notification, pull it down and type.').catch(() => {});
      }
      return { ok: true };
    }
    if (chatId !== tg.chatId) return { ok: true }; // a stranger found the bot: ignore

    if (text === '/stop') { await this.removeTelegram(); return { ok: true }; }
    if (text.startsWith('/')) {
      await bot.send(chatId, 'Just reply with what you’re doing and I’ll log it. Send /stop to disconnect.').catch(() => {});
      return { ok: true };
    }
    if (!text) {
      await bot.send(chatId, 'I can only log text replies.').catch(() => {});
      return { ok: true };
    }
    const result = await this.answer(text);
    if (result.ok) await bot.react(chatId, msg.message_id).catch(() => bot.send(chatId, 'Logged ✓').catch(() => {}));
    return { ok: true };
  }

  async handle(request) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => ({}));
    switch (route) {
      case 'POST /tick': return this.tick();
      case 'GET /api/state': {
        const [settings, state, subs, tg] = await Promise.all([this.settings(), this.state(), this.subs(), this.telegram()]);
        return { settings, pending: state.pending, log: state.log, devices: subs.length, telegram: this.telegramInfo(tg) };
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
      case 'POST /api/telegram': return this.setupTelegram(body?.token, url.origin);
      case 'PUT /api/telegram': return this.updateTelegram(body);
      case 'DELETE /api/telegram': return this.removeTelegram();
      case 'POST /telegram/webhook': return this.telegramWebhook(request, body);
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
