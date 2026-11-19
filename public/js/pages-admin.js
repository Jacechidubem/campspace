// Accommodation officer portal (super administrators can use it for any camp via the camp switcher).
import {
  S, html, raw, esc, route, go, get, post, patch, del, toast, submitForm, confirmDialog, openModal, badge, fmtDT, ago, floorName,
  bar, empty, num, needLabel, downloadApi, pager, can, reload, $, current,
} from './core.js';
import { pageHead, tabs } from './shell.js';
import { ticketCard } from './pages-corps.js';

const STAFF = ['accommodation_officer', 'super_admin'];

// ---------------------------------------------------------------- shared chart helpers (also used by other portals)
export const kpi = (value, label, tone = '') => html`<div class="kpi ${tone}"><b>${value}</b><span>${label}</span></div>`;
export function hbars(rows, { suffix = '' } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.total ?? r.value));
  return html`${rows.map((r) => html`<div class="rowbar"><span class="lbl" title="${r.label}">${r.label}</span>${bar(((r.value) / max) * 100, { tone: r.tone || 'g', label: r.label })}<span class="v">${r.text ?? num(r.value) + suffix}</span></div>`)}`;
}
export function dayChart(per) {
  if (!per?.length) return empty('No bookings yet');
  const max = Math.max(1, ...per.map((d) => d.n));
  return html`<div class="columns-chart" role="img" aria-label="Bookings per day">${per.map((d) => html`<div class="col" style="height:${Math.max(3, (d.n / max) * 100)}%" title="${d.day}: ${d.n}"></div>`)}</div>
    <div class="axis"><span>${per[0].day.slice(5)}</span><span>peak ${max}/day</span><span>${per[per.length - 1].day.slice(5)}</span></div>`;
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const tone = (p) => (p > 90 ? 'r' : p > 70 ? 'w' : 'g');

// ---------------------------------------------------------------- bunk picker modal (assign / move)
async function pickBunk({ title, gender, onPick }) {
  const rooms = (await get('/admin/rooms')).items.filter((r) => r.status === 'open' && (!gender || r.gender === gender));
  if (!rooms.length) return toast('There are no open rooms for this person.', 'bad');
  let chosen = null;
  const m = openModal(title, html`
    <div class="field"><label for="pk-room">Room</label><select id="pk-room">${rooms.map((r) => html`<option value="${r.id}">${r.hostel_name} - ${r.number} (${floorName(r.floor)}) - ${r.beds - r.booked - r.blocked} free</option>`)}</select></div>
    <div id="pk-map"><span class="spinner"></span></div>
    <div class="btn-row end"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" id="pk-ok" disabled>Choose this bunk</button></div>`.toString(), { wide: true });
  const el = m.el;
  const load = async () => {
    chosen = null; el.querySelector('#pk-ok').disabled = true;
    const d = await get('/rooms/' + el.querySelector('#pk-room').value + '/beds');
    const pairs = new Map();
    for (const b of d.beds) { const p = pairs.get(b.bunk_no) || {}; p[b.level] = b; pairs.set(b.bunk_no, p); }
    const b = (x, l) => (x ? `<button class="bed ${x.state}" data-id="${x.id}" ${x.state === 'available' ? '' : 'disabled'}><span>${l}</span><span class="lv">${x.state === 'available' ? (x.medical_reserved ? 'Medical reserve' : 'Free') : x.state}</span></button>` : '');
    el.querySelector('#pk-map').innerHTML = `<div class="bunk-map">${[...pairs.entries()].map(([n, p]) => `<div class="bunk"><div class="no">Bunk ${n}</div>${b(p.upper, 'Upper')}${b(p.lower, 'Lower')}</div>`).join('')}</div>`;
  };
  el.querySelector('#pk-room').addEventListener('change', load);
  el.addEventListener('click', async (e) => {
    const bed = e.target.closest('.bed');
    if (bed && !bed.disabled) { el.querySelectorAll('.bed.selected').forEach((x) => x.classList.remove('selected')); bed.classList.add('selected'); chosen = Number(bed.dataset.id); el.querySelector('#pk-ok').disabled = false; }
    if (e.target.id === 'pk-ok' && chosen) { const id = chosen; try { await onPick(id); m.close(); } catch (err) { toast(err.message, 'bad'); load(); } }
  });
  load();
}

// ================================================================== dashboard
route('/admin', STAFF, async () => {
  const d = await get('/admin/dashboard');
  const r = d.report;
  return {
    title: 'Dashboard',
    body: html`${pageHead(d.camp.name, `${d.camp.state} State - ${d.camp.batch}`, can('bookings.view') ? html`<a class="btn primary" href="#/admin/checkin">Check-in desk</a>` : '')}
      <div class="kpis">
        ${kpi(num(r.capacity.bookable), 'Bookable bunks')}${kpi(num(r.bookings.active), 'Booked')}${kpi(num(r.bookings.checked_in), 'Checked in')}
        ${kpi(num(r.bookings.available), 'Free bunks')}${kpi(r.bookings.occupancy_pct + '%', 'Occupancy', r.bookings.occupancy_pct > 90 ? 'bad' : '')}
        ${kpi(num(r.waitlist.waiting), 'On waiting list', r.waitlist.waiting ? 'warn' : '')}${kpi(num(r.corps.without_booking), 'Registered, no bunk yet')}
        ${kpi(num(d.unverified), 'Call-ups to verify', d.unverified ? 'warn' : '')}
        ${can('medical.instructions') ? kpi(num(d.pending_medical_allocations), 'Medical cases to allocate', d.pending_medical_allocations ? 'bad' : '') : ''}
      </div>
      <div class="cols">
        <div class="card"><h2>Occupancy by hostel</h2>${hbars(r.by_hostel.map((h) => ({ label: h.name, value: h.booked, total: h.beds, text: `${h.booked}/${h.beds}`, tone: tone(pct(h.booked, h.beds)) })))}</div>
        <div class="card"><h2>Bookings per day</h2>${dayChart(r.per_day)}</div>
        <div class="card"><h2>Recent activity</h2>${d.recent.length ? html`<ul class="timeline">${d.recent.map((x) => html`<li><span>${x.full_name} - <b>${x.label}</b></span><span>${badge(x.status)} <span class="muted small">${ago(x.checked_in_at || x.created_at)}</span></span></li>`)}</ul>` : empty('Nothing yet')}</div>
      </div>
      <div class="card"><h2>Quick actions</h2><div class="btn-row" style="margin:0">
        ${can('bookings.view') ? html`<a class="btn ghost" href="#/admin/bookings?tab=corps&verification=pending">Verify call-up numbers</a><a class="btn ghost" href="#/admin/bookings?tab=waitlist">Waiting list</a>` : ''}
        ${can('hostels.view') ? html`<a class="btn ghost" href="#/admin/bunks">Bunk map</a>` : ''}
        ${can('reports.camp') ? html`<a class="btn ghost" href="#/admin/reports">Reports</a>` : ''}</div></div>`,
  };
});

// ================================================================== hostels
route('/admin/hostels', STAFF, async () => {
  const { items } = await get('/admin/hostels');
  const manage = can('hostels.manage');
  const form = (h = {}) => html`<form><div class="field"><label for="h-n">Hostel name</label><input id="h-n" name="name" value="${h.name || ''}" required minlength="2" maxlength="80"></div>
    ${h.id ? '' : html`<div class="field"><label for="h-g">Gender</label><select id="h-g" name="gender" required><option value="male">Male</option><option value="female">Female</option></select></div>`}
    <div class="field"><label for="h-f">Floors</label><input id="h-f" name="floors" type="number" min="1" max="20" value="${h.floors || 3}" required></div>
    <div class="field"><label for="h-d">Description</label><input id="h-d" name="description" maxlength="300" value="${h.description || ''}"></div>
    <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">${h.id ? 'Save' : 'Add hostel'}</button></div><div class="form-error"></div></form>`.toString();
  return {
    title: 'Hostel Management',
    body: html`${pageHead('Hostels', 'Blocks and wings in this camp.', manage ? html`<button class="btn primary" id="add">Add hostel</button>` : '')}
      <div class="table-wrap"><table><thead><tr><th>Hostel</th><th>Gender</th><th class="num">Floors</th><th class="num">Rooms</th><th class="num">Bunks</th><th>Occupancy</th><th>Status</th><th></th></tr></thead><tbody>
      ${items.length ? items.map((h) => html`<tr><td><b>${h.name}</b><div class="small muted">${h.description || ''}</div></td><td>${h.gender === 'male' ? 'Male' : 'Female'}</td><td class="num">${h.floors}</td><td class="num">${h.rooms}</td><td class="num">${h.beds}</td>
        <td style="min-width:140px">${h.booked || 0}/${h.beds}${bar(pct(h.booked || 0, h.beds), { tone: tone(pct(h.booked || 0, h.beds)) })}</td><td>${h.active ? badge('open', 'Active') : badge('closed', 'Inactive')}</td>
        <td>${manage ? html`<button class="btn ghost sm" data-edit="${h.id}">Edit</button><button class="btn ghost sm" data-toggle="${h.id}" data-active="${h.active}">${h.active ? 'Deactivate' : 'Activate'}</button>` : ''}<a class="btn ghost sm" href="#/admin/rooms?hostel=${h.id}">Rooms</a></td></tr>`) : html`<tr><td colspan="8">${empty('No hostels yet', 'Add the first hostel for this camp.')}</td></tr>`}
      </tbody></table></div>`,
    mount(el) {
      el.querySelector('#add')?.addEventListener('click', () => {
        const m = openModal('Add hostel', form());
        submitForm(m.el.querySelector('form'), async (d) => { d.floors = Number(d.floors); await post('/admin/hostels', d); m.close(); toast('Hostel added.'); reload(); });
      });
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const h = items.find((x) => x.id === Number(b.dataset.edit));
        const m = openModal('Edit hostel', form(h));
        submitForm(m.el.querySelector('form'), async (d) => { d.floors = Number(d.floors); await patch('/admin/hostels/' + h.id, d); m.close(); toast('Saved.'); reload(); });
      }));
      el.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
        const on = b.dataset.active === '1';
        if (on && !(await confirmDialog('Deactivate hostel', 'Corps members will no longer see this hostel. Existing bookings stay valid.', { okLabel: 'Deactivate', danger: true }))) return;
        await patch('/admin/hostels/' + b.dataset.toggle, { active: !on }); toast('Updated.'); reload();
      }));
    },
  };
});

