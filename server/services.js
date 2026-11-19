// Business logic shared by all route modules: audit trail, notifications, bunk eligibility,
// transactional booking, waiting-list promotion, tickets and reports.
import crypto from 'node:crypto';
import { HttpError } from './util.js';
import { emit } from './events.js';
import { NEEDS } from './constants.js';

export const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- config
export function getConfig(db) {
  const out = {};
  for (const r of db.all('SELECT key, value FROM config')) out[r.key] = r.value;
  return out;
}
export const cfgBool = (db, key) => (db.get('SELECT value FROM config WHERE key=?', key)?.value) === 'true';
export const cfgNum = (db, key, d) => {
  const v = Number(db.get('SELECT value FROM config WHERE key=?', key)?.value);
  return Number.isFinite(v) ? v : d;
};

// ---------------------------------------------------------------- audit (append-only, hash-chained)
const auditHash = (prev, r) =>
  sha([prev, r.ts, r.user_id ?? '', r.role ?? '', r.action, r.entity ?? '', r.entity_id ?? '', r.detail ?? '', r.ip ?? ''].join('|'));

export function audit(db, actor, action, entity = null, entityId = null, detail = null) {
  const last = db.get('SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1');
  const prev = last ? last.hash : 'GENESIS';
  const row = {
    ts: now(),
    user_id: actor?.id ?? null,
    role: actor?.role ?? null,
    action,
    entity,
    entity_id: entityId == null ? null : String(entityId),
    detail: detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    ip: actor?.ip ?? null,
  };
  const hash = auditHash(prev, row);
  db.run(
    'INSERT INTO audit_logs(ts,user_id,role,action,entity,entity_id,detail,ip,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    row.ts, row.user_id, row.role, row.action, row.entity, row.entity_id, row.detail, row.ip, prev, hash,
  );
}

export function verifyAuditChain(db) {
  let prev = 'GENESIS';
  let checked = 0;
  for (const r of db.all('SELECT * FROM audit_logs ORDER BY id ASC')) {
    if (r.prev_hash !== prev || auditHash(prev, r) !== r.hash) return { ok: false, checked, broken_at: r.id };
    prev = r.hash;
    checked++;
  }
  return { ok: true, checked, broken_at: null };
}

// ---------------------------------------------------------------- notifications
export function notify(db, userId, kind, title, body = null, link = null) {
  db.run('INSERT INTO notifications(user_id,kind,title,body,link,read,created_at) VALUES (?,?,?,?,?,0,?)', userId, kind, title, body, link, now());
  db.onCommit(() => emit('notify', { user_id: userId }));
}
export function notifyRole(db, campId, role, kind, title, body = null, link = null) {
  for (const u of db.all('SELECT id FROM users WHERE role=? AND active=1 AND (camp_id=? OR camp_id IS NULL)', role, campId))
    notify(db, u.id, kind, title, body, link);
}

// ---------------------------------------------------------------- medical needs & bed eligibility
export function approvedNeeds(db, userId) {
  const set = new Set();
  for (const r of db.all("SELECT approved_needs FROM medical_requests WHERE user_id=? AND status='approved'", userId)) {
    try { JSON.parse(r.approved_needs).forEach((x) => set.add(x)); } catch { /* ignore bad row */ }
  }
  return [...set];
}
export const needLabels = (needs) => needs.map((n) => NEEDS[n] || n);
const needsGround = (med) => med.includes('ground_floor') || med.includes('wheelchair_access');

export function bedRows(db, { campId = null, hostelId = null, roomId = null, bedId = null, gender = null } = {}) {
  const where = [];
  const p = [];
  if (campId != null) { where.push('h.camp_id=?'); p.push(campId); }
  if (hostelId != null) { where.push('h.id=?'); p.push(hostelId); }
  if (roomId != null) { where.push('r.id=?'); p.push(roomId); }
  if (bedId != null) { where.push('b.id=?'); p.push(bedId); }
  if (gender != null) { where.push('h.gender=?'); p.push(gender); }
  return db.all(
    `SELECT b.id bed_id, b.room_id, b.bunk_no, b.level, b.label, b.status bed_status, b.medical_reserved bed_med,
            r.number room_number, r.floor, r.status room_status, r.medical_reserved room_med, r.hostel_id,
            h.name hostel_name, h.gender, h.active hostel_active, h.camp_id,
            bk.id booking_id, bk.user_id booking_user, bk.status booking_status
       FROM beds b
       JOIN rooms r ON r.id = b.room_id
       JOIN hostels h ON h.id = r.hostel_id
       LEFT JOIN bookings bk ON bk.bed_id = b.id AND bk.status IN ('confirmed','checked_in')
      WHERE ${where.join(' AND ') || '1=1'}
      ORDER BY h.id, r.floor, r.number, b.bunk_no, b.level`,
    ...p,
  );
}

