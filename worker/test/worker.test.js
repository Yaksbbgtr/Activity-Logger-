import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';
import ece from 'http_ece';
import { encryptPayload, vapidAuthorization, b64uEncode, b64uDecode } from '../src/webpush.js';
import { currentSlot, sanitizeSettings } from '../src/schedule.js';
import { LoggerCore } from '../src/logger.js';

// A fake browser: a P-256 key pair and auth secret, like a real PushSubscription.
function fakeBrowser(endpoint = 'https://push.example.com/send/abc') {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: { endpoint, keys: { p256dh: b64uEncode(ecdh.getPublicKey()), auth: b64uEncode(auth) } },
    decrypt: (body) => ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString(),
  };
}

// Behaves like Durable Object storage: values are copied in and out.
function memoryStorage() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined),
    put: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

async function vapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: b64uEncode(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateKey: (await crypto.subtle.exportKey('jwk', kp.privateKey)).d,
    subject: 'https://example.com',
    verifyKey: kp.publicKey,
  };
}

test('payload encryption decrypts with an independent aes128gcm implementation', async () => {
  const b = fakeBrowser();
  const body = await encryptPayload(new TextEncoder().encode('{"hello":"world"}'), b.subscription.keys.p256dh, b.subscription.keys.auth);
  assert.equal(b.decrypt(body), '{"hello":"world"}');
});

test('VAPID header carries a valid ES256 JWT for the push origin', async () => {
  const keys = await vapidKeys();
  const header = await vapidAuthorization('https://push.example.com/send/abc', keys, Date.UTC(2026, 0, 1));
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, s] = jwt.split('.');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, keys.verifyKey, b64uDecode(s), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
  const claims = JSON.parse(new TextDecoder().decode(b64uDecode(c)));
  assert.equal(claims.aud, 'https://push.example.com');
  assert.equal(claims.sub, 'https://example.com');
});

test('slots follow the interval from the window start, in the user time zone', () => {
  const s = sanitizeSettings({ interval: 10, timezone: 'America/New_York', windows: [{ start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }] });
  // Monday 2026-11-16 09:10 in New York is 14:10 UTC.
  assert.deepEqual(currentSlot(s, new Date('2026-11-16T14:10:30Z')).key, '2026-11-16T09:10');
  assert.equal(currentSlot(s, new Date('2026-11-16T14:13:00Z')).late, 3);
  assert.equal(currentSlot(s, new Date('2026-11-16T13:59:00Z')), null); // 08:59
  assert.equal(currentSlot(s, new Date('2026-11-16T22:01:00Z')), null); // 17:01
  assert.equal(currentSlot(s, new Date('2026-11-15T14:10:00Z')), null); // Sunday
  assert.equal(currentSlot(s, new Date('2026-11-16T22:00:00Z')).key, '2026-11-16T17:00');
});

test('settings are cleaned up', () => {
  const s = sanitizeSettings({ interval: '0', timezone: 'Not/AZone', windows: [{ start: 'x', end: '10:00', days: [1] }, { start: '08:00', end: '09:00', days: [9, 1, 1, '2'] }] });
  assert.equal(s.interval, 10); // invalid falls back to the default
  assert.equal(s.timezone, 'UTC');
  assert.deepEqual(s.windows, [{ start: '08:00', end: '09:00', days: [1, 2] }]);
});

test('full flow: reminder, answer, missed prompt, dead subscription pruned', async () => {
  const keys = await vapidKeys();
  const browser = fakeBrowser('https://push.example.com/live');
  const pushes = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/dead')) return new Response('', { status: 410 });
    pushes.push(JSON.parse(browser.decrypt(init.body)));
    return new Response('', { status: 201 });
  };
  let now = new Date('2026-11-16T09:09:30Z'); // Monday, UTC
  const core = new LoggerCore(memoryStorage(), { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }, { fetchImpl, clock: () => now });
  const call = (method, path, body) => core.handle(new Request(`https://x${path}`, { method, body: body && JSON.stringify(body) }));

  await call('PUT', '/api/settings', { interval: 10, timezone: 'UTC', windows: [{ start: '09:00', end: '17:00', days: [1] }] });
  await call('POST', '/api/subscribe', { subscription: browser.subscription });
  await call('POST', '/api/subscribe', { subscription: { ...fakeBrowser().subscription, endpoint: 'https://push.example.com/dead' } });
  assert.equal((await call('GET', '/api/state')).devices, 2);

  assert.deepEqual(await call('POST', '/tick'), { sent: 0 }); // 09:09, nothing due
  now = new Date('2026-11-16T09:10:20Z');
  const r = await call('POST', '/tick');
  assert.equal(r.sent, 1);
  assert.equal(pushes[0].asked, '2026-11-16T09:10:00.000Z');
  assert.equal((await call('GET', '/api/state')).devices, 1, 'dead subscription removed');
  assert.deepEqual(await call('POST', '/tick'), { sent: 0 }, 'same slot not sent twice');

  now = new Date('2026-11-16T09:12:00Z');
  assert.deepEqual(await call('POST', '/api/answer', { text: '  writing code ' }), { ok: true });
  now = new Date('2026-11-16T09:15:00Z');
  assert.deepEqual(await call('POST', '/api/answer', { text: 'coffee' }), { ok: true }, 'logging without a question');

  now = new Date('2026-11-16T09:20:00Z'); await call('POST', '/tick'); // left unanswered
  now = new Date('2026-11-16T09:30:00Z'); await call('POST', '/tick');
  const st = await call('GET', '/api/state');
  assert.deepEqual(st.log.map((e) => [e.asked.slice(11, 16), e.status, e.response]), [
    ['09:10', 'answered', 'writing code'],
    ['09:15', 'answered', 'coffee'],
    ['09:20', 'missed', ''],
  ]);
  assert.equal(st.pending.asked, '2026-11-16T09:30:00.000Z');
  assert.equal(pushes.length, 3);

  // A slot noticed too late (e.g. the worker was down) is skipped rather than sent late.
  now = new Date('2026-11-16T09:45:00Z');
  assert.deepEqual(await call('POST', '/tick'), { sent: 0 });
  assert.equal(pushes.length, 3);
});