// ================================================================== rooms
route('/admin/rooms', STAFF, async ({ query }) => {
  const [{ items: hostels }, { items }] = await Promise.all([get('/admin/hostels'), get('/admin/rooms' + (query.hostel ? '?hostel_id=' + query.hostel : ''))]);
  const manage = can('hostels.manage');
  return {
    title: 'Room Management',
    body: html`${pageHead('Rooms', `${items.length} rooms`, manage ? html`<button class="btn primary" id="add">Add rooms</button>` : '')}
      <div class="toolbar"><select id="hf" aria-label="Filter by hostel"><option value="">All hostels</option>${hostels.map((h) => html`<option value="${h.id}" ${String(h.id) === query.hostel ? raw('selected') : ''}>${h.name}</option>`)}</select>
        <input class="grow" id="rq" type="search" placeholder="Search room number" aria-label="Search rooms"></div>
      <div class="table-wrap"><table><thead><tr><th>Room</th><th>Hostel</th><th>Floor</th><th class="num">Bunks</th><th>Booked</th><th>Status</th><th>Medical reserve</th><th></th></tr></thead><tbody id="rows">
      ${items.map((r) => html`<tr data-n="${r.number.toLowerCase()}"><td><b>${r.number}</b></td><td>${r.hostel_name}</td><td>${floorName(r.floor)}</td><td class="num">${r.beds}${r.blocked ? html` <span class="muted small">(${r.blocked} closed)</span>` : ''}</td><td>${r.booked}/${r.beds}</td><td>${badge(r.status)}</td><td>${r.medical_reserved ? badge('info', 'Reserved') : '-'}</td>
        <td><a class="btn ghost sm" href="#/admin/bunks?room=${r.id}">Bunks</a>${manage ? html`<button class="btn ghost sm" data-edit="${r.id}">Edit</button>` : ''}</td></tr>`)}
      </tbody></table></div>`,
    mount(el) {
      el.querySelector('#hf').addEventListener('change', (e) => go('/admin/rooms' + (e.target.value ? '?hostel=' + e.target.value : '')));
      el.querySelector('#rq').addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); el.querySelectorAll('#rows tr').forEach((tr) => { tr.hidden = q && !tr.dataset.n.includes(q); }); });
      el.querySelector('#add')?.addEventListener('click', () => {
        const m = openModal('Add rooms', html`<form>
          <div class="field"><label for="a-h">Hostel</label><select id="a-h" name="hostel_id" required>${hostels.map((h) => html`<option value="${h.id}">${h.name}</option>`)}</select></div>
          <div class="grid2"><div class="field"><label for="a-n">Room number or prefix</label><input id="a-n" name="number" required maxlength="12" placeholder="M-G or M-101"><div class="hint">With more than one room, numbers are prefix + 2 digits (M-G01, M-G02...).</div></div>
          <div class="field"><label for="a-c">How many rooms</label><input id="a-c" name="count" type="number" min="1" max="60" value="1"></div>
          <div class="field"><label for="a-s">Starting number</label><input id="a-s" name="start" type="number" min="0" value="1"></div>
          <div class="field"><label for="a-f">Floor (0 = ground)</label><input id="a-f" name="floor" type="number" min="0" max="25" value="0"></div>
          <div class="field"><label for="a-cap">Beds per room</label><input id="a-cap" name="capacity" type="number" min="2" max="64" step="2" value="32"><div class="hint">Even number. Half are lower, half upper bunks.</div></div></div>
          <label class="check"><input type="checkbox" name="medical_reserved"><span>Reserve for approved medical accommodation</span></label>
          <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Create rooms</button></div><div class="form-error"></div></form>`.toString());
        submitForm(m.el.querySelector('form'), async (d) => {
          const r = await post('/admin/rooms', { ...d, hostel_id: Number(d.hostel_id), count: Number(d.count), start: Number(d.start), floor: Number(d.floor), capacity: Number(d.capacity) });
          m.close(); toast(`${r.ids.length} room${r.ids.length > 1 ? 's' : ''} created.`); reload();
        });
      });
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const r = items.find((x) => x.id === Number(b.dataset.edit));
        const m = openModal(`Room ${r.number}`, html`<form>
          <div class="field"><label for="e-s">Status</label><select id="e-s" name="status">${['open', 'closed', 'maintenance'].map((s) => html`<option ${s === r.status ? raw('selected') : ''}>${s}</option>`)}</select><div class="hint">A room can only be closed when it has no active bookings.</div></div>
          <label class="check"><input type="checkbox" name="medical_reserved" ${r.medical_reserved ? raw('checked') : ''}><span>Reserve for approved medical accommodation</span></label>
          <div class="field"><label for="e-n">Notes</label><input id="e-n" name="notes" value="${r.notes || ''}" maxlength="300"></div>
          <div class="btn-row"><button type="button" class="btn danger sm" id="del-room">Delete room</button><span style="flex:1"></span><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div><div class="form-error"></div></form>`.toString());
        submitForm(m.el.querySelector('form'), async (d) => { await patch('/admin/rooms/' + r.id, d); m.close(); toast('Room updated.'); reload(); });
        m.el.querySelector('#del-room').addEventListener('click', async () => {
          if (!(await confirmDialog('Delete room', `Delete ${r.number} and its bunks? This only works for rooms with no booking history.`, { okLabel: 'Delete', danger: true }))) return;
          try { await del('/admin/rooms/' + r.id); m.close(); toast('Room deleted.'); reload(); } catch (e) { toast(e.message, 'bad'); }
        });
      }));
    },
  };
});

