import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, expected);
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function loadMasterKey(dataDir) {
  const env = process.env.CAMPSPACE_MASTER_KEY;
  if (env) {
    const k = Buffer.from(env, 'base64');
    if (k.length !== 32) throw new Error('CAMPSPACE_MASTER_KEY must be 32 bytes, base64 encoded');
    return k;
  }
  const f = path.join(dataDir, '.master.key');
  if (fs.existsSync(f)) return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
  fs.mkdirSync(dataDir, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(f, k.toString('base64'), { mode: 0o600 });
  return k;
}

/** Field-level / file-level encryption (AES-256-GCM) and QR signing, all derived from one master key. */
export class Vault {
  constructor(masterKey, dir) {
    this.key = crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'campspace-medical-v1', 32);
    this.key = Buffer.from(this.key);
    this.qrKey = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'campspace-qr-v1', 32));
    this.dir = dir;
    if (dir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  encBuf(buf, aad) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(String(aad)));
    const ct = Buffer.concat([c.update(buf), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  decBuf(blob, aad) {
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from(String(aad)));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  }
  enc(obj, aad) {
    return 'v1:' + this.encBuf(Buffer.from(JSON.stringify(obj), 'utf8'), aad).toString('base64url');
  }
  dec(s, aad) {
    if (!s || !s.startsWith('v1:')) return null;
    return JSON.parse(this.decBuf(Buffer.from(s.slice(3), 'base64url'), aad).toString('utf8'));
  }
  saveFile(buf, aad) {
    const name = crypto.randomBytes(16).toString('hex') + '.bin';
    fs.writeFileSync(path.join(this.dir, name), this.encBuf(buf, aad), { mode: 0o600 });
    return name;
  }
  readFile(name, aad) {
    if (!/^[0-9a-f]{32}\.bin$/.test(name)) throw new Error('bad vault file name');
    return this.decBuf(fs.readFileSync(path.join(this.dir, name)), aad);
  }
  /** QR payload signature: proves a ticket code was issued by this server. */
  sign(text) {
    return crypto.createHmac('sha256', this.qrKey).update(text).digest('hex').slice(0, 16);
  }
  qrCode(ref) {
    return `CS1-${ref}-${this.sign(ref)}`;
  }
  parseQr(code) {
    const m = /^CS1-([A-Z2-9]{8})-([0-9a-f]{16})$/.exec(String(code || '').trim());
    if (!m) return null;
    const good = Buffer.from(this.sign(m[1]));
    const given = Buffer.from(m[2]);
    if (good.length !== given.length || !crypto.timingSafeEqual(good, given)) return null;
    return m[1];
  }
}

/** Tiny in-memory sliding-window limiter. */
export class Limiter {
  constructor() { this.hits = new Map(); }
  /** @returns {boolean} true when the call is allowed */
  take(key, max, windowMs) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 20000) this.sweep(windowMs);
    return true;
  }
  reset(key) { this.hits.delete(key); }
  sweep(windowMs) {
    const now = Date.now();
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < windowMs)) this.hits.delete(k);
  }
}
