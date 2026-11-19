import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createApp } from '../server/app.js';
import { seed } from '../server/seed.js';
import { hashPassword, newToken, sha256hex } from '../server/security.js';
import { verifyAuditChain, now } from '../server/services.js';

let app, db, base, dir, pwHash;
let n = 0;

class Client {
  constructor(cookie = '') { this.cookie = cookie; }
  async req(method, p, body, headers = {}) {
    const r = await fetch(base + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'campspace', ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc && /cs_sid=[^;]+/.test(sc)) this.cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let data = null;
    try { data = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
    return { status: r.status, data, buf, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  patch(p, b = {}) { return this.req('PATCH', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}

function sessionFor(userId) {
  const tok = newToken();
  db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)', sha256hex(tok), userId, now(), new Date(Date.now() + 3600e3).toISOString());
  return new Client('cs_sid=' + tok);
}
const idOf = (email) => db.get('SELECT id FROM users WHERE email=?', email).id;
const asEmail = (email) => sessionFor(idOf(email));

function mkUser({ role = 'corps_member', gender = 'male', camp = 1, verified = true, email } = {}) {
  n++;
  const em = email || `t${n}.${Date.now()}@example.test`;
  const id = Number(db.run(
    `INSERT INTO users(email,phone,password_hash,role,full_name,call_up_number,gender,state_of_origin,camp_id,verification_status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    em, '+2348011112222', pwHash, role, `Test User ${n}`, role === 'corps_member' ? `TT/26C/${9000 + n}` : null, gender, 'Lagos', camp, verified ? 'verified' : 'pending', now()).lastInsertRowid);
  return { id, email: em, client: sessionFor(id) };
}

/** Find a free, normal (non-reserved) bed: hostel 1 = camp A male, 2 = camp A female */
function freeBed({ hostel = 1, floor = null, level = null, reserved = 0, skip = 0 } = {}) {
  return db.all(
    `SELECT b.id, b.label, r.floor, b.level FROM beds b JOIN rooms r ON r.id=b.room_id
      WHERE r.hostel_id=? AND r.status='open' AND b.status='available' AND r.medical_reserved=? AND b.medical_reserved=0
        ${floor !== null ? 'AND r.floor=' + Number(floor) : ''} ${level ? `AND b.level='${level}'` : ''}
        AND b.id NOT IN (SELECT bed_id FROM bookings WHERE status IN ('confirmed','checked_in'))
      ORDER BY b.id DESC LIMIT 1 OFFSET ?`, hostel, reserved, skip)[0];
}

function rawGet(pathname) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    http.get({ host: u.hostname, port: u.port, path: pathname }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campspace-test-'));
  app = createApp({ dataDir: dir, demoMode: true });
  db = app.db;
  await seed(db, app.vault, { quiet: true });
  pwHash = await hashPassword('Test@1234');
  base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1'));
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// ------------------------------------------------------------------ double booking
test('30 people racing for one bunk: exactly one wins, 29 are refused', async () => {
  const bed = freeBed({ skip: 3 });
  const users = Array.from({ length: 30 }, () => mkUser());
  const results = await Promise.all(users.map((u) => u.client.post('/bookings', { bed_id: bed.id })));
  const wins = results.filter((r) => r.status === 200);
  assert.equal(wins.length, 1, 'exactly one booking succeeds');
  assert.ok(results.filter((r) => r.status === 409).length === 29);
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.data.code === 'BED_TAKEN'));
  assert.equal(db.get("SELECT COUNT(*) n FROM bookings WHERE bed_id=? AND status IN ('confirmed','checked_in')", bed.id).n, 1);
});

test('the database itself refuses a second active booking for the same bunk or the same person', () => {
  const bed = freeBed({ skip: 4 });
  const a = mkUser(); const b = mkUser();
  const ins = (uid, bedId, ref) => db.run("INSERT INTO bookings(ref,user_id,camp_id,bed_id,status,created_at,updated_at) VALUES (?,?,1,?,'confirmed',?,?)", ref, uid, bedId, now(), now());
  ins(a.id, bed.id, 'DBTEST01');
  assert.throws(() => ins(b.id, bed.id, 'DBTEST02'), /UNIQUE/);
  const bed2 = freeBed({ skip: 5 });
  assert.throws(() => ins(a.id, bed2.id, 'DBTEST03'), /UNIQUE/);
});

test('one person cannot hold two bunks; they can change instead', async () => {
  const u = mkUser();
  const r1 = await u.client.post('/bookings', { bed_id: freeBed({ skip: 6 }).id });
  assert.equal(r1.status, 200);
  const r2 = await u.client.post('/bookings', { bed_id: freeBed({ skip: 7 }).id });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.code, 'ALREADY_BOOKED');
  const target = freeBed({ skip: 8 });
  const r3 = await u.client.post(`/bookings/${r1.data.booking.id}/change`, { bed_id: target.id });
  assert.equal(r3.status, 200);
  assert.equal(r3.data.booking.bed.id, target.id);
  assert.equal(db.get("SELECT COUNT(*) n FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", u.id).n, 1);
  // a failed change rolls back completely: original bunk is kept
  const taken = r3.data.booking.bed.id;
  const other = mkUser();
  const r4 = await other.client.post('/bookings', { bed_id: freeBed({ skip: 9 }).id });
  const fail = await other.client.post(`/bookings/${r4.data.booking.id}/change`, { bed_id: taken });
  assert.equal(fail.status, 409);
  const still = await other.client.get('/bookings/current');
  assert.equal(still.data.booking.status, 'confirmed');
  assert.equal(still.data.booking.bed.id, r4.data.booking.bed.id, 'failed change leaves the original bunk untouched');
});

test('gender, camp and booking-window rules are enforced', async () => {
  const f = mkUser({ gender: 'female' });
  assert.equal((await f.client.post('/bookings', { bed_id: freeBed({ hostel: 1 }).id })).status, 403, 'female cannot take a male-wing bunk');
  const otherCamp = mkUser({ camp: 2 });
  assert.equal((await otherCamp.client.post('/bookings', { bed_id: freeBed({ hostel: 1 }).id })).status, 403, 'cannot book a bunk in another camp');
  const sup = asEmail('super@campspace.demo');
  await sup.patch('/super/camps/1', { booking_open: false });
  const u = mkUser();
  const closed = await u.client.post('/bookings', { bed_id: freeBed({ skip: 10 }).id });
  assert.equal(closed.status, 409); assert.equal(closed.data.code, 'BOOKING_CLOSED');
  await sup.patch('/super/camps/1', { booking_open: true });
  assert.equal((await u.client.post('/bookings', { bed_id: freeBed({ skip: 10 }).id })).status, 200);
  // unverified users can book unless the camp requires verification
  await sup.put('/super/config', { require_verified_to_book: true });
  const un = mkUser({ verified: false });
  const blocked = await un.client.post('/bookings', { bed_id: freeBed({ skip: 11 }).id });
  assert.equal(blocked.status, 403); assert.equal(blocked.data.code, 'NOT_VERIFIED');
  await sup.put('/super/config', { require_verified_to_book: false });
});

test('offline-synced requests are idempotent via client_ref', async () => {
  const u = mkUser();
  const bed = freeBed({ skip: 12 });
  const ref = 'client-ref-' + Date.now();
  const a = await u.client.post('/bookings', { bed_id: bed.id, client_ref: ref, via: 'offline_sync' });
  const b = await u.client.post('/bookings', { bed_id: bed.id, client_ref: ref, via: 'offline_sync' });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(a.data.booking.ref, b.data.booking.ref);
  assert.equal(db.get('SELECT source FROM bookings WHERE id=?', a.data.booking.id).source, 'offline_sync');
});

test('self-cancel frees the bunk, respects the per-person limit, and the bunk can be rebooked', async () => {
  const u = mkUser();
  const bed = freeBed({ skip: 13 });
  for (let i = 0; i < 2; i++) {
    const b = await u.client.post('/bookings', { bed_id: bed.id });
    assert.equal(b.status, 200);
    assert.equal((await u.client.post(`/bookings/${b.data.booking.id}/cancel`, {})).status, 200);
  }
  const b3 = await u.client.post('/bookings', { bed_id: bed.id });
  const c3 = await u.client.post(`/bookings/${b3.data.booking.id}/cancel`, {});
  assert.equal(c3.status, 403, 'third self-cancellation refused');
  const w = mkUser();
  assert.equal((await w.client.post('/bookings', { bed_id: freeBed({ skip: 99 }).id })).status, 200);
});

// ------------------------------------------------------------------ access control
test('role-based access control', async () => {
  const corper = mkUser().client;
  const officer = asEmail('officer@campspace.demo');
  const medic = asEmail('medic@campspace.demo');
  const anon = new Client();
  for (const p of ['/admin/dashboard', '/med/dashboard', '/super/dashboard', '/super/users', '/super/audit']) assert.equal((await corper.get(p)).status, 403, 'corps member blocked from ' + p);
  for (const p of ['/med/requests', '/med/dashboard', '/super/users', '/super/audit', '/super/config']) assert.equal((await officer.get(p)).status, 403, 'officer blocked from ' + p);
  for (const p of ['/admin/bookings', '/admin/dashboard', '/super/users']) assert.equal((await medic.get(p)).status, 403, 'medic blocked from ' + p);
  for (const p of ['/hostels', '/admin/dashboard', '/notifications', '/medical/requests/mine']) assert.equal((await anon.get(p)).status, 401, 'anonymous blocked from ' + p);
  assert.equal((await officer.get('/admin/dashboard')).status, 200);
  assert.equal((await medic.get('/med/dashboard')).status, 200);
});

test('officers and medical staff are confined to their own camp', async () => {
  const officerB = asEmail('officer.b@campspace.demo');
  const medicB = asEmail('medic.b@campspace.demo');
  const roomA = db.get('SELECT id FROM rooms WHERE hostel_id=1 LIMIT 1').id;
  assert.equal((await officerB.get(`/rooms/${roomA}/beds`)).status, 404);
  const bookingA = db.get('SELECT id FROM bookings WHERE camp_id=1 AND status=? LIMIT 1', 'confirmed').id;
  assert.equal((await officerB.post(`/admin/bookings/${bookingA}/cancel`, { reason: 'cross camp attack' })).status, 404);
  assert.equal((await officerB.get(`/bookings/${bookingA}/ticket`)).status, 404);
  const medA = db.get("SELECT id FROM medical_requests WHERE camp_id=1 LIMIT 1").id;
  assert.equal((await medicB.get(`/med/requests/${medA}`)).status, 404);
  // camp_id parameters are ignored for non-super users
  const own = await officerB.get('/admin/dashboard?camp_id=1');
  assert.equal(own.data.camp.id, 2);
});

test('permission changes made by a super administrator apply immediately', async () => {
  const sup = asEmail('super@campspace.demo');
  const officer = asEmail('officer@campspace.demo');
  assert.equal((await officer.get('/admin/bookings')).status, 200);
  const perms = (await sup.get('/super/roles')).data.roles.find((r) => r.role === 'accommodation_officer').permissions;
  assert.equal((await sup.put('/super/roles/accommodation_officer', { permissions: perms.filter((p) => p !== 'bookings.view') })).status, 200);
  assert.equal((await officer.get('/admin/bookings')).status, 403);
  await sup.put('/super/roles/accommodation_officer', { permissions: perms });
  assert.equal((await officer.get('/admin/bookings')).status, 200);
  assert.equal((await sup.put('/super/roles/super_admin', { permissions: [] })).status, 409, 'super admin role is locked');
});

test('deactivating a user ends their session; temp passwords force a change', async () => {
  const sup = asEmail('super@campspace.demo');
  const u = mkUser();
  assert.equal((await u.client.get('/notifications')).status, 200);
  await sup.patch(`/super/users/${u.id}`, { active: false });
  assert.equal((await u.client.get('/notifications')).status, 401);
  const created = await sup.post('/super/users', { role: 'accommodation_officer', full_name: 'New Officer', email: `new.${Date.now()}@example.test`, camp_id: 1 });
  assert.equal(created.status, 200);
  const c = new Client();
  const login = await c.post('/auth/login', { email: db.get('SELECT email FROM users WHERE id=?', created.data.id).email, password: created.data.temporary_password });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.must_change_password, true);
  assert.equal((await c.get('/admin/dashboard')).data.code, 'MUST_CHANGE_PASSWORD');
});

// ------------------------------------------------------------------ authentication
test('authentication: CSRF header, bad passwords, lockout, validation', async () => {
  const noHeader = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
  const crossOrigin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'campspace', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  const u = mkUser();
  const c = new Client();
  const email = db.get('SELECT email FROM users WHERE id=?', u.id).email;
  assert.equal((await c.post('/auth/login', { email, password: 'wrong-password1' })).status, 401);
  assert.equal((await c.post('/auth/login', { email: 'nobody@example.test', password: 'x' })).status, 401);
  const ok = await c.post('/auth/login', { email, password: 'Test@1234' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.password_hash, undefined, 'password hash never leaves the server');
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);
  // lockout
  const victim = mkUser();
  const vEmail = db.get('SELECT email FROM users WHERE id=?', victim.id).email;
  let last;
  for (let i = 0; i < 9; i++) last = await new Client().post('/auth/login', { email: vEmail, password: 'bad-guess-' + i });
  assert.ok([423, 429].includes(last.status), 'repeated failures lock or throttle the account (got ' + last.status + ')');
  assert.ok([423, 429].includes((await new Client().post('/auth/login', { email: vEmail, password: 'Test@1234' })).status), 'even the right password is refused while locked');
  // registration validation
  const base_ = { full_name: 'Valid Name', email: `v${Date.now()}@example.test`, phone: '+2348012345678', password: 'Abcdef12', call_up_number: 'LA/26C/1234', gender: 'male', state_of_origin: 'Lagos', camp_id: 1 };
  const bad = [{ ...base_, call_up_number: '1234' }, { ...base_, password: 'short' }, { ...base_, password: 'allletters' }, { ...base_, gender: 'x' }, { ...base_, camp_id: 999 }, { ...base_, email: 'not-an-email' }, { ...base_, state_of_origin: 'Atlantis' }];
  for (const b of bad) assert.equal((await new Client().post('/auth/register', b)).status, 400);
  const good = await new Client().post('/auth/register', { ...base_, call_up_number: `LA/26C/${5000 + (n++)}` });
  assert.equal(good.status, 200);
  assert.equal(good.data.user.verification_status, 'pending');
  assert.equal((await new Client().post('/auth/register', { ...base_, email: `v2${Date.now()}@example.test`, call_up_number: 'EN/26C/4521' })).status, 409, 'duplicate call-up number refused');
});

test('security headers and static file safety', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.notEqual(await rawGet('/%2e%2e/server/db.js'), 200);
  assert.notEqual(await rawGet('/..%2fdata%2f.master.key'), 200);
  assert.equal((await fetch(base + '/sw.js')).status, 200);
  assert.equal((await fetch(base + '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
});

// ------------------------------------------------------------------ medical privacy and accommodation rules
test('medical records are encrypted, private, audited, and drive bunk eligibility', async () => {
  const SECRET = 'ZZ-SECRET-DIAGNOSIS-123';
  const corper = mkUser();
  const other = mkUser();
  const officer = asEmail('officer@campspace.demo');
  const medic = asEmail('medic@campspace.demo');
  const medicB = asEmail('medic.b@campspace.demo');

  const created = await corper.client.post('/medical/requests', { category: 'Chronic illness', condition: SECRET, details: 'details-xyz', needs: ['ground_floor', 'lower_bunk'] });
  assert.equal(created.status, 200);
  const rid = created.data.request.id;
  assert.equal((await corper.client.post('/medical/requests', { category: 'Respiratory', condition: 'Another condition', needs: ['quiet_room'] })).status, 409, 'only one open request at a time');

  const raw = db.get('SELECT payload_enc FROM medical_requests WHERE id=?', rid).payload_enc;
  assert.ok(raw.startsWith('v1:') && !raw.includes(SECRET) && !Buffer.from(raw.slice(3), 'base64url').toString('latin1').includes(SECRET), 'condition stored encrypted');

  // document vault: encrypted at rest, owner-only access
  const pdf = Buffer.from('%PDF-1.4\nSECRET-DOC-BODY-777\n%%EOF');
  const up = await corper.client.post(`/medical/requests/${rid}/documents`, { filename: 'note.pdf', mime: 'application/pdf', data_b64: pdf.toString('base64') });
  assert.equal(up.status, 200);
  const fake = await corper.client.post(`/medical/requests/${rid}/documents`, { filename: 'evil.pdf', mime: 'application/pdf', data_b64: Buffer.from('<script>alert(1)</script>').toString('base64') });
  assert.equal(fake.status, 400, 'file contents must match the declared type');
  const vaultDir = path.join(dir, 'vault');
  for (const f of fs.readdirSync(vaultDir)) assert.ok(!fs.readFileSync(path.join(vaultDir, f)).includes('SECRET-DOC-BODY-777'), 'document encrypted on disk');
  assert.deepEqual((await corper.client.req('GET', `/medical/documents/${up.data.id}`)).buf, pdf, 'owner can download');
  assert.equal((await other.client.get(`/medical/documents/${up.data.id}`)).status, 404, 'another corps member cannot');
  assert.equal((await officer.get(`/medical/documents/${up.data.id}`)).status, 404, 'accommodation officer cannot');
  assert.equal((await medicB.get(`/medical/documents/${up.data.id}`)).status, 404, 'medical staff of another camp cannot');
  assert.deepEqual((await medic.req('GET', `/medical/documents/${up.data.id}`)).buf, pdf, 'camp medical staff can');

  // who can read the record
  assert.equal((await officer.get(`/med/requests/${rid}`)).status, 403);
  assert.equal((await other.client.get(`/med/requests/${rid}`)).status, 403);
  assert.equal((await medicB.get(`/med/requests/${rid}`)).status, 404);
  const view = await medic.get(`/med/requests/${rid}`);
  assert.equal(view.status, 200);
  assert.equal(view.data.request.condition, SECRET);
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='medical.record.view' AND entity_id=?", String(rid)), 'record view is audited');

  // approval
  const bad = await medic.post(`/med/requests/${rid}/assess`, { status: 'approved', priority: 'high', assessment: 'ok', approved_needs: [] });
  assert.equal(bad.status, 400, 'approval needs at least one approved need');
  const ok = await medic.post(`/med/requests/${rid}/assess`, { status: 'approved', priority: 'high', assessment: 'Confirmed. CLINICAL-NOTE-555', approved_needs: ['ground_floor', 'lower_bunk'], officer_instruction: 'Ground-floor room, lower bunk.', message_to_corper: 'Approved.' });
  assert.equal(ok.status, 200);

  // officers see the instruction, never the diagnosis or notes
  const instr = await officer.get('/admin/medical-instructions');
  const text = JSON.stringify(instr.data);
  assert.ok(text.includes('Ground-floor room, lower bunk.'));
  assert.ok(!text.includes(SECRET) && !text.includes('CLINICAL-NOTE-555') && !text.includes('details-xyz'), 'no diagnosis or clinical notes reach accommodation officers');
  // the corps member's own ticket/API never leak clinical notes either
  const mine = JSON.stringify((await corper.client.get('/medical/requests/mine')).data);
  assert.ok(!mine.includes('CLINICAL-NOTE-555'));

  // bunk eligibility now follows the approval
  const f1 = freeBed({ floor: 1, level: 'lower' });
  const r1 = await corper.client.post('/bookings', { bed_id: f1.id });
  assert.equal(r1.status, 409); assert.equal(r1.data.code, 'BED_RESTRICTED', 'upper floors refused');
  const g0u = freeBed({ floor: 0, level: 'upper' });
  assert.equal((await corper.client.post('/bookings', { bed_id: g0u.id })).data.code, 'BED_RESTRICTED', 'upper bunks refused');
  const states = (await corper.client.get(`/rooms/${db.get('SELECT room_id FROM beds WHERE id=?', f1.id).room_id}/beds`)).data.beds;
  assert.ok(states.every((b) => b.state !== 'available'), 'first-floor room shows no bunk as available');
  // medical-reserve bunk: only for people with an approved need
  const reserved = freeBed({ floor: 0, level: 'lower', reserved: 1 }) || db.get("SELECT b.id FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.hostel_id=1 AND r.medical_reserved=1 AND b.level='lower' AND b.id NOT IN (SELECT bed_id FROM bookings WHERE status IN ('confirmed','checked_in')) LIMIT 1");
  assert.equal((await other.client.post('/bookings', { bed_id: reserved.id })).data.code, 'BED_RESERVED', 'ordinary users cannot take medical-reserve bunks');
  const mb = await corper.client.post('/bookings', { bed_id: reserved.id });
  assert.equal(mb.status, 200, 'approved user can take a medical-reserve lower bunk');
  assert.deepEqual(mb.data.booking.medical, ['Ground-floor room', 'Lower bunk']);
  // officer allocation helper finds a suitable bunk too
  const c2 = mkUser();
  const r2 = await c2.client.post('/medical/requests', { category: 'Mobility or injury', condition: 'Knee', needs: ['wheelchair_access'] });
  await medic.post(`/med/requests/${r2.data.request.id}/assess`, { status: 'approved', priority: 'urgent', assessment: 'Confirmed by exam', approved_needs: ['wheelchair_access'], officer_instruction: 'Step-free' });
  const alloc = await officer.post(`/admin/medical-instructions/${r2.data.request.id}/allocate`, {});
  assert.equal(alloc.status, 200);
  assert.equal(alloc.data.booking.room.floor, 0, 'wheelchair access means ground floor');
});

// ------------------------------------------------------------------ tickets, QR, check-in, PDF
test('QR codes are signed; verification and check-in work and cannot be forged or repeated', async () => {
  const u = mkUser();
  const b = await u.client.post('/bookings', { bed_id: freeBed({ skip: 20 }).id });
  const t = b.data.booking;
  assert.match(t.qr, /^CS1-[A-Z2-9]{8}-[0-9a-f]{16}$/);
  const officer = asEmail('officer@campspace.demo');
  const officerB = asEmail('officer.b@campspace.demo');

  const v = await officer.post('/admin/verify', { code: t.qr });
  assert.equal(v.data.state, 'ready'); assert.equal(v.data.signed, true);
  const forged = t.qr.slice(0, -1) + (t.qr.endsWith('0') ? '1' : '0');
  const f = await officer.post('/admin/verify', { code: forged });
  assert.equal(f.status, 422); assert.equal(f.data.code, 'BAD_SIGNATURE');
  assert.equal((await officer.post('/admin/verify', { code: 'CS1-AAAAAAAA-0000000000000000' })).status, 422);
  assert.equal((await officer.post('/admin/verify', { code: t.ref })).data.signed, false, 'manual lookup by reference is flagged as unsigned');
  assert.equal((await officer.post('/admin/verify', { code: db.get('SELECT call_up_number c FROM users WHERE id=?', u.id).c })).data.ticket.ref, t.ref, 'lookup by call-up number');
  assert.equal((await officerB.post('/admin/verify', { code: t.qr })).data.code, 'WRONG_CAMP');
  assert.equal((await u.client.post('/admin/verify', { code: t.qr })).status, 403);

  assert.equal((await officer.post('/admin/checkin', { booking_id: t.id })).data.ticket.status, 'checked_in');
  assert.equal((await officer.post('/admin/checkin', { booking_id: t.id })).status, 409, 'cannot check in twice');
  assert.equal((await officer.post('/admin/verify', { code: t.qr })).data.state, 'already_checked_in');
  assert.equal((await u.client.post(`/bookings/${t.id}/cancel`, {})).status, 409, 'checked-in people cannot self-cancel');
  assert.equal((await officer.post('/admin/checkin/undo', { booking_id: t.id })).status, 200);

  // released bookings stop being valid
  assert.equal((await officer.post(`/admin/bookings/${t.id}/cancel`, { reason: 'No-show test' })).status, 200);
  const dead = await officer.post('/admin/verify', { code: t.qr });
  assert.equal(dead.data.state, 'inactive');
  assert.equal(dead.data.ticket.status, 'released');
});

test('PDF ticket is a valid PDF containing the booking details', async () => {
  const u = mkUser();
  const b = await u.client.post('/bookings', { bed_id: freeBed({ skip: 21 }).id });
  const pdf = await u.client.req('GET', `/bookings/${b.data.booking.id}/ticket.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.equal(pdf.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await mkUser().client.get(`/bookings/${b.data.booking.id}/ticket.pdf`)).status, 404, "someone else's ticket is not downloadable");
  const text = spawnSync('pdftotext', ['-', '-'], { input: pdf.buf });
  if (text.status === 0) {
    const s = text.stdout.toString();
    assert.ok(s.includes(b.data.booking.ref) && s.includes(b.data.booking.bed.label) && s.includes('Your Camp. Your Space. Your Comfort.'), 'PDF text has reference, bunk and tagline');
  }
});

// ------------------------------------------------------------------ waiting list
test('waiting list allocates released bunks in priority order and notifies', async () => {
  const officerB = asEmail('officer.b@campspace.demo');
  const waiting = db.all("SELECT w.* FROM waitlist w WHERE w.camp_id=2 AND w.status='waiting' AND w.gender='male' ORDER BY w.priority DESC, w.created_at, w.id");
  assert.ok(waiting.length >= 2, 'seed has a male waiting list in camp B');
  const next = waiting[0];
  const booking = db.get("SELECT bk.id FROM bookings bk JOIN users u ON u.id=bk.user_id WHERE bk.camp_id=2 AND bk.status='confirmed' AND u.gender='male' LIMIT 1");
  assert.equal((await officerB.post(`/admin/bookings/${booking.id}/cancel`, { reason: 'Test release' })).status, 200);
  const got = db.get("SELECT * FROM bookings WHERE user_id=? AND status='confirmed'", next.user_id);
  assert.ok(got, 'first person in priority order was allocated');
  assert.equal(got.source, 'waitlist');
  assert.equal(db.get('SELECT status FROM waitlist WHERE id=?', next.id).status, 'fulfilled');
  assert.ok(db.get("SELECT 1 x FROM notifications WHERE user_id=? AND title LIKE '%waiting list%'", next.user_id), 'allocation notification sent');
  const q = await officerB.get('/admin/waitlist');
  assert.ok(!q.data.items.some((i) => i.user_id === next.user_id));
});

test('joining the waiting list is refused while suitable bunks exist', async () => {
  const u = mkUser();
  const r = await u.client.post('/waitlist/join', {});
  assert.equal(r.status, 409); assert.equal(r.data.code, 'BEDS_AVAILABLE');
});

// ------------------------------------------------------------------ admin structure, reports, audit
test('officers can build hostels, rooms and bunks; closing an occupied room is refused', async () => {
  const officer = asEmail('officer@campspace.demo');
  const h = await officer.post('/admin/hostels', { name: 'Test Annex ' + Date.now(), gender: 'male', floors: 2 });
  assert.equal(h.status, 200);
  const rooms = await officer.post('/admin/rooms', { hostel_id: h.data.id, number: 'T', count: 3, start: 1, floor: 0, capacity: 8 });
  assert.equal(rooms.data.ids.length, 3);
  assert.equal(db.get('SELECT COUNT(*) n FROM beds WHERE room_id=?', rooms.data.ids[0]).n, 8);
  assert.equal((await officer.post('/admin/rooms', { hostel_id: h.data.id, number: 'T', count: 1, capacity: 7 })).status, 400, 'odd capacity refused');
  const u = mkUser();
  const bed = db.get('SELECT id FROM beds WHERE room_id=? LIMIT 1', rooms.data.ids[0]).id;
  assert.equal((await u.client.post('/bookings', { bed_id: bed })).status, 200);
  assert.equal((await officer.patch(`/admin/rooms/${rooms.data.ids[0]}`, { status: 'closed' })).status, 409);
  assert.equal((await officer.patch('/admin/beds', { bed_ids: [bed], status: 'blocked' })).status, 409, 'cannot close an occupied bunk');
  assert.equal((await officer.del(`/admin/rooms/${rooms.data.ids[0]}`)).status, 409, 'rooms with booking history cannot be deleted');
  assert.equal((await officer.del(`/admin/rooms/${rooms.data.ids[1]}`)).status, 200);
  const other = db.get('SELECT id FROM beds WHERE room_id=? AND id!=? LIMIT 1', rooms.data.ids[0], bed).id;
  await officer.patch('/admin/beds', { bed_ids: [other], status: 'blocked' });
  assert.equal((await mkUser().client.post('/bookings', { bed_id: other })).data.code, 'BED_UNAVAILABLE', 'closed bunks cannot be booked');
});

test('reports add up; CSV export neutralises formula injection', async () => {
  const officer = asEmail('officer@campspace.demo');
  const rep = (await officer.get('/admin/reports')).data.report;
  const hostelSum = rep.by_hostel.reduce((a, x) => a + x.booked, 0);
  assert.equal(hostelSum, rep.bookings.active, 'hostel totals equal the booked total');
  assert.equal(db.get("SELECT COUNT(*) n FROM bookings WHERE camp_id=1 AND status IN ('confirmed','checked_in')").n, rep.bookings.active);
  assert.equal(rep.by_floor.reduce((a, x) => a + x.booked, 0), rep.bookings.active);
  const evil = mkUser(); db.run("UPDATE users SET full_name='=HYPERLINK(\"http://evil\")' WHERE id=?", evil.id);
  await evil.client.post('/bookings', { bed_id: freeBed({ skip: 30 }).id });
  const csv = (await officer.req('GET', '/admin/bookings.csv?q=HYPERLINK')).buf.toString();
  assert.ok(csv.includes("'=HYPERLINK") && !/,=HYPERLINK/.test(csv.replace(/"/g, '')) , 'formula prefix neutralised');
  const sup = asEmail('super@campspace.demo');
  const sys = (await sup.get('/super/reports')).data;
  assert.equal(sys.camps.length, 2);
});

test('multi-camp: a new camp can be created and staffed without code changes', async () => {
  const sup = asEmail('super@campspace.demo');
  const c = await sup.post('/super/camps', { code: 'NEW-' + Date.now().toString().slice(-4), name: 'Brand New Camp', state: 'Kano', batch: '2027 Batch A' });
  assert.equal(c.status, 200);
  const o = await sup.post('/super/users', { role: 'accommodation_officer', full_name: 'Camp Officer', email: `o${Date.now()}@example.test`, camp_id: c.data.id });
  db.run('UPDATE users SET must_change_password=0 WHERE id=?', o.data.id);
  const off = sessionFor(o.data.id);
  assert.equal((await off.get('/admin/dashboard')).data.camp.id, c.data.id);
  const h = await off.post('/admin/hostels', { name: 'Main', gender: 'female', floors: 1 });
  await off.post('/admin/rooms', { hostel_id: h.data.id, number: 'R', count: 2, capacity: 4 });
  const rep = (await off.get('/admin/reports')).data.report;
  assert.equal(rep.capacity.total_beds, 8);
  // the old camp is untouched
  assert.ok((await asEmail('officer@campspace.demo').get('/admin/reports')).data.report.capacity.total_beds > 1000);
});

test('audit log is append-only and hash-chained; tampering is detected', async () => {
  const sup = asEmail('super@campspace.demo');
  assert.equal((await sup.get('/super/audit/verify')).data.ok, true);
  assert.ok(db.get('SELECT COUNT(*) n FROM audit_logs').n > 20);
  assert.throws(() => db.run("UPDATE audit_logs SET action='x' WHERE id=1"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit_logs WHERE id=1'), /append-only/);
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action LIKE 'booking.%'"));
  assert.ok(db.get("SELECT 1 x FROM audit_logs WHERE action='checkin.complete'"));
  // simulate someone with raw database access editing history
  db.exec('DROP TRIGGER audit_logs_no_update');
  db.run("UPDATE audit_logs SET detail='tampered' WHERE id=(SELECT MIN(id)+3 FROM audit_logs)");
  const res = verifyAuditChain(db);
  assert.equal(res.ok, false, 'edited history is detected');
  assert.ok(res.broken_at > 0);
  assert.equal((await sup.get('/super/dashboard')).data.audit.intact, false);
});
