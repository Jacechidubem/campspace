// Public endpoints, authentication, profile, notifications and the live-update stream.
import crypto from 'node:crypto';
import { HttpError, str, int, oneOf, email, phone, password, callUp } from '../util.js';
import { hashPassword, verifyPassword, newToken, sha256hex } from '../security.js';
import { STATES, NEEDS, MEDICAL_CATEGORIES, ROLE_LABELS } from '../constants.js';
import { now, cfgBool, cfgNum, getConfig, notify, approvedNeeds, bookingWindow } from '../services.js';
import { addClient } from '../events.js';

const COOKIE = 'cs_sid';
export const DEMO_PASSWORD = 'Demo@1234';
const DEMO_ACCOUNTS = [
  { role: 'Corps member (no booking yet)', email: 'corper@campspace.demo' },
  { role: 'Corps member (has a ticket)', email: 'corper.f@campspace.demo' },
  { role: 'Corps member (medical approval)', email: 'corper.med@campspace.demo' },
  { role: 'Accommodation officer', email: 'officer@campspace.demo' },
  { role: 'Medical personnel', email: 'medic@campspace.demo' },
  { role: 'Super administrator', email: 'super@campspace.demo' },
];
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');

export const publicUser = (u) => ({
  id: u.id, email: u.email, phone: u.phone, role: u.role, role_label: ROLE_LABELS[u.role], full_name: u.full_name,
  call_up_number: u.call_up_number, gender: u.gender, state_of_origin: u.state_of_origin, institution: u.institution,
  camp_id: u.camp_id, verification_status: u.verification_status, must_change_password: !!u.must_change_password,
  created_at: u.created_at,
});

