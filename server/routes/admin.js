// Accommodation officer endpoints (also available to super administrators for any camp).
import { HttpError, str, int, oneOf, arrayOf, toCsv } from '../util.js';
import { NEEDS } from '../constants.js';
import {
  now, audit, notify, approvedNeeds, needLabels, bedRows, bedState, createBooking, cancelBooking, moveBooking,
  findBedFor, promoteWaitlist, ticketView, campReport,
} from '../services.js';
import { makeBeds } from '../layout.js';
import { campOf, sameCamp, paging, like } from '../scope.js';
import { emit } from '../events.js';

export function registerAdmin(r, app) {
  const { db, vault } = app;

  const bookingRow = (id) => {
    const b = db.get('SELECT * FROM bookings WHERE id=?', id);
    if (!b) throw new HttpError(404, 'Booking not found');
    return b;
  };
  const roomRow = (ctx, id) => {
    const room = db.get('SELECT r.*, h.camp_id, h.gender, h.name hostel_name FROM rooms r JOIN hostels h ON h.id=r.hostel_id WHERE r.id=?', id);
    if (!room) throw new HttpError(404, 'Room not found');
    sameCamp(ctx, room.camp_id);
    return room;
  };
  const hostelRow = (ctx, id) => {
    const h = db.get('SELECT * FROM hostels WHERE id=?', id);
    if (!h) throw new HttpError(404, 'Hostel not found');
    sameCamp(ctx, h.camp_id);
    return h;
  };
  const corperRow = (ctx, id) => {
    const u = db.get("SELECT * FROM users WHERE id=? AND role='corps_member'", id);
    if (!u) throw new HttpError(404, 'Corps member not found');
    sameCamp(ctx, u.camp_id);
    return u;
  };

  // ---------------------------------------------------------------- dashboard
  r.get('/api/admin/dashboard', { perm: 'bookings.view' }, (ctx) => {
    const campId = campOf(ctx);
    const camp = db.get('SELECT id, name, state, batch, booking_open, booking_opens_at, booking_closes_at FROM camps WHERE id=?', campId);
    const report = campReport(db, campId);
    const recent = db.all(
      `SELECT bk.id, bk.ref, bk.status, bk.source, bk.created_at, bk.checked_in_at, u.full_name, b.label
         FROM bookings bk JOIN users u ON u.id=bk.user_id JOIN beds b ON b.id=bk.bed_id
        WHERE bk.camp_id=? ORDER BY COALESCE(bk.checked_in_at, bk.updated_at) DESC LIMIT 8`, campId);
    const pendingMedical = app.can(ctx.user, 'medical.instructions')
      ? db.get(
        `SELECT COUNT(*) n FROM medical_requests mr WHERE mr.camp_id=? AND mr.status='approved'
            AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.user_id=mr.user_id AND bk.status IN ('confirmed','checked_in'))`, campId).n
      : 0;
    const unverified = db.get("SELECT COUNT(*) n FROM users WHERE role='corps_member' AND camp_id=? AND active=1 AND verification_status IN ('pending','unverified')", campId).n;
    return { camp, report, recent, pending_medical_allocations: pendingMedical, unverified };
  });

  // ---------------------------------------------------------------- hostels
  r.get('/api/admin/hostels', { perm: 'hostels.view' }, (ctx) => {
    const campId = campOf(ctx);
    return {
      items: db.all(
        `SELECT h.id, h.name, h.gender, h.description, h.floors, h.active,
                COUNT(DISTINCT r.id) rooms, COUNT(b.id) beds,
                SUM(CASE WHEN bk.id IS NOT NULL THEN 1 ELSE 0 END) booked
           FROM hostels h LEFT JOIN rooms r ON r.hostel_id=h.id LEFT JOIN beds b ON b.room_id=r.id
           LEFT JOIN bookings bk ON bk.bed_id=b.id AND bk.status IN ('confirmed','checked_in')
          WHERE h.camp_id=? GROUP BY h.id ORDER BY h.name`, campId),
    };
  });

  r.post('/api/admin/hostels', { perm: 'hostels.manage' }, (ctx) => {
    const campId = campOf(ctx);
    const b = ctx.body;
    const name = str(b.name, 'Name', { min: 2, max: 80 });
    const gender = oneOf(b.gender, ['male', 'female'], 'Gender');
    const floors = int(b.floors ?? 1, 'Floors', { min: 1, max: 20 });
    try {
      const id = Number(db.run('INSERT INTO hostels(camp_id,name,gender,description,floors) VALUES (?,?,?,?,?)', campId, name, gender, str(b.description, 'Description', { required: false, max: 300 }), floors).lastInsertRowid);
      ctx.audit('hostel.create', 'hostel', id, { name });
      return { id };
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'A hostel with that name already exists in this camp.');
      throw e;
    }
  });

  r.patch('/api/admin/hostels/:id', { perm: 'hostels.manage' }, (ctx) => {
    const h = hostelRow(ctx, int(ctx.params.id, 'id'));
    const b = ctx.body;
    const name = b.name !== undefined ? str(b.name, 'Name', { min: 2, max: 80 }) : h.name;
    const description = b.description !== undefined ? str(b.description, 'Description', { required: false, max: 300 }) : h.description;
    const floors = b.floors !== undefined ? int(b.floors, 'Floors', { min: 1, max: 20 }) : h.floors;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : h.active;
    try { db.run('UPDATE hostels SET name=?, description=?, floors=?, active=? WHERE id=?', name, description, floors, active, h.id); }
    catch (e) { if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'A hostel with that name already exists.'); throw e; }
    ctx.audit('hostel.update', 'hostel', h.id, { active });
    emit('beds', { camp_id: h.camp_id });
    if (active && !h.active) promoteWaitlist(db, h.camp_id, h.gender);
    return { ok: true };
  });

  // ---------------------------------------------------------------- rooms
  r.get('/api/admin/rooms', { perm: 'hostels.view' }, (ctx) => {
    const campId = campOf(ctx);
    const hostelId = ctx.query.hostel_id ? int(ctx.query.hostel_id, 'hostel_id') : null;
    return {
      items: db.all(
        `SELECT r.id, r.number, r.floor, r.capacity, r.status, r.medical_reserved, r.notes, h.id hostel_id, h.name hostel_name, h.gender,
                COUNT(b.id) beds,
                SUM(CASE WHEN b.status='blocked' THEN 1 ELSE 0 END) blocked,
                SUM(CASE WHEN bk.id IS NOT NULL THEN 1 ELSE 0 END) booked,
                SUM(CASE WHEN bk.status='checked_in' THEN 1 ELSE 0 END) checked_in
           FROM rooms r JOIN hostels h ON h.id=r.hostel_id LEFT JOIN beds b ON b.room_id=r.id
           LEFT JOIN bookings bk ON bk.bed_id=b.id AND bk.status IN ('confirmed','checked_in')
          WHERE h.camp_id=? ${hostelId ? 'AND h.id=?' : ''} GROUP BY r.id ORDER BY h.name, r.floor, r.number`,
        ...(hostelId ? [campId, hostelId] : [campId])),
    };
  });

  r.post('/api/admin/rooms', { perm: 'hostels.manage' }, (ctx) => {
    const b = ctx.body;
    const hostel = hostelRow(ctx, int(b.hostel_id, 'hostel_id'));
    const floor = int(b.floor ?? 0, 'Floor', { min: 0, max: hostel.floors + 5 });
    const capacity = int(b.capacity ?? 32, 'Capacity', { min: 2, max: 64 });
    if (capacity % 2) throw new HttpError(400, 'Capacity must be an even number (two beds per bunk).');
    const count = int(b.count ?? 1, 'Number of rooms', { min: 1, max: 60 });
    const prefix = str(b.number, 'Room number', { min: 1, max: 12 });
    const start = int(b.start ?? 1, 'Starting number', { min: 0, max: 9999 });
    const reserved = b.medical_reserved ? 1 : 0;
    const created = db.tx(() => {
      const ids = [];
      for (let i = 0; i < count; i++) {
        const number = count === 1 ? prefix : `${prefix}${String(start + i).padStart(2, '0')}`;
        try {
          const id = Number(db.run('INSERT INTO rooms(hostel_id,number,floor,capacity,status,medical_reserved) VALUES (?,?,?,?,?,?)', hostel.id, number, floor, capacity, 'open', reserved).lastInsertRowid);
          makeBeds(db, id, number, capacity);
          ids.push(id);
        } catch (e) {
          if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, `Room ${number} already exists in ${hostel.name}.`);
          throw e;
        }
      }
      audit(db, ctx.actor, 'room.create', 'hostel', hostel.id, { count, floor, capacity });
      return ids;
    });
    emit('beds', { camp_id: hostel.camp_id });
    promoteWaitlist(db, hostel.camp_id, hostel.gender);
    return { ids: created };
  });

  r.patch('/api/admin/rooms/:id', { perm: 'hostels.manage' }, (ctx) => {
    const room = roomRow(ctx, int(ctx.params.id, 'id'));
    const b = ctx.body;
    const status = b.status !== undefined ? oneOf(b.status, ['open', 'closed', 'maintenance'], 'Status') : room.status;
    const reserved = b.medical_reserved !== undefined ? (b.medical_reserved ? 1 : 0) : room.medical_reserved;
    const notes = b.notes !== undefined ? str(b.notes, 'Notes', { required: false, max: 300 }) : room.notes;
    if (status !== 'open' && room.status === 'open') {
      const n = db.get("SELECT COUNT(*) n FROM bookings bk JOIN beds b ON b.id=bk.bed_id WHERE b.room_id=? AND bk.status IN ('confirmed','checked_in')", room.id).n;
      if (n) throw new HttpError(409, `Move or cancel the ${n} active booking${n > 1 ? 's' : ''} in this room before closing it.`);
    }
    db.run('UPDATE rooms SET status=?, medical_reserved=?, notes=? WHERE id=?', status, reserved, notes, room.id);
    ctx.audit('room.update', 'room', room.id, { status, reserved });
    emit('beds', { camp_id: room.camp_id, room_id: room.id });
    if (status === 'open' || !reserved) promoteWaitlist(db, room.camp_id, room.gender);
    return { ok: true };
  });

  r.delete('/api/admin/rooms/:id', { perm: 'hostels.manage' }, (ctx) => {
    const room = roomRow(ctx, int(ctx.params.id, 'id'));
    if (db.get('SELECT 1 x FROM bookings bk JOIN beds b ON b.id=bk.bed_id WHERE b.room_id=?', room.id))
      throw new HttpError(409, 'This room has booking history and cannot be deleted. Close it instead.');
    db.tx(() => {
      db.run('DELETE FROM beds WHERE room_id=?', room.id);
      db.run('DELETE FROM rooms WHERE id=?', room.id);
      audit(db, ctx.actor, 'room.delete', 'room', room.id, { number: room.number });
    });
    emit('beds', { camp_id: room.camp_id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- bunks
  r.patch('/api/admin/beds', { perm: 'hostels.manage' }, (ctx) => {
    const ids = Array.isArray(ctx.body.bed_ids) ? ctx.body.bed_ids.slice(0, 200).map((x) => int(x, 'bed id')) : [];
    if (!ids.length) throw new HttpError(400, 'Choose at least one bunk.');
    const status = ctx.body.status !== undefined ? oneOf(ctx.body.status, ['available', 'blocked'], 'Status') : null;
    const reserved = ctx.body.medical_reserved !== undefined ? (ctx.body.medical_reserved ? 1 : 0) : null;
    if (status === null && reserved === null) throw new HttpError(400, 'Nothing to change.');
    const touched = new Set();
    let gender = null;
    db.tx(() => {
      for (const id of ids) {
        const row = bedRows(db, { bedId: id })[0];
        if (!row) throw new HttpError(404, 'Bunk not found');
        sameCamp(ctx, row.camp_id);
        gender = row.gender;
        if (status === 'blocked' && row.booking_id) throw new HttpError(409, `${row.label} is booked. Move or cancel that booking before blocking it.`);
        if (status !== null) db.run('UPDATE beds SET status=? WHERE id=?', status, id);
        if (reserved !== null) db.run('UPDATE beds SET medical_reserved=? WHERE id=?', reserved, id);
        touched.add(row.room_id);
      }
      audit(db, ctx.actor, 'bed.update', 'bed', ids.join(','), { status, reserved });
    });
    const campId = campOf(ctx);
    for (const rid of touched) emit('beds', { camp_id: campId, room_id: rid });
    if (status === 'available' || reserved === 0) promoteWaitlist(db, campId, gender);
    return { ok: true, changed: ids.length };
  });

  // ---------------------------------------------------------------- bookings
  function bookingFilters(ctx) {
    const campId = campOf(ctx);
    const where = ['bk.camp_id=?'];
    const p = [campId];
    const q = (ctx.query.q || '').trim();
    if (q) { where.push("(u.full_name LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\' OR bk.ref LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"); p.push(like(q), like(q), like(q), like(q)); }
    if (ctx.query.status && ctx.query.status !== 'all') { where.push('bk.status=?'); p.push(oneOf(ctx.query.status, ['confirmed', 'checked_in', 'cancelled', 'released'], 'status')); }
    if (ctx.query.hostel_id) { where.push('h.id=?'); p.push(int(ctx.query.hostel_id, 'hostel_id')); }
    return { where: where.join(' AND '), p };
  }
  const BOOKING_SELECT = `SELECT bk.id, bk.ref, bk.status, bk.source, bk.created_at, bk.checked_in_at, bk.cancel_reason,
          u.id user_id, u.full_name, u.call_up_number, u.gender, u.verification_status, h.name hostel_name, r.number room_number, r.floor, b.label bed_label
     FROM bookings bk JOIN users u ON u.id=bk.user_id JOIN beds b ON b.id=bk.bed_id JOIN rooms r ON r.id=b.room_id JOIN hostels h ON h.id=r.hostel_id`;

  r.get('/api/admin/bookings', { perm: 'bookings.view' }, (ctx) => {
    const { where, p } = bookingFilters(ctx);
    const { page, size, offset } = paging(ctx);
    const total = db.get(`SELECT COUNT(*) n FROM bookings bk JOIN users u ON u.id=bk.user_id JOIN beds b ON b.id=bk.bed_id JOIN rooms r ON r.id=b.room_id JOIN hostels h ON h.id=r.hostel_id WHERE ${where}`, ...p).n;
    const items = db.all(`${BOOKING_SELECT} WHERE ${where} ORDER BY bk.id DESC LIMIT ? OFFSET ?`, ...p, size, offset);
    return { items, total, page, size };
  });

  r.get('/api/admin/bookings.csv', { perm: 'bookings.view' }, (ctx) => {
    const { where, p } = bookingFilters(ctx);
    const rows = db.all(`${BOOKING_SELECT} WHERE ${where} ORDER BY bk.id DESC LIMIT 20000`, ...p);
    ctx.audit('report.export', 'bookings', null, { rows: rows.length });
    const csv = toCsv(['Reference', 'Name', 'Call-up number', 'Gender', 'Hostel', 'Room', 'Bunk', 'Status', 'Source', 'Booked at', 'Checked in at'],
      rows.map((x) => [x.ref, x.full_name, x.call_up_number, x.gender, x.hostel_name, x.room_number, x.bed_label, x.status, x.source, x.created_at, x.checked_in_at]));
    return { __raw: true, body: csv, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campspace-bookings.csv"' } };
  });

  r.get('/api/admin/corps', { perm: 'bookings.view' }, (ctx) => {
    const campId = campOf(ctx);
    const where = ["u.role='corps_member'", 'u.camp_id=?', 'u.active=1'];
    const p = [campId];
    const q = (ctx.query.q || '').trim();
    if (q) { where.push("(u.full_name LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')"); p.push(like(q), like(q), like(q)); }
    if (ctx.query.unbooked === '1') where.push("NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.user_id=u.id AND bk.status IN ('confirmed','checked_in'))");
    if (ctx.query.verification) { where.push('u.verification_status=?'); p.push(oneOf(ctx.query.verification, ['unverified', 'pending', 'verified', 'rejected'], 'verification')); }
    const { page, size, offset } = paging(ctx);
    const total = db.get(`SELECT COUNT(*) n FROM users u WHERE ${where.join(' AND ')}`, ...p).n;
    const items = db.all(
      `SELECT u.id, u.full_name, u.call_up_number, u.gender, u.state_of_origin, u.verification_status, u.phone,
              (SELECT b.label FROM bookings bk JOIN beds b ON b.id=bk.bed_id WHERE bk.user_id=u.id AND bk.status IN ('confirmed','checked_in') LIMIT 1) bed_label,
              EXISTS (SELECT 1 FROM waitlist w WHERE w.user_id=u.id AND w.status='waiting') waiting
         FROM users u WHERE ${where.join(' AND ')} ORDER BY u.full_name LIMIT ? OFFSET ?`, ...p, size, offset);
    return { items, total, page, size };
  });

  r.post('/api/admin/corps/:id/verify', { perm: 'corps.verify' }, (ctx) => {
    const u = corperRow(ctx, int(ctx.params.id, 'id'));
    const status = oneOf(ctx.body.status, ['verified', 'rejected', 'pending'], 'Status');
    db.run('UPDATE users SET verification_status=? WHERE id=?', status, u.id);
    ctx.audit('corps.verify', 'user', u.id, { status });
    notify(db, u.id, 'info', status === 'verified' ? 'Call-up number verified' : status === 'rejected' ? 'Call-up number could not be verified' : 'Verification pending',
      status === 'rejected' ? 'Please check your call-up number in Profile Settings and correct it, or visit the accommodation desk.' : null, '#/app/settings');
    return { ok: true };
  });

  r.post('/api/admin/bookings/assign', { perm: 'bookings.manage' }, (ctx) => {
    const u = corperRow(ctx, int(ctx.body.user_id, 'user_id'));
    const bedId = int(ctx.body.bed_id, 'bed_id');
    const row = bedRows(db, { bedId })[0];
    if (!row) throw new HttpError(404, 'Bunk not found');
    sameCamp(ctx, row.camp_id);
    const existing = db.get("SELECT * FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id);
    let res;
    if (existing) {
      if (existing.status === 'checked_in') throw new HttpError(409, 'This corps member is already checked in. Cancel the booking first if they must move.');
      res = moveBooking(db, existing, bedId, { actor: ctx.actor, source: 'officer' });
    } else res = createBooking(db, { user: u, bedId, source: 'officer', actor: ctx.actor });
    return { booking: ticketView(db, vault, res.id) };
  });

  r.post('/api/admin/bookings/:id/cancel', { perm: 'bookings.manage' }, (ctx) => {
    const b = bookingRow(int(ctx.params.id, 'id'));
    sameCamp(ctx, b.camp_id);
    const reason = str(ctx.body.reason, 'Reason', { min: 3, max: 200 });
    cancelBooking(db, b, { actor: ctx.actor, reason: `Released by accommodation office: ${reason}`, status: 'released' });
    return { ok: true };
  });

  r.post('/api/admin/bookings/:id/move', { perm: 'bookings.manage' }, (ctx) => {
    const b = bookingRow(int(ctx.params.id, 'id'));
    sameCamp(ctx, b.camp_id);
    if (b.status !== 'confirmed') throw new HttpError(409, 'Only confirmed bookings can be moved.');
    const res = moveBooking(db, b, int(ctx.body.bed_id, 'bed_id'), { actor: ctx.actor, source: 'officer' });
    return { booking: ticketView(db, vault, res.id) };
  });

  // ---------------------------------------------------------------- check-in
  function locate(ctx, codeRaw) {
    const raw = str(codeRaw, 'Code', { max: 80 });
    const campId = campOf(ctx);
    let b = null;
    let signed = false;
    const ref = vault.parseQr(raw);
    if (ref) { b = db.get('SELECT * FROM bookings WHERE ref=?', ref); signed = true; }
    else if (/^CS1-/i.test(raw)) throw new HttpError(422, 'This QR code is not a genuine CampSpace ticket (the signature does not match).', { code: 'BAD_SIGNATURE' });
    else {
      const up = raw.toUpperCase().replace(/\s+/g, '');
      b = db.get('SELECT * FROM bookings WHERE ref=?', up)
        || db.get(`SELECT bk.* FROM bookings bk JOIN users u ON u.id=bk.user_id WHERE u.call_up_number=? AND bk.camp_id=?
                    ORDER BY CASE WHEN bk.status IN ('confirmed','checked_in') THEN 0 ELSE 1 END, bk.id DESC LIMIT 1`, up, campId);
    }
    if (!b) throw new HttpError(404, signed ? 'No booking found for this ticket.' : 'No booking matches that reference or call-up number.', { code: 'NOT_FOUND' });
    if (b.camp_id !== campId) {
      const other = db.get('SELECT name FROM camps WHERE id=?', b.camp_id);
      throw new HttpError(409, `This ticket is for a different camp (${other?.name}).`, { code: 'WRONG_CAMP' });
    }
    return { booking: b, signed };
  }

  function verifyResult(ctx, codeRaw) {
    const { booking, signed } = locate(ctx, codeRaw);
    const ticket = ticketView(db, vault, booking.id);
    const state = booking.status === 'confirmed' ? 'ready' : booking.status === 'checked_in' ? 'already_checked_in' : 'inactive';
    const message = {
      ready: 'Valid ticket. Ready to check in.',
      already_checked_in: `Already checked in at ${booking.checked_in_at?.slice(0, 16).replace('T', ' ')} UTC.`,
      inactive: `This booking was ${booking.status === 'released' ? 'released' : 'cancelled'}${booking.cancel_reason ? ` (${booking.cancel_reason})` : ''}. It is no longer valid.`,
    }[state];
    return { state, message, signed, ticket };
  }

  r.post('/api/admin/verify', { perm: 'checkin.manage' }, (ctx) => {
    const res = verifyResult(ctx, ctx.body.code);
    ctx.audit('checkin.verify', 'booking', res.ticket.id, { state: res.state, signed: res.signed });
    return res;
  });

  r.post('/api/admin/checkin', { perm: 'checkin.manage' }, (ctx) => {
    const b = bookingRow(int(ctx.body.booking_id, 'booking_id'));
    sameCamp(ctx, b.camp_id);
    db.tx(() => {
      const ts = now();
      const res = db.run("UPDATE bookings SET status='checked_in', checked_in_at=?, checked_in_by=?, updated_at=? WHERE id=? AND status='confirmed'", ts, ctx.user.id, ts, b.id);
      if (!res.changes) throw new HttpError(409, 'This booking cannot be checked in (it may already be checked in or cancelled).');
      audit(db, ctx.actor, 'checkin.complete', 'booking', b.id);
      notify(db, b.user_id, 'booking', 'You are checked in', 'Welcome to camp. Your bunk is confirmed.', '#/app/accommodation');
    });
    return { ticket: ticketView(db, vault, b.id) };
  });

  r.post('/api/admin/checkin/undo', { perm: 'checkin.manage' }, (ctx) => {
    const b = bookingRow(int(ctx.body.booking_id, 'booking_id'));
    sameCamp(ctx, b.camp_id);
    const res = db.run("UPDATE bookings SET status='confirmed', checked_in_at=NULL, checked_in_by=NULL, updated_at=? WHERE id=? AND status='checked_in'", now(), b.id);
    if (!res.changes) throw new HttpError(409, 'This booking is not checked in.');
    ctx.audit('checkin.undo', 'booking', b.id);
    return { ok: true };
  });

  r.get('/api/admin/checkins', { perm: 'checkin.manage' }, (ctx) => {
    const campId = campOf(ctx);
    return {
      items: db.all(
        `SELECT bk.id, bk.ref, bk.checked_in_at, u.full_name, u.call_up_number, b.label, s.full_name by_name
           FROM bookings bk JOIN users u ON u.id=bk.user_id JOIN beds b ON b.id=bk.bed_id LEFT JOIN users s ON s.id=bk.checked_in_by
          WHERE bk.camp_id=? AND bk.status='checked_in' ORDER BY bk.checked_in_at DESC LIMIT 30`, campId),
      totals: db.get("SELECT SUM(CASE WHEN status='checked_in' THEN 1 ELSE 0 END) checked_in, COUNT(*) active FROM bookings WHERE camp_id=? AND status IN ('confirmed','checked_in')", campId),
    };
  });

  // ---------------------------------------------------------------- medical accommodation instructions (no diagnoses)
  r.get('/api/admin/medical-instructions', { perm: 'medical.instructions' }, (ctx) => {
    const campId = campOf(ctx);
    const rows = db.all(
      `SELECT mr.id, mr.user_id, mr.priority, mr.approved_needs, mr.officer_instruction, mr.reviewed_at, u.full_name, u.call_up_number, u.gender
         FROM medical_requests mr JOIN users u ON u.id=mr.user_id
        WHERE mr.camp_id=? AND mr.status='approved'
        ORDER BY CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, mr.reviewed_at`, campId);
    const free = { male: bedRows(db, { campId, gender: 'male' }).filter((x) => !x.booking_id), female: bedRows(db, { campId, gender: 'female' }).filter((x) => !x.booking_id) };
    return {
      items: rows.map((x) => {
        const needs = JSON.parse(x.approved_needs);
        const bk = db.get(
          `SELECT bk.id, bk.status, b.label, b.level, r.floor, r.number room_number, h.name hostel_name
             FROM bookings bk JOIN beds b ON b.id=bk.bed_id JOIN rooms r ON r.id=b.room_id JOIN hostels h ON h.id=r.hostel_id
            WHERE bk.user_id=? AND bk.status IN ('confirmed','checked_in')`, x.user_id);
        const needGround = needs.includes('ground_floor') || needs.includes('wheelchair_access');
        const conflict = !!bk && ((needGround && bk.floor !== 0) || (needs.includes('lower_bunk') && bk.level !== 'lower'));
        const fake = { id: x.user_id };
        const suitable = free[x.gender].filter((row) => bedState(row, fake, needs) === 'available').length;
        return {
          request_id: x.id, user_id: x.user_id, full_name: x.full_name, call_up_number: x.call_up_number, gender: x.gender,
          priority: x.priority, needs, need_labels: needLabels(needs), instruction: x.officer_instruction, approved_at: x.reviewed_at,
          booking: bk || null, conflict, waiting: !!db.get("SELECT 1 x FROM waitlist WHERE user_id=? AND status='waiting'", x.user_id),
          suitable_free: suitable,
        };
      }),
    };
  });

  r.post('/api/admin/medical-instructions/:id/allocate', { perm: 'bookings.manage' }, (ctx) => {
    const mr = db.get("SELECT * FROM medical_requests WHERE id=? AND status='approved'", int(ctx.params.id, 'id'));
    if (!mr) throw new HttpError(404, 'Approved request not found');
    sameCamp(ctx, mr.camp_id);
    const u = db.get('SELECT * FROM users WHERE id=?', mr.user_id);
    const needs = approvedNeeds(db, u.id);
    const existing = db.get("SELECT * FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id);
    let bedId = ctx.body.bed_id ? int(ctx.body.bed_id, 'bed_id') : null;
    if (!bedId) {
      const bed = findBedFor(db, u);
      if (!bed) throw new HttpError(409, 'No suitable bunk is free. Release a bunk or mark more ground-floor bunks as medical reserve.', { code: 'NO_SUITABLE_BED' });
      bedId = bed.bed_id;
    }
    if (existing?.status === 'checked_in') throw new HttpError(409, 'Already checked in. Cancel the booking first if they must move.');
    const res = existing ? moveBooking(db, existing, bedId, { actor: ctx.actor, source: 'officer' }) : createBooking(db, { user: u, bedId, source: 'officer', actor: ctx.actor });
    ctx.audit('medical.allocate', 'medical_request', mr.id, { booking: res.id });
    void needs;
    return { booking: ticketView(db, vault, res.id) };
  });

  // ---------------------------------------------------------------- waiting list
  r.get('/api/admin/waitlist', { perm: 'bookings.view' }, (ctx) => {
    const campId = campOf(ctx);
    const items = db.all(
      `SELECT w.id, w.user_id, w.priority, w.note, w.created_at, w.gender, u.full_name, u.call_up_number
         FROM waitlist w JOIN users u ON u.id=w.user_id WHERE w.camp_id=? AND w.status='waiting'
        ORDER BY w.priority DESC, w.created_at ASC, w.id ASC`, campId);
    const pos = { male: 0, female: 0 };
    for (const it of items) it.position = ++pos[it.gender];
    return { items };
  });

  r.post('/api/admin/waitlist/:id/promote', { perm: 'bookings.manage' }, (ctx) => {
    const w = db.get("SELECT * FROM waitlist WHERE id=? AND status='waiting'", int(ctx.params.id, 'id'));
    if (!w) throw new HttpError(404, 'Waiting-list entry not found');
    sameCamp(ctx, w.camp_id);
    const u = db.get('SELECT * FROM users WHERE id=?', w.user_id);
    const bed = findBedFor(db, u);
    if (!bed) throw new HttpError(409, 'No suitable bunk is free for this person right now.', { code: 'NO_SUITABLE_BED' });
    const res = createBooking(db, { user: u, bedId: bed.bed_id, source: 'officer', actor: ctx.actor });
    return { booking: ticketView(db, vault, res.id) };
  });

  r.delete('/api/admin/waitlist/:id', { perm: 'bookings.manage' }, (ctx) => {
    const w = db.get("SELECT * FROM waitlist WHERE id=? AND status='waiting'", int(ctx.params.id, 'id'));
    if (!w) throw new HttpError(404, 'Waiting-list entry not found');
    sameCamp(ctx, w.camp_id);
    db.run("UPDATE waitlist SET status='cancelled' WHERE id=?", w.id);
    ctx.audit('waitlist.remove', 'waitlist', w.id);
    notify(db, w.user_id, 'waitlist', 'Removed from the waiting list', 'Please contact the accommodation desk if this is unexpected.', '#/app/accommodation');
    return { ok: true };
  });

  // ---------------------------------------------------------------- reports
  r.get('/api/admin/reports', { perm: 'reports.camp' }, (ctx) => {
    const campId = campOf(ctx);
    const camp = db.get('SELECT id, name, state, batch FROM camps WHERE id=?', campId);
    return { camp, report: campReport(db, campId), generated_at: now() };
  });

  r.get('/api/admin/reports.csv', { perm: 'reports.camp' }, (ctx) => {
    const campId = campOf(ctx);
    const rep = campReport(db, campId);
    ctx.audit('report.export', 'occupancy', null);
    const csv = toCsv(['Hostel', 'Gender', 'Total bunks', 'Booked', 'Checked in', 'Blocked', 'Available'],
      rep.by_hostel.map((h) => [h.name, h.gender, h.beds, h.booked, h.checked_in, h.blocked, h.available]));
    return { __raw: true, body: csv, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campspace-occupancy.csv"' } };
  });

  void arrayOf; void NEEDS;
}