// ================================================================== bunk management
route('/admin/bunks', STAFF, async ({ query }) => {
  const rooms = (await get('/admin/rooms')).items;
  if (!rooms.length) return { title: 'Bunk Management', body: html`${pageHead('Bunks')}${empty('No rooms yet', 'Create rooms first.', html`<a class="btn primary" href="#/admin/rooms">Rooms</a>`)}` };
  const roomId = Number(query.room) || rooms[0].id;
  const d = await get('/rooms/' + roomId + '/beds');
  const manage = can('hostels.manage');
  const assign = can('bookings.manage');
  const pairs = new Map();
  for (const b of d.beds) { const p = pairs.get(b.bunk_no) || {}; p[b.level] = b; pairs.set(b.bunk_no, p); }
  const bedBtn = (b, l) => !b ? '' : html`<button class="bed ${b.blocked ? 'blocked' : b.state === 'booked' ? 'booked' : b.medical_reserved ? 'reserved' : 'available'}" data-id="${b.id}" data-state="${b.state}" data-blocked="${b.blocked ? 1 : 0}" title="${b.occupant ? b.occupant.full_name : b.label}">
    <span>${l}</span><span class="lv">${b.occupant ? b.occupant.full_name.split(' ')[0] : b.blocked ? 'Closed' : b.medical_reserved ? 'Med. reserve' : 'Free'}</span></button>`;
  const stats = { free: d.beds.filter((b) => b.state === 'available').length, booked: d.beds.filter((b) => b.state === 'booked').length };
  return {
    title: 'Bunk Management',
    body: html`${pageHead(`Room ${d.room.number}`, `${d.room.hostel_name} - ${floorName(d.room.floor)} - ${stats.booked} booked, ${stats.free} free`)}
      <div class="toolbar"><select id="room-sel" aria-label="Room">${rooms.map((r) => html`<option value="${r.id}" ${r.id === roomId ? raw('selected') : ''}>${r.hostel_name} - ${r.number} (${r.booked}/${r.beds})</option>`)}</select>
        <span class="muted small">Tap bunks to select them. Tap a booked bunk to see who is in it.</span></div>
      <div class="legend"><span><i class="sw available"></i> Free</span><span><i class="sw booked"></i> Booked</span><span><i class="sw reserved"></i> Medical reserve</span><span><i class="sw blocked"></i> Closed</span><span><i class="sw selected"></i> Selected</span></div>
      <div class="card"><div class="bunk-map" id="map">${[...pairs.entries()].map(([n, p]) => html`<div class="bunk"><div class="no">Bunk ${n}</div>${bedBtn(p.upper, 'Upper')}${bedBtn(p.lower, 'Lower')}</div>`)}</div></div>
      <div class="action-bar" id="bar" hidden><b id="cnt"></b><div class="btn-row" style="margin:0">
        ${assign ? html`<button class="btn primary sm" id="b-assign" hidden>Assign corps member</button>` : ''}
        ${manage ? html`<button class="btn ghost sm" id="b-block">Close bunks</button><button class="btn ghost sm" id="b-open">Open bunks</button><button class="btn ghost sm" id="b-res">Medical reserve</button><button class="btn ghost sm" id="b-unres">Release reserve</button>` : ''}
        <button class="btn ghost sm" id="b-clear">Clear</button></div></div>`,
    mount(el) {
      const sel = new Set();
      const bar_ = el.querySelector('#bar');
      const refreshBar = () => {
        bar_.hidden = !sel.size;
        el.querySelector('#cnt').textContent = `${sel.size} selected`;
        const one = sel.size === 1 ? el.querySelector(`.bed[data-id="${[...sel][0]}"]`) : null;
        const a = el.querySelector('#b-assign'); if (a) a.hidden = !(one && one.dataset.state === 'available');
      };
      el.querySelector('#room-sel').addEventListener('change', (e) => go('/admin/bunks?room=' + e.target.value));
      el.querySelector('#map').addEventListener('click', (e) => {
        const b = e.target.closest('.bed'); if (!b) return;
        const id = Number(b.dataset.id);
        if (b.dataset.state === 'booked') {
          const bed = d.beds.find((x) => x.id === id); const o = bed.occupant;
          const m = openModal(`Bunk ${bed.label}`, html`<dl class="kv"><dt>Occupant</dt><dd>${o.full_name}</dd><dt>Call-up number</dt><dd class="mono">${o.call_up_number}</dd><dt>Status</dt><dd>${badge(o.status)}</dd><dt>Reference</dt><dd class="mono">${o.ref}</dd></dl>
            <div class="btn-row"><button class="btn ghost" id="vt">View ticket</button>${assign && o.status === 'confirmed' ? html`<button class="btn ghost" id="mv">Move</button>` : ''}${assign ? html`<button class="btn danger" id="rel">Release bunk</button>` : ''}</div>`.toString());
          m.el.querySelector('#vt').addEventListener('click', async () => { const t = (await get(`/bookings/${o.booking_id}/ticket`)).ticket; m.close(); openModal('Ticket', ticketCard(t).toString(), { wide: true }); });
          m.el.querySelector('#mv')?.addEventListener('click', () => { m.close(); pickBunk({ title: 'Move to another bunk', gender: d.room.gender, onPick: async (bed_id) => { await post(`/admin/bookings/${o.booking_id}/move`, { bed_id }); toast('Moved.'); reload(); } }); });
          m.el.querySelector('#rel')?.addEventListener('click', () => { m.close(); releaseDialog(o.booking_id, o.full_name); });
          return;
        }
        if (sel.has(id)) { sel.delete(id); b.classList.remove('admin-sel'); } else { sel.add(id); b.classList.add('admin-sel'); }
        refreshBar();
      });
      el.querySelector('#b-clear').addEventListener('click', () => { sel.clear(); el.querySelectorAll('.admin-sel').forEach((x) => x.classList.remove('admin-sel')); refreshBar(); });
      const bulk = (body, msg) => async () => { try { await patch('/admin/beds', { bed_ids: [...sel], ...body }); toast(msg); reload(); } catch (e) { toast(e.message, 'bad'); } };
      el.querySelector('#b-block')?.addEventListener('click', bulk({ status: 'blocked' }, 'Bunks closed.'));
      el.querySelector('#b-open')?.addEventListener('click', bulk({ status: 'available' }, 'Bunks opened.'));
      el.querySelector('#b-res')?.addEventListener('click', bulk({ medical_reserved: true }, 'Reserved for medical accommodation.'));
      el.querySelector('#b-unres')?.addEventListener('click', bulk({ medical_reserved: false }, 'Reserve released.'));
      el.querySelector('#b-assign')?.addEventListener('click', () => assignDialog([...sel][0], d.room.gender));
    },
  };
});

