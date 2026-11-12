// Prints a fresh VAPID key pair for Web Push. Run once: `npm run vapid`.
import { b64uEncode } from '../src/webpush.js';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('raw', kp.publicKey);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${b64uEncode(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