test('WhatsApp: setup, webhook verify, link, template vs text, replies, stop', async () => {
  const calls = [];
  const TOKEN = 'EAAG' + 'x'.repeat(60);
  const fetchImpl = async (url, init = {}) => {
    if (!url.startsWith('https://graph.facebook.com/')) return new Response('', { status: 201 });
    const path = url.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path, body });
    if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return Response.json({ error: { code: 190, message: 'Invalid OAuth access token' } }, { status: 401 });
    if (path.startsWith('5550001?fields')) return Response.json({ display_phone_number: '+1 555-010-0199', verified_name: 'Test Number' });
    if (path.startsWith('9990001/message_templates?')) return Response.json({ data: [{ name: 'activity_check', status: 'PENDING' }] });
    return Response.json({ messages: [{ id: 'wamid.out' }] });
  };
  let now = new Date('2026-11-16T09:10:00Z');
  const core = new LoggerCore(memoryStorage(), {}, { fetchImpl, clock: () => now });
  const call = (method, path, body, headers = {}) =>
    core.handle(new Request(`https://logger.example.dev${path}`, { method, headers, body: body && JSON.stringify(body) }));

  assert.match((await call('POST', '/api/whatsapp', { phoneNumberId: 'abc', token: TOKEN })).error, /phone number ID/);
  assert.match((await call('POST', '/api/whatsapp', { phoneNumberId: '5550001', token: 'EAAG' + 'y'.repeat(60) })).error, /isn’t valid/);
  const { whatsapp: info } = await call('POST', '/api/whatsapp', { phoneNumberId: '5550001', wabaId: '9990001', token: TOKEN });
  assert.equal(info.displayNumber, '+1 555-010-0199');
  assert.equal(info.template, 'PENDING');
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '9990001/message_templates' && c.body.name === 'activity_check'));
  assert.equal(JSON.stringify(await call('GET', '/api/state')).includes(TOKEN), false, 'token never leaves the server');
  const hookPath = new URL(info.webhookUrl).pathname;
  const code = decodeURIComponent(new URL(info.linkUrl).searchParams.get('text')).replace('connect ', '');
  assert.equal(new URL(info.linkUrl).pathname, '/15550100199');

  // Webhook verification (Meta's GET handshake)
  assert.equal((await call('GET', `${hookPath}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123`)).status, 403);
  assert.equal((await call('GET', `/whatsapp/webhook/guess?hub.mode=subscribe&hub.verify_token=${info.verifyToken}&hub.challenge=123`)).status, 404);
  assert.deepEqual(await call('GET', `${hookPath}?hub.mode=subscribe&hub.verify_token=${info.verifyToken}&hub.challenge=123`), { raw: '123' });
  assert.equal((await call('GET', '/api/state')).whatsapp.webhookVerified, true);

  const inbound = (from, text, id = 'wamid.in') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: '5550001' }, messages: [{ from, id, type: 'text', text: { body: text } }] } }] }] });
  await call('POST', hookPath, inbound('15559990000', 'connect wrong'));
  assert.equal((await call('GET', '/api/state')).whatsapp.linked, false);
  await call('POST', hookPath, inbound('15551234567', `connect ${code}`));
  assert.equal((await call('GET', '/api/state')).whatsapp.linked, true);

  // Inside the 24-hour window: plain text question.
  calls.length = 0;
  assert.equal((await call('POST', '/api/ask')).whatsapp, true);
  const sent = calls.filter((c) => c.path === '5550001/messages');
  assert.deepEqual(sent.map((c) => [c.body.to, c.body.type, c.body.text?.body]), [['15551234567', 'text', 'What are you doing right now?']]);

  // Reply is logged and gets a reaction; strangers are ignored.
  now = new Date('2026-11-16T09:12:00Z');
  await call('POST', hookPath, inbound('15559990000', 'stranger'));
  await call('POST', hookPath, inbound('15551234567', 'Writing a report', 'wamid.reply'));
  assert.deepEqual((await call('GET', '/api/state')).log.map((e) => e.response), ['Writing a report']);
  assert.ok(calls.some((c) => c.body?.type === 'reaction' && c.body.reaction.message_id === 'wamid.reply'));

  // Next day, window closed, template still pending -> hello_world template.
  now = new Date('2026-11-17T13:00:00Z');
  calls.length = 0;
  await call('POST', '/api/ask');
  const t = calls.find((c) => c.path === '5550001/messages').body;
  assert.equal(t.type, 'template');
  assert.equal(t.template.name, 'hello_world');

  // "stop" unlinks.
  await call('POST', hookPath, inbound('15551234567', 'STOP'));
  assert.equal((await call('GET', '/api/state')).whatsapp.linked, false);
});

