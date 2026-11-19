// Core client library: templating, API client, state, router, offline storage, drafts, sync queue, UI helpers.
import { qrEncode, qrPath } from './qr.js';

// ------------------------------------------------------------------ templating (auto-escaping)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(s);
const val = (v) => (v == null || v === false ? '' : Array.isArray(v) ? v.map(val).join('') : v instanceof Raw ? v.s : esc(v));
export const html = (st, ...v) => new Raw(st.reduce((a, s, i) => a + s + (i < v.length ? val(v[i]) : ''), ''));
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ------------------------------------------------------------------ state
export const S = {
  user: null, perms: new Set(), camp: null, unread: 0, camps: [], campId: null, medNeeds: [], announcement: '',
  meta: null, nyscLogo: false, installEvt: null, online: navigator.onLine,
};
export const can = (p) => S.perms.has(p);
export const ROLE_HOME = { corps_member: '/app', accommodation_officer: '/admin', medical_personnel: '/med', super_admin: '/super' };

// ------------------------------------------------------------------ formatting
const dtf = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
const df = new Intl.DateTimeFormat('en-NG', { dateStyle: 'medium', timeZone: 'Africa/Lagos' });
export const fmtDT = (iso) => (iso ? dtf.format(new Date(iso)) : '-');
export const fmtD = (iso) => (iso ? df.format(new Date(iso)) : '-');
export const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return fmtD(iso);
};
export const firstName = (n) => String(n || '').replace(/^(Mr|Mrs|Ms|Dr|Prof|Engr|Chief)\.?\s+/i, '').split(' ')[0];
export const num = (n) => Number(n || 0).toLocaleString('en-NG');
export const floorName = (f) => (f === 0 ? 'Ground floor' : `Floor ${f}`);
export const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const NEEDS_FALLBACK = {};
export const needLabel = (k) => (S.meta?.needs?.[k]) || k;

const BADGES = {
  confirmed: ['ok', 'Confirmed'], checked_in: ['ok', 'Checked in'], cancelled: ['bad', 'Cancelled'], released: ['warn', 'Released'],
  submitted: ['info', 'Submitted'], under_review: ['info', 'Under review'], more_info: ['warn', 'More info needed'], approved: ['ok', 'Approved'], rejected: ['bad', 'Not approved'],
  routine: ['muted', 'Routine'], high: ['warn', 'High'], urgent: ['bad', 'Urgent'],
  verified: ['ok', 'Verified'], pending: ['warn', 'Pending verification'], unverified: ['muted', 'Unverified'],
  waiting: ['info', 'Waiting'], fulfilled: ['ok', 'Allocated'],
  open: ['ok', 'Open'], closed: ['bad', 'Closed'], maintenance: ['warn', 'Maintenance'],
};
export const badge = (k, label) => { const [c, l] = BADGES[k] || ['muted', k]; return html`<span class="badge b-${c}">${label || l}</span>`; };

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, data) { super(data?.error || 'Request failed'); this.status = status; this.data = data || {}; this.code = data?.code; }
}
const SCOPED = /^\/(admin|med|hostels|rooms)(\/|$|\?)/;
export async function api(path, { method = 'GET', body, raw: wantRaw = false } = {}) {
  if (S.user?.role === 'super_admin' && S.campId && SCOPED.test(path) && !/[?&]camp_id=/.test(path))
    path += (path.includes('?') ? '&' : '?') + 'camp_id=' + S.campId;
  let res;
  try {
    res = await fetch('/api' + path, {
      method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'campspace', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('You appear to be offline.');
    e.offline = true;
    throw e;
  }
  if (wantRaw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 && S.user) { S.user = null; S.perms = new Set(); go('/login?expired=1'); }
    throw new ApiError(res.status, data);
  }
  return data;
}
export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });

export async function refreshMe() {
  const d = await get('/auth/me');
  if (!d.user) { S.user = null; S.perms = new Set(); return null; }
  S.user = d.user; S.perms = new Set(d.permissions); S.camp = d.camp; S.unread = d.unread; S.camps = d.camps || [];
  S.medNeeds = d.medical_needs || []; S.announcement = d.announcement || '';
  if (S.user.role === 'super_admin') {
    let id = Number(lsGet('cs_camp') || 0);
    if (!S.camps.some((c) => c.id === id)) id = S.camps[0]?.id || null;
    S.campId = id;
  }
  return S.user;
}

// ------------------------------------------------------------------ safe storage
export const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
export const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
export const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* storage unavailable */ } };

