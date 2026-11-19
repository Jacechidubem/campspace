// Super administrator portal: system dashboard, camps, users, roles, configuration, reports, audit logs.
import {
  S, html, raw, esc, route, go, get, post, patch, put, toast, submitForm, openModal, confirmDialog, badge, fmtDT, fmtD, ago, empty, num, pager, downloadApi, reload, refreshMe,
} from './core.js';
import { pageHead } from './shell.js';
import { kpi, hbars, reportBody } from './pages-admin.js';

const SUPER = ['super_admin'];
const ROLE_LABEL = { corps_member: 'Corps member', accommodation_officer: 'Accommodation officer', medical_personnel: 'Medical personnel', super_admin: 'Super administrator' };

const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); if (Number.isNaN(+d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');

function tempPasswordDialog(title, who, pw) {
  const m = openModal(title, html`<p>Temporary password for <b>${who}</b>. It is shown only once. They must choose a new password when they first sign in.</p>
    <div class="card" style="text-align:center"><span class="big-ref" id="tp">${pw}</span></div>
    <div class="btn-row end"><button class="btn ghost" id="cp">Copy</button><button class="btn primary" data-close>Done</button></div>`.toString());
  m.el.querySelector('#cp').addEventListener('click', async () => { try { await navigator.clipboard.writeText(pw); toast('Copied.'); } catch { toast('Select the password and copy it manually.', 'info'); } });
}

// ================================================================== system dashboard
route('/super', SUPER, async () => {
  const d = await get('/super/dashboard');
  const users = Object.fromEntries(d.users.map((u) => [u.role, u.n]));
  return {
    title: 'System Dashboard',
    body: html`${pageHead('System dashboard', 'All orientation camps at a glance.')}
      <div class="kpis">${kpi(d.camps.length, 'Camps')}${kpi(num(d.camps.reduce((a, c) => a + c.beds, 0)), 'Bunks')}${kpi(num(d.camps.reduce((a, c) => a + c.booked, 0)), 'Booked')}${kpi(num(users.corps_member || 0), 'Corps members')}
        ${kpi((users.accommodation_officer || 0) + (users.medical_personnel || 0) + (users.super_admin || 0), 'Staff accounts')}${kpi(d.active_last_24h, 'Active in 24 h')}${kpi(d.unhandled_messages, 'Unread contact messages', d.unhandled_messages ? 'warn' : '')}</div>
      <div class="card"><div class="card-head"><h2>Camps</h2><a class="btn ghost sm" href="#/super/camps">Manage camps</a></div>
        <div class="table-wrap"><table><thead><tr><th>Camp</th><th>Booking</th><th class="num">Bunks</th><th class="num">Booked</th><th>Occupancy</th><th class="num">Checked in</th><th class="num">Waiting</th></tr></thead><tbody>
        ${d.camps.map((c) => html`<tr><td><b>${c.name}</b><div class="small muted">${c.state} - ${c.batch}</div></td><td>${c.active ? (c.booking_open ? badge('open', 'Open') : badge('closed', 'Closed')) : badge('muted', 'Inactive')}</td><td class="num">${num(c.beds)}</td><td class="num">${num(c.booked)}</td><td style="min-width:150px">${c.occupancy_pct}%${hbars([{ label: '', value: c.occupancy_pct, total: 100, text: '', tone: c.occupancy_pct > 90 ? 'r' : c.occupancy_pct > 70 ? 'w' : 'g' }])}</td><td class="num">${num(c.checked_in)}</td><td class="num">${num(c.waiting)}</td></tr>`)}</tbody></table></div></div>
      <div class="cols">
        <div class="card"><h2>Audit trail</h2><p>${d.audit.intact ? badge('ok', 'Chain intact') : badge('bad', 'Chain broken')} ${num(d.audit.entries)} entries.</p><a class="btn ghost sm" href="#/super/audit">Open audit logs</a></div>
        <div class="card"><h2>Contact messages</h2>${d.contact_messages.length ? html`<ul class="timeline">${d.contact_messages.map((m) => html`<li><span><b>${m.subject}</b><br><span class="small muted">${m.name} - ${ago(m.created_at)}</span></span>${m.handled ? badge('ok', 'Handled') : html`<button class="btn ghost sm" data-msg="${m.id}">Mark handled</button>`}</li>`)}</ul>` : empty('No messages')}</div>
      </div>`,
    mount(el) { el.querySelectorAll('[data-msg]').forEach((b) => b.addEventListener('click', async () => { await post(`/super/messages/${b.dataset.msg}/handled`, {}); reload(); })); },
  };
});

// ================================================================== camps
route('/super/camps', SUPER, async () => {
  const { items } = await get('/super/camps');
  const form = (c = {}) => html`<form>
    <div class="grid2">
      ${c.id ? '' : html`<div class="field"><label for="c-code">Camp code</label><input id="c-code" name="code" required minlength="2" maxlength="12" placeholder="OGUN-01"></div>`}
      <div class="field"><label for="c-n">Name</label><input id="c-n" name="name" value="${c.name || ''}" required minlength="3" maxlength="120"></div>
      <div class="field"><label for="c-s">State</label><select id="c-s" name="state" required>${(S.meta?.states || []).map((s) => html`<option ${s === c.state ? raw('selected') : ''}>${s}</option>`)}</select></div>
      <div class="field"><label for="c-b">Batch / stream</label><input id="c-b" name="batch" value="${c.batch || ''}" required maxlength="30" placeholder="2026 Batch C, Stream I"></div>
      <div class="field"><label for="c-a">Address</label><input id="c-a" name="address" value="${c.address || ''}" maxlength="200"></div>
      <div class="field"><label for="c-st">Camp opens</label><input id="c-st" name="starts_on" type="date" value="${c.starts_on || ''}"></div>
      <div class="field"><label for="c-en">Camp ends</label><input id="c-en" name="ends_on" type="date" value="${c.ends_on || ''}"></div>
      <div class="field"><label for="c-bo">Booking opens (optional)</label><input id="c-bo" name="booking_opens_at" type="datetime-local" value="${toLocalInput(c.booking_opens_at)}"></div>
      <div class="field"><label for="c-bc">Booking closes (optional)</label><input id="c-bc" name="booking_closes_at" type="datetime-local" value="${toLocalInput(c.booking_closes_at)}"></div></div>
    <label class="check"><input type="checkbox" name="booking_open" ${c.booking_open !== 0 ? raw('checked') : ''}><span>Booking is open</span></label>
    <label class="check"><input type="checkbox" name="active" ${c.active !== 0 ? raw('checked') : ''}><span>Camp is active (visible for registration)</span></label>
    <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${c.id ? 'Save camp' : 'Create camp'}</button></div><div class="form-error"></div></form>`.toString();
  const clean = (d) => ({ ...d, booking_opens_at: fromLocalInput(d.booking_opens_at), booking_closes_at: fromLocalInput(d.booking_closes_at), starts_on: d.starts_on || '', ends_on: d.ends_on || '' });
  return {
    title: 'Camp Management',
    body: html`${pageHead('Camps', 'Every NYSC orientation camp on the platform.', html`<button class="btn primary" id="add">Add camp</button>`)}
      <div class="table-wrap"><table><thead><tr><th>Camp</th><th>Code</th><th>Dates</th><th>Booking</th><th class="num">Hostels</th><th class="num">Corps</th><th class="num">Staff</th><th></th></tr></thead><tbody>
      ${items.map((c) => html`<tr><td><b>${c.name}</b><div class="small muted">${c.state} - ${c.batch}</div></td><td class="mono">${c.code}</td><td class="small">${c.starts_on ? fmtD(c.starts_on) : '-'} to ${c.ends_on ? fmtD(c.ends_on) : '-'}</td><td>${c.active ? (c.booking_open ? badge('open', 'Open') : badge('closed', 'Closed')) : badge('muted', 'Inactive')}</td><td class="num">${c.hostels}</td><td class="num">${c.corps}</td><td class="num">${c.staff}</td>
        <td><button class="btn ghost sm" data-edit="${c.id}">Edit</button><button class="btn ghost sm" data-toggle="${c.id}" data-open="${c.booking_open}">${c.booking_open ? 'Close booking' : 'Open booking'}</button></td></tr>`)}</tbody></table></div>
      <div class="card notice info" style="margin-top:1rem"><b>Setting up a new camp:</b> create the camp, then add hostels and rooms (switch to the camp with the selector in the top bar, then use Hostel Management) and create its accommodation officers and medical staff under User Management.</div>`,
    mount(el) {
      el.querySelector('#add').addEventListener('click', () => {
        const m = openModal('Add camp', form(), { wide: true });
        submitForm(m.el.querySelector('form'), async (d) => { await post('/super/camps', clean(d)); await refreshMe(); m.close(); toast('Camp created.'); reload(); });
      });
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const c = items.find((x) => x.id === Number(b.dataset.edit));
        const m = openModal('Edit camp', form(c), { wide: true });
        submitForm(m.el.querySelector('form'), async (d) => { await patch('/super/camps/' + c.id, clean(d)); await refreshMe(); m.close(); toast('Camp saved.'); reload(); });
      }));
      el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => { await patch('/super/camps/' + b.dataset.toggle, { booking_open: b.dataset.open !== '1' }); toast('Updated.'); reload(); }));
    },
  };
});