function releaseDialog(bookingId, name) {
  const m = openModal('Release bunk', html`<p>Release the bunk held by <b>${name}</b>? They will be notified.</p><form><div class="field"><label for="rr">Reason</label><input id="rr" name="reason" required minlength="3" maxlength="200" placeholder="For example: did not arrive, duplicate booking"></div>
    <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn danger" type="submit">Release</button></div><div class="form-error"></div></form>`.toString());
  submitForm(m.el.querySelector('form'), async (d) => { await post(`/admin/bookings/${bookingId}/cancel`, d); m.close(); toast('Bunk released.'); reload(); });
}

function assignDialog(bedId, gender) {
  const m = openModal('Assign a corps member', html`<div class="inline-form"><div class="field"><label for="as-q">Search name or call-up number</label><input id="as-q" type="search" autocomplete="off"></div></div><div id="as-res" style="margin-top:1rem"></div>`.toString());
  const run = async () => {
    const q = m.el.querySelector('#as-q').value;
    const d = await get(`/admin/corps?unbooked=1&size=8&q=${encodeURIComponent(q)}`);
    const rows = d.items.filter((c) => c.gender === gender);
    m.el.querySelector('#as-res').innerHTML = rows.length ? rows.map((c) => `<div class="card" style="padding:.7rem 1rem;margin-bottom:.5rem"><div class="card-head" style="margin:0"><div><b>${esc(c.full_name)}</b><div class="small muted mono">${esc(c.call_up_number)}</div></div><button class="btn primary sm" data-u="${c.id}">Assign</button></div></div>`).join('') : '<p class="muted">No unassigned corps members match.</p>';
  };
  let t; m.el.querySelector('#as-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-u]'); if (!b) return;
    try { await post('/admin/bookings/assign', { user_id: Number(b.dataset.u), bed_id: bedId }); m.close(); toast('Bunk assigned. The corps member was notified.'); reload(); } catch (err) { toast(err.message, 'bad'); }
  });
  run();
}

