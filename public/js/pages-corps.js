import {
  S, firstName, html, raw, esc, route, go, get, post, patch, del, api, toast, submitForm, draftForm, clearDraft, confirmDialog, openModal, badge,
  fmtDT, fmtD, ago, floorName, bar, empty, qrSvg, bytes, needLabel, downloadApi, newRef, refreshMe, ROLE_HOME, current, can,
  saveTicket, loadSavedTicket, forgetTicket, saveRoomCache, loadRoomCache, saveHostelsCache, loadHostelsCache,
  queueBooking, queuedItems, cancelQueued, outcomes, dismissOutcome, syncQueue, wipeLocalData, kvList, reload, $, $$,
} from './core.js';
import { pageHead } from './shell.js';

const CORPS = ['corps_member'];
const ANY = 'any';

// re-render the current page when the server tells us something changed (only if still on that page)
let liveCleanup = null;
function live(events, pathPrefix, fn = reload, delay = 350) {
  liveCleanup?.();
  let t = null;
  const h = () => {
    if (!current.path.startsWith(pathPrefix) || $('.modal-wrap')) return;
    clearTimeout(t);
    t = setTimeout(fn, delay);
  };
  events.forEach((e) => window.addEventListener(e, h));
  liveCleanup = () => events.forEach((e) => window.removeEventListener(e, h));
}

const savedNote = (iso) => html`<div class="card notice warn no-print"><b>Offline copy.</b> Saved ${fmtDT(iso)}. Availability and status may have changed since then.</div>`;

// ================================================================== dashboard
route('/app', CORPS, async () => {
  let cur = null;
  let offline = false;
  try {
    cur = await get('/bookings/current');
    if (cur.booking) await saveTicket(cur.booking); else await forgetTicket();
  } catch (e) { if (!e.offline) throw e; offline = true; }
  const saved = offline ? await loadSavedTicket() : null;
  const t = cur?.booking || saved?.ticket;
  const queue = await queuedItems();
  const outs = await outcomes();
  const u = S.user;
  const verified = u.verification_status === 'verified';
  const booked = !!t && ['confirmed', 'checked_in'].includes(t.status);
  const checked = t?.status === 'checked_in';
  const steps = [['Registered', true], ['Call-up verified', verified], ['Bunk booked', booked], ['Checked in', checked]];
  const nowIdx = steps.findIndex(([, d]) => !d);
  const w = cur?.window;
  return {
    title: 'Dashboard',
    live: true,
    body: html`
      ${pageHead(`Hello, ${firstName(u.full_name)}`, S.camp ? `${S.camp.name} - ${S.camp.batch}` : '')}
      ${offline ? html`<div class="card notice warn"><b>You are offline.</b> Showing what was saved on this device.</div>` : ''}
      <div class="card"><h2>Your journey</h2>
        <ol class="journey">${steps.map(([l, d], i) => html`<li class="${d ? 'done' : i === nowIdx ? 'now' : ''}">${l}</li>`)}</ol>
        ${!verified ? html`<p class="small muted" style="margin:1rem 0 0">Call-up number ${badge(u.verification_status)} An accommodation officer verifies it. ${u.verification_status === 'rejected' ? 'Please correct it in Profile Settings.' : ''}</p>` : ''}
      </div>
      ${outs.map((o) => html`<div class="card notice ${o.ok ? '' : 'bad'}"><div class="card-head"><b>${o.ok ? `Your saved booking request was confirmed (${o.label}).` : `Your saved request for ${o.label} could not be confirmed.`}</b><button class="btn ghost sm" data-dismiss="${o.client_ref}">Dismiss</button></div>${o.ok ? '' : html`<p>${o.message}</p><a class="btn primary sm" href="#/app/bunks">Choose another bunk</a>`}</div>`)}
      <div class="cols">
        <div class="card">
          <h2>My accommodation</h2>
          ${booked ? html`
            <dl class="kv"><dt>Status</dt><dd>${badge(t.status)}${offline ? ' (offline copy)' : ''}</dd><dt>Hostel</dt><dd>${t.hostel.name}</dd><dt>Room</dt><dd>${t.room.number} - ${floorName(t.room.floor)}</dd><dt>Bunk</dt><dd>${t.bed.label} (${t.bed.level})</dd><dt>Reference</dt><dd class="mono">${t.ref}</dd></dl>
            <div class="btn-row"><a class="btn primary" href="#/app/accommodation">View ticket</a></div>`
            : queue.length ? html`<div class="notice warn card" style="margin:0"><b>Pending - not confirmed</b><p>Your request for ${queue[0].label} is saved on this device and will be sent when you are online. The bunk is only yours once it is confirmed.</p></div>`
            : cur?.waitlist ? html`<p><b>You are on the waiting list.</b> Position ${cur.waitlist.position}. You will be allocated the first suitable bunk that becomes free.</p><div class="btn-row"><a class="btn ghost" href="#/app/accommodation">See details</a></div>`
            : html`<p>You have not chosen a bunk yet.</p>
              ${w && !w.open ? html`<div class="card notice warn" style="margin:0 0 1rem">${w.reason}</div>` : ''}
              <div class="btn-row"><a class="btn primary lg" href="#/app/book">Choose my bunk</a></div>`}
        </div>
        <div class="card">
          <h2>Camp</h2>
          <dl class="kv"><dt>Camp</dt><dd>${S.camp?.name || '-'}</dd><dt>State</dt><dd>${S.camp?.state || '-'}</dd><dt>Booking</dt><dd>${w ? (w.open ? badge('open', 'Open') : badge('closed', 'Closed')) : '-'}</dd></dl>
          ${w && !w.open ? html`<p class="small muted" style="margin-top:.6rem">${w.reason}</p>` : ''}
        </div>
        <div class="card"><h2>Medical support</h2>
          ${S.medNeeds.length ? html`<p>Approved accommodation:</p><div class="pill-row">${S.medNeeds.map((n) => html`<span class="pill">${needLabel(n)}</span>`)}</div>`
            : html`<p>If you have a medical condition that affects where you can sleep, tell the camp clinic before you book.</p>`}
          <div class="btn-row"><a class="btn ghost" href="#/app/medical">Medical support</a></div>
        </div>
      </div>`,
    mount(el) {
      live(['cs:beds', 'cs:sync', 'cs:notify'], '/app', reload, 600);
      el.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => { await dismissOutcome(b.dataset.dismiss); reload(); }));
    },
  };
});