/** One source of truth for what a corps member sees and what the server will accept. */
export function bedState(row, user, med, { override = false } = {}) {
  if (row.booking_id) return row.booking_user === user?.id ? 'mine' : 'booked';
  if (row.bed_status === 'blocked' || row.room_status !== 'open' || !row.hostel_active) return 'blocked';
  if (override) return 'available';
  if ((row.bed_med || row.room_med) && !med.length) return 'reserved';
  if (needsGround(med) && row.floor !== 0) return 'restricted';
  if (med.includes('lower_bunk') && row.level !== 'lower') return 'restricted';
  return 'available';
}

const STATE_MESSAGES = {
  booked: ['BED_TAKEN', 'That bunk was just taken by someone else. Please choose another.'],
  mine: ['ALREADY_BOOKED', 'That bunk is already yours.'],
  blocked: ['BED_UNAVAILABLE', 'That bunk is not available for booking.'],
  reserved: ['BED_RESERVED', 'That bunk is reserved for approved medical accommodation.'],
  restricted: ['BED_RESTRICTED', 'Your approved medical accommodation requires a different bunk (for example a ground-floor room or a lower bunk).'],
};

export function bookingWindow(camp) {
  if (!camp.active) return { open: false, reason: 'This camp is not active.' };
  if (!camp.booking_open) return { open: false, reason: 'Booking is currently closed for this camp.' };
  const t = Date.now();
  if (camp.booking_opens_at && Date.parse(camp.booking_opens_at) > t) return { open: false, reason: `Booking opens on ${camp.booking_opens_at.slice(0, 10)}.` };
  if (camp.booking_closes_at && Date.parse(camp.booking_closes_at) < t) return { open: false, reason: 'Booking for this camp has closed.' };
  return { open: true, reason: null };
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef(db) {
  for (;;) {
    const b = crypto.randomBytes(8);
    let s = '';
    for (let i = 0; i < 8; i++) s += REF_ALPHABET[b[i] % REF_ALPHABET.length];
    if (!db.get('SELECT 1 x FROM bookings WHERE ref=?', s)) return s;
  }
}

const bedEvent = (db, campId, roomId) => db.onCommit(() => emit('beds', { camp_id: campId, room_id: roomId }));

/**
 * Create a booking inside one immediate transaction. Two people can never end up in the same bunk and one
 * person can never hold two bunks: the checks below run serialised, and partial unique indexes enforce it again.
 */
export function createBooking(db, { user, bedId, source = 'self', clientRef = null, actor = null }) {
  return db.tx(() => {
    if (clientRef) {
      const ex = db.get('SELECT id, ref FROM bookings WHERE user_id=? AND client_ref=?', user.id, clientRef);
      if (ex) return { id: ex.id, ref: ex.ref, duplicate: true };
    }
    if (user.role !== 'corps_member') throw new HttpError(400, 'Only corps members can hold a bunk.');
    const camp = db.get('SELECT * FROM camps WHERE id=?', user.camp_id);
    if (!camp) throw new HttpError(400, 'You are not assigned to a camp.');
    const staff = source === 'officer';
    if (!staff) {
      const w = bookingWindow(camp);
      if (!w.open) throw new HttpError(409, w.reason, { code: 'BOOKING_CLOSED' });
      if (cfgBool(db, 'require_verified_to_book') && user.verification_status !== 'verified')
        throw new HttpError(403, 'Your NYSC call-up number must be verified before you can book.', { code: 'NOT_VERIFIED' });
    }
    if (db.get("SELECT 1 x FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", user.id))
      throw new HttpError(409, 'You already have an active accommodation booking.', { code: 'ALREADY_BOOKED' });

    const row = bedRows(db, { bedId })[0];
    if (!row) throw new HttpError(404, 'Bunk not found.');
    if (row.camp_id !== user.camp_id) throw new HttpError(403, 'That bunk is in a different camp.');
    if (row.gender !== user.gender) throw new HttpError(403, `That hostel is for ${row.gender} corps members.`);
    const med = approvedNeeds(db, user.id);
    const st = bedState(row, user, med, { override: staff });
    if (st !== 'available') {
      const [code, msg] = STATE_MESSAGES[st];
      throw new HttpError(409, msg, { code });
    }

    const ts = now();
    const ref = newRef(db);
    let id;
    try {
      id = Number(db.run(
        'INSERT INTO bookings(ref,user_id,camp_id,bed_id,status,source,client_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ref, user.id, camp.id, bedId, 'confirmed', source, clientRef, ts, ts,
      ).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) {
        throw new HttpError(409, STATE_MESSAGES.booked[1], { code: 'BED_TAKEN' });
      }
      throw e;
    }
    db.run("UPDATE waitlist SET status='fulfilled', fulfilled_at=?, booking_id=? WHERE user_id=? AND status='waiting'", ts, id, user.id);
    audit(db, actor || { id: user.id, role: user.role }, `booking.${source === 'self' ? 'create' : source}`, 'booking', id, { bed: row.label, user: user.id });
    const where = `${row.hostel_name}, room ${row.room_number}, ${row.label}`;
    notify(db, user.id, 'booking',
      source === 'waitlist' ? 'A bunk was allocated from the waiting list' : source === 'officer' ? 'An officer assigned you a bunk' : 'Booking confirmed',
      `Your bunk is ${where}. Your ticket is ready under My Accommodation.`, '#/app/accommodation');
    bedEvent(db, camp.id, row.room_id);
    return { id, ref, duplicate: false };
  });
}

export function cancelBooking(db, booking, { actor, reason = null, status = 'cancelled', notifyUser = true }) {
  return db.tx(() => {
    const b = db.get('SELECT * FROM bookings WHERE id=?', booking.id);
    if (!b || !['confirmed', 'checked_in'].includes(b.status)) throw new HttpError(409, 'That booking is no longer active.');
    const ts = now();
    db.run('UPDATE bookings SET status=?, cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?', status, ts, reason, ts, b.id);
    audit(db, actor, `booking.${status}`, 'booking', b.id, { reason });
    const bed = db.get('SELECT b.label, b.room_id, r.hostel_id FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.id=?', b.bed_id);
    if (notifyUser) notify(db, b.user_id, 'booking', status === 'cancelled' ? 'Booking cancelled' : 'Bunk released', reason || `Bunk ${bed.label} is no longer held for you.`, '#/app/accommodation');
    bedEvent(db, b.camp_id, bed.room_id);
    const u = db.get('SELECT gender FROM users WHERE id=?', b.user_id);
    promoteWaitlist(db, b.camp_id, u.gender);
    return b;
  });
}

export function moveBooking(db, booking, newBedId, { actor, source = 'self' }) {
  return db.tx(() => {
    const user = db.get('SELECT * FROM users WHERE id=?', booking.user_id);
    const b = db.get('SELECT * FROM bookings WHERE id=?', booking.id);
    if (!b || b.status !== 'confirmed') throw new HttpError(409, 'Only a confirmed booking can be moved.');
    if (b.bed_id === newBedId) throw new HttpError(400, 'You already hold that bunk.');
    // release first (inside the same transaction: if the new bunk is refused, everything rolls back)
    const ts = now();
    db.run("UPDATE bookings SET status='released', cancelled_at=?, cancel_reason=?, updated_at=? WHERE id=?", ts, 'Changed bunk', ts, b.id);
    const res = createBooking(db, { user, bedId: newBedId, source: source === 'officer' ? 'officer' : 'self', actor });
    const oldBed = db.get('SELECT room_id FROM beds WHERE id=?', b.bed_id);
    bedEvent(db, b.camp_id, oldBed.room_id);
    promoteWaitlist(db, b.camp_id, user.gender);
    return res;
  });
}

/** Choose the best free bunk for someone (used by auto-pick and waiting-list promotion). */
export function findBedFor(db, user, { hostelId = null } = {}) {
  const med = approvedNeeds(db, user.id);
  const ok = bedRows(db, { campId: user.camp_id, gender: user.gender, hostelId }).filter((r) => bedState(r, user, med) === 'available');
  if (!ok.length) return null;
  // Keep ground-floor rooms free for people who need them.
  ok.sort((a, b) => (med.length ? a.floor - b.floor || (a.level === 'lower' ? -1 : 1) - (b.level === 'lower' ? -1 : 1) : b.floor - a.floor)
    || a.room_number.localeCompare(b.room_number) || a.bunk_no - b.bunk_no || a.level.localeCompare(b.level));
  return ok[0];
}

export function promoteWaitlist(db, campId, gender) {
  if (!cfgBool(db, 'waitlist_auto_promote')) return [];
  const promoted = [];
  const waiting = db.all(
    "SELECT user_id FROM waitlist WHERE status='waiting' AND camp_id=? AND gender=? ORDER BY priority DESC, created_at ASC, id ASC",
    campId, gender,
  );
  for (const w of waiting) {
    const user = db.get('SELECT * FROM users WHERE id=? AND active=1', w.user_id);
    if (!user) continue;
    const bed = findBedFor(db, user);
    if (!bed) continue;
    try {
      promoted.push(createBooking(db, { user, bedId: bed.bed_id, source: 'waitlist', actor: { id: null, role: 'system' } }).id);
    } catch { /* this person cannot be placed right now; try the next */ }
  }
  return promoted;
}

// ---------------------------------------------------------------- tickets
export function ticketView(db, vault, bookingId) {
  const r = db.get(
    `SELECT bk.*, u.full_name, u.call_up_number, u.gender, u.state_of_origin, u.institution, u.verification_status,
            c.name camp_name, c.state camp_state, c.batch, c.address camp_address,
            b.label, b.bunk_no, b.level, r.number room_number, r.floor, h.name hostel_name
       FROM bookings bk
       JOIN users u ON u.id = bk.user_id
       JOIN camps c ON c.id = bk.camp_id
       JOIN beds b ON b.id = bk.bed_id
       JOIN rooms r ON r.id = b.room_id
       JOIN hostels h ON h.id = r.hostel_id
      WHERE bk.id = ?`, bookingId);
  if (!r) return null;
  return {
    id: r.id,
    ref: r.ref,
    status: r.status,
    source: r.source,
    created_at: r.created_at,
    checked_in_at: r.checked_in_at,
    cancelled_at: r.cancelled_at,
    cancel_reason: r.cancel_reason,
    qr: vault.qrCode(r.ref),
    corper: { id: r.user_id, name: r.full_name, call_up_number: r.call_up_number, gender: r.gender, state_of_origin: r.state_of_origin, institution: r.institution, verification_status: r.verification_status },
    camp: { id: r.camp_id, name: r.camp_name, state: r.camp_state, batch: r.batch, address: r.camp_address },
    hostel: { name: r.hostel_name },
    room: { number: r.room_number, floor: r.floor },
    bed: { id: r.bed_id, label: r.label, bunk_no: r.bunk_no, level: r.level },
    medical: needLabels(approvedNeeds(db, r.user_id)),
    generated_at: now(),
  };
}

// ---------------------------------------------------------------- reports
export function campReport(db, campId) {
  const q = (sql, ...p) => db.all(sql, ...p);
  const totals = db.get(
    `SELECT COUNT(*) beds,
            SUM(CASE WHEN b.status='blocked' OR r.status!='open' OR h.active=0 THEN 1 ELSE 0 END) blocked
       FROM beds b JOIN rooms r ON r.id=b.room_id JOIN hostels h ON h.id=r.hostel_id WHERE h.camp_id=?`, campId);
  const booked = db.get("SELECT COUNT(*) n, SUM(CASE WHEN status='checked_in' THEN 1 ELSE 0 END) checked_in FROM bookings WHERE camp_id=? AND status IN ('confirmed','checked_in')", campId);
  const corps = db.get("SELECT COUNT(*) n, SUM(CASE WHEN gender='male' THEN 1 ELSE 0 END) male, SUM(CASE WHEN gender='female' THEN 1 ELSE 0 END) female, SUM(CASE WHEN verification_status='verified' THEN 1 ELSE 0 END) verified FROM users WHERE role='corps_member' AND camp_id=? AND active=1", campId);
  const byHostel = q(
    `SELECT h.id, h.name, h.gender,
            COUNT(b.id) beds,
            SUM(CASE WHEN bk.id IS NOT NULL THEN 1 ELSE 0 END) booked,
            SUM(CASE WHEN bk.status='checked_in' THEN 1 ELSE 0 END) checked_in,
            SUM(CASE WHEN bk.id IS NULL AND (b.status='blocked' OR r.status!='open') THEN 1 ELSE 0 END) blocked
       FROM hostels h JOIN rooms r ON r.hostel_id=h.id JOIN beds b ON b.room_id=r.id
       LEFT JOIN bookings bk ON bk.bed_id=b.id AND bk.status IN ('confirmed','checked_in')
      WHERE h.camp_id=? GROUP BY h.id ORDER BY h.id`, campId);
  const byFloor = q(
    `SELECT r.floor, COUNT(b.id) beds, SUM(CASE WHEN bk.id IS NOT NULL THEN 1 ELSE 0 END) booked
       FROM rooms r JOIN hostels h ON h.id=r.hostel_id JOIN beds b ON b.room_id=r.id
       LEFT JOIN bookings bk ON bk.bed_id=b.id AND bk.status IN ('confirmed','checked_in')
      WHERE h.camp_id=? GROUP BY r.floor ORDER BY r.floor`, campId);
  const perDay = q("SELECT substr(created_at,1,10) day, COUNT(*) n FROM bookings WHERE camp_id=? GROUP BY day ORDER BY day DESC LIMIT 21", campId).reverse();
  const bySource = q('SELECT source, COUNT(*) n FROM bookings WHERE camp_id=? GROUP BY source', campId);
  const byState = q("SELECT COALESCE(state_of_origin,'Unknown') state, COUNT(*) n FROM users WHERE role='corps_member' AND camp_id=? GROUP BY state ORDER BY n DESC LIMIT 8", campId);
  const waitlist = db.get("SELECT COUNT(*) n, SUM(CASE WHEN priority>0 THEN 1 ELSE 0 END) priority FROM waitlist WHERE camp_id=? AND status='waiting'", campId);
  const medical = {
    by_status: q('SELECT status, COUNT(*) n FROM medical_requests WHERE camp_id=? GROUP BY status', campId),
    by_priority: q("SELECT priority, COUNT(*) n FROM medical_requests WHERE camp_id=? AND status IN ('submitted','under_review','more_info','approved') GROUP BY priority", campId),
  };
  const cancellations = db.get("SELECT SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled, SUM(CASE WHEN status='released' THEN 1 ELSE 0 END) released FROM bookings WHERE camp_id=?", campId);
  const capacity = totals.beds - (totals.blocked || 0);
  return {
    capacity: { total_beds: totals.beds, blocked: totals.blocked || 0, bookable: capacity },
    bookings: { active: booked.n, checked_in: booked.checked_in || 0, available: Math.max(0, capacity - booked.n), occupancy_pct: capacity ? Math.round((booked.n / capacity) * 1000) / 10 : 0 },
    corps: { registered: corps.n, male: corps.male || 0, female: corps.female || 0, verified: corps.verified || 0, without_booking: Math.max(0, corps.n - booked.n) },
    by_hostel: byHostel.map((h) => ({ ...h, blocked: h.blocked || 0, checked_in: h.checked_in || 0, available: h.beds - h.booked - (h.blocked || 0) })),
    by_floor: byFloor,
    per_day: perDay,
    by_source: bySource,
    by_state: byState,
    waitlist: { waiting: waitlist.n, priority: waitlist.priority || 0 },
    medical,
    cancellations: { cancelled: cancellations.cancelled || 0, released: cancellations.released || 0 },
  };
}