// IndexedDB key-value store (falls back to memory when unavailable)
const mem = new Map();
let dbp = null;
const idb = () => (dbp ||= new Promise((res, rej) => {
  try {
    const r = indexedDB.open('campspace-offline', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  } catch (e) { rej(e); }
}));
async function withStore(mode, fn) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction('kv', mode);
    const out = fn(t.objectStore('kv'));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
export const kvSet = async (k, v) => { try { await withStore('readwrite', (s) => s.put(v, k)); } catch { mem.set(k, v); } };
export const kvGet = async (k) => { try { return await withStore('readonly', (s) => s.get(k)); } catch { return mem.get(k); } };
export const kvDel = async (k) => { try { await withStore('readwrite', (s) => s.delete(k)); } catch { mem.delete(k); } };
export async function kvList(prefix) {
  try {
    const d = await idb();
    return await new Promise((res, rej) => {
      const out = [];
      const t = d.transaction('kv', 'readonly');
      const req = t.objectStore('kv').openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
      req.onsuccess = () => { const c = req.result; if (c) { out.push({ key: c.key, value: c.value }); c.continue(); } };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
    });
  } catch {
    return [...mem.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
  }
}
export async function wipeLocalData() {
  try { await withStore('readwrite', (s) => s.clear()); } catch { /* ignore */ }
  mem.clear();
  try { Object.keys(localStorage).filter((k) => k.startsWith('cs_draft:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  try { if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('campspace-data')) await caches.delete(k); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ toasts & modal
export function toast(msg, kind = 'ok') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast t-${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 6500 : 4000);
}

export function openModal(title, body, { wide = false, onMount } = {}) {
  const prev = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">&times;</button></div>
      <div class="modal-body">${body}</div></div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('no-scroll');
  const close = () => { wrap.remove(); if (!$('.modal-wrap')) document.body.classList.remove('no-scroll'); prev?.focus?.(); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap || e.target.closest('[data-close]')) close(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const first = $('input,select,textarea,button:not([data-close])', wrap.querySelector('.modal-body')) || $('[data-close]', wrap);
  first?.focus();
  onMount?.(wrap.querySelector('.modal-body'), close);
  return { el: wrap.querySelector('.modal-body'), close };
}

export function confirmDialog(title, message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = openModal(title, `<p>${esc(message)}</p><div class="btn-row end"><button class="btn ghost" data-no>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-yes>${esc(okLabel)}</button></div>`, {
      onMount: (el, close) => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('[data-yes]')) { done = true; close(); resolve(true); }
          if (e.target.closest('[data-no]')) { close(); resolve(false); }
        });
      },
    });
    const obs = new MutationObserver(() => { if (!document.body.contains(m.el) && !done) { obs.disconnect(); resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

// ------------------------------------------------------------------ forms and drafts
export function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      const group = form.querySelectorAll(`[name="${el.name}"]`);
      if (group.length > 1 || el.dataset.multi !== undefined) { (o[el.name] ||= []); if (el.checked) o[el.name].push(el.value); }
      else o[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type === 'file') continue;
    else o[el.name] = el.value;
  }
  return o;
}

export function submitForm(form, fn, { draft } = {}) {
  const errBox = form.querySelector('.form-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.busy) return;
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector('button[type=submit]');
    form.dataset.busy = '1';
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Please wait...'; }
    if (errBox) errBox.textContent = '';
    try {
      await fn(formData(form), form);
      if (draft) clearDraft(draft);
    } catch (err) {
      const msg = err.offline ? 'You are offline. Your entries are saved on this device. Try again when you are connected.' : err.message || 'Something went wrong.';
      if (errBox) { errBox.textContent = msg; errBox.scrollIntoView({ block: 'nearest' }); } else toast(msg, 'bad');
    } finally {
      delete form.dataset.busy;
      if (btn && document.contains(btn)) { btn.disabled = false; btn.textContent = old; }
    }
  });
}

const DRAFT_TTL = 24 * 3600_000;
const dkey = (k) => `cs_draft:${S.user?.id || 'anon'}:${k}`;
export function clearDraft(k) { lsDel(dkey(k)); }
/** Restore and continuously save a form's fields (never passwords) so nothing is lost if the connection drops. */
export function draftForm(form, key) {
  let saved = null;
  try { saved = JSON.parse(lsGet(dkey(key)) || 'null'); } catch { /* corrupt draft */ }
  if (saved && Date.now() - saved.t < DRAFT_TTL) {
    let restored = false;
    for (const [name, v] of Object.entries(saved.v)) {
      const els = form.querySelectorAll(`[name="${name}"]`);
      els.forEach((el) => {
        if (el.type === 'password' || el.type === 'file') return;
        if (el.type === 'checkbox') el.checked = Array.isArray(v) ? v.includes(el.value) : !!v;
        else if (el.type === 'radio') el.checked = el.value === v;
        else if (v) el.value = v;
        restored = true;
      });
    }
    if (restored) { const n = form.querySelector('.draft-note'); if (n) n.hidden = false; }
  } else lsDel(dkey(key));
  const save = () => {
    const d = formData(form);
    for (const el of form.elements) if (el.type === 'password') delete d[el.name];
    if (Object.values(d).some((v) => (Array.isArray(v) ? v.length : v && v !== false))) lsSet(dkey(key), JSON.stringify({ t: Date.now(), v: d }));
  };
  form.addEventListener('input', save);
  form.addEventListener('change', save);
}

// ------------------------------------------------------------------ misc UI helpers
export function qrSvg(text, { size = 200, label = 'QR code for this ticket' } = {}) {
  const q = qrEncode(text, 'M');
  const p = qrPath(q, 3);
  return raw(`<svg class="qr" role="img" aria-label="${esc(label)}" width="${size}" height="${size}" viewBox="${p.viewBox}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${p.d}" fill="#000"/></svg>`);
}

export function bar(pct, { tone = 'g', label = '' } = {}) {
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  return html`<div class="bar ${tone}" role="progressbar" aria-valuenow="${Math.round(v)}" aria-valuemin="0" aria-valuemax="100" aria-label="${label}"><span style="width:${v}%"></span></div>`;
}

export const empty = (title, text = '', action = '') => html`<div class="empty"><div class="empty-ic" aria-hidden="true">&#9675;</div><h3>${title}</h3>${text ? html`<p>${text}</p>` : ''}${action}</div>`;

export function pager(page, size, total, hrefFn) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) return '';
  return html`<nav class="pager" aria-label="Pagination">
    ${page > 1 ? html`<a class="btn ghost sm" href="${hrefFn(page - 1)}">&larr; Previous</a>` : ''}
    <span>Page ${page} of ${pages} (${num(total)})</span>
    ${page < pages ? html`<a class="btn ghost sm" href="${hrefFn(page + 1)}">Next &rarr;</a>` : ''}</nav>`;
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
export async function downloadApi(path, fallbackName) {
  try {
    const res = await api(path, { raw: true });
    if (!res.ok) { let m = 'Download failed.'; try { m = (await res.json()).error || m; } catch { /* ignore */ } throw new Error(m); }
    const cd = res.headers.get('Content-Disposition') || '';
    downloadBlob(await res.blob(), cd.match(/filename="([^"]+)"/)?.[1] || fallbackName);
  } catch (e) { toast(e.offline ? 'You are offline. Downloads need a connection.' : e.message, 'bad'); }
}

export const newRef = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16));