// ================================================================== hostel booking
route('/app/book', CORPS, async () => {
  let d; let savedAt = null;
  try { d = await get('/hostels'); await saveHostelsCache(d); }
  catch (e) { if (!e.offline) throw e; const c = await loadHostelsCache(); if (!c) throw e; d = c.data; savedAt = c.saved_at; }
  let cur = null;
  try { cur = await get('/bookings/current'); } catch { /* offline */ }
  const hasBooking = !!cur?.booking;
  const closed = d.window && !d.window.open;
  const needs = d.medical_needs || [];
  return {
    title: 'Hostel Booking',
    body: html`
      ${pageHead('Hostel booking', `${d.camp.name}. Choose a room, then pick your bunk.`, closed ? '' : html`<button class="btn primary" id="auto" ${hasBooking ? 'disabled' : ''}>Pick a bunk for me</button>`)}
      ${savedAt ? savedNote(savedAt) : ''}
      ${closed ? html`<div class="card notice warn"><b>Booking is not open.</b> ${d.window.reason}</div>` : ''}
      ${hasBooking ? html`<div class="card notice info"><b>You already have bunk ${cur.booking.bed.label}.</b> Choosing another bunk will move you to it. <a href="#/app/accommodation">View my ticket</a></div>` : ''}
      ${needs.length ? html`<div class="card notice"><b>Your approved medical accommodation is applied.</b> You will only be offered bunks that suit you: ${needs.map((n) => needLabel(n)).join(', ')}.</div>` : ''}
      <div class="toolbar no-print"><label class="check" style="margin:0"><input type="checkbox" id="only-free" checked> Only rooms with free bunks</label>
        <select id="floor-f" aria-label="Filter by floor"><option value="">All floors</option>${[...new Set(d.hostels.flatMap((h) => h.rooms.map((r) => r.floor)))].sort().map((f) => html`<option value="${f}">${floorName(f)}</option>`)}</select></div>
      ${d.hostels.length ? '' : empty('No hostel for you yet', 'Your camp has not published a hostel for your gender yet. Check back soon.')}
      ${d.hostels.map((h) => html`
        <div class="card"><div class="card-head"><div><h2>${h.name}</h2><span class="muted small">${h.description || ''}</span></div>
          <div style="min-width:180px"><b>${h.available}</b> free of ${h.total}${bar(h.total ? (h.booked / h.total) * 100 : 0, { tone: h.available < h.total * 0.1 ? 'r' : h.available < h.total * 0.3 ? 'w' : 'g', label: 'Occupancy' })}</div></div>
          ${[...new Set(h.rooms.map((r) => r.floor))].sort().map((f) => html`
            <div class="floor-grp" data-floor="${f}"><div class="floor-title"><h3>${floorName(f)}</h3></div>
              <div class="room-grid">${h.rooms.filter((r) => r.floor === f).map((r) => {
    const unavailable = r.status !== 'open';
    const full = unavailable || r.available === 0;
    return html`<a class="room-card ${full ? 'full' : ''} ${r.mine ? 'mine' : ''}" data-free="${full ? 0 : 1}" href="#/app/bunks?room=${r.id}" aria-label="Room ${r.number}, ${r.available} bunks free">
                  ${r.mine ? html`<span class="badge b-ok tag">Yours</span>` : unavailable ? html`<span class="badge b-warn tag">${r.status}</span>` : r.available === 0 && r.reserved ? html`<span class="badge b-info tag">Reserved</span>` : ''}
                  <b>${r.number}</b><small>${r.available} free of ${r.total}</small>${bar(r.total ? (r.booked / r.total) * 100 : 0, { tone: r.available < 4 ? 'r' : 'g' })}</a>`;
  })}</div></div>`)}
        </div>`)}`,
    mount(el) {
      live(['cs:beds'], '/app/book');
      const apply = () => {
        const onlyFree = el.querySelector('#only-free').checked;
        const floor = el.querySelector('#floor-f').value;
        el.querySelectorAll('.room-card').forEach((c) => { c.hidden = onlyFree && c.dataset.free === '0'; });
        el.querySelectorAll('.floor-grp').forEach((g) => { g.hidden = (floor !== '' && g.dataset.floor !== floor) || ![...g.querySelectorAll('.room-card')].some((c) => !c.hidden); });
      };
      el.querySelector('#only-free')?.addEventListener('change', apply);
      el.querySelector('#floor-f')?.addEventListener('change', apply);
      apply();
      el.querySelector('#auto')?.addEventListener('click', async (e) => {
        if (!(await confirmDialog('Pick a bunk for me', 'We will choose a suitable free bunk for you and confirm it straight away. Continue?', { okLabel: 'Book it' }))) return;
        e.target.disabled = true;
        try { await post('/bookings/auto', { client_ref: newRef() }); toast('Booking confirmed.'); go('/app/accommodation'); }
        catch (err) {
          e.target.disabled = false;
          if (err.code === 'FULL') { toast(err.message, 'bad'); go('/app/accommodation'); } else toast(err.offline ? 'You are offline. Choose a bunk from a room and it will be saved as pending.' : err.message, 'bad');
        }
      });
    },
  };
});

