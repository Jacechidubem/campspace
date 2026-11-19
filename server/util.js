// Small shared helpers: HTTP errors and input validation.
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function str(v, name, { min = 0, max = 500, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text`);
  const s = v.replace(CTRL, '').trim();
  if (!s) {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  if (s.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`);
  if (s.length > max) throw new HttpError(400, `${name} must be at most ${max} characters`);
  return s;
}

export function int(v, name, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number`);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return n;
}

export function oneOf(v, list, name, { required = true } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  if (!list.includes(v)) throw new HttpError(400, `${name} must be one of: ${list.join(', ')}`);
  return v;
}

export function email(v, name = 'Email') {
  const s = str(v, name, { max: 160 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new HttpError(400, `${name} is not a valid email address`);
  return s;
}

export function phone(v, required = false) {
  const s = str(v, 'Phone', { required, max: 20 });
  if (s === null) return null;
  if (!/^\+?[0-9\s-]{7,18}$/.test(s)) throw new HttpError(400, 'Phone number is not valid');
  return s;
}

export function arrayOf(v, allowed, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${name} must be a list`);
  const out = [...new Set(v)];
  for (const x of out) if (!allowed.includes(x)) throw new HttpError(400, `${name} contains an unknown value`);
  return out;
}

export function password(v) {
  if (typeof v !== 'string' || v.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (v.length > 128) throw new HttpError(400, 'Password is too long');
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) throw new HttpError(400, 'Password must contain letters and numbers');
  return v;
}

export const CALL_UP_RE = /^[A-Z]{2}\/\d{2}[A-Z]\/\d{3,6}$/;

export function callUp(v) {
  const s = str(v, 'Call-up number', { max: 20 }).toUpperCase().replace(/\s+/g, '');
  if (!CALL_UP_RE.test(s)) throw new HttpError(400, 'Call-up number format looks like AB/26C/1234');
  return s;
}

export const sha256 = (s) => crypto_sha256(s);
import crypto from 'node:crypto';
function crypto_sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n') + '\r\n';
}
