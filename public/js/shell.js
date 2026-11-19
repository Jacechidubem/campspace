// Layouts (public site and the four portals), navigation, branding.
import { S, html, raw, esc, can, ROLE_HOME } from './core.js';

export const TAGLINE = 'Your Camp. Your Space. Your Comfort.';

export function logoSvg(size = 42) {
  return raw(`<svg viewBox="0 0 512 512" width="${size}" height="${size}" aria-hidden="true" focusable="false">
    <rect width="512" height="512" rx="112" fill="#0b6a3e"/>
    <path d="M96 232 256 108l160 124" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="120" y="262" width="272" height="26" rx="8" fill="#fff"/><rect x="120" y="346" width="272" height="26" rx="8" fill="#fff"/>
    <rect x="120" y="262" width="26" height="130" rx="8" fill="#fff"/><rect x="366" y="262" width="26" height="130" rx="8" fill="#fff"/>
    <rect x="164" y="232" width="74" height="30" rx="14" fill="#a9e3c2"/><rect x="164" y="316" width="74" height="30" rx="14" fill="#a9e3c2"/></svg>`);
}

/** The official NYSC logo is shown only when an authorised file exists at /img/nysc-logo.png. Until then a clearly labelled slot is shown. */
export function nyscLogo(cls = '') {
  return S.nyscLogo
    ? html`<img class="nysc-logo ${cls}" src="/img/nysc-logo.png" alt="National Youth Service Corps (NYSC) logo">`
    : html`<span class="nysc-slot ${cls}" role="img" aria-label="Official NYSC logo placeholder">NYSC logo<br>pending<br>authorisation</span>`;
}

export const brand = (href = '#/') => html`<a class="brand" href="${href}" aria-label="CampSpace home">${logoSvg()}<span><b>CampSpace</b><small>${TAGLINE}</small></span></a>`;

// ------------------------------------------------------------------ navigation per role
const NAV = {
  corps_member: [
    { g: 'My camp', items: [
      ['/app', 'Dashboard', '&#8962;'], ['/app/book', 'Hostel Booking', '&#9636;'], ['/app/bunks', 'Bunk Selection', '&#9638;'],
      ['/app/accommodation', 'My Accommodation', '&#9635;'], ['/app/medical', 'Medical Support', '&#10010;'], ['/app/history', 'Booking History', '&#9776;'],
      ['/app/notifications', 'Notifications', '&#9993;', 'unread'], ['/app/settings', 'Profile Settings', '&#9881;'],
    ] },
  ],
  accommodation: [
    { g: 'Accommodation', items: [
      ['/admin', 'Dashboard', '&#8962;'], ['/admin/hostels', 'Hostel Management', '&#9636;', null, 'hostels.view'], ['/admin/rooms', 'Room Management', '&#9638;', null, 'hostels.view'],
      ['/admin/bunks', 'Bunk Management', '&#9635;', null, 'hostels.view'], ['/admin/bookings', 'Booking Management', '&#9776;', null, 'bookings.view'],
      ['/admin/checkin', 'Check-in Management', '&#10003;', null, 'checkin.manage'], ['/admin/medical', 'Medical Instructions', '&#10010;', null, 'medical.instructions'],
      ['/admin/reports', 'Reports and Analytics', '&#9783;', null, 'reports.camp'],
    ] },
  ],
  medical: [
    { g: 'Medical team', items: [
      ['/med', 'Dashboard', '&#8962;'], ['/med/requests', 'Incoming Requests', '&#9993;'], ['/med/profiles', 'Medical Profiles', '&#9786;'],
      ['/med/assess', 'Medical Assessment', '&#10010;'], ['/med/priority', 'Priority Tagging', '&#9873;'], ['/med/recommend', 'Recommendations', '&#9635;'], ['/med/history', 'Request History', '&#9776;'],
    ] },
  ],
  system: [
    { g: 'System', items: [
      ['/super', 'System Dashboard', '&#8962;'], ['/super/camps', 'Camp Management', '&#9636;'], ['/super/users', 'User Management', '&#9786;'], ['/super/roles', 'Role Management', '&#9873;'],
      ['/super/config', 'System Configuration', '&#9881;'], ['/super/reports', 'Reports', '&#9783;'], ['/super/audit', 'Audit Logs', '&#9776;'],
    ] },
  ],
};
const BOTTOM = {
  corps_member: ['/app', '/app/bunks', '/app/accommodation', '/app/medical', '/app/notifications'],
  accommodation_officer: ['/admin', '/admin/bookings', '/admin/checkin', '/admin/medical', '/admin/reports'],
  medical_personnel: ['/med', '/med/requests', '/med/assess', '/med/priority', '/med/history'],
  super_admin: ['/super', '/super/camps', '/super/users', '/super/roles', '/super/audit'],
};
const SHORT = { '/app/accommodation': 'Ticket', '/app/bunks': 'Bunks', '/app/notifications': 'Alerts', '/app/medical': 'Medical', '/admin/bookings': 'Bookings', '/admin/checkin': 'Check-in', '/admin/medical': 'Medical', '/admin/reports': 'Reports', '/med/requests': 'Requests', '/med/assess': 'Assess', '/med/priority': 'Priority', '/med/history': 'History', '/super/camps': 'Camps', '/super/users': 'Users', '/super/roles': 'Roles', '/super/audit': 'Audit' };

