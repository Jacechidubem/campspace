// Super administrator endpoints: camps, users, roles, configuration, system reports, audit logs.
import { HttpError, str, int, oneOf, email, phone, password, callUp, toCsv } from '../util.js';
import { ROLES, ROLE_LABELS, PERMISSIONS, DEFAULT_CONFIG, STATES } from '../constants.js';
import { now, audit, notify, verifyAuditChain, campReport, getConfig } from '../services.js';
import { hashPassword } from '../security.js';
import { paging, like } from '../scope.js';
import crypto from 'node:crypto';

const CONFIG_BOOL = ['registration_open', 'require_verified_to_book', 'allow_self_cancel', 'waitlist_auto_promote'];
const CONFIG_INT = { max_self_cancellations: [0, 10], session_hours: [1, 72] };
const CONFIG_TEXT = { support_email: 160, support_phone: 30, announcement: 300 };

function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[b[i] % alphabet.length];
  return s + '7a';
}

export function registerSuper(r, app) {
  const { db } = app;

  // ---------------------------------------------------------------- dashboard
  r.get('/api/super/dashboard', { perm: 'reports.system' }, () => {
    const camps = db.all('SELECT id, code, name, state, batch, booking_open, active FROM camps ORDER BY name').map((c) => {
      const rep = campReport(db, c.id);
      return { ...c, beds: rep.capacity.total_beds, booked: rep.bookings.active, checked_in: rep.bookings.checked_in, occupancy_pct: rep.bookings.occupancy_pct, waiting: rep.waitlist.waiting, corps: rep.corps.registered };
    });
    const users = db.all('SELECT role, COUNT(*) n FROM users WHERE active=1 GROUP BY role');
    const lastLogins = db.get("SELECT COUNT(*) n FROM users WHERE last_login_at > ?", new Date(Date.now() - 24 * 3600_000).toISOString()).n;
    const msgs = db.all('SELECT id, name, email, subject, created_at, handled FROM contact_messages ORDER BY id DESC LIMIT 5');
    const chain = verifyAuditChain(db);
    return {
      camps, users, active_last_24h: lastLogins, contact_messages: msgs, unhandled_messages: db.get('SELECT COUNT(*) n FROM contact_messages WHERE handled=0').n,
      audit: { entries: db.get('SELECT COUNT(*) n FROM audit_logs').n, intact: chain.ok },
      sessions: db.get('SELECT COUNT(*) n FROM sessions WHERE expires_at > ?', now()).n,
    };
  });

  r.get('/api/super/reports', { perm: 'reports.system' }, () => {
    const camps = db.all('SELECT id, name, state, batch FROM camps ORDER BY name');
    const per = camps.map((c) => ({ camp: c, report: campReport(db, c.id) }));
    const tot = per.reduce((a, x) => {
      a.beds += x.report.capacity.total_beds; a.booked += x.report.bookings.active; a.checked_in += x.report.bookings.checked_in;
      a.corps += x.report.corps.registered; a.waiting += x.report.waitlist.waiting; return a;
    }, { beds: 0, booked: 0, checked_in: 0, corps: 0, waiting: 0 });
    return { totals: tot, camps: per, generated_at: now() };
  });

  r.get('/api/super/reports.csv', { perm: 'reports.system' }, (ctx) => {
    const rows = db.all('SELECT id, name, state, batch FROM camps ORDER BY name').map((c) => {
      const rep = campReport(db, c.id);
      return [c.name, c.state, c.batch, rep.capacity.total_beds, rep.bookings.active, rep.bookings.checked_in, rep.bookings.available, rep.bookings.occupancy_pct, rep.waitlist.waiting, rep.corps.registered];
    });
    ctx.audit('report.export', 'system', null);
    return { __raw: true, body: toCsv(['Camp', 'State', 'Batch', 'Bunks', 'Booked', 'Checked in', 'Available', 'Occupancy %', 'Waiting', 'Registered corps'], rows), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campspace-system-report.csv"' } };
  });

  // ---------------------------------------------------------------- camps
  r.get('/api/super/camps', { perm: 'camps.manage' }, () => ({
    items: db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM hostels h WHERE h.camp_id=c.id) hostels,
              (SELECT COUNT(*) FROM users u WHERE u.camp_id=c.id AND u.role='corps_member') corps,
              (SELECT COUNT(*) FROM users u WHERE u.camp_id=c.id AND u.role!='corps_member') staff
         FROM camps c ORDER BY c.name`),
  }));

  function campFields(b, cur = {}) {
    const f = {
      name: b.name !== undefined ? str(b.name, 'Name', { min: 3, max: 120 }) : cur.name,
      state: b.state !== undefined ? oneOf(b.state, STATES, 'State') : cur.state,
      address: b.address !== undefined ? str(b.address, 'Address', { required: false, max: 200 }) : cur.address,
      batch: b.batch !== undefined ? str(b.batch, 'Batch', { min: 2, max: 30 }) : cur.batch,
      starts_on: b.starts_on !== undefined ? str(b.starts_on, 'Start date', { required: false, max: 10 }) : cur.starts_on,
      ends_on: b.ends_on !== undefined ? str(b.ends_on, 'End date', { required: false, max: 10 }) : cur.ends_on,
      booking_open: b.booking_open !== undefined ? (b.booking_open ? 1 : 0) : (cur.booking_open ?? 1),
      booking_opens_at: b.booking_opens_at !== undefined ? str(b.booking_opens_at, 'Booking opens', { required: false, max: 30 }) : cur.booking_opens_at,
      booking_closes_at: b.booking_closes_at !== undefined ? str(b.booking_closes_at, 'Booking closes', { required: false, max: 30 }) : cur.booking_closes_at,
      active: b.active !== undefined ? (b.active ? 1 : 0) : (cur.active ?? 1),
    };
    for (const k of ['starts_on', 'ends_on']) if (f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k])) throw new HttpError(400, 'Dates must look like 2026-12-01');
    for (const k of ['booking_opens_at', 'booking_closes_at']) if (f[k] && Number.isNaN(Date.parse(f[k]))) throw new HttpError(400, 'Booking window dates are not valid');
    return f;
  }

  r.post('/api/super/camps', { perm: 'camps.manage' }, (ctx) => {
    const f = campFields(ctx.body);
    const code = str(ctx.body.code, 'Camp code', { min: 2, max: 12 }).toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(code)) throw new HttpError(400, 'Camp code may only contain letters, numbers and dashes.');
    try {
      const id = Number(db.run(
        'INSERT INTO camps(code,name,state,address,batch,starts_on,ends_on,booking_open,booking_opens_at,booking_closes_at,active) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        code, f.name, f.state, f.address, f.batch, f.starts_on, f.ends_on, f.booking_open, f.booking_opens_at, f.booking_closes_at, f.active).lastInsertRowid);
      ctx.audit('camp.create', 'camp', id, { code });
      return { id };
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'A camp with that code already exists.');
      throw e;
    }
  });

  r.patch('/api/super/camps/:id', { perm: 'camps.manage' }, (ctx) => {
    const cur = db.get('SELECT * FROM camps WHERE id=?', int(ctx.params.id, 'id'));
    if (!cur) throw new HttpError(404, 'Camp not found');
    const f = campFields(ctx.body, cur);
    db.run('UPDATE camps SET name=?, state=?, address=?, batch=?, starts_on=?, ends_on=?, booking_open=?, booking_opens_at=?, booking_closes_at=?, active=? WHERE id=?',
      f.name, f.state, f.address, f.batch, f.starts_on, f.ends_on, f.booking_open, f.booking_opens_at, f.booking_closes_at, f.active, cur.id);
    ctx.audit('camp.update', 'camp', cur.id, { booking_open: f.booking_open, active: f.active });
    return { ok: true };
  });

  // ---------------------------------------------------------------- users
  r.get('/api/super/users', { perm: 'users.manage' }, (ctx) => {
    const where = ['1=1'];
    const p = [];
    const q = (ctx.query.q || '').trim();
    if (q) { where.push("(u.full_name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\')"); p.push(like(q), like(q), like(q)); }
    if (ctx.query.role && ctx.query.role !== 'all') { where.push('u.role=?'); p.push(oneOf(ctx.query.role, ROLES, 'role')); }
    if (ctx.query.camp_id) { where.push('u.camp_id=?'); p.push(int(ctx.query.camp_id, 'camp_id')); }
    const { page, size, offset } = paging(ctx);
    const total = db.get(`SELECT COUNT(*) n FROM users u WHERE ${where.join(' AND ')}`, ...p).n;
    const items = db.all(
      `SELECT u.id, u.email, u.full_name, u.role, u.call_up_number, u.gender, u.camp_id, c.name camp_name, u.verification_status, u.active, u.last_login_at, u.created_at
         FROM users u LEFT JOIN camps c ON c.id=u.camp_id WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ? OFFSET ?`, ...p, size, offset)
      .map((x) => ({ ...x, role_label: ROLE_LABELS[x.role] }));
    return { items, total, page, size };
  });

  r.post('/api/super/users', { perm: 'users.manage' }, async (ctx) => {
    const b = ctx.body;
    const role = oneOf(b.role, ROLES.filter((x) => x !== 'corps_member'), 'Role');
    const full_name = str(b.full_name, 'Full name', { min: 3, max: 100 });
    const mail = email(b.email);
    const camp_id = role === 'super_admin' ? null : int(b.camp_id, 'Camp');
    if (camp_id && !db.get('SELECT 1 x FROM camps WHERE id=?', camp_id)) throw new HttpError(400, 'Choose a valid camp.');
    if (db.get('SELECT 1 x FROM users WHERE email=?', mail)) throw new HttpError(409, 'A user with that email already exists.');
    const temp = tempPassword();
    const hash = await hashPassword(temp);
    const id = Number(db.run(
      'INSERT INTO users(email,phone,password_hash,role,full_name,camp_id,verification_status,must_change_password,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      mail, phone(b.phone, false), hash, role, full_name, camp_id, 'verified', 1, now()).lastInsertRowid);
    ctx.audit('user.create', 'user', id, { role });
    return { id, temporary_password: temp };
  });

  r.patch('/api/super/users/:id', { perm: 'users.manage' }, (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id=?', int(ctx.params.id, 'id'));
    if (!u) throw new HttpError(404, 'User not found');
    const b = ctx.body;
    const self = u.id === ctx.user.id;
    const role = b.role !== undefined ? oneOf(b.role, ROLES, 'Role') : u.role;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
    if (self && (role !== u.role || !active)) throw new HttpError(409, 'You cannot change your own role or deactivate your own account.');
    if (u.role === 'corps_member' && role !== 'corps_member') throw new HttpError(409, 'Corps member accounts cannot be turned into staff accounts.');
    if (u.role !== 'corps_member' && role === 'corps_member') throw new HttpError(409, 'Staff accounts cannot be turned into corps member accounts.');
    const camp_id = b.camp_id !== undefined ? (b.camp_id === null ? null : int(b.camp_id, 'Camp')) : u.camp_id;
    if (camp_id && !db.get('SELECT 1 x FROM camps WHERE id=?', camp_id)) throw new HttpError(400, 'Choose a valid camp.');
    if (role !== 'super_admin' && !camp_id) throw new HttpError(400, 'This role must be assigned to a camp.');
    const gender = b.gender !== undefined && u.role === 'corps_member' ? oneOf(b.gender, ['male', 'female'], 'Gender') : u.gender;
    if (gender !== u.gender && db.get("SELECT 1 x FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id))
      throw new HttpError(409, 'Cancel the active booking before changing gender.');
    const ver = b.verification_status !== undefined ? oneOf(b.verification_status, ['unverified', 'pending', 'verified', 'rejected'], 'Verification') : u.verification_status;
    const name = b.full_name !== undefined ? str(b.full_name, 'Full name', { min: 3, max: 100 }) : u.full_name;
    const cu = b.call_up_number !== undefined && u.role === 'corps_member' ? callUp(b.call_up_number) : u.call_up_number;
    try {
      db.run('UPDATE users SET role=?, active=?, camp_id=?, gender=?, verification_status=?, full_name=?, call_up_number=? WHERE id=?', role, active, camp_id, gender, ver, name, cu, u.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That call-up number is already registered.');
      throw e;
    }
    if (!active) db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    ctx.audit('user.update', 'user', u.id, { role, active, camp_id });
    return { ok: true };
  });

  r.post('/api/super/users/:id/reset-password', { perm: 'users.manage' }, async (ctx) => {
    const u = db.get('SELECT * FROM users WHERE id=?', int(ctx.params.id, 'id'));
    if (!u) throw new HttpError(404, 'User not found');
    const temp = tempPassword();
    db.run('UPDATE users SET password_hash=?, must_change_password=1, failed_logins=0, locked_until=NULL WHERE id=?', await hashPassword(temp), u.id);
    db.run('DELETE FROM sessions WHERE user_id=?', u.id);
    ctx.audit('user.reset_password', 'user', u.id);
    notify(db, u.id, 'info', 'Your password was reset', 'An administrator reset your password. Sign in with the temporary password and choose a new one.');
    return { temporary_password: temp };
  });

  // ---------------------------------------------------------------- roles & permissions
  r.get('/api/super/roles', { perm: 'roles.manage' }, () => ({
    roles: ROLES.map((role) => ({
      role, label: ROLE_LABELS[role], locked: role === 'super_admin',
      users: db.get('SELECT COUNT(*) n FROM users WHERE role=? AND active=1', role).n,
      permissions: [...(app.perms[role] || [])],
    })),
    permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
  }));

  r.put('/api/super/roles/:role', { perm: 'roles.manage' }, (ctx) => {
    const role = oneOf(ctx.params.role, ROLES, 'Role');
    if (role === 'super_admin') throw new HttpError(409, 'The super administrator role is locked so the system can never be left without an administrator.');
    const list = Array.isArray(ctx.body.permissions) ? ctx.body.permissions : [];
    for (const p of list) if (!PERMISSIONS[p]) throw new HttpError(400, `Unknown permission: ${p}`);
    if (role === 'corps_member' && list.some((p) => !['booking.own', 'medical.request', 'hostels.view'].includes(p)))
      throw new HttpError(400, 'Corps members can only hold corps-member permissions.');
    db.tx(() => {
      db.run('DELETE FROM role_permissions WHERE role=?', role);
      for (const p of new Set(list)) db.run('INSERT INTO role_permissions(role,permission) VALUES (?,?)', role, p);
      audit(db, ctx.actor, 'role.update', 'role', role, { permissions: [...new Set(list)] });
    });
    app.reloadPerms();
    return { ok: true };
  });

  // ---------------------------------------------------------------- configuration
  r.get('/api/super/config', { perm: 'config.manage' }, () => ({ config: { ...DEFAULT_CONFIG, ...getConfig(db) } }));

  r.put('/api/super/config', { perm: 'config.manage' }, (ctx) => {
    const b = ctx.body;
    const changes = {};
    for (const k of CONFIG_BOOL) if (b[k] !== undefined) changes[k] = b[k] ? 'true' : 'false';
    for (const [k, [lo, hi]] of Object.entries(CONFIG_INT)) if (b[k] !== undefined) changes[k] = String(int(b[k], k, { min: lo, max: hi }));
    for (const [k, max] of Object.entries(CONFIG_TEXT)) if (b[k] !== undefined) changes[k] = str(b[k], k, { required: false, max }) || '';
    if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
    db.tx(() => {
      for (const [k, v] of Object.entries(changes)) db.run('INSERT INTO config(key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at', k, v, ctx.user.id, now());
      audit(db, ctx.actor, 'config.update', 'config', null, changes);
    });
    return { config: { ...DEFAULT_CONFIG, ...getConfig(db) } };
  });

  r.post('/api/super/messages/:id/handled', { perm: 'users.manage' }, (ctx) => {
    db.run('UPDATE contact_messages SET handled=1 WHERE id=?', int(ctx.params.id, 'id'));
    return { ok: true };
  });

  r.get('/api/super/messages', { perm: 'users.manage' }, () => ({ items: db.all('SELECT * FROM contact_messages ORDER BY id DESC LIMIT 100') }));

  // ---------------------------------------------------------------- audit log
  function auditQuery(ctx) {
    const where = ['1=1'];
    const p = [];
    if (ctx.query.action) { where.push("a.action LIKE ? ESCAPE '\\'"); p.push(like(ctx.query.action)); }
    if (ctx.query.role) { where.push('a.role=?'); p.push(oneOf(ctx.query.role, [...ROLES, 'system'], 'role')); }
    const q = (ctx.query.q || '').trim();
    if (q) { where.push("(u.full_name LIKE ? ESCAPE '\\' OR a.entity LIKE ? ESCAPE '\\' OR a.entity_id LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')"); p.push(like(q), like(q), like(q), like(q)); }
    return { where: where.join(' AND '), p };
  }

  r.get('/api/super/audit', { perm: 'audit.view' }, (ctx) => {
    const { where, p } = auditQuery(ctx);
    const { page, size, offset } = paging(ctx, 50, 200);
    const total = db.get(`SELECT COUNT(*) n FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${where}`, ...p).n;
    const items = db.all(
      `SELECT a.id, a.ts, a.role, a.action, a.entity, a.entity_id, a.detail, a.ip, u.full_name actor
         FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...p, size, offset);
    return { items, total, page, size };
  });

  r.get('/api/super/audit/verify', { perm: 'audit.view' }, (ctx) => {
    const res = verifyAuditChain(db);
    ctx.audit('audit.verify', 'audit_logs', null, { ok: res.ok });
    return res;
  });

  r.get('/api/super/audit.csv', { perm: 'audit.view' }, (ctx) => {
    const { where, p } = auditQuery(ctx);
    const rows = db.all(`SELECT a.id, a.ts, a.role, u.full_name actor, a.action, a.entity, a.entity_id, a.detail, a.ip FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT 50000`, ...p);
    ctx.audit('report.export', 'audit_logs', null, { rows: rows.length });
    return { __raw: true, body: toCsv(['ID', 'Time (UTC)', 'Role', 'Actor', 'Action', 'Entity', 'Entity ID', 'Detail', 'IP'], rows.map((x) => [x.id, x.ts, x.role, x.actor, x.action, x.entity, x.entity_id, x.detail, x.ip])), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="campspace-audit-log.csv"' } };
  });
}