// ------------------------------------------------------------------ router
const routes = [];
export function route(pattern, access, fn, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ re, keys, access, fn, opts });
}
export const go = (path) => { if (location.hash === '#' + path) window.dispatchEvent(new Event('hashchange')); else location.hash = '#' + path; };
const parseHash = () => {
  const h = location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = h.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q)) };
};
let renderToken = 0;
let layoutFn = null;
let afterRender = null;
export const setLayout = (fn) => { layoutFn = fn; };
export const onAfterRender = (fn) => { afterRender = fn; };
export let current = { path: '/', query: {}, opts: {}, reload: null };

export async function render(keepScroll = false) {
  const token = ++renderToken;
  const { path, query } = parseHash();
  const app = $('#app');
  let match = null;
  for (const r of routes) { const m = r.re.exec(path); if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; } }
  if (!match) return renderNotFound(app);
  const { r, params } = match;
  if (r.access !== 'public') {
    if (!S.user) { return go('/login?next=' + encodeURIComponent(path)); }
    if (S.user.must_change_password && path !== '/app/settings' && S.user.role !== 'corps_member') { /* staff must change temp password */ }
    if (r.access !== 'any' && !r.access.includes(S.user.role)) return go(ROLE_HOME[S.user.role]);
  } else if (r.opts.guestOnly && S.user) return go(ROLE_HOME[S.user.role]);
  current = { path, query, opts: r.opts, reload: () => render(true), params };
  const scroll = keepScroll ? window.scrollY : 0;
  if (!keepScroll) app.innerHTML = layoutFn(r, '<div class="loading" role="status"><span class="spinner"></span> Loading...</div>', path);
  try {
    const page = await r.fn({ params, query, path });
    if (token !== renderToken) return;
    if (!page) return;
    document.title = (page.title ? page.title + ' | ' : '') + 'CampSpace';
    app.innerHTML = layoutFn(r, page.body.toString(), path, page);
    page.mount?.($('#view'));
    afterRender?.(r, path);
    window.scrollTo(0, scroll);
    if (!keepScroll) { const h = $('#view h1'); h?.setAttribute('tabindex', '-1'); }
  } catch (e) {
    if (token !== renderToken) return;
    if (e.offline) {
      app.innerHTML = layoutFn(r, `<div class="card notice warn"><h2>You are offline</h2><p>This page needs a connection. If you downloaded your ticket earlier, open <a href="#/app/accommodation">My Accommodation</a> to view it offline.</p><button class="btn primary" id="retry">Try again</button></div>`, path);
      $('#retry')?.addEventListener('click', () => render());
    } else if (e.status === 403 && e.code === 'MUST_CHANGE_PASSWORD') {
      go('/settings');
    } else {
      app.innerHTML = layoutFn(r, `<div class="card notice bad"><h2>We could not load this page</h2><p>${esc(e.message || 'Unexpected error')}</p><button class="btn primary" id="retry">Try again</button></div>`, path);
      $('#retry')?.addEventListener('click', () => render());
    }
  }
}
function renderNotFound(app) {
  app.innerHTML = layoutFn({ access: 'public', opts: {} }, `<section class="container narrow center"><h1>Page not found</h1><p>The page you are looking for does not exist.</p><a class="btn primary" href="#/">Go to the homepage</a></section>`, '/');
}
export const reload = () => render(true);