// ================================================================== bookings (bookings | corps members | waiting list)
route('/admin/bookings', STAFF, async ({ query }) => {
  const tab = ['bookings', 'corps', 'waitlist'].includes(query.tab) ? query.tab : 'bookings';
  const page = Number(query.page) || 1;
  const qs = new URLSearchParams({ page, size: 20 });
  for (const k of ['q', 'status', 'verification']) if (query[k]) qs.set(k, query[k]);
  if (query.unbooked) qs.set('unbooked', '1');
  const head = pageHead('Booking management', 'Bookings, corps members and the waiting list for this camp.');
  const nav = tabs([['#/admin/bookings', 'Bookings'], ['#/admin/bookings?tab=corps', 'Corps members'], ['#/admin/bookings?tab=waitlist', 'Waiting list']].map(([h, l]) => [h, l]), tab === 'bookings' ? '#/admin/bookings' : `#/admin/bookings?tab=${tab}`);
  const manage = can('bookings.manage');
  const search = (extra = '') => html`<form class="toolbar" id="sf"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search name, call-up number${tab === 'bookings' ? ', reference' : ''}" aria-label="Search">${extra}<button class="btn ghost" type="submit">Search</button></form>`;
  const link = (p) => `#/admin/bookings?${new URLSearchParams({ ...(tab !== 'bookings' ? { tab } : {}), ...(query.q ? { q: query.q } : {}), ...(query.status ? { status: query.status } : {}), ...(query.verification ? { verification: query.verification } : {}), ...(query.unbooked ? { unbooked: 1 } : {}), page: p })}`;

  let body;
  if (tab === 'bookings') {
    const d = await get('/admin/bookings?' + qs);
    body = html`${search(html`<select name="status" aria-label="Status"><option value="all">All statuses</option>${['confirmed', 'checked_in', 'cancelled', 'released'].map((s) => html`<option value="${s}" ${query.status === s ? raw('selected') : ''}>${s.replace('_', ' ')}</option>`)}</select><button class="btn ghost" type="button" id="csv">Export CSV</button>`)}
      <div class="table-wrap"><table><thead><tr><th>Ref</th><th>Corps member</th><th>Hostel / room</th><th>Bunk</th><th>Status</th><th>Booked</th><th></th></tr></thead><tbody>
      ${d.items.length ? d.items.map((b) => html`<tr><td class="mono">${b.ref}</td><td><b>${b.full_name}</b><div class="small muted mono">${b.call_up_number}</div></td><td>${b.hostel_name}<div class="small muted">${b.room_number} - ${floorName(b.floor)}</div></td><td>${b.bed_label}</td><td>${badge(b.status)}${b.source !== 'self' ? html`<div class="small muted">${b.source.replace('_', ' ')}</div>` : ''}</td><td class="small">${fmtDT(b.created_at)}</td>
        <td><button class="btn ghost sm" data-ticket="${b.id}">Ticket</button>${manage && b.status === 'confirmed' ? html`<button class="btn ghost sm" data-move="${b.id}" data-g="${b.gender}">Move</button>` : ''}${manage && ['confirmed', 'checked_in'].includes(b.status) ? html`<button class="btn ghost sm" data-rel="${b.id}" data-name="${b.full_name}">Release</button>` : ''}</td></tr>`) : html`<tr><td colspan="7">${empty('No bookings match')}</td></tr>`}</tbody></table></div>${pager(d.page, d.size, d.total, link)}`;
  } else if (tab === 'corps') {
    const d = await get('/admin/corps?' + qs);
    body = html`${search(html`<select name="verification" aria-label="Verification"><option value="">Any verification</option>${['pending', 'verified', 'rejected', 'unverified'].map((s) => html`<option value="${s}" ${query.verification === s ? raw('selected') : ''}>${s}</option>`)}</select><label class="check" style="margin:0"><input type="checkbox" name="unbooked" value="1" ${query.unbooked ? raw('checked') : ''}> No bunk yet</label>`)}
      <div class="table-wrap"><table><thead><tr><th>Corps member</th><th>Call-up number</th><th>Verification</th><th>Bunk</th><th></th></tr></thead><tbody>
      ${d.items.length ? d.items.map((c) => html`<tr><td><b>${c.full_name}</b><div class="small muted">${c.gender}, ${c.state_of_origin || ''} ${c.phone ? '- ' + c.phone : ''}</div></td><td class="mono">${c.call_up_number}</td><td>${badge(c.verification_status)}</td><td>${c.bed_label || (c.waiting ? badge('waiting', 'Waiting list') : html`<span class="muted">None</span>`)}</td>
        <td>${can('corps.verify') ? html`${c.verification_status !== 'verified' ? html`<button class="btn primary sm" data-verify="${c.id}" data-s="verified">Verify</button>` : ''}${c.verification_status !== 'rejected' && c.verification_status !== 'verified' ? html`<button class="btn ghost sm" data-verify="${c.id}" data-s="rejected">Reject</button>` : ''}` : ''}${manage && !c.bed_label ? html`<button class="btn ghost sm" data-assign="${c.id}" data-g="${c.gender}">Assign bunk</button>` : ''}</td></tr>`) : html`<tr><td colspan="5">${empty('No corps members match')}</td></tr>`}</tbody></table></div>${pager(d.page, d.size, d.total, link)}`;
  } else {
    const d = await get('/admin/waitlist');
    body = html`<div class="table-wrap"><table><thead><tr><th>#</th><th>Corps member</th><th>Joined</th><th>Priority</th><th></th></tr></thead><tbody>
      ${d.items.length ? d.items.map((w) => html`<tr><td>${w.position}</td><td><b>${w.full_name}</b><div class="small muted mono">${w.call_up_number} - ${w.gender}</div></td><td>${fmtDT(w.created_at)}</td><td>${w.priority ? badge(w.priority === 2 ? 'urgent' : 'high') : badge('routine')}</td>
        <td>${manage ? html`<button class="btn primary sm" data-promote="${w.id}">Allocate now</button><button class="btn ghost sm" data-wrm="${w.id}">Remove</button>` : ''}</td></tr>`) : html`<tr><td colspan="5">${empty('The waiting list is empty', 'People are added here when no suitable bunk is free. They are allocated automatically as bunks are released.')}</td></tr>`}</tbody></table></div>`;
  }
  return {
    title: 'Booking Management',
    body: html`${head}${nav}${body}`,
    mount(el) {
      const sf = el.querySelector('#sf');
      sf?.addEventListener('submit', (e) => {
        e.preventDefault();
        const f = new FormData(sf); const p = new URLSearchParams();
        if (tab !== 'bookings') p.set('tab', tab);
        for (const [k, v] of f) if (v && v !== 'all') p.set(k, v);
        go('/admin/bookings' + (p.size ? '?' + p : ''));
      });
      el.querySelector('#csv')?.addEventListener('click', () => downloadApi('/admin/bookings.csv?' + new URLSearchParams({ ...(query.q ? { q: query.q } : {}), ...(query.status ? { status: query.status } : {}) }), 'campspace-bookings.csv'));
      el.querySelectorAll('[data-ticket]').forEach((b) => b.addEventListener('click', async () => { const t = (await get(`/bookings/${b.dataset.ticket}/ticket`)).ticket; openModal('Ticket', ticketCard(t).toString(), { wide: true }); }));
      el.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', () => pickBunk({ title: 'Move to another bunk', gender: b.dataset.g, onPick: async (bed_id) => { await post(`/admin/bookings/${b.dataset.move}/move`, { bed_id }); toast('Moved.'); reload(); } })));
      el.querySelectorAll('[data-rel]').forEach((b) => b.addEventListener('click', () => releaseDialog(b.dataset.rel, b.dataset.name)));
      el.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => { await post(`/admin/corps/${b.dataset.verify}/verify`, { status: b.dataset.s }); toast(b.dataset.s === 'verified' ? 'Verified.' : 'Marked as rejected.'); reload(); }));
      el.querySelectorAll('[data-assign]').forEach((b) => b.addEventListener('click', () => pickBunk({ title: 'Assign a bunk', gender: b.dataset.g, onPick: async (bed_id) => { await post('/admin/bookings/assign', { user_id: Number(b.dataset.assign), bed_id }); toast('Bunk assigned.'); reload(); } })));
      el.querySelectorAll('[data-promote]').forEach((b) => b.addEventListener('click', async () => { try { await post(`/admin/waitlist/${b.dataset.promote}/promote`, {}); toast('Allocated.'); reload(); } catch (e) { toast(e.message, 'bad'); } }));
      el.querySelectorAll('[data-wrm]').forEach((b) => b.addEventListener('click', async () => { if (await confirmDialog('Remove from waiting list', 'The corps member will be notified.', { okLabel: 'Remove', danger: true })) { await del('/admin/waitlist/' + b.dataset.wrm); reload(); } }));
    },
  };
});

