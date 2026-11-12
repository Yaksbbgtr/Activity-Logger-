import { LoggerCore } from './logger.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

async function authorized(request, env) {
  if (!env.APP_KEY) return false;
  const given = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, env.APP_KEY].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const stub = (env) => env.LOGGER.get(env.LOGGER.idFromName('main'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/api/vapid-key') return json({ key: env.VAPID_PUBLIC_KEY || null });
    // Meta calls this directly; the secret part of the path is checked by the Durable Object.
    if (url.pathname.startsWith('/whatsapp/webhook/') && (request.method === 'GET' || request.method === 'POST')) {
      const res = await stub(env).fetch(request);
      if (request.method === 'GET') return res;
      return new Response(null, { status: res.status === 404 ? 404 : 200 });
    }
    if (!url.pathname.startsWith('/api/')) return json({ name: 'activity-logger', ok: true });
    if (!(await authorized(request, env))) return json({ error: 'Wrong or missing app key' }, 401);
    const res = await stub(env).fetch(request);
    return new Response(res.body, { status: res.status, headers: { ...Object.fromEntries(res.headers), ...CORS } });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(stub(env).fetch('https://logger/tick', { method: 'POST' }));
  },
};

/** Durable Object: one instance holds all of the user's data, with consistent reads and writes. */
export class Logger {
  constructor(state, env) {
    this.core = new LoggerCore(state.storage, env);
  }

  async fetch(request) {
    const result = await this.core.handle(request);
    if (result.raw !== undefined) return new Response(String(result.raw), { headers: { 'Content-Type': 'text/plain' } });
    const { status = 200, ...data } = result;
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }
}
