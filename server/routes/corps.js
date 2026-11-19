// Corps member endpoints: hostels, bunks, bookings, tickets, waiting list, medical requests.
import { HttpError, str, int, oneOf, arrayOf } from '../util.js';
import { MEDICAL_CATEGORIES, NEEDS } from '../constants.js';
import {
  now, cfgBool, cfgNum, audit, notify, notifyRole, approvedNeeds, bedRows, bedState, bookingWindow,
  createBooking, cancelBooking, moveBooking, findBedFor, ticketView,
} from '../services.js';
import { ticketPdf } from '../pdf.js';
import { campOf } from '../scope.js';

const CLIENT_REF = /^[A-Za-z0-9-]{8,64}$/;
const clientRef = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !CLIENT_REF.test(v)) throw new HttpError(400, 'Invalid client reference');
  return v;
};
const PRI = { routine: 0, high: 1, urgent: 2 };

export function registerCorps(r, app) {
  const { db, vault } = app;
  const isCorps = (u) => u.role === 'corps_member';

  // ---------------------------------------------------------------- hostels / rooms / bunks
  r.get('/api/hostels', { perm: 'hostels.view' }, (ctx) => {
    const u = ctx.user;
    const campId = isCorps(u) ? u.camp_id : campOf(ctx);
    if (!campId) throw new HttpError(400, 'You are not assigned to a camp.');
    const gender = isCorps(u) ? u.gender : null;
    const med = isCorps(u) ? approvedNeeds(db, u.id) : [];
    const stateOf = (row) => bedState(row, u, med, { override: !isCorps(u) });
    const rows = bedRows(db, { campId, gender });
    const byRoom = new Map();
    for (const row of rows) {
      const t = byRoom.get(row.room_id) || { total: 0, available: 0, booked: 0, reserved: 0, mine: false };
      const st = stateOf(row);
      t.total++;
      if (st === 'available') t.available++;
      else if (st === 'booked' || st === 'mine') t.booked++;
      else if (st === 'reserved') t.reserved++;
      if (st === 'mine') t.mine = true;
      byRoom.set(row.room_id, t);
    }
    const hostels = db.all(`SELECT id, name, gender, description, floors FROM hostels WHERE camp_id=? AND active=1 ${gender ? 'AND gender=?' : ''} ORDER BY name`, ...(gender ? [campId, gender] : [campId]));
    for (const h of hostels) {
      h.rooms = db.all('SELECT id, number, floor, capacity, status, medical_reserved FROM rooms WHERE hostel_id=? ORDER BY floor, number', h.id).map((rm) => ({
        ...rm, ...(byRoom.get(rm.id) || { total: 0, available: 0, booked: 0, reserved: 0, mine: false }),
      }));
      h.total = h.rooms.reduce((a, x) => a + x.total, 0);
      h.available = h.rooms.reduce((a, x) => a + (x.status === 'open' ? x.available : 0), 0);
      h.booked = h.rooms.reduce((a, x) => a + x.booked, 0);
    }
    const camp = db.get('SELECT * FROM camps WHERE id=?', campId);
    return { hostels, medical_needs: med, window: bookingWindow(camp), camp: { id: camp.id, name: camp.name } };
  });

  r.get('/api/rooms/:id/beds', { perm: 'hostels.view' }, (ctx) => {
    const u = ctx.user;
    const roomId = int(ctx.params.id, 'id');
    const rows = bedRows(db, { roomId });
    if (!rows.length) throw new HttpError(404, 'Room not found');
    const first = rows[0];
    if (isCorps(u)) {
      if (first.camp_id !== u.camp_id || first.gender !== u.gender) throw new HttpError(404, 'Room not found');
    } else if (first.camp_id !== campOf(ctx)) throw new HttpError(404, 'Room not found');
    const med = isCorps(u) ? approvedNeeds(db, u.id) : [];
    const staff = !isCorps(u);
    const occupants = new Map();
    if (staff && app.can(u, 'bookings.view')) {
      for (const o of db.all(
        `SELECT bk.bed_id, bk.id booking_id, bk.status, bk.ref, us.full_name, us.call_up_number, us.id user_id
           FROM bookings bk JOIN users us ON us.id=bk.user_id
           JOIN beds b ON b.id=bk.bed_id WHERE b.room_id=? AND bk.status IN ('confirmed','checked_in')`, roomId)) occupants.set(o.bed_id, o);
    }
    const room = db.get('SELECT r.id, r.number, r.floor, r.capacity, r.status, r.medical_reserved, r.notes, h.name hostel_name, h.gender, h.id hostel_id FROM rooms r JOIN hostels h ON h.id=r.hostel_id WHERE r.id=?', roomId);
    return {
      room,
      medical_needs: med,
      beds: rows.map((row) => ({
        id: row.bed_id, bunk_no: row.bunk_no, level: row.level, label: row.label,
        state: bedState(row, u, med, { override: staff }),
        ...(staff ? { blocked: row.bed_status === 'blocked', medical_reserved: !!row.bed_med, occupant: occupants.get(row.bed_id) || null } : {}),
      })),
    };
  });

  // ---------------------------------------------------------------- bookings
  function sourceFor(body) { return body.via === 'offline_sync' ? 'offline_sync' : 'self'; }

  r.post('/api/bookings', { perm: 'booking.own' }, (ctx) => {
    const bedId = int(ctx.body.bed_id, 'bed_id');
    const res = createBooking(db, { user: ctx.user, bedId, source: sourceFor(ctx.body), clientRef: clientRef(ctx.body.client_ref), actor: ctx.actor });
    return { booking: ticketView(db, vault, res.id), duplicate: res.duplicate };
  });

  r.post('/api/bookings/auto', { perm: 'booking.own' }, (ctx) => {
    const hostelId = ctx.body.hostel_id ? int(ctx.body.hostel_id, 'hostel_id') : null;
    const ref = clientRef(ctx.body.client_ref);
    for (let attempt = 0; attempt < 4; attempt++) {
      const bed = findBedFor(db, ctx.user, { hostelId });
      if (!bed) throw new HttpError(409, 'No bunk is free for you right now. You can join the waiting list.', { code: 'FULL' });
      try {
        const res = createBooking(db, { user: ctx.user, bedId: bed.bed_id, source: sourceFor(ctx.body), clientRef: ref, actor: ctx.actor });
        return { booking: ticketView(db, vault, res.id), duplicate: res.duplicate };
      } catch (e) {
        if (e instanceof HttpError && e.extra?.code === 'BED_TAKEN') continue;
        throw e;
      }
    }
    throw new HttpError(409, 'Bunks are being taken quickly. Please try again.', { code: 'BUSY' });
  });

  r.get('/api/bookings/current', { perm: 'booking.own' }, (ctx) => {
    const u = ctx.user;
    const b = db.get("SELECT id FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id);
    const wl = db.get("SELECT id, priority, note, created_at FROM waitlist WHERE user_id=? AND status='waiting'", u.id);
    let waitlist = null;
    if (wl) {
      const ahead = db.get(
        "SELECT COUNT(*) n FROM waitlist WHERE status='waiting' AND camp_id=? AND gender=? AND (priority > ? OR (priority = ? AND (created_at < ? OR (created_at = ? AND id < ?))))",
        u.camp_id, u.gender, wl.priority, wl.priority, wl.created_at, wl.created_at, wl.id).n;
      waitlist = { ...wl, position: ahead + 1 };
    }
    const camp = db.get('SELECT * FROM camps WHERE id=?', u.camp_id);
    return { booking: b ? ticketView(db, vault, b.id) : null, waitlist, window: bookingWindow(camp), medical_needs: approvedNeeds(db, u.id) };
  });

  r.get('/api/bookings/mine', { perm: 'booking.own' }, (ctx) => ({
    items: db.all('SELECT id FROM bookings WHERE user_id=? ORDER BY id DESC', ctx.user.id).map((x) => ticketView(db, vault, x.id)),
    waitlist: db.all('SELECT id, status, priority, created_at, fulfilled_at FROM waitlist WHERE user_id=? ORDER BY id DESC', ctx.user.id),
  }));

  function ownBooking(ctx) {
    const b = db.get('SELECT * FROM bookings WHERE id=?', int(ctx.params.id, 'id'));
    if (!b || b.user_id !== ctx.user.id) throw new HttpError(404, 'Booking not found');
    return b;
  }

  r.post('/api/bookings/:id/cancel', { perm: 'booking.own' }, (ctx) => {
    const b = ownBooking(ctx);
    if (!cfgBool(db, 'allow_self_cancel')) throw new HttpError(403, 'Self-service cancellation is switched off. Please contact the accommodation desk.');
    if (b.status !== 'confirmed') throw new HttpError(409, b.status === 'checked_in' ? 'You are already checked in. Ask an accommodation officer to change your bunk.' : 'This booking is not active.');
    const used = db.get("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status='cancelled'", ctx.user.id).n;
    if (used >= cfgNum(db, 'max_self_cancellations', 2)) throw new HttpError(403, 'You have reached the cancellation limit. Please contact the accommodation desk.');
    const reason = str(ctx.body.reason, 'Reason', { required: false, max: 200 }) || 'Cancelled by corps member';
    cancelBooking(db, b, { actor: ctx.actor, reason, status: 'cancelled', notifyUser: true });
    return { ok: true };
  });

  r.post('/api/bookings/:id/change', { perm: 'booking.own' }, (ctx) => {
    const b = ownBooking(ctx);
    const res = moveBooking(db, b, int(ctx.body.bed_id, 'bed_id'), { actor: ctx.actor, source: 'self' });
    return { booking: ticketView(db, vault, res.id) };
  });

  function ticketFor(ctx) {
    const b = db.get('SELECT * FROM bookings WHERE id=?', int(ctx.params.id, 'id'));
    if (!b) throw new HttpError(404, 'Booking not found');
    const own = b.user_id === ctx.user.id;
    if (!own) {
      if (!app.can(ctx.user, 'bookings.view') || b.camp_id !== campOf(ctx)) throw new HttpError(404, 'Booking not found');
    }
    return ticketView(db, vault, b.id);
  }
  r.get('/api/bookings/:id/ticket', (ctx) => ({ ticket: ticketFor(ctx) }));
  r.get('/api/bookings/:id/ticket.pdf', (ctx) => {
    const t = ticketFor(ctx);
    ctx.audit('ticket.download', 'booking', t.id);
    return { __raw: true, body: ticketPdf(t), headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="CampSpace-ticket-${t.ref}.pdf"` } };
  });

  // ---------------------------------------------------------------- waiting list
  r.post('/api/waitlist/join', { perm: 'booking.own' }, (ctx) => {
    const u = ctx.user;
    if (db.get("SELECT 1 x FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id)) throw new HttpError(409, 'You already have a booking.');
    if (findBedFor(db, u)) throw new HttpError(409, 'Bunks are available right now. Please book one instead.', { code: 'BEDS_AVAILABLE' });
    const pri = db.get("SELECT priority FROM medical_requests WHERE user_id=? AND status='approved' ORDER BY id DESC LIMIT 1", u.id)?.priority || 'routine';
    try {
      db.run('INSERT INTO waitlist(user_id,camp_id,gender,priority,status,note,created_at) VALUES (?,?,?,?,?,?,?)',
        u.id, u.camp_id, u.gender, PRI[pri], 'waiting', str(ctx.body.note, 'Note', { required: false, max: 200 }), now());
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'You are already on the waiting list.');
      throw e;
    }
    ctx.audit('waitlist.join', 'user', u.id);
    notify(db, u.id, 'waitlist', 'You are on the waiting list', 'You will be allocated the first suitable bunk that becomes free, and notified straight away.', '#/app/accommodation');
    return { ok: true };
  });

  r.delete('/api/waitlist/mine', { perm: 'booking.own' }, (ctx) => {
    db.run("UPDATE waitlist SET status='cancelled' WHERE user_id=? AND status='waiting'", ctx.user.id);
    ctx.audit('waitlist.leave', 'user', ctx.user.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- medical requests (corps member side)
  const OPEN = ['submitted', 'under_review', 'more_info'];

  function myRequestView(row) {
    const payload = vault.dec(row.payload_enc, `medreq:${row.id}`) || {};
    return {
      id: row.id, status: row.status, priority: row.priority, created_at: row.created_at, updated_at: row.updated_at,
      category: payload.category, condition: payload.condition, details: payload.details,
      requested_needs: JSON.parse(row.requested_needs), approved_needs: JSON.parse(row.approved_needs),
      message_to_corper: row.message_to_corper,
      documents: db.all('SELECT id, size, created_at FROM medical_documents WHERE request_id=? ORDER BY id', row.id).map((d) => ({
        id: d.id, size: d.size, created_at: d.created_at, name: vault.dec(db.get('SELECT meta_enc FROM medical_documents WHERE id=?', d.id).meta_enc, `meddoc:${d.id}`)?.name,
      })),
    };
  }

  r.post('/api/medical/requests', { perm: 'medical.request' }, (ctx) => {
    const u = ctx.user;
    const b = ctx.body;
    const ref = clientRef(b.client_ref);
    if (ref) {
      const ex = db.get('SELECT * FROM medical_requests WHERE user_id=? AND client_ref=?', u.id, ref);
      if (ex) return { request: myRequestView(ex), duplicate: true };
    }
    const category = oneOf(b.category, MEDICAL_CATEGORIES, 'Category');
    const condition = str(b.condition, 'Condition', { min: 3, max: 200 });
    const details = str(b.details, 'Details', { required: false, max: 2000 });
    const needs = arrayOf(b.needs, Object.keys(NEEDS), 'Accommodation needs');
    if (!needs.length) throw new HttpError(400, 'Choose at least one accommodation need.');
    if (db.get(`SELECT 1 x FROM medical_requests WHERE user_id=? AND status IN (${OPEN.map(() => '?').join(',')})`, u.id, ...OPEN))
      throw new HttpError(409, 'You already have a request being reviewed. Wait for the outcome or add information to it.');
    const ts = now();
    const id = db.tx(() => {
      const rid = Number(db.run(
        `INSERT INTO medical_requests(user_id,camp_id,payload_enc,requested_needs,status,priority,client_ref,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`, u.id, u.camp_id, 'pending', JSON.stringify(needs), 'submitted', 'routine', ref, ts, ts).lastInsertRowid);
      db.run('UPDATE medical_requests SET payload_enc=? WHERE id=?', vault.enc({ category, condition, details }, `medreq:${rid}`), rid);
      audit(db, ctx.actor, 'medical.request.create', 'medical_request', rid);
      notifyRole(db, u.camp_id, 'medical_personnel', 'medical', 'New medical accommodation request', 'A corps member has submitted a request for review.', '#/med/requests');
      notify(db, u.id, 'medical', 'Medical request received', 'The camp medical team will review it. You will be notified of the outcome.', '#/app/medical');
      return rid;
    });
    return { request: myRequestView(db.get('SELECT * FROM medical_requests WHERE id=?', id)), duplicate: false };
  });

  r.get('/api/medical/requests/mine', { perm: 'medical.request' }, (ctx) => ({
    items: db.all('SELECT * FROM medical_requests WHERE user_id=? ORDER BY id DESC', ctx.user.id).map(myRequestView),
  }));

  r.post('/api/medical/requests/:id/respond', { perm: 'medical.request' }, (ctx) => {
    const row = db.get('SELECT * FROM medical_requests WHERE id=? AND user_id=?', int(ctx.params.id, 'id'), ctx.user.id);
    if (!row) throw new HttpError(404, 'Request not found');
    if (!['more_info', 'submitted', 'under_review'].includes(row.status)) throw new HttpError(409, 'This request is closed.');
    const extra = str(ctx.body.details, 'Additional information', { min: 3, max: 2000 });
    const p = vault.dec(row.payload_enc, `medreq:${row.id}`) || {};
    p.details = [p.details, `[Update ${now().slice(0, 10)}] ${extra}`].filter(Boolean).join('\n\n').slice(0, 4000);
    db.run("UPDATE medical_requests SET payload_enc=?, status='submitted', updated_at=? WHERE id=?", vault.enc(p, `medreq:${row.id}`), now(), row.id);
    ctx.audit('medical.request.update', 'medical_request', row.id);
    notifyRole(db, row.camp_id, 'medical_personnel', 'medical', 'Medical request updated', 'A corps member added information to their request.', '#/med/requests');
    return { request: myRequestView(db.get('SELECT * FROM medical_requests WHERE id=?', row.id)) };
  });

  const DOC_TYPES = {
    'application/pdf': (b) => b.subarray(0, 4).toString() === '%PDF',
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
    'image/png': (b) => b.subarray(1, 4).toString() === 'PNG',
  };
  r.post('/api/medical/requests/:id/documents', { perm: 'medical.request' }, (ctx) => {
    const row = db.get('SELECT * FROM medical_requests WHERE id=? AND user_id=?', int(ctx.params.id, 'id'), ctx.user.id);
    if (!row) throw new HttpError(404, 'Request not found');
    if (db.get('SELECT COUNT(*) n FROM medical_documents WHERE request_id=?', row.id).n >= 5) throw new HttpError(409, 'You can attach up to 5 documents.');
    const name = str(ctx.body.filename, 'File name', { max: 120 });
    const mime = oneOf(ctx.body.mime, Object.keys(DOC_TYPES), 'File type');
    const buf = Buffer.from(String(ctx.body.data_b64 || ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'The file is empty.');
    if (buf.length > 3 * 1024 * 1024) throw new HttpError(413, 'Files must be 3 MB or smaller.');
    if (!DOC_TYPES[mime](buf)) throw new HttpError(400, 'The file contents do not match its type.');
    const id = db.tx(() => {
      const did = Number(db.run('INSERT INTO medical_documents(request_id,user_id,meta_enc,size,vault_file,created_at) VALUES (?,?,?,?,?,?)', row.id, ctx.user.id, 'pending', buf.length, 'pending', now()).lastInsertRowid);
      const file = vault.saveFile(buf, `meddoc-file:${did}`);
      db.run('UPDATE medical_documents SET meta_enc=?, vault_file=? WHERE id=?', vault.enc({ name, mime }, `meddoc:${did}`), file, did);
      audit(db, ctx.actor, 'medical.document.upload', 'medical_document', did, { request: row.id, size: buf.length });
      return did;
    });
    return { id };
  });

  r.get('/api/medical/documents/:id', (ctx) => {
    const d = db.get('SELECT * FROM medical_documents WHERE id=?', int(ctx.params.id, 'id'));
    if (!d) throw new HttpError(404, 'Document not found');
    const reviewer = app.can(ctx.user, 'medical.review');
    if (d.user_id !== ctx.user.id && !(reviewer && db.get('SELECT 1 x FROM medical_requests WHERE id=? AND camp_id=?', d.request_id, campOf(ctx)))) throw new HttpError(404, 'Document not found');
    const meta = vault.dec(d.meta_enc, `meddoc:${d.id}`);
    const buf = vault.readFile(d.vault_file, `meddoc-file:${d.id}`);
    ctx.audit('medical.document.read', 'medical_document', d.id, { by: reviewer ? 'staff' : 'owner' });
    const safe = String(meta.name).replace(/[^\w.\- ]/g, '_');
    return { __raw: true, body: buf, headers: { 'Content-Type': meta.mime, 'Content-Disposition': `attachment; filename="${safe}"` } };
  });
}