// ================================================================== check-in
let stopScan = null;
route('/admin/checkin', STAFF, async () => {
  const d = await get('/admin/checkins');
  const supported = 'BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia;
  return {
    title: 'Check-in Management',
    body: html`${pageHead('Check-in desk', `${d.totals.checked_in || 0} of ${d.totals.active || 0} booked corps members are checked in.`)}
      <div class="cols">
        <div>
          <div class="card"><h2>Scan a ticket</h2>
            ${supported ? html`<div class="scan-box" id="scanbox" hidden><video id="video" playsinline muted></video><div class="frame"></div></div>
              <div class="btn-row"><button class="btn primary" id="scan">Start camera</button><button class="btn ghost" id="stopscan" hidden>Stop camera</button></div>`
              : html`<p class="muted">Camera scanning is not supported in this browser. Use the box below, or open CampSpace in Chrome on Android.</p>`}
            <form id="manual" style="margin-top:1rem"><div class="inline-form"><div class="field"><label for="code">Or type the booking reference, QR text or call-up number</label><input id="code" name="code" required autocomplete="off" autocapitalize="characters" placeholder="K7M3Q9XP or EN/26C/4521"></div><button class="btn primary" type="submit">Verify</button></div><div class="form-error" role="alert"></div></form>
          </div>
          <div id="result"></div>
        </div>
        <div class="card"><h2>Recently checked in</h2>${d.items.length ? html`<ul class="timeline">${d.items.map((x) => html`<li><span><b>${x.full_name}</b><br><span class="small muted">${x.label} - by ${x.by_name || 'officer'}</span></span><span class="small muted">${ago(x.checked_in_at)}</span></li>`)}</ul>` : empty('No check-ins yet')}</div>
      </div>`,
    mount(el) {
      const out = el.querySelector('#result');
      const showResult = (r) => {
        const t = r.ticket;
        out.innerHTML = html`<div class="result ${r.state}"><div class="card-head"><h2 style="margin:0">${r.state === 'ready' ? 'Valid ticket' : r.state === 'already_checked_in' ? 'Already checked in' : 'Not valid'}</h2>${badge(t.status)}</div>
          <p><b>${r.message}</b>${r.signed ? '' : ' (found by reference or call-up number, not by QR signature)'}</p>
          <dl class="kv"><dt>Name</dt><dd>${t.corper.name}</dd><dt>Call-up number</dt><dd class="mono">${t.corper.call_up_number} ${badge(t.corper.verification_status)}</dd><dt>Hostel</dt><dd>${t.hostel.name}</dd><dt>Room / bunk</dt><dd>${t.room.number} - ${floorName(t.room.floor)} - ${t.bed.label}</dd>
          ${t.medical.length ? html`<dt>Medical accommodation</dt><dd>${t.medical.join(', ')}</dd>` : ''}</dl>
          <div class="btn-row">${r.state === 'ready' ? html`<button class="btn primary lg" id="do-checkin">Check in</button>` : ''}${r.state === 'already_checked_in' ? html`<button class="btn ghost" id="undo">Undo check-in</button>` : ''}</div></div>`.toString();
        out.querySelector('#do-checkin')?.addEventListener('click', async (e) => { e.target.disabled = true; try { await post('/admin/checkin', { booking_id: t.id }); toast(`${t.corper.name} is checked in.`); reload(); } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; } });
        out.querySelector('#undo')?.addEventListener('click', async () => { if (await confirmDialog('Undo check-in', 'Mark this corps member as not yet checked in?', { okLabel: 'Undo' })) { await post('/admin/checkin/undo', { booking_id: t.id }); reload(); } });
        out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
      const verify = async (code) => {
        try { showResult(await post('/admin/verify', { code })); }
        catch (err) { out.innerHTML = html`<div class="result inactive"><h2>Ticket not accepted</h2><p>${err.message}</p></div>`.toString(); }
      };
      submitForm(el.querySelector('#manual'), async (d) => { await verify(d.code.trim()); el.querySelector('#code').select(); });
      if (!supported) return;
      let stream = null; let timer = null; let busy = false; let lastCode = '';
      const stop = () => { clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); stream = null; el.querySelector('#scanbox').hidden = true; el.querySelector('#scan').hidden = false; el.querySelector('#stopscan').hidden = true; };
      stopScan = stop;
      el.querySelector('#stopscan').addEventListener('click', stop);
      el.querySelector('#scan').addEventListener('click', async () => {
        try {
          const det = new BarcodeDetector({ formats: ['qr_code'] });
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
          const v = el.querySelector('#video'); v.srcObject = stream; await v.play();
          el.querySelector('#scanbox').hidden = false; el.querySelector('#scan').hidden = true; el.querySelector('#stopscan').hidden = false;
          timer = setInterval(async () => {
            if (busy) return; busy = true;
            try { const codes = await det.detect(v); const c = codes[0]?.rawValue; if (c && c !== lastCode) { lastCode = c; await verify(c); navigator.vibrate?.(60); setTimeout(() => { lastCode = ''; }, 4000); } } catch { /* frame not ready */ }
            busy = false;
          }, 350);
        } catch (err) { toast('Could not open the camera: ' + (err.message || 'permission denied') + '. Use the manual box instead.', 'bad'); }
      });
      window.addEventListener('hashchange', () => { stop(); }, { once: true });
    },
  };
});