// ================================================================== users
route('/super/users', SUPER, async ({ query }) => {
  const qs = new URLSearchParams({ size: 20, page: query.page || 1 });
  for (const k of ['q', 'role', 'camp_id']) if (query[k]) qs.set(k, query[k]);
  const d = await get('/super/users?' + qs);
  const camps = S.camps;
  const link = (p) => `#/super/users?${new URLSearchParams({ ...query, page: p })}`;
  const staffForm = html`<form>
    <div class="grid2"><div class="field"><label for="u-n">Full name</label><input id="u-n" name="full_name" required minlength="3" maxlength="100"></div>
    <div class="field"><label for="u-e">Email</label><input id="u-e" name="email" type="email" required></div>
    <div class="field"><label for="u-r">Role</label><select id="u-r" name="role">${['accommodation_officer', 'medical_personnel', 'super_admin'].map((r) => html`<option value="${r}">${ROLE_LABEL[r]}</option>`)}</select></div>
    <div class="field" id="u-cw"><label for="u-c">Camp</label><select id="u-c" name="camp_id">${camps.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></div></div>
    <p class="small muted">A temporary password is generated and shown once.</p>
    <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Create user</button></div><div class="form-error"></div></form>`.toString();
  return {
    title: 'User Management',
    body: html`${pageHead('Users', `${num(d.total)} accounts`, html`<button class="btn primary" id="add">Create staff user</button>`)}
      <form class="toolbar" id="f"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search name, email, call-up number" aria-label="Search">
        <select name="role" aria-label="Role"><option value="">All roles</option>${Object.entries(ROLE_LABEL).map(([v, l]) => html`<option value="${v}" ${query.role === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <select name="camp_id" aria-label="Camp"><option value="">All camps</option>${camps.map((c) => html`<option value="${c.id}" ${String(c.id) === query.camp_id ? raw('selected') : ''}>${c.name}</option>`)}</select><button class="btn ghost" type="submit">Filter</button></form>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Camp</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${d.items.map((u) => html`<tr><td><b>${u.full_name}</b><div class="small muted">${u.email}${u.call_up_number ? ' - ' + u.call_up_number : ''}</div></td><td>${u.role_label}</td><td class="small">${u.camp_name || 'All camps'}</td><td>${u.active ? badge('ok', 'Active') : badge('bad', 'Disabled')}${u.role === 'corps_member' ? html` ${badge(u.verification_status)}` : ''}</td><td class="small">${u.last_login_at ? ago(u.last_login_at) : 'Never'}</td>
        <td><button class="btn ghost sm" data-edit="${u.id}">Edit</button><button class="btn ghost sm" data-reset="${u.id}" data-name="${u.full_name}">Reset password</button></td></tr>`)}</tbody></table></div>${pager(d.page, d.size, d.total, link)}`,
    mount(el) {
      el.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const p = new URLSearchParams(new FormData(e.target)); [...p].forEach(([k, v]) => { if (!v) p.delete(k); }); go('/super/users' + (p.size ? '?' + p : '')); });
      el.querySelector('#add').addEventListener('click', () => {
        const m = openModal('Create staff user', staffForm);
        const role = m.el.querySelector('#u-r'); const sync = () => { m.el.querySelector('#u-cw').hidden = role.value === 'super_admin'; }; role.addEventListener('change', sync); sync();
        submitForm(m.el.querySelector('form'), async (f) => { const r = await post('/super/users', { ...f, camp_id: f.role === 'super_admin' ? null : Number(f.camp_id) }); m.close(); tempPasswordDialog('User created', f.full_name, r.temporary_password); reload(); });
      });
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const u = d.items.find((x) => x.id === Number(b.dataset.edit));
        const corps = u.role === 'corps_member';
        const m = openModal('Edit user', html`<form><div class="field"><label for="e-n">Full name</label><input id="e-n" name="full_name" value="${u.full_name}" required></div>
          ${corps ? html`<div class="field"><label for="e-cu">Call-up number</label><input id="e-cu" name="call_up_number" value="${u.call_up_number}"></div>
            <div class="field"><label for="e-v">Verification</label><select id="e-v" name="verification_status">${['unverified', 'pending', 'verified', 'rejected'].map((s) => html`<option ${s === u.verification_status ? raw('selected') : ''}>${s}</option>`)}</select></div>`
            : html`<div class="field"><label for="e-r">Role</label><select id="e-r" name="role">${['accommodation_officer', 'medical_personnel', 'super_admin'].map((r) => html`<option value="${r}" ${r === u.role ? raw('selected') : ''}>${ROLE_LABEL[r]}</option>`)}</select></div>`}
          <div class="field"><label for="e-c">Camp</label><select id="e-c" name="camp_id">${u.role === 'super_admin' ? html`<option value="">All camps</option>` : ''}${camps.map((c) => html`<option value="${c.id}" ${c.id === u.camp_id ? raw('selected') : ''}>${c.name}</option>`)}</select></div>
          <label class="check"><input type="checkbox" name="active" ${u.active ? raw('checked') : ''}><span>Account is active</span></label>
          <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div><div class="form-error"></div></form>`.toString());
        submitForm(m.el.querySelector('form'), async (f) => { await patch('/super/users/' + u.id, { ...f, camp_id: f.camp_id ? Number(f.camp_id) : null }); m.close(); toast('User saved.'); reload(); });
      }));
      el.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog('Reset password', `Generate a new temporary password for ${b.dataset.name}? They will be signed out everywhere.`, { okLabel: 'Reset' }))) return;
        const r = await post(`/super/users/${b.dataset.reset}/reset-password`, {}); tempPasswordDialog('Password reset', b.dataset.name, r.temporary_password);
      }));
    },
  };
});

// ================================================================== roles & permissions
route('/super/roles', SUPER, async () => {
  const d = await get('/super/roles');
  const CORPS_OK = ['booking.own', 'medical.request', 'hostels.view'];
  return {
    title: 'Role Management',
    body: html`${pageHead('Roles and permissions', 'Choose what each role may do. Changes apply immediately. The super administrator role is locked.')}
      <form id="roles"><div class="table-wrap"><table><thead><tr><th>Permission</th>${d.roles.map((r) => html`<th style="text-align:center">${r.label}<div class="small muted" style="text-transform:none;letter-spacing:0">${r.users} users</div></th>`)}</tr></thead><tbody>
      ${d.permissions.map((p) => html`<tr><td><b>${p.label}</b><div class="small muted mono">${p.key}</div></td>${d.roles.map((r) => html`<td style="text-align:center"><input type="checkbox" data-role="${r.role}" data-perm="${p.key}" aria-label="${r.label}: ${p.label}" ${r.permissions.includes(p.key) ? raw('checked') : ''} ${r.locked || (r.role === 'corps_member' && !CORPS_OK.includes(p.key)) ? raw('disabled') : ''}></td>`)}</tr>`)}</tbody></table></div>
      <div class="btn-row"><button class="btn primary" type="submit">Save changes</button></div><div class="form-error" role="alert"></div></form>
      <div class="card notice info" style="margin-top:1rem">Officers and medical staff can only ever see data from their own camp, whatever permissions they hold.</div>`,
    mount(el) {
      const f = el.querySelector('#roles');
      submitForm(f, async () => {
        for (const r of d.roles.filter((x) => !x.locked)) {
          const now = [...f.querySelectorAll(`[data-role="${r.role}"]:checked`)].map((c) => c.dataset.perm);
          if (now.slice().sort().join() !== r.permissions.slice().sort().join()) await put('/super/roles/' + r.role, { permissions: now });
        }
        toast('Permissions saved.'); reload();
      });
    },
  };
});

// ================================================================== configuration
route('/super/config', SUPER, async () => {
  const { config: c } = await get('/super/config');
  const sw = (name, label, hint) => html`<label class="check"><input type="checkbox" name="${name}" ${c[name] === 'true' ? raw('checked') : ''}><span>${label}${hint ? html`<small>${hint}</small>` : ''}</span></label>`;
  return {
    title: 'System Configuration',
    body: html`${pageHead('System configuration', 'Settings that apply to every camp.')}
      <form class="card" id="cfg" style="max-width:760px"><h2>Registration and booking</h2>
        ${sw('registration_open', 'Registration is open', 'New corps members can create accounts.')}
        ${sw('require_verified_to_book', 'Require a verified call-up number before booking', 'Corps members must be verified by an officer first.')}
        ${sw('allow_self_cancel', 'Allow corps members to cancel their own booking')}
        ${sw('waitlist_auto_promote', 'Allocate the waiting list automatically when bunks are released')}
        <div class="grid2" style="margin-top:1rem"><div class="field"><label for="c-m">Self-cancellations allowed per person</label><input id="c-m" name="max_self_cancellations" type="number" min="0" max="10" value="${c.max_self_cancellations}"></div>
        <div class="field"><label for="c-h">Session length (hours)</label><input id="c-h" name="session_hours" type="number" min="1" max="72" value="${c.session_hours}"><div class="hint">Applies to new sign-ins.</div></div></div>
        <h2 style="margin-top:1rem">Support and notices</h2>
        <div class="grid2"><div class="field"><label for="c-se">Support email</label><input id="c-se" name="support_email" type="email" value="${c.support_email}"></div><div class="field"><label for="c-sp">Support phone</label><input id="c-sp" name="support_phone" value="${c.support_phone}"></div></div>
        <div class="field"><label for="c-an">Announcement banner (shown to signed-in users)</label><input id="c-an" name="announcement" maxlength="300" value="${c.announcement}"></div>
        <button class="btn primary" type="submit">Save configuration</button><div class="form-error" role="alert"></div></form>`,
    mount(el) {
      submitForm(el.querySelector('#cfg'), async (d) => {
        await put('/super/config', { ...d, max_self_cancellations: Number(d.max_self_cancellations), session_hours: Number(d.session_hours) });
        await refreshMe(); toast('Configuration saved.');
      });
    },
  };
});

// ================================================================== system reports
route('/super/reports', SUPER, async () => {
  const d = await get('/super/reports');
  const t = d.totals;
  return {
    title: 'Reports',
    body: html`${pageHead('System reports', `Generated ${fmtDT(d.generated_at)}`, html`<button class="btn ghost" id="csv">Export CSV</button><button class="btn ghost" id="print">Print</button>`)}
      <div class="kpis">${kpi(d.camps.length, 'Camps')}${kpi(num(t.beds), 'Bunks')}${kpi(num(t.booked), 'Booked')}${kpi(t.beds ? Math.round((t.booked / t.beds) * 1000) / 10 + '%' : '0%', 'Occupancy')}${kpi(num(t.checked_in), 'Checked in')}${kpi(num(t.corps), 'Corps members')}${kpi(num(t.waiting), 'Waiting list')}</div>
      <div class="card"><h2>Camp comparison</h2>${hbars(d.camps.map((c) => ({ label: c.camp.name, value: c.report.bookings.active, total: c.report.capacity.bookable, text: `${c.report.bookings.active}/${c.report.capacity.bookable}`, tone: c.report.bookings.occupancy_pct > 90 ? 'r' : c.report.bookings.occupancy_pct > 70 ? 'w' : 'g' })))}</div>
      ${d.camps.map((c, i) => html`<details class="faq" ${i === 0 ? raw('open') : ''}><summary>${c.camp.name} - ${c.camp.state} (${c.camp.batch})</summary><div style="padding-top:.5rem">${reportBody(c.report)}</div></details>`)}`,
    mount(el) {
      el.querySelector('#csv').addEventListener('click', () => downloadApi('/super/reports.csv', 'campspace-system-report.csv'));
      el.querySelector('#print').addEventListener('click', () => { el.querySelectorAll('details').forEach((x) => { x.open = true; }); window.print(); });
    },
  };
});

// ================================================================== audit logs
route('/super/audit', SUPER, async ({ query }) => {
  const qs = new URLSearchParams({ size: 50, page: query.page || 1 });
  for (const k of ['q', 'action', 'role']) if (query[k]) qs.set(k, query[k]);
  const d = await get('/super/audit?' + qs);
  const link = (p) => `#/super/audit?${new URLSearchParams({ ...query, page: p })}`;
  const ACTIONS = ['auth.', 'booking.', 'medical.', 'checkin.', 'user.', 'role.', 'config.', 'camp.', 'hostel.', 'room.', 'bed.', 'report.', 'waitlist.', 'ticket.'];
  return {
    title: 'Audit Logs',
    body: html`${pageHead('Audit logs', `${num(d.total)} entries. Append-only and hash-chained, so tampering is detectable.`, html`<button class="btn ghost" id="verify">Verify integrity</button><button class="btn ghost" id="csv">Export CSV</button>`)}
      <div id="vres"></div>
      <form class="toolbar" id="f"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search person, record or detail" aria-label="Search">
        <select name="action" aria-label="Action"><option value="">All actions</option>${ACTIONS.map((a) => html`<option value="${a}" ${query.action === a ? raw('selected') : ''}>${a}*</option>`)}</select>
        <select name="role" aria-label="Role"><option value="">All roles</option>${[...Object.keys(ROLE_LABEL), 'system'].map((r) => html`<option value="${r}" ${query.role === r ? raw('selected') : ''}>${ROLE_LABEL[r] || r}</option>`)}</select><button class="btn ghost" type="submit">Filter</button></form>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Time</th><th>Who</th><th>Action</th><th>Record</th><th>Detail</th><th>IP</th></tr></thead><tbody>
      ${d.items.length ? d.items.map((a) => html`<tr><td class="small muted">${a.id}</td><td class="small" style="white-space:nowrap">${fmtDT(a.ts)}</td><td>${a.actor || html`<span class="muted">${a.role || 'anonymous'}</span>`}<div class="small muted">${a.role || ''}</div></td><td class="mono small">${a.action}</td><td class="small">${a.entity || ''} ${a.entity_id || ''}</td><td class="small" style="max-width:280px;word-break:break-word">${a.detail || ''}</td><td class="small muted">${a.ip || ''}</td></tr>`) : html`<tr><td colspan="7">${empty('No entries match')}</td></tr>`}</tbody></table></div>${pager(d.page, d.size, d.total, link)}`,
    mount(el) {
      el.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const p = new URLSearchParams(new FormData(e.target)); [...p].forEach(([k, v]) => { if (!v) p.delete(k); }); go('/super/audit' + (p.size ? '?' + p : '')); });
      el.querySelector('#csv').addEventListener('click', () => downloadApi('/super/audit.csv?' + new URLSearchParams(Object.fromEntries(['q', 'action', 'role'].filter((k) => query[k]).map((k) => [k, query[k]]))), 'campspace-audit-log.csv'));
      el.querySelector('#verify').addEventListener('click', async () => {
        const r = await get('/super/audit/verify');
        el.querySelector('#vres').innerHTML = html`<div class="card notice ${r.ok ? '' : 'bad'}"><b>${r.ok ? 'Audit log intact.' : `Audit log broken at entry ${r.broken_at}.`}</b> ${num(r.checked)} entries checked.</div>`.toString();
      });
    },
  };
});
void esc;