// ------------------------------------------------------------------ live updates (server-sent events)
let es = null;
export function connectStream() {
  if (es || !('EventSource' in window) || !S.user) return;
  es = new EventSource('/api/stream');
  es.addEventListener('beds', () => window.dispatchEvent(new Event('cs:beds')));
  es.addEventListener('notify', async () => {
    try { const d = await get('/notifications'); S.unread = d.unread; const b = $('#bell-count'); if (b) { b.textContent = d.unread; b.hidden = !d.unread; } } catch { /* offline */ }
    window.dispatchEvent(new Event('cs:notify'));
  });
}
export function disconnectStream() { es?.close(); es = null; }

// ------------------------------------------------------------------ offline booking queue
let syncing = false;
export async function queuedItems() {
  if (!S.user) return [];
  return (await kvList('queue:')).map((x) => x.value).filter((q) => q.user_id === S.user.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function outcomes() {
  if (!S.user) return [];
  return (await kvList('outcome:')).map((x) => x.value).filter((q) => q.user_id === S.user.id).sort((a, b) => b.at.localeCompare(a.at));
}
export async function dismissOutcome(clientRef) { await kvDel('outcome:' + clientRef); }
export async function queueBooking({ bed_id, label, room_id }) {
  const q = { client_ref: newRef(), user_id: S.user.id, type: 'booking', bed_id, label, room_id, created_at: new Date().toISOString() };
  // One pending request per person: replace any earlier unsent request.
  for (const old of await queuedItems()) await kvDel('queue:' + old.client_ref);
  await kvSet('queue:' + q.client_ref, q);
  registerBackgroundSync();
  return q;
}
export async function cancelQueued(clientRef) { await kvDel('queue:' + clientRef); }
export async function syncQueue() {
  if (syncing || !S.user || !navigator.onLine) return;
  syncing = true;
  let changed = false;
  try {
    for (const q of await queuedItems()) {
      try {
        const r = await post('/bookings', { bed_id: q.bed_id, client_ref: q.client_ref, via: 'offline_sync' });
        await kvDel('queue:' + q.client_ref);
        await kvSet('outcome:' + q.client_ref, { ...q, ok: true, ref: r.booking.ref, at: new Date().toISOString() });
        await kvSet('ticket:' + S.user.id, { ticket: r.booking, saved_at: new Date().toISOString() });
        toast(`Your saved booking request was confirmed: ${q.label}.`, 'ok');
        changed = true;
      } catch (e) {
        if (e.offline || e.status === 401) break;
        await kvDel('queue:' + q.client_ref);
        await kvSet('outcome:' + q.client_ref, { ...q, ok: false, message: e.message, at: new Date().toISOString() });
        toast(`Your saved booking request for ${q.label} could not be confirmed: ${e.message}`, 'bad');
        changed = true;
      }
    }
  } finally { syncing = false; }
  if (changed) { try { await refreshMe(); } catch { /* ignore */ } window.dispatchEvent(new Event('cs:sync')); }
}
function registerBackgroundSync() {
  navigator.serviceWorker?.ready.then((reg) => reg.sync?.register('campspace-sync')).catch(() => {});
}

// ------------------------------------------------------------------ saved tickets for offline viewing
export const saveTicket = (t) => kvSet('ticket:' + S.user.id, { ticket: t, saved_at: new Date().toISOString() });
export const loadSavedTicket = async () => (S.user ? kvGet('ticket:' + S.user.id) : null);
export const forgetTicket = () => (S.user ? kvDel('ticket:' + S.user.id) : null);
export const saveRoomCache = (id, data) => kvSet('room:' + id, { data, saved_at: new Date().toISOString() });
export const loadRoomCache = (id) => kvGet('room:' + id);
export const saveHostelsCache = (d) => kvSet('hostels:' + S.user.id, { data: d, saved_at: new Date().toISOString() });
export const loadHostelsCache = () => kvGet('hostels:' + S.user.id);