// ================================================================== medical accommodation instructions
route('/admin/medical', STAFF, async () => {
  const d = await get('/admin/medical-instructions');
  const assign = can('bookings.manage');
  const todo = d.items.filter((x) => !x.booking || x.conflict);
  return {
    title: 'Medical Accommodation Instructions',
    body: html`${pageHead('Medical accommodation instructions', 'Approved needs from the camp medical team. Diagnoses are never shown here.')}
      <div class="kpis">${kpi(d.items.length, 'Approved cases')}${kpi(todo.length, 'Need allocation', todo.length ? 'bad' : '')}${kpi(d.items.filter((x) => x.booking && !x.conflict).length, 'Correctly placed')}</div>
      ${d.items.length ? d.items.map((x) => html`<div class="card ${x.conflict || !x.booking ? 'notice warn' : ''}">
        <div class="card-head"><div><h3>${x.full_name}</h3><span class="small muted mono">${x.call_up_number} - ${x.gender}</span></div><div>${badge(x.priority)} ${x.booking ? (x.conflict ? badge('warn', 'Bunk does not match') : badge('ok', 'Placed')) : x.waiting ? badge('waiting', 'On waiting list') : badge('bad', 'No bunk yet')}</div></div>
        <div class="pill-row">${x.need_labels.map((n) => html`<span class="pill">${n}</span>`)}</div>
        ${x.instruction ? html`<p style="margin:.7rem 0 0"><b>Instruction:</b> ${x.instruction}</p>` : ''}
        <p class="small muted" style="margin:.6rem 0 0">${x.booking ? `Current bunk: ${x.booking.hostel_name}, room ${x.booking.room_number}, ${x.booking.label} (${floorName(x.booking.floor)}, ${x.booking.level})` : `${x.suitable_free} suitable bunk${x.suitable_free === 1 ? '' : 's'} free`}</p>
        ${assign && (!x.booking || (x.conflict && x.booking.status === 'confirmed')) ? html`<div class="btn-row"><button class="btn primary sm" data-auto="${x.request_id}">${x.booking ? 'Move to a suitable bunk' : 'Allocate automatically'}</button><button class="btn ghost sm" data-pick="${x.request_id}" data-g="${x.gender}">Choose a bunk</button></div>` : ''}
      </div>`) : html`<div class="card">${empty('No approved medical cases', 'When the camp medical team approves an accommodation need it appears here.')}</div>`}`,
    mount(el) {
      el.querySelectorAll('[data-auto]').forEach((b) => b.addEventListener('click', async () => { b.disabled = true; try { await post(`/admin/medical-instructions/${b.dataset.auto}/allocate`, {}); toast('Allocated. The corps member was notified.'); reload(); } catch (e) { toast(e.message, 'bad'); b.disabled = false; } }));
      el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => pickBunk({ title: 'Choose a bunk', gender: b.dataset.g, onPick: async (bed_id) => { await post(`/admin/medical-instructions/${b.dataset.pick}/allocate`, { bed_id }); toast('Allocated.'); reload(); } })));
    },
  };
});