test('deleting one log entry', async () => {
  let now = new Date('2026-11-16T09:00:00Z');
  const core = new LoggerCore(memoryStorage(), {}, { clock: () => now });
  const call = (method, path, body) => core.handle(new Request(`https://x${path}`, { method, body: body && JSON.stringify(body) }));
  for (const t of ['one', 'two', 'three']) { await call('POST', '/api/answer', { text: t }); now = new Date(now.getTime() + 60000); }
  const [, two] = (await call('GET', '/api/state')).log;
  assert.deepEqual(await call('POST', '/api/log/delete', two), { ok: true });
  assert.deepEqual((await call('GET', '/api/state')).log.map((e) => e.response), ['one', 'three']);
  assert.equal((await call('POST', '/api/log/delete', two)).status, 404);

  // Editing
  const [one] = (await call('GET', '/api/state')).log;
  const { entry } = await call('POST', '/api/log/edit', { entry: one, text: '  one, edited ' });
  assert.equal(entry.response, 'one, edited');
  assert.ok(entry.edited);
  assert.equal((await call('POST', '/api/log/edit', { entry: one, text: 'stale' })).status, 404, 'old copy no longer matches');
  assert.equal((await call('POST', '/api/log/edit', { entry, text: '   ' })).status, 400);

  // A missed entry becomes answered once filled in.
  await call('POST', '/api/ask'); await call('POST', '/api/ask');
  const missed = (await call('GET', '/api/state')).log.find((e) => e.status === 'missed');
  const filled = (await call('POST', '/api/log/edit', { entry: missed, text: 'Lunch' })).entry;
  assert.deepEqual([filled.status, filled.response, filled.answered], ['answered', 'Lunch', null]);
});

test('editing and deleting several entries at once', async () => {
  let now = new Date('2026-11-16T14:00:00Z');
  const core = new LoggerCore(memoryStorage(), {}, { clock: () => now });
  const call = (method, path, body) => core.handle(new Request(`https://x${path}`, { method, body: body && JSON.stringify(body) }));
  for (let i = 0; i < 5; i++) { await call('POST', '/api/ask'); now = new Date(now.getTime() + 600000); }
  await call('POST', '/api/answer', { text: 'Back at desk' });
  const log = (await call('GET', '/api/state')).log; // 4 missed (14:00-14:30) + 1 answered (14:40)
  assert.equal(log.filter((e) => e.status === 'missed').length, 4);
  const span = log.slice(0, 3);
  const r = await call('POST', '/api/log/edit-many', { entries: span, text: ' Team meeting ' });
  assert.deepEqual([r.changed, r.missing], [3, 0]);
  assert.deepEqual(r.log.map((e) => [e.asked.slice(11, 16), e.status, e.response]), [
    ['14:00', 'answered', 'Team meeting'], ['14:10', 'answered', 'Team meeting'], ['14:20', 'answered', 'Team meeting'],
    ['14:30', 'missed', ''], ['14:40', 'answered', 'Back at desk'],
  ]);
  // Stale copies don't match; empty text is refused.
  assert.equal((await call('POST', '/api/log/edit-many', { entries: span, text: 'x' })).changed, 0);
  assert.equal((await call('POST', '/api/log/edit-many', { entries: r.log.slice(0, 1), text: '  ' })).status, 400);
  const d = await call('POST', '/api/log/delete-many', { entries: r.log.slice(1, 4) });
  assert.deepEqual(d.log.map((e) => e.asked.slice(11, 16)), ['14:00', '14:40']);
});