export function registerAuth(r, app) {
  const { db } = app;

  function startSession(ctx, userId) {
    const tok = newToken();
    const hours = cfgNum(db, 'session_hours', 12);
    const exp = new Date(Date.now() + hours * 3600_000).toISOString();
    db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at,ip,ua) VALUES (?,?,?,?,?,?)',
      sha256hex(tok), userId, now(), exp, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200));
    db.run('DELETE FROM sessions WHERE expires_at < ?', now());
    const secure = app.cookieSecure || (app.trustProxy && ctx.req.headers['x-forwarded-proto'] === 'https');
    ctx.setHeader('Set-Cookie', `${COOKIE}=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${hours * 3600}${secure ? '; Secure' : ''}`);
  }

  // ---------------------------------------------------------------- public
  r.get('/api/public/meta', { auth: false }, () => {
    const cfg = getConfig(db);
    return {
      states: STATES,
      needs: NEEDS,
      medical_categories: MEDICAL_CATEGORIES,
      camps: db.all('SELECT id, name, state, batch, booking_open FROM camps WHERE active=1 ORDER BY name'),
      config: {
        registration_open: cfg.registration_open === 'true',
        support_email: cfg.support_email,
        support_phone: cfg.support_phone,
        announcement: cfg.announcement,
      },
      demo: app.demoMode ? { password: DEMO_PASSWORD, accounts: DEMO_ACCOUNTS } : null,
    };
  });

  r.get('/api/public/stats', { auth: false }, () => {
    const beds = db.get("SELECT COUNT(*) n FROM beds b JOIN rooms r ON r.id=b.room_id JOIN hostels h ON h.id=r.hostel_id JOIN camps c ON c.id=h.camp_id WHERE c.active=1")?.n || 0;
    const booked = db.get("SELECT COUNT(*) n FROM bookings bk JOIN camps c ON c.id=bk.camp_id WHERE c.active=1 AND bk.status IN ('confirmed','checked_in')")?.n || 0;
    const camps = db.get('SELECT COUNT(*) n FROM camps WHERE active=1')?.n || 0;
    return { camps, beds, booked, available: Math.max(0, beds - booked) };
  });

  r.post('/api/contact', { auth: false }, (ctx) => {
    if (!app.limiter.take('contact:' + ctx.ip, 5, 3600_000)) throw new HttpError(429, 'Too many messages. Please try again later.');
    const b = ctx.body;
    const name = str(b.name, 'Name', { min: 2, max: 100 });
    const mail = email(b.email);
    const subject = str(b.subject, 'Subject', { min: 3, max: 140 });
    const message = str(b.message, 'Message', { min: 10, max: 3000 });
    db.run('INSERT INTO contact_messages(name,email,subject,message,created_at) VALUES (?,?,?,?,?)', name, mail, subject, message, now());
    return { ok: true };
  });

  // ---------------------------------------------------------------- auth
  r.post('/api/auth/register', { auth: false }, async (ctx) => {
    if (!app.limiter.take('register:' + ctx.ip, 15, 3600_000)) throw new HttpError(429, 'Too many registrations from this network. Try again later.');
    if (!cfgBool(db, 'registration_open')) throw new HttpError(403, 'Registration is currently closed.');
    const b = ctx.body;
    const full_name = str(b.full_name, 'Full name', { min: 3, max: 100 });
    const mail = email(b.email);
    const ph = phone(b.phone, true);
    const pw = password(b.password);
    const call_up = callUp(b.call_up_number);
    const gender = oneOf(b.gender, ['male', 'female'], 'Gender');
    const state = oneOf(b.state_of_origin, STATES, 'State of origin');
    const institution = str(b.institution, 'Institution', { required: false, max: 120 });
    const camp_id = int(b.camp_id, 'Camp');
    const camp = db.get('SELECT id FROM camps WHERE id=? AND active=1', camp_id);
    if (!camp) throw new HttpError(400, 'Please choose a valid orientation camp.');
    if (db.get('SELECT 1 x FROM users WHERE email=?', mail)) throw new HttpError(409, 'An account with this email already exists.');
    if (db.get('SELECT 1 x FROM users WHERE call_up_number=?', call_up)) throw new HttpError(409, 'This call-up number is already registered.');
    const hash = await hashPassword(pw);
    let id;
    try {
      id = Number(db.run(
        `INSERT INTO users(email,phone,password_hash,role,full_name,call_up_number,gender,state_of_origin,institution,camp_id,verification_status,created_at,last_login_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        mail, ph, hash, 'corps_member', full_name, call_up, gender, state, institution, camp_id, 'pending', now(), now(),
      ).lastInsertRowid);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'That email or call-up number is already registered.');
      throw e;
    }
    notify(db, id, 'info', 'Welcome to CampSpace', 'Your call-up number is awaiting verification. You can already choose your hostel and bunk.', '#/app/book');
    ctx.audit('auth.register', 'user', id);
    startSession(ctx, id);
    return { user: publicUser(db.get('SELECT * FROM users WHERE id=?', id)) };
  });

  r.post('/api/auth/login', { auth: false }, async (ctx) => {
    const mail = String(ctx.body.email || '').trim().toLowerCase();
    const pw = String(ctx.body.password || '');
    if (!app.limiter.take('login-ip:' + ctx.ip, 30, 15 * 60_000) || !app.limiter.take('login-user:' + mail, 10, 15 * 60_000))
      throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.');
    const u = db.get('SELECT * FROM users WHERE email=?', mail);
    if (u?.locked_until && u.locked_until > now()) throw new HttpError(423, 'This account is temporarily locked after repeated failed attempts. Try again later.');
    const ok = await verifyPassword(pw, u ? u.password_hash : DUMMY_HASH);
    if (!u || !ok || !u.active) {
      if (u) {
        const fails = u.failed_logins + 1;
        db.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', fails >= 8 ? 0 : fails, fails >= 8 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, u.id);
        ctx.audit('auth.login_failed', 'user', u.id);
      }
      throw new HttpError(401, 'Incorrect email or password.');
    }
    db.run('UPDATE users SET failed_logins=0, locked_until=NULL, last_login_at=? WHERE id=?', now(), u.id);
    app.limiter.reset('login-user:' + mail);
    ctx.actor.id = u.id; ctx.actor.role = u.role;
    ctx.audit('auth.login', 'user', u.id);
    startSession(ctx, u.id);
    return { user: publicUser(u) };
  });

  r.post('/api/auth/logout', { auth: false }, (ctx) => {
    const tok = (ctx.req.headers.cookie || '').match(/cs_sid=([^;]+)/)?.[1];
    if (tok) db.run('DELETE FROM sessions WHERE token_hash=?', sha256hex(decodeURIComponent(tok)));
    ctx.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return { ok: true };
  });

  r.get('/api/auth/me', { auth: false }, (ctx) => {
    if (!ctx.user) return { user: null };
    const u = ctx.user;
    const camp = u.camp_id ? db.get('SELECT id, name, state, batch, booking_open, booking_opens_at, booking_closes_at, active FROM camps WHERE id=?', u.camp_id) : null;
    return {
      user: publicUser(u),
      permissions: [...(app.perms[u.role] || [])],
      camp: camp && { ...camp, window: bookingWindow({ ...camp }) },
      unread: db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', u.id).n,
      medical_needs: u.role === 'corps_member' ? approvedNeeds(db, u.id) : [],
      camps: u.role === 'super_admin' ? db.all('SELECT id, name, state, batch FROM camps ORDER BY name') : undefined,
      announcement: getConfig(db).announcement || '',
    };
  });

  r.post('/api/auth/change-password', (ctx) => {
    const cur = String(ctx.body.current_password || '');
    const next = password(ctx.body.new_password);
    return verifyPassword(cur, db.get('SELECT password_hash FROM users WHERE id=?', ctx.user.id).password_hash).then(async (ok) => {
      if (!ok) throw new HttpError(400, 'Your current password is not correct.');
      if (cur === next) throw new HttpError(400, 'Choose a different password.');
      const hash = await hashPassword(next);
      db.run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hash, ctx.user.id);
      db.run('DELETE FROM sessions WHERE user_id=? AND token_hash != ?', ctx.user.id, ctx.user.session_hash);
      ctx.audit('auth.password_change', 'user', ctx.user.id);
      return { ok: true };
    });
  });

  r.patch('/api/me', (ctx) => {
    const b = ctx.body;
    const u = ctx.user;
    const sets = [];
    const vals = [];
    if (b.full_name !== undefined) { sets.push('full_name=?'); vals.push(str(b.full_name, 'Full name', { min: 3, max: 100 })); }
    if (b.phone !== undefined) { sets.push('phone=?'); vals.push(phone(b.phone, true)); }
    if (b.institution !== undefined) { sets.push('institution=?'); vals.push(str(b.institution, 'Institution', { required: false, max: 120 })); }
    if (b.state_of_origin !== undefined) { sets.push('state_of_origin=?'); vals.push(oneOf(b.state_of_origin, STATES, 'State of origin')); }
    if (b.call_up_number !== undefined && u.role === 'corps_member') {
      const c = callUp(b.call_up_number);
      if (c !== u.call_up_number) {
        if (u.verification_status === 'verified') throw new HttpError(409, 'A verified call-up number can only be changed by an accommodation officer.');
        if (db.get('SELECT 1 x FROM users WHERE call_up_number=? AND id!=?', c, u.id)) throw new HttpError(409, 'That call-up number is already registered.');
        sets.push('call_up_number=?', "verification_status='pending'");
        vals.push(c);
      }
    }
    if (!sets.length) return { user: publicUser(u) };
    db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, ...vals, u.id);
    ctx.audit('profile.update', 'user', u.id);
    return { user: publicUser(db.get('SELECT * FROM users WHERE id=?', u.id)) };
  });

  // ---------------------------------------------------------------- notifications
  r.get('/api/notifications', (ctx) => ({
    items: db.all('SELECT id, kind, title, body, link, read, created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', ctx.user.id),
    unread: db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', ctx.user.id).n,
  }));

  r.post('/api/notifications/read', (ctx) => {
    if (ctx.body.all) db.run('UPDATE notifications SET read=1 WHERE user_id=?', ctx.user.id);
    else if (Array.isArray(ctx.body.ids)) {
      for (const id of ctx.body.ids.slice(0, 200)) db.run('UPDATE notifications SET read=1 WHERE id=? AND user_id=?', int(id, 'id'), ctx.user.id);
    }
    return { unread: db.get('SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0', ctx.user.id).n };
  });

  // ---------------------------------------------------------------- live updates
  r.get('/api/stream', (ctx) => {
    const { res } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 5000\n\n');
    addClient(res, { user_id: ctx.user.id, camp_id: ctx.user.role === 'super_admin' ? null : ctx.user.camp_id, role: ctx.user.role });
    return ctx.HANDLED;
  });

  void crypto;
}