// ================================================================== reports
export function reportBody(r) {
  const medStatus = Object.fromEntries(r.medical.by_status.map((x) => [x.status, x.n]));
  return html`
    <div class="kpis">${kpi(num(r.capacity.bookable), 'Bookable bunks')}${kpi(num(r.bookings.active), 'Booked')}${kpi(r.bookings.occupancy_pct + '%', 'Occupancy')}${kpi(num(r.bookings.checked_in), 'Checked in')}${kpi(num(r.corps.registered), 'Registered corps members')}${kpi(num(r.corps.verified), 'Call-ups verified')}${kpi(num(r.waitlist.waiting), 'Waiting list')}${kpi(num(r.cancellations.cancelled + r.cancellations.released), 'Cancelled or released')}</div>
    <div class="cols">
      <div class="card"><h2>Occupancy by hostel</h2>${hbars(r.by_hostel.map((h) => ({ label: h.name, value: h.booked, total: h.beds, text: `${h.booked}/${h.beds} (${pct(h.booked, h.beds)}%)`, tone: tone(pct(h.booked, h.beds)) })))}</div>
      <div class="card"><h2>Occupancy by floor</h2>${hbars(r.by_floor.map((f) => ({ label: floorName(f.floor), value: f.booked, total: f.beds, text: `${f.booked}/${f.beds}` })))}</div>
      <div class="card"><h2>Bookings per day</h2>${dayChart(r.per_day)}</div>
      <div class="card"><h2>Gender</h2>${hbars([{ label: 'Male', value: r.corps.male }, { label: 'Female', value: r.corps.female }])}<h2 style="margin-top:1.2rem">How bunks were booked</h2>${hbars(r.by_source.map((s) => ({ label: s.source.replace('_', ' '), value: s.n })))}</div>
      <div class="card"><h2>Top states of origin</h2>${hbars(r.by_state.map((s) => ({ label: s.state, value: s.n })))}</div>
      <div class="card"><h2>Medical requests</h2>${hbars(['submitted', 'under_review', 'more_info', 'approved', 'rejected'].map((s) => ({ label: s.replace('_', ' '), value: medStatus[s] || 0 })))}<p class="small muted">Open requests by priority: ${r.medical.by_priority.map((p) => `${p.priority} ${p.n}`).join(', ') || 'none'}</p></div>
    </div>`;
}
route('/admin/reports', STAFF, async () => {
  const d = await get('/admin/reports');
  return {
    title: 'Reports and Analytics',
    body: html`${pageHead('Reports and analytics', `${d.camp.name} - generated ${fmtDT(d.generated_at)}`, html`<button class="btn ghost" id="csv">Export occupancy CSV</button><button class="btn ghost" id="print">Print</button>`)}${reportBody(d.report)}`,
    mount(el) {
      el.querySelector('#csv').addEventListener('click', () => downloadApi('/admin/reports.csv', 'campspace-occupancy.csv'));
      el.querySelector('#print').addEventListener('click', () => window.print());
    },
  };
});
void $; void current; void needLabel;
