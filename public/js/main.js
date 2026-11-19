// Application bootstrap: service worker, session, router, offline/online handling.
import {
  S, $, api, get, post, refreshMe, render, route, go, setLayout, onAfterRender, connectStream, disconnectStream,
  wipeLocalData, syncQueue, toast, lsGet, lsSet, lsDel, ROLE_HOME, current,
} from './core.js';
import { layout } from './shell.js';
import './pages-public.js';
import './pages-corps.js';
import './pages-admin.js';
import './pages-med.js';
import './pages-super.js';

setLayout(layout);

// ---- minimal identity cache so the app can open offline (wiped on sign-out)
const cacheMe = () => lsSet('cs_me', JSON.stringify({ user: S.user, perms: [...S.perms], camp: S.camp }));
function restoreMe() {
  try {
    const m = JSON.parse(lsGet('cs_me') || 'null');
    if (m?.user) { S.user = m.user; S.perms = new Set(m.perms); S.camp = m.camp; S.offlineSession = true; }
  } catch { /* ignore */ }
}

async function loadSession() {
  try {
    const u = await refreshMe();
    S.offlineSession = false;
    if (u) cacheMe(); else lsDel('cs_me');
  } catch (e) {
    if (e.offline) restoreMe();
  }
}

export async function logout() {
  try { await post('/auth/logout'); } catch { /* offline: cookie will expire */ }
  disconnectStream();
  await wipeLocalData();
  lsDel('cs_me');
  S.user = null; S.perms = new Set(); S.camp = null; S.unread = 0;
  go('/');
}
window.addEventListener('cs:login', async () => { cacheMe(); connectStream(); syncQueue(); });

// ---- banner
function banner() {
  const b = $('#net-banner');
  if (!b) return;
  if (!navigator.onLine) { b.hidden = false; b.className = ''; b.textContent = 'You are offline. Saved tickets and drafts are still available. Changes will sync when you are back online.'; }
  else if (b.dataset.was === 'off') {
    b.hidden = false; b.className = 'back'; b.textContent = 'Back online. Syncing your saved requests...';
    setTimeout(() => { b.hidden = true; }, 3500);
  } else b.hidden = true;
  b.dataset.was = navigator.onLine ? 'on' : 'off';
}
window.addEventListener('offline', () => { S.online = false; banner(); });
window.addEventListener('online', async () => {
  S.online = true; banner();
  if (S.offlineSession) { await loadSession(); render(); }
  await syncQueue();
  connectStream();
});

// ---- delegated UI behaviour
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest('[data-menu]')) {
    const nav = $('.pub-nav'); const open = nav.classList.toggle('open');
    t.closest('[data-menu]').setAttribute('aria-expanded', String(open));
  } else if (t.closest('.pub-nav a')) $('.pub-nav')?.classList.remove('open');
  if (t.closest('[data-drawer]')) $('#portal')?.classList.toggle('drawer-open');
  else if (t.closest('.sidebar a')) $('#portal')?.classList.remove('drawer-open');
  if (t.closest('[data-logout]')) logout();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'camp-switch') { S.campId = Number(e.target.value); lsSet('cs_camp', String(S.campId)); render(); }
});
onAfterRender(() => { $('#portal')?.classList.remove('drawer-open'); });

// ---- install prompt
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; window.dispatchEvent(new Event('cs:installable')); });
window.addEventListener('appinstalled', () => { S.installEvt = null; toast('CampSpace was added to your device.'); });

// ---- service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'sync') syncQueue(); });
  });
}

// ---- start
(async function start() {
  const logoCheck = fetch('/img/nysc-logo.png', { method: 'HEAD' }).then((r) => { S.nyscLogo = r.ok && /image\//.test(r.headers.get('content-type') || ''); }).catch(() => {});
  const metaP = get('/public/meta').then((m) => { S.meta = m; }).catch(() => {
    try { S.meta = JSON.parse(lsGet('cs_meta') || 'null'); } catch { /* ignore */ }
  });
  await Promise.all([logoCheck, metaP, loadSession()]);
  if (S.meta) lsSet('cs_meta', JSON.stringify({ ...S.meta, demo: null }));
  banner();
  window.addEventListener('hashchange', () => render());
  if (S.user && !S.offlineSession) { connectStream(); }
  // installed-app launch goes straight to the portal
  if (!location.hash && S.user) location.hash = '#' + ROLE_HOME[S.user.role];
  await render();
  if (S.user && !S.offlineSession) syncQueue();
  void api; void route; void current;
})();