// ================================================================== bunk selection
let selected = null;
route('/app/bunks', CORPS, async ({ query }) => {
  let hostels; let cur = null; let savedAt = null;
  try { const d = await get('/hostels'); hostels = d; await saveHostelsCache(d); }
  catch (e) { if (!e.offline) throw e; const c = await loadHostelsCache(); if (c) { hostels = c.data; savedAt = c.saved_at; } }
  try { cur = await get('/bookings/current'); } catch { /* offline */ }
  const rooms = (hostels?.hostels || []).flatMap((h) => h.rooms.map((r) => ({ ...r, hostel: h.name })));
  let roomId = Number(query.room || 0);
  if (!roomId) {
    const needsGround = (hostels?.medical_needs || []).some((n) => n === 'ground_floor' || n === 'wheelchair_access');
    const pick = rooms.find((r) => r.mine) || rooms.find((r) => r.status === 'open' && r.available > 0 && (!needsGround || r.floor === 0)) || rooms[0];
    if (!pick) return { title: 'Bunk Selection', body: html`${pageHead('Bunk selection')}${empty('No rooms to show', 'Open Hostel Booking to see rooms, or connect to the internet.', html`<a class="btn primary" href="#/app/book">Hostel booking</a>`)}` };
    go('/app/bunks?room=' + pick.id);
    return null;
  }
  let data;
  try { data = await get('/rooms/' + roomId + '/beds'); await saveRoomCache(roomId, data); savedAt = null; }
  catch (e) { if (!e.offline) throw e; const c = await loadRoomCache(roomId); if (!c) throw e; data = c.data; savedAt = c.saved_at; }
  const queue = (await queuedItems())[0];
  const hold = cur?.booking && ['confirmed'].includes(cur.booking.status) ? cur.booking : null;
  const locked = cur?.booking?.status === 'checked_in';
  const closed = cur?.window && !cur.window.open;
  const pairs = new Map();
  for (const b of data.beds) { const p = pairs.get(b.bunk_no) || {}; p[b.level] = b; pairs.set(b.bunk_no, p); }
  const GLYPH = { available: '&#9675;', booked: '&#10005;', mine: '&#9733;', blocked: '&#8856;', reserved: '&#9679;', restricted: '&#9651;' };
  const WORD = { available: 'Free', booked: 'Taken', mine: 'Yours', blocked: 'Closed', reserved: 'Reserved', restricted: 'Not for you' };
  const bed = (b, lvl) => !b ? '' : html`<button class="bed ${b.state} ${selected === b.id && b.state === 'available' ? 'selected' : ''}" data-bed="${b.id}" data-label="${b.label}" data-level="${b.level}" ${b.state !== 'available' || closed || locked ? 'disabled' : ''} aria-label="${b.label}, ${lvl} bunk, ${WORD[b.state]}"><span class="st" aria-hidden="true">${raw(GLYPH[b.state])}</span><span>${lvl}</span><span class="lv">${WORD[b.state]}</span></button>`;
  const free = data.beds.filter((b) => b.state === 'available').length;
  return {
    title: `Room ${data.room.number}`,
    body: html`
      ${pageHead(`Room ${data.room.number}`, `${data.room.hostel_name} - ${floorName(data.room.floor)} - ${free} of ${data.beds.length} bunks free`)}
      ${savedAt ? savedNote(savedAt) : ''}
      ${closed ? html`<div class="card notice warn">${cur.window.reason}</div>` : ''}
      ${locked ? html`<div class="card notice info">You are checked in. To change bunk, ask an accommodation officer.</div>` : ''}
      ${queue ? html`<div class="card notice warn"><div class="card-head"><div><b>Pending - not confirmed.</b> Your request for ${queue.label} is saved on this device and will be sent when you are online.</div><button class="btn ghost sm" id="cancel-q" data-ref="${queue.client_ref}">Cancel request</button></div></div>` : ''}
      <div class="toolbar no-print"><label for="room-sel" class="small muted" style="margin:0">Room</label>
        <select id="room-sel">${rooms.map((r) => html`<option value="${r.id}" ${r.id === roomId ? 'selected' : ''}>${r.number} (${floorName(r.floor)}) - ${r.status === 'open' ? `${r.available} free` : r.status}</option>`)}</select>
        <a class="btn ghost sm" href="#/app/book">All rooms</a></div>
      ${data.medical_needs.length ? html`<div class="card notice"><b>Medical accommodation applied.</b> Bunks that do not suit your approved needs are marked "Not for you".</div>` : ''}
      <div class="legend" aria-label="Legend">
        <span><i class="sw available"></i> Free</span><span><i class="sw selected"></i> Selected</span><span><i class="sw booked"></i> Taken</span><span><i class="sw mine"></i> Yours</span>
        <span><i class="sw reserved"></i> Medical reserve</span><span><i class="sw restricted"></i> Not for you</span><span><i class="sw blocked"></i> Closed</span></div>
      <div class="card"><div class="bunk-map" id="map">
        ${[...pairs.entries()].map(([n, p]) => html`<div class="bunk"><div class="no">Bunk ${n}</div>${bed(p.upper, 'Upper')}${bed(p.lower, 'Lower')}</div>`)}
      </div></div>
      <div class="action-bar" id="bar" hidden>
        <div><b id="sel-label"></b><div class="small muted">${hold ? `This will move you from ${hold.bed.label}.` : 'Your bunk is confirmed as soon as the server accepts it.'}</div></div>
        <div class="btn-row" style="margin:0"><button class="btn ghost" id="clear">Clear</button><button class="btn primary" id="confirm">${hold ? 'Change to this bunk' : 'Confirm bunk'}</button></div>
      </div>`,
    mount(el) {
      live(['cs:beds'], '/app/bunks');
      const bar_ = el.querySelector('#bar');
      const show = (id) => {
        selected = id;
        el.querySelectorAll('.bed').forEach((b) => b.classList.toggle('selected', Number(b.dataset.bed) === id && b.classList.contains('available')));
        const b = id ? el.querySelector(`.bed[data-bed="${id}"]`) : null;
        bar_.hidden = !b;
        if (b) el.querySelector('#sel-label').textContent = `${b.dataset.label} - ${b.dataset.level === 'lower' ? 'Lower' : 'Upper'} bunk, room ${data.room.number}`;
      };
      if (selected && !el.querySelector(`.bed.available[data-bed="${selected}"]`)) { if (selected) toast('The bunk you selected is no longer free.', 'info'); selected = null; }
      show(selected);
      el.querySelector('#map').addEventListener('click', (e) => { const b = e.target.closest('.bed'); if (b && !b.disabled) show(Number(b.dataset.bed)); });
      el.querySelector('#clear').addEventListener('click', () => show(null));
      el.querySelector('#room-sel').addEventListener('change', (e) => { selected = null; go('/app/bunks?room=' + e.target.value); });
      el.querySelector('#cancel-q')?.addEventListener('click', async (e) => { await cancelQueued(e.target.dataset.ref); toast('Saved request cancelled.'); reload(); });
      el.querySelector('#confirm').addEventListener('click', async (e) => {
        const id = selected;
        const b = el.querySelector(`.bed[data-bed="${id}"]`);
        const label = b.dataset.label;
        e.target.disabled = true;
        try {
          if (hold) await post(`/bookings/${hold.id}/change`, { bed_id: id });
          else await post('/bookings', { bed_id: id, client_ref: newRef() });
          selected = null;
          toast(`Bunk ${label} is confirmed.`);
          go('/app/accommodation');
        } catch (err) {
          e.target.disabled = false;
          if (err.offline) {
            if (hold) return toast('You are offline. Changing a confirmed bunk needs a connection.', 'bad');
            const ok = await confirmDialog('Save request for later?', `You are offline. We can save your request for ${label} and send it when you are back online. It will NOT be confirmed until then, and the bunk may be taken by someone else in the meantime.`, { okLabel: 'Save request' });
            if (!ok) return;
            await queueBooking({ bed_id: id, label, room_id: roomId });
            selected = null;
            toast('Saved as pending. NOT confirmed yet.', 'info');
            reload();
          } else {
            toast(err.message, 'bad');
            if (['BED_TAKEN', 'BED_UNAVAILABLE', 'BED_RESERVED', 'BED_RESTRICTED'].includes(err.code)) { selected = null; reload(); }
            if (err.code === 'ALREADY_BOOKED') go('/app/accommodation');
          }
        }
      });
    },
  };
});

