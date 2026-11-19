// HTTP application: router, sessions, RBAC, security headers, static files, server-sent events.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import { HttpError } from './util.js';
import { Vault, Limiter, loadMasterKey, parseCookies, sha256hex } from './security.js';
import { audit, now } from './services.js';
import { DEFAULT_CONFIG, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from './constants.js';
import { registerAuth } from './routes/auth.js';
import { registerCorps } from './routes/corps.js';
import { registerAdmin } from './routes/admin.js';
import { registerMed } from './routes/med.js';
import { registerSuper } from './routes/super.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
export const COOKIE = 'cs_sid';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function makeRouter(routes) {
  const add = (method) => (pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  };
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
}

export function createApp({ dataDir, dbFile, demoMode = true, cookieSecure = false, trustProxy = false } = {}) {
  const db = new Db(dbFile || path.join(dataDir, 'campspace.db'));
  const vault = new Vault(loadMasterKey(dataDir), path.join(dataDir, 'vault'));
  const limiter = new Limiter();
  const app = { db, vault, limiter, demoMode, cookieSecure, trustProxy, perms: {} };

  // seed defaults (idempotent)
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) db.run('INSERT OR IGNORE INTO config(key,value,updated_at) VALUES (?,?,?)', k, v, now());
  if (!db.get('SELECT 1 x FROM role_permissions LIMIT 1')) {
    for (const [role, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS))
      for (const p of ps) db.run('INSERT OR IGNORE INTO role_permissions(role,permission) VALUES (?,?)', role, p);
  }
  app.reloadPerms = () => {
    const m = {};
    for (const r of db.all('SELECT role, permission FROM role_permissions')) (m[r.role] ||= new Set()).add(r.permission);
    app.perms = m;
  };
  app.reloadPerms();
  app.can = (user, perm) => !!user && !!app.perms[user.role]?.has(perm);

  const routes = [];
  const r = makeRouter(routes);
  registerAuth(r, app);
  registerCorps(r, app);
  registerAdmin(r, app);
  registerMed(r, app);
  registerSuper(r, app);

  const clientIp = (req) => {
    if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  };

  function sessionUser(req) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok) return null;
    const u = db.get(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha256hex(tok), now());
    if (!u) return null;
    delete u.password_hash;
    u.session_hash = sha256hex(tok);
    return u;
  }

  function readBody(req, limit = 6 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new HttpError(413, 'Request is too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new HttpError(400, 'Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  function sendJson(res, status, obj, extra = {}) {
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  }

  async function handleApi(req, res, url) {
    const ip = clientIp(req);
    if (!limiter.take('api:' + ip, 900, 60_000)) throw new HttpError(429, 'Too many requests. Please slow down.');
    const route = routes.find((rt) => rt.method === req.method && rt.re.test(url.pathname));
    if (!route) {
      if (routes.some((rt) => rt.re.test(url.pathname))) throw new HttpError(405, 'Method not allowed');
      throw new HttpError(404, 'Not found');
    }
    // CSRF: state-changing calls must carry a custom header, which a cross-site form cannot send.
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'campspace') throw new HttpError(403, 'Missing request header');
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET') {
      try { if (new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused'); }
      catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(403, 'Bad origin'); }
    }
    const m = route.re.exec(url.pathname);
    const params = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const user = sessionUser(req);
    const o = route.opts;
    if (o.auth !== false) {
      if (!user) throw new HttpError(401, 'Please sign in to continue');
      if (user.must_change_password && !url.pathname.startsWith('/api/auth/') && url.pathname !== '/api/me')
        throw new HttpError(403, 'You must change your temporary password first', { code: 'MUST_CHANGE_PASSWORD' });
      if (o.perm && !app.can(user, o.perm)) throw new HttpError(403, 'You do not have permission to do that');
    }
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
    const query = Object.fromEntries(url.searchParams);
    const headers = {};
    const actor = { id: user?.id ?? null, role: user?.role ?? null, ip };
    const ctx = {
      app, db, vault, req, res, user, params, query, body, ip, actor, url,
      setHeader: (k, v) => { headers[k] = v; },
      audit: (action, entity, id, detail) => audit(db, actor, action, entity, id, detail),
      HANDLED: Symbol.for('handled'),
    };
    const out = await route.handler(ctx);
    if (out === ctx.HANDLED) return;
    if (out && out.__raw) {
      send(res, out.status || 200, out.body, { 'Cache-Control': 'no-store', ...(out.headers || {}), ...headers });
      return;
    }
    sendJson(res, 200, out ?? { ok: true }, headers);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden');
    let st;
    try { st = fs.statSync(file); } catch { st = null; }
    if (!st || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel === '/sw.js' ? 'no-cache, no-store' : 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) return send(res, 304, null, headers);
    res.writeHead(200, { ...SECURITY_HEADERS, ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (cookieSecure || (trustProxy && req.headers['x-forwarded-proto'] === 'https'))
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else serveStatic(req, res, url);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* socket gone */ } return; }
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
      console.error('Unhandled error:', e);
      sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;

  return {
    app, db, vault, server,
    listen: (port = 0, host = '0.0.0.0') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); }); }),
  };
}

export { PERMISSIONS };