export function navFor(role) {
  const groups = [];
  const add = (key) => groups.push(...NAV[key].map((g) => ({ ...g, items: g.items.filter((i) => !i[4] || can(i[4])) })).filter((g) => g.items.length));
  if (role === 'corps_member') add('corps_member');
  if (role === 'accommodation_officer') add('accommodation');
  if (role === 'medical_personnel') add('medical');
  if (role === 'super_admin') { add('system'); add('accommodation'); }
  return groups;
}

const ALL = Object.values(NAV).flatMap((g) => g.flatMap((x) => x.items));
export const titleFor = (path) => ALL.find((i) => i[0] === path)?.[1];

export function layout(route, content, path, page) {
  return route.access === 'public' ? publicLayout(content, path) : portalLayout(content, path, page);
}

// ------------------------------------------------------------------ public site
const PUB_LINKS = [['/', 'Home'], ['/about', 'About'], ['/how-it-works', 'How it works'], ['/faq', 'FAQ'], ['/contact', 'Contact']];
function publicLayout(content, path) {
  const here = (p) => (p === path ? 'aria-current="page"' : '');
  return `<header class="pub-header"><div class="container">
      <div class="logos">${nyscLogo()}<span class="sep"></span>${brand().toString()}</div>
      <button class="icon-btn menu-btn" data-menu aria-label="Open menu" aria-expanded="false">&#9776;</button>
      <nav class="pub-nav" aria-label="Main">
        ${PUB_LINKS.map(([p, l]) => `<a href="#${p}" ${here(p)}>${l}</a>`).join('')}
        ${S.user ? `<a class="btn primary" href="#${ROLE_HOME[S.user.role]}">Open my portal</a>`
          : `<a href="#/login" ${here('/login')}>Log in</a><a class="btn primary" href="#/register">Register</a>`}
      </nav></div></header>
    <main id="view">${content}</main>
    <footer class="pub-footer"><div class="container">
      <div class="logos" style="margin-bottom:1rem">${nyscLogo().toString()}${brand().toString().replace('color:var(--g900)', '')}</div>
      <p class="tag">${TAGLINE}</p>
      <p>CampSpace is a hostel booking, bunk allocation and medical accommodation platform for NYSC orientation camps. It is a demonstration system prepared for presentation to NYSC and is not yet an official NYSC service.</p>
      <p><a href="#/about">About</a> &middot; <a href="#/how-it-works">How it works</a> &middot; <a href="#/faq">FAQ</a> &middot; <a href="#/contact">Contact</a>${S.meta?.config?.support_email ? ` &middot; ${esc(S.meta.config.support_email)}` : ''}</p>
    </div></footer>`;
}