// ================================================================== my accommodation / ticket
export function ticketCard(t, { stale = false, savedAt = null } = {}) {
  const ok = ['confirmed', 'checked_in'].includes(t.status);
  return html`<article class="ticket ${stale ? 'stale' : ''}" aria-label="Accommodation ticket">
    <div class="ticket-top"><div><small>NYSC orientation camp accommodation ticket</small><h2>CampSpace</h2></div><div>${stale ? html`<span class="badge b-warn">Offline copy</span>` : badge(t.status)}</div></div>
    <div class="ticket-body">
      <div>
        <div class="muted small">Booking reference</div><div class="big-ref">${t.ref}</div>
        <dl class="kv" style="margin-top:1rem">
          <dt>Corps member</dt><dd>${t.corper.name}</dd><dt>Call-up number</dt><dd class="mono">${t.corper.call_up_number}</dd>
          <dt>Camp</dt><dd>${t.camp.name} (${t.camp.state})</dd><dt>Hostel</dt><dd>${t.hostel.name}</dd>
          <dt>Room</dt><dd>${t.room.number} - ${floorName(t.room.floor)}</dd><dt>Bunk</dt><dd>${t.bed.label} (${t.bed.level === 'lower' ? 'Lower' : 'Upper'})</dd>
          ${t.medical.length ? html`<dt>Medical accommodation</dt><dd>${t.medical.join(', ')}</dd>` : ''}
          ${t.checked_in_at ? html`<dt>Checked in</dt><dd>${fmtDT(t.checked_in_at)}</dd>` : ''}
        </dl>
      </div>
      <div class="ticket-qr">${ok ? qrSvg(t.qr, { label: `QR code for booking ${t.ref}` }) : ''}<code>${ok ? t.qr : ''}</code></div>
    </div>
    <div class="ticket-foot">${stale ? `Saved on this device ${fmtDT(savedAt)}. Status may have changed. The officer's scan at camp is the final check.` : 'Show this QR code and your NYSC call-up letter at the accommodation desk.'}</div>
  </article>`;
}

route('/app/accommodation', CORPS, async () => {
  let cur = null; let stale = null;
  try {
    cur = await get('/bookings/current');
    if (cur.booking) await saveTicket(cur.booking); else await forgetTicket();
  } catch (e) { if (!e.offline) throw e; stale = await loadSavedTicket(); }
  const t = cur ? cur.booking : stale?.ticket;
  const queue = await queuedItems();
  const outs = await outcomes();
  const active = t && ['confirmed', 'checked_in'].includes(t.status);
  return {
    title: 'My Accommodation',
    body: html`
      ${pageHead('My accommodation', '', active && !stale ? html`<button class="btn ghost" id="print">Print</button><button class="btn primary" id="pdf">Download PDF</button>` : active ? html`<button class="btn ghost" id="print">Print</button>` : '')}
      ${stale ? html`<div class="card notice warn"><b>You are offline.</b> This is the ticket saved on this device on ${fmtDT(stale.saved_at)}. Its status may have changed.</div>` : ''}
      ${outs.map((o) => html`<div class="card notice ${o.ok ? '' : 'bad'}"><div class="card-head"><b>${o.ok ? `Saved request confirmed: ${o.label}` : `Saved request not confirmed: ${o.label}`}</b><button class="btn ghost sm" data-dismiss="${o.client_ref}">Dismiss</button></div>${o.ok ? '' : html`<p>${o.message}</p>`}</div>`)}
      ${queue.map((q) => html`<div class="card notice warn"><div class="card-head"><div><b>Pending - not confirmed.</b> Request for ${q.label}, saved ${ago(q.created_at)}. It is sent automatically when you are online; the bunk is only yours once confirmed.</div><button class="btn ghost sm" data-cancelq="${q.client_ref}">Cancel request</button></div></div>`)}
      ${active ? ticketCard(t, { stale: !!stale, savedAt: stale?.saved_at }) : html`
        ${!queue.length && !cur?.waitlist ? html`<div class="card">${empty('No accommodation yet', t && t.status === 'cancelled' ? 'Your last booking was cancelled.' : 'Choose a hostel room and bunk to get your ticket.', html`<a class="btn primary" href="#/app/book">Choose my bunk</a>`)}</div>` : ''}`}
      ${active && !stale && t.status === 'confirmed' ? html`<div class="card no-print" style="max-width:640px;margin:1rem auto"><h3>Need to change something?</h3>
        <div class="btn-row"><a class="btn ghost" href="#/app/bunks">Change bunk</a><button class="btn ghost" id="cancel">Cancel booking</button></div></div>` : ''}
      ${cur?.waitlist ? html`<div class="card"><h2>Waiting list</h2><p>You are number <b>${cur.waitlist.position}</b> on the waiting list. As soon as a suitable bunk is free you will be allocated it automatically and notified.</p><div class="btn-row"><button class="btn ghost" id="leave-wl">Leave waiting list</button></div></div>` : ''}
      ${!active && !cur?.waitlist && !stale ? html`<div class="card"><h3>No free bunk?</h3><p class="muted">If every suitable bunk is taken, join the waiting list and you will be allocated one as soon as it is released.</p><button class="btn ghost" id="join-wl">Join waiting list</button></div>` : ''}`,
    mount(el) {
      live(['cs:beds', 'cs:sync', 'cs:notify'], '/app/accommodation', reload, 600);
      el.querySelector('#print')?.addEventListener('click', () => window.print());
      el.querySelector('#pdf')?.addEventListener('click', () => downloadApi(`/bookings/${t.id}/ticket.pdf`, `CampSpace-ticket-${t.ref}.pdf`));
      el.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => { await dismissOutcome(b.dataset.dismiss); reload(); }));
      el.querySelectorAll('[data-cancelq]').forEach((b) => b.addEventListener('click', async () => { await cancelQueued(b.dataset.cancelq); toast('Saved request cancelled.'); reload(); }));
      el.querySelector('#cancel')?.addEventListener('click', () => {
        const m = openModal('Cancel booking', html`<p>Your bunk <b>${t.bed.label}</b> will be released for someone else.</p>
          <form><div class="field"><label for="why">Reason (optional)</label><input id="why" name="reason" maxlength="200"></div>
          <div class="btn-row end"><button type="button" class="btn ghost" data-close>Keep my bunk</button><button class="btn danger" type="submit">Cancel booking</button></div><div class="form-error"></div></form>`.toString());
        submitForm(m.el.querySelector('form'), async (d) => { await post(`/bookings/${t.id}/cancel`, d); m.close(); toast('Booking cancelled.'); reload(); });
      });
      el.querySelector('#join-wl')?.addEventListener('click', async () => {
        try { await post('/waitlist/join', {}); toast('You are on the waiting list.'); reload(); }
        catch (err) { toast(err.message, 'bad'); if (err.code === 'BEDS_AVAILABLE') go('/app/book'); }
      });
      el.querySelector('#leave-wl')?.addEventListener('click', async () => { await del('/waitlist/mine'); toast('Removed from the waiting list.'); reload(); });
    },
  };
});

// ================================================================== medical support
const PRIORITY_NOTE = 'Priority is set by the camp medical team.';
async function fileToDoc(file) {
  if (!file) return null;
  if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.type)) throw new Error('Attach a PDF, JPG or PNG file.');
  if (file.size > 3 * 1024 * 1024) throw new Error('The file is larger than 3 MB.');
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
  return { filename: file.name, mime: file.type, data_b64: b64 };
}

route('/app/medical', CORPS, async () => {
  let items = null;
  try { items = (await get('/medical/requests/mine')).items; } catch (e) { if (!e.offline) throw e; }
  const open = items?.find((r) => ['submitted', 'under_review', 'more_info'].includes(r.status));
  const form = html`<form class="card" id="newreq" novalidate>
      <h2>Request medical accommodation</h2>
      <p class="muted">Tell the camp clinic about any condition that affects where or how you can sleep. Only you and the camp medical team can read this.</p>
      <div class="draft-note" hidden>We restored your unfinished request. It is saved only on this device.</div>
      <div class="field"><label for="m-cat">Type of condition</label><select id="m-cat" name="category" required><option value="">Choose...</option>${(S.meta?.medical_categories || []).map((c) => html`<option>${c}</option>`)}</select></div>
      <div class="field"><label for="m-con">Condition</label><input id="m-con" name="condition" required minlength="3" maxlength="200" placeholder="For example: fractured ankle, using crutches"></div>
      <div class="field"><label for="m-det">More details (optional)</label><textarea id="m-det" name="details" maxlength="2000" placeholder="Anything the clinic should know, medication, doctor's advice..."></textarea></div>
      <fieldset style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.92rem;margin-bottom:.4rem">What accommodation do you need?</legend>
        ${Object.entries(S.meta?.needs || {}).map(([k, v]) => html`<label class="check"><input type="checkbox" name="needs" value="${k}" data-multi><span>${v}</span></label>`)}</fieldset>
      <div class="field"><label for="m-file">Doctor's note (optional)</label><input id="m-file" type="file" accept="application/pdf,image/jpeg,image/png"><div class="hint">PDF, JPG or PNG, up to 3 MB. Stored encrypted.</div></div>
      <button class="btn primary" type="submit">Submit request</button><div class="form-error" role="alert"></div>
    </form>`;
  return {
    title: 'Medical Support',
    body: html`
      ${pageHead('Medical support', 'Request ground-floor, lower-bunk or other accommodation for a medical need.')}
      ${S.medNeeds.length ? html`<div class="card notice"><b>Approved accommodation:</b> ${S.medNeeds.map((n) => needLabel(n)).join(', ')}. When you book, only matching bunks are offered.</div>` : ''}
      ${items === null ? html`<div class="card notice warn">You are offline. You can still write your request: it is kept on this device until you are connected and can send it.</div>` : ''}
      ${(items || []).map((r) => html`<div class="card">
        <div class="card-head"><h3>${r.category}: ${r.condition}</h3><div>${badge(r.status)} ${r.status !== 'rejected' ? badge(r.priority) : ''}</div></div>
        <p class="small muted">Submitted ${fmtDT(r.created_at)}. ${r.status === 'approved' || r.priority !== 'routine' ? PRIORITY_NOTE : ''}</p>
        ${r.details ? html`<p style="white-space:pre-wrap">${r.details}</p>` : ''}
        <div class="pill-row">${r.requested_needs.map((n) => html`<span class="pill" style="background:#eceff0;color:#44544b">${needLabel(n)}</span>`)}</div>
        ${r.status === 'approved' ? html`<p style="margin-top:.7rem"><b>Approved:</b> ${r.approved_needs.map((n) => needLabel(n)).join(', ')}</p>` : ''}
        ${r.message_to_corper ? html`<div class="card notice ${r.status === 'more_info' ? 'warn' : 'info'}" style="margin:.7rem 0 0"><b>Message from the medical team</b><p style="margin:0">${r.message_to_corper}</p></div>` : ''}
        ${r.documents.length ? html`<p class="small" style="margin-top:.7rem"><b>Documents:</b> ${r.documents.map((d) => html`<button class="btn ghost sm" data-doc="${d.id}" data-name="${d.name}">${d.name} (${bytes(d.size)})</button>`)}</p>` : ''}
        ${['submitted', 'under_review', 'more_info'].includes(r.status) ? html`<form class="respond" data-id="${r.id}" style="margin-top:1rem"><div class="field"><label>Add information or a document</label><textarea name="details" maxlength="2000" placeholder="Add more details for the medical team"></textarea></div><div class="field"><input type="file" accept="application/pdf,image/jpeg,image/png" aria-label="Attach a document"></div><button class="btn ghost sm" type="submit">Send to the medical team</button><div class="form-error"></div></form>` : ''}
      </div>`)}
      ${open ? html`<div class="card notice info">You already have a request being reviewed. You can add information to it above.</div>` : form}
      <div class="card notice info small">Your medical information is encrypted and visible only to the camp medical team. Accommodation officers see only the approved instruction, never your diagnosis.</div>`,
    mount(el) {
      el.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => downloadApi('/medical/documents/' + b.dataset.doc, b.dataset.name)));
      const f = el.querySelector('#newreq');
      if (f) {
        draftForm(f, 'medreq');
        submitForm(f, async (d) => {
          if (!d.needs?.length) throw new Error('Choose at least one accommodation need.');
          const doc = await fileToDoc(f.querySelector('input[type=file]').files[0]);
          d.client_ref = f.dataset.ref ||= newRef();
          const r = await post('/medical/requests', d);
          if (doc) { try { await post(`/medical/requests/${r.request.id}/documents`, doc); } catch (e) { toast('Request sent, but the document could not be attached: ' + e.message, 'bad'); } }
          toast('Request sent to the camp medical team.');
          clearDraft('medreq');
          reload();
        }, { draft: 'medreq' });
      }
      el.querySelectorAll('form.respond').forEach((rf) => submitForm(rf, async (d) => {
        const doc = await fileToDoc(rf.querySelector('input[type=file]').files[0]);
        if (!d.details?.trim() && !doc) throw new Error('Write something or attach a document.');
        if (d.details?.trim()) await post(`/medical/requests/${rf.dataset.id}/respond`, { details: d.details });
        if (doc) await post(`/medical/requests/${rf.dataset.id}/documents`, doc);
        toast('Sent.');
        reload();
      }));
    },
  };
});

// ================================================================== booking history
route('/app/history', CORPS, async () => {
  const d = await get('/bookings/mine');
  return {
    title: 'Booking History',
    body: html`${pageHead('Booking history', 'Every booking and waiting-list entry on your account.')}
      <div class="card"><h2>Bookings</h2>${d.items.length ? html`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Bunk</th><th>Hostel</th><th>Status</th><th>Booked</th><th>Notes</th></tr></thead><tbody>
        ${d.items.map((t) => html`<tr><td class="mono">${t.ref}</td><td>${t.bed.label}</td><td>${t.hostel.name}</td><td>${badge(t.status)}</td><td>${fmtDT(t.created_at)}</td><td class="small muted">${t.cancel_reason || (t.source === 'waitlist' ? 'Allocated from the waiting list' : t.source === 'officer' ? 'Assigned by an officer' : t.source === 'offline_sync' ? 'Saved offline, confirmed on sync' : '')}</td></tr>`)}</tbody></table></div>` : empty('No bookings yet', '', html`<a class="btn primary" href="#/app/book">Choose my bunk</a>`)}</div>
      ${d.waitlist.length ? html`<div class="card"><h2>Waiting list</h2><div class="table-wrap"><table><thead><tr><th>Joined</th><th>Status</th><th>Allocated</th></tr></thead><tbody>${d.waitlist.map((w) => html`<tr><td>${fmtDT(w.created_at)}</td><td>${badge(w.status)}</td><td>${w.fulfilled_at ? fmtDT(w.fulfilled_at) : '-'}</td></tr>`)}</tbody></table></div></div>` : ''}`,
  };
});

// ================================================================== notifications (all roles)
async function notificationsPage() {
  const d = await get('/notifications');
  S.unread = d.unread;
  return {
    title: 'Notifications',
    body: html`${pageHead('Notifications', `${d.unread} unread`, d.unread ? html`<button class="btn ghost" id="all">Mark all as read</button>` : '')}
      <div class="card" style="padding:0">${d.items.length ? d.items.map((n) => html`<a class="notif ${n.read ? 'read' : 'unread'}" href="${n.link || '#/notifications'}" data-id="${n.id}"><span class="dot"></span><span><b>${n.title}</b>${n.body ? html`<span>${n.body}</span>` : ''}<small>${ago(n.created_at)}</small></span></a>`) : empty('Nothing here yet', 'You will be notified about bookings, medical decisions and the waiting list.')}</div>`,
    mount(el) {
      live(['cs:notify'], current.path, reload, 500);
      el.querySelector('#all')?.addEventListener('click', async () => { await post('/notifications/read', { all: true }); S.unread = 0; reload(); });
      el.querySelectorAll('.notif.unread').forEach((a) => a.addEventListener('click', () => post('/notifications/read', { ids: [Number(a.dataset.id)] }).catch(() => {})));
    },
  };
}
route('/app/notifications', CORPS, notificationsPage);
route('/notifications', ANY, notificationsPage);

// ================================================================== profile & settings (all roles)
async function settingsPage() {
  const u = S.user;
  const corps = u.role === 'corps_member';
  const saved = await kvList('');
  const mine = saved.filter((x) => /^(ticket|queue|room|hostels|outcome):/.test(x.key)).length;
  return {
    title: 'Profile Settings',
    body: html`${pageHead('Profile settings')}
      ${u.must_change_password ? html`<div class="card notice warn"><b>Set a new password.</b> You are using a temporary password. Choose your own below to continue.</div>` : ''}
      <div class="cols">
        <form class="card" id="prof">
          <h2>Your details</h2>
          <div class="field"><label>Email</label><input value="${u.email}" disabled></div>
          <div class="field"><label for="p-name">Full name</label><input id="p-name" name="full_name" value="${u.full_name}" required minlength="3" maxlength="100"></div>
          <div class="field"><label for="p-ph">Phone</label><input id="p-ph" name="phone" type="tel" value="${u.phone || ''}" ${corps ? 'required' : ''}></div>
          ${corps ? html`
            <div class="field"><label for="p-cu">NYSC call-up number ${badge(u.verification_status)}</label><input id="p-cu" name="call_up_number" value="${u.call_up_number}" required ${u.verification_status === 'verified' ? 'readonly' : ''} pattern="[A-Za-z]{2}/\\d{2}[A-Za-z]/\\d{3,6}"><div class="hint">${u.verification_status === 'verified' ? 'Verified numbers can only be changed by an accommodation officer.' : 'Changing it sends it for verification again.'}</div></div>
            <div class="field"><label for="p-in">Institution</label><input id="p-in" name="institution" value="${u.institution || ''}" maxlength="120"></div>
            <div class="field"><label for="p-st">State of origin</label><select id="p-st" name="state_of_origin">${(S.meta?.states || []).map((s) => html`<option ${s === u.state_of_origin ? raw('selected') : ''}>${s}</option>`)}</select></div>` : ''}
          <button class="btn primary" type="submit">Save changes</button><div class="form-error" role="alert"></div>
        </form>
        <form class="card" id="pw">
          <h2>Change password</h2>
          <div class="field"><label for="pw0">Current password</label><input id="pw0" name="current_password" type="password" required autocomplete="current-password"></div>
          <div class="field"><label for="pw1">New password</label><input id="pw1" name="new_password" type="password" required minlength="8" autocomplete="new-password"><div class="hint">At least 8 characters, letters and numbers.</div></div>
          <div class="field"><label for="pw2">Confirm new password</label><input id="pw2" name="again" type="password" required autocomplete="new-password"></div>
          <button class="btn primary" type="submit">Change password</button><div class="form-error" role="alert"></div>
        </form>
      </div>
      <div class="card" id="offline-card"><h2>This device</h2>
        <p>CampSpace can be installed like an app and keeps your last ticket for offline use.</p>
        <div class="btn-row"><button class="btn ghost" id="install" ${S.installEvt ? '' : 'hidden'}>Install CampSpace</button>
          <button class="btn ghost" id="wipe">Clear saved data on this device (${mine})</button></div>
        <p class="small muted" style="margin-top:.8rem">${S.installEvt ? '' : 'To install: use your browser menu and choose "Add to Home screen" or "Install app". '}Saved data (tickets, drafts, pending requests) is removed automatically when you sign out.</p>
      </div>`,
    mount(el) {
      submitForm(el.querySelector('#prof'), async (d) => {
        if (corps && d.call_up_number) d.call_up_number = d.call_up_number.toUpperCase().replace(/\s+/g, '');
        await patch('/me', d); await refreshMe(); toast('Profile saved.'); reload();
      });
      submitForm(el.querySelector('#pw'), async (d) => {
        if (d.new_password !== d.again) throw new Error('The new passwords do not match.');
        await post('/auth/change-password', { current_password: d.current_password, new_password: d.new_password });
        await refreshMe(); toast('Password changed.'); go(ROLE_HOME[S.user.role]);
      });
      el.querySelector('#install')?.addEventListener('click', async () => { S.installEvt.prompt(); await S.installEvt.userChoice; S.installEvt = null; reload(); });
      el.querySelector('#wipe').addEventListener('click', async () => {
        if (await confirmDialog('Clear saved data', 'This removes your saved ticket, unfinished forms and any pending offline request from this device. Your account and bookings on the server are not affected.', { okLabel: 'Clear' })) { await wipeLocalData(); toast('Saved data cleared.'); reload(); }
      });
    },
  };
}
route('/app/settings', CORPS, settingsPage);
route('/settings', ANY, settingsPage);
void patch; void can; void api; void syncQueue; void esc;