// ------------------------------------------------------------------ portals
function portalLayout(content, path, page) {
  const u = S.user;
  const groups = navFor(u.role);
  const link = ([p, label, ico, flag]) => {
    const cur = path === p || (p !== '/app' && p !== '/admin' && p !== '/med' && p !== '/super' && path.startsWith(p + '/')) ? 'aria-current="page"' : '';
    const count = flag === 'unread' && S.unread ? `<span class="count">${S.unread > 99 ? '99+' : S.unread}</span>` : '';
    return `<a class="nav-link" href="#${p}" ${cur}><span class="ico" aria-hidden="true">${ico}</span>${esc(label)}${count}</a>`;
  };
  const side = groups.map((g) => `<div class="nav-group"><h4>${esc(g.g)}</h4>${g.items.map(link).join('')}</div>`).join('');
  const bottomItems = (BOTTOM[u.role] || []).map((p) => ALL.find((i) => i[0] === p)).filter((i) => i && groups.some((g) => g.items.includes(i)));
  const bottom = bottomItems.map((i) => `<a href="#${i[0]}" ${path === i[0] ? 'aria-current="page"' : ''}><span aria-hidden="true">${i[2]}</span>${esc(SHORT[i[0]] || i[1])}</a>`).join('');
  const campScoped = u.role === 'super_admin' && /^\/(admin|med)/.test(path);
  const camps = campScoped && S.camps.length
    ? `<label class="small muted" for="camp-switch" style="margin:0">Camp</label><select id="camp-switch" aria-label="Switch camp">${S.camps.map((c) => `<option value="${c.id}" ${c.id === S.campId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>` : '';
  const campName = u.role !== 'super_admin' && S.camp ? S.camp.name : '';
  return `<div class="portal" id="portal">
    <aside class="sidebar" id="sidebar" aria-label="Portal navigation">
      <div style="padding:1rem 1.1rem .2rem">${brand(`#${ROLE_HOME[u.role]}`).toString()}</div>
      <div class="side-logos">${nyscLogo().toString()}</div>
      <nav>${side}</nav>
      <div class="side-foot">${esc(u.role_label)}<br>${esc(campName)}<br><a href="#/" style="color:#cfe9da">Public site</a></div>
    </aside>
    <div class="scrim" data-drawer></div>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn drawer-btn" data-drawer aria-label="Open navigation">&#9776;</button>
        <div class="title">${esc(page?.title || titleFor(path) || 'CampSpace')}</div>
        ${camps}
        <a class="bell" href="#${u.role === 'corps_member' ? '/app/notifications' : '/notifications'}" aria-label="Notifications">&#128276;<span id="bell-count" ${S.unread ? '' : 'hidden'}>${S.unread}</span></a>
        <div class="who"><b>${esc(u.full_name)}</b><span class="muted">${esc(u.role_label)}</span></div>
        <button class="btn ghost sm" data-logout>Sign out</button>
      </header>
      ${S.announcement ? `<div class="announce">${esc(S.announcement)}</div>` : ''}
      <main id="view" class="content">${content}</main>
    </div>
    <nav class="bottom-nav" style="--n:${bottomItems.length || 1}" aria-label="Quick navigation">${bottom}</nav>
  </div>`;
}

// ------------------------------------------------------------------ shared page pieces
export const pageHead = (title, sub = '', actions = '') => html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="btn-row" style="margin:0">${actions}</div>` : ''}</div>`;
export const tabs = (items, current) => html`<nav class="tabs" aria-label="Sections">${items.map(([href, label]) => html`<a href="${href}" ${href === current ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>`;
