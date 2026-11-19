// Realistic fictional demonstration data. Every person, call-up number and email below is invented.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';
import { Vault, loadMasterKey, hashPassword } from './security.js';
import { makeBeds } from './layout.js';
import { audit, now, notify } from './services.js';
import { STATES, DEFAULT_CONFIG, DEFAULT_ROLE_PERMISSIONS } from './constants.js';
import { DEMO_PASSWORD } from './routes/auth.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MALE = ['Chinedu', 'Tunde', 'Emeka', 'Ibrahim', 'Segun', 'Uche', 'Musa', 'Damilola', 'Kelechi', 'Abdullahi', 'Ifeanyi', 'Olumide', 'Yusuf', 'Chidera', 'Obinna', 'Femi', 'Sani', 'Tobi', 'Nnamdi', 'Gbenga', 'Aliyu', 'Ikenna', 'Kunle', 'Ahmed', 'Victor', 'Daniel', 'Emmanuel', 'Samuel', 'Peter', 'Joseph'];
const FEMALE = ['Amaka', 'Funke', 'Aisha', 'Ngozi', 'Bukola', 'Zainab', 'Chioma', 'Titilayo', 'Halima', 'Adaeze', 'Folake', 'Blessing', 'Hauwa', 'Ifeoma', 'Yetunde', 'Fatima', 'Nneka', 'Damilare', 'Precious', 'Rukayat', 'Oluwaseun', 'Chiamaka', 'Habiba', 'Temitope', 'Grace', 'Mercy', 'Esther', 'Ruth', 'Sarah', 'Joy'];
const SURNAMES = ['Okafor', 'Adeyemi', 'Bello', 'Eze', 'Balogun', 'Nwosu', 'Abubakar', 'Ogunleye', 'Ibe', 'Lawal', 'Okeke', 'Adebayo', 'Danjuma', 'Onyeka', 'Salami', 'Chukwu', 'Olawale', 'Musa', 'Akpan', 'Ekong', 'Idowu', 'Nnaji', 'Garba', 'Oladipo', 'Umeh', 'Afolabi', 'Yakubu', 'Okonkwo', 'Ojo', 'Mohammed', 'Etim', 'Anyanwu', 'Fashola', 'Isah', 'Obi'];
const INSTITUTIONS = ['University of Lagos', 'Ahmadu Bello University', 'University of Nigeria, Nsukka', 'Obafemi Awolowo University', 'University of Ibadan', 'Federal University of Technology, Akure', 'University of Ilorin', 'Bayero University Kano', 'University of Benin', 'Nile University of Nigeria', 'Covenant University', 'Federal University of Agriculture, Abeokuta'];

const CONDITIONS = [
  ['Mobility or injury', 'Fractured ankle, healing in a walking boot', ['ground_floor', 'lower_bunk'], 'Cannot climb stairs or a bunk ladder.'],
  ['Chronic illness', 'Type 1 diabetes, insulin-dependent', ['lower_bunk', 'near_restroom', 'observation'], 'Needs refrigerated insulin and regular glucose checks.'],
  ['Respiratory', 'Asthma, triggered by dust', ['ground_floor', 'quiet_room'], 'Carries an inhaler; ventilation matters.'],
  ['Neurological', 'Epilepsy, controlled with medication', ['lower_bunk', 'observation'], 'Last seizure over a year ago.'],
  ['Post-surgery recovery', 'Appendectomy six weeks ago', ['lower_bunk', 'near_restroom'], 'Should avoid climbing.'],
  ['Vision or hearing', 'Low vision in the left eye', ['ground_floor'], 'Needs a familiar, uncluttered route to the exits.'],
  ['Cardiovascular', 'Hypertension on medication', ['lower_bunk', 'observation'], 'Stable; wants to be close to the clinic.'],
  ['Mobility or injury', 'Knee ligament repair, using a crutch', ['wheelchair_access', 'ground_floor', 'lower_bunk'], 'Crutch use for another month.'],
  ['Chronic illness', 'Sickle cell trait with occasional pain episodes', ['lower_bunk', 'near_restroom'], 'Needs to keep warm and hydrated.'],
  ['Mental health', 'Anxiety, sleeps poorly in noisy rooms', ['quiet_room', 'lower_bunk'], 'Prefers a lower bunk near the wall.'],
];

export async function seed(db, vault, { quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const rand = rng(2026);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const demoHash = await hashPassword(DEMO_PASSWORD);
  const ts = (daysAgo, hour = 9) => new Date(Date.now() - daysAgo * 86400_000 + (hour - 9) * 3600_000).toISOString();

  db.tx(() => {
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) db.run('INSERT OR IGNORE INTO config(key,value,updated_at) VALUES (?,?,?)', k, v, now());
    db.run("UPDATE config SET value='Demonstration data only: all names and numbers are fictional.' WHERE key='announcement' AND value=''");
    for (const [role, ps] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) for (const p of ps) db.run('INSERT OR IGNORE INTO role_permissions(role,permission) VALUES (?,?)', role, p);

    // ------------------------------------------------ camps
    const campA = Number(db.run(
      "INSERT INTO camps(code,name,state,address,batch,starts_on,ends_on,booking_open,created_at) VALUES ('DEMO-OG','Demo Orientation Camp A','Ogun','Demonstration address, Ogun State','2026 Batch C, Stream I','2026-12-02','2026-12-22',1,?)", now()).lastInsertRowid);
    const campB = Number(db.run(
      "INSERT INTO camps(code,name,state,address,batch,starts_on,ends_on,booking_open,created_at) VALUES ('DEMO-KD','Demo Orientation Camp B','Kaduna','Demonstration address, Kaduna State','2026 Batch C, Stream I','2026-12-02','2026-12-22',1,?)", now()).lastInsertRowid);

    // ------------------------------------------------ camp A: one large hostel block, two wings, 84 rooms x 32 beds
    const wing = (camp, name, gender, prefix, perFloor, floors, capacity, medReservedPerWing) => {
      const hid = Number(db.run('INSERT INTO hostels(camp_id,name,gender,description,floors) VALUES (?,?,?,?,?)', camp, name, gender, `${gender === 'male' ? 'Male' : 'Female'} wing of the main hostel block`, floors).lastInsertRowid);
      for (let f = 0; f < floors; f++)
        for (let n = 1; n <= perFloor; n++) {
          const number = f === 0 ? `${prefix}-G${String(n).padStart(2, '0')}` : `${prefix}-${f}${String(n).padStart(2, '0')}`;
          const reserved = f === 0 && n <= medReservedPerWing ? 1 : 0;
          const rid = Number(db.run('INSERT INTO rooms(hostel_id,number,floor,capacity,status,medical_reserved) VALUES (?,?,?,?,?,?)', hid, number, f, capacity, 'open', reserved).lastInsertRowid);
          makeBeds(db, rid, number, capacity);
        }
      return hid;
    };
    const aMale = wing(campA, 'Block A - Male Wing', 'male', 'M', 14, 3, 32, 4);
    const aFemale = wing(campA, 'Block A - Female Wing', 'female', 'F', 14, 3, 32, 4);
    // camp B: small, so the waiting list can be demonstrated
    const bMale = wing(campB, 'Cedar Wing (Male)', 'male', 'C', 3, 1, 8, 0);
    const bFemale = wing(campB, 'Palm Wing (Female)', 'female', 'P', 3, 1, 8, 0);

    // ------------------------------------------------ staff and named demo accounts
    const addUser = (o) => Number(db.run(
      `INSERT INTO users(email,phone,password_hash,role,full_name,call_up_number,gender,state_of_origin,institution,camp_id,verification_status,created_at,last_login_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      o.email, o.phone ?? null, demoHash, o.role, o.name, o.callUp ?? null, o.gender ?? null, o.state ?? null, o.institution ?? null, o.camp ?? null, o.ver ?? 'verified', o.created ?? now(), null).lastInsertRowid);
    addUser({ email: 'super@campspace.demo', role: 'super_admin', name: 'Dr. Adaobi Nwankwo (Demo)' });
    const officerA = addUser({ email: 'officer@campspace.demo', role: 'accommodation_officer', name: 'Mr. Kayode Adewale (Demo)', camp: campA, phone: '+234 801 000 0001' });
    addUser({ email: 'officer.b@campspace.demo', role: 'accommodation_officer', name: 'Mrs. Hadiza Sule (Demo)', camp: campB });
    const medicA = addUser({ email: 'medic@campspace.demo', role: 'medical_personnel', name: 'Dr. Ifeoma Chukwuemeka (Demo)', camp: campA });
    addUser({ email: 'medic.b@campspace.demo', role: 'medical_personnel', name: 'Dr. Salisu Abdullahi (Demo)', camp: campB });
    void officerA;

    // ------------------------------------------------ corps members, camp A
    let serial = 1000;
    const stateCode = { Lagos: 'LA', Ogun: 'OG', Oyo: 'OY', Kano: 'KN', Kaduna: 'KD', Enugu: 'EN', Anambra: 'AN', Rivers: 'RV', Delta: 'DT', Edo: 'ED', Kwara: 'KW', Plateau: 'PL', FCT: 'FC', Osun: 'OS', Imo: 'IM', Borno: 'BO', Sokoto: 'SO', Abia: 'AB', Niger: 'NG', Ondo: 'ON' };
    const codes = Object.keys(stateCode);
    const usedNames = new Set();
    const makeCorper = (camp, gender, extra = {}) => {
      let name;
      do { name = `${pick(gender === 'male' ? MALE : FEMALE)} ${pick(SURNAMES)}`; } while (usedNames.has(name));
      usedNames.add(name);
      const st = pick(codes);
      serial += 1 + Math.floor(rand() * 7);
      const id = addUser({
        email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${serial}@example.test`, role: 'corps_member', name, gender,
        state: st, institution: pick(INSTITUTIONS), camp, callUp: `${stateCode[st]}/26C/${serial}`,
        ver: rand() < 0.78 ? 'verified' : 'pending', created: ts(2 + rand() * 12, 8 + Math.floor(rand() * 10)),
        phone: `+234 80${Math.floor(rand() * 9)} ${String(Math.floor(rand() * 1e7)).padStart(7, '0')}`, ...extra,
      });
      return id;
    };

    const book = (userId, campId, bedId, createdAt, source = 'self', status = 'confirmed') => {
      const refChars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let ref = '';
      for (let i = 0; i < 8; i++) ref += refChars[Math.floor(rand() * refChars.length)];
      const id = Number(db.run(
        'INSERT INTO bookings(ref,user_id,camp_id,bed_id,status,source,created_at,updated_at,checked_in_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ref, userId, campId, bedId, status, source, createdAt, createdAt, status === 'checked_in' ? createdAt : null).lastInsertRowid);
      return id;
    };
    const freeBeds = (hostelId, { groundFirst = false } = {}) => db.all(
      `SELECT b.id, r.floor FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.hostel_id=? AND r.medical_reserved=0 AND b.id NOT IN (SELECT bed_id FROM bookings WHERE status IN ('confirmed','checked_in'))
       ORDER BY r.floor ${groundFirst ? 'ASC' : 'DESC'}, r.number, b.bunk_no, b.level`, hostelId);

    // Fill about 28% of each wing (spread across rooms for a realistic look)
    for (const [hostelId, gender, count] of [[aMale, 'male', 260], [aFemale, 'female', 230]]) {
      const beds = freeBeds(hostelId);
      // sparse, room-wise random picks
      const chosen = [];
      const stride = Math.max(1, Math.floor(beds.length / count));
      for (let i = 0; i < beds.length && chosen.length < count; i += stride) chosen.push(beds[Math.min(beds.length - 1, i + Math.floor(rand() * stride))]);
      const seen = new Set();
      for (const bed of chosen) {
        if (seen.has(bed.id)) continue;
        seen.add(bed.id);
        const uid = makeCorper(campA, gender);
        const createdAt = ts(rand() * 11, 8 + Math.floor(rand() * 12));
        book(uid, campA, bed.id, createdAt, rand() < 0.04 ? 'officer' : 'self', rand() < 0.08 ? 'checked_in' : 'confirmed');
      }
    }
    // some registered corps members who haven't booked yet
    for (let i = 0; i < 24; i++) makeCorper(campA, i % 2 ? 'male' : 'female');

    // named demo corps members, camp A
    const corper = addUser({ email: 'corper@campspace.demo', role: 'corps_member', name: 'Chinedu Okoro (Demo)', gender: 'male', state: 'Enugu', institution: 'University of Nigeria, Nsukka', camp: campA, callUp: 'EN/26C/4521', ver: 'verified', phone: '+234 803 000 0101', created: ts(1) });
    const corperF = addUser({ email: 'corper.f@campspace.demo', role: 'corps_member', name: 'Amaka Eze (Demo)', gender: 'female', state: 'Anambra', institution: 'University of Lagos', camp: campA, callUp: 'AN/26C/4522', ver: 'verified', phone: '+234 803 000 0102', created: ts(3) });
    const corperMed = addUser({ email: 'corper.med@campspace.demo', role: 'corps_member', name: 'Tunde Bakare (Demo)', gender: 'male', state: 'Oyo', institution: 'University of Ibadan', camp: campA, callUp: 'OY/26C/4523', ver: 'verified', phone: '+234 803 000 0103', created: ts(2) });
    void corper;
    const demoBed = freeBeds(aFemale)[5];
    book(corperF, campA, demoBed.id, ts(2, 11));

    // ------------------------------------------------ medical requests (camp A)
    const addMedical = (userId, campId, cIndex, status, priority, daysAgo, opts = {}) => {
      const [category, condition, needs, details] = CONDITIONS[cIndex % CONDITIONS.length];
      const id = Number(db.run(
        `INSERT INTO medical_requests(user_id,camp_id,payload_enc,requested_needs,status,priority,approved_needs,officer_instruction,message_to_corper,reviewer_id,reviewed_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        userId, campId, 'pending', JSON.stringify(needs), status, priority,
        JSON.stringify(status === 'approved' ? (opts.approved ?? needs) : []),
        status === 'approved' ? (opts.instruction ?? 'Allocate as approved. Please be discreet.') : null,
        opts.message ?? null, ['approved', 'rejected', 'under_review', 'more_info'].includes(status) ? medicA : null,
        ['approved', 'rejected'].includes(status) ? ts(daysAgo - 0.5) : null, ts(daysAgo), ts(daysAgo - 0.2)).lastInsertRowid);
      db.run('UPDATE medical_requests SET payload_enc=? WHERE id=?', vault.enc({ category, condition, details }, `medreq:${id}`), id);
      if (status === 'approved' || status === 'rejected')
        db.run('UPDATE medical_requests SET assessment_enc=? WHERE id=?', vault.enc({ text: status === 'approved' ? 'Reviewed and confirmed clinically. Accommodation adjustments recommended as listed.' : 'Does not meet the criteria for a medical accommodation adjustment at this time.' }, `medassess:${id}`), id);
      return id;
    };
    // Tunde has an approved ground-floor / lower-bunk need but has not booked yet
    addMedical(corperMed, campA, 0, 'approved', 'high', 2, { approved: ['ground_floor', 'lower_bunk'], instruction: 'Ground-floor room, lower bunk. Cannot climb stairs.', message: 'Approved. Please book a bunk in a ground-floor room.' });
    // others across the pipeline
    const medicalUsers = db.all("SELECT id FROM users WHERE role='corps_member' AND camp_id=? AND email LIKE '%@example.test' ORDER BY id LIMIT 12", campA).map((x) => x.id);
    const plan = [
      ['approved', 'urgent', 4], ['approved', 'routine', 5], ['approved', 'high', 3],
      ['submitted', 'routine', 1], ['submitted', 'high', 0.5], ['submitted', 'urgent', 0.3],
      ['under_review', 'routine', 1.5], ['more_info', 'routine', 2], ['rejected', 'routine', 5], ['submitted', 'routine', 0.2],
    ];
    plan.forEach(([status, priority, days], i) => addMedical(medicalUsers[i], campA, i + 1, status, priority, days, status === 'more_info' ? { message: 'Please upload a short note from your doctor.' } : {}));

    // ------------------------------------------------ camp B: nearly full, with a waiting list
    for (let i = 0; i < 12; i++) {
      const beds = freeBeds(bMale, { groundFirst: true });
      if (!beds.length) break;
      book(makeCorper(campB, 'male'), campB, beds[0].id, ts(6 - i * 0.4, 9));
    }
    for (let i = 0; i < 9; i++) {
      const beds = freeBeds(bFemale, { groundFirst: true });
      if (!beds.length) break;
      book(makeCorper(campB, 'female'), campB, beds[0].id, ts(5 - i * 0.3, 10));
    }
    // fill the remaining male bunks so the wing is full, then add the waiting list
    for (;;) {
      const beds = freeBeds(bMale, { groundFirst: true });
      if (!beds.length) break;
      book(makeCorper(campB, 'male'), campB, beds[0].id, ts(2, 10));
    }
    const corperB = addUser({ email: 'corper.b@campspace.demo', role: 'corps_member', name: 'Ibrahim Danjuma (Demo)', gender: 'male', state: 'Kaduna', institution: 'Ahmadu Bello University', camp: campB, callUp: 'KD/26C/4524', ver: 'verified', created: ts(1) });
    db.run("INSERT INTO waitlist(user_id,camp_id,gender,priority,status,created_at) VALUES (?,?,?,?,?,?)", corperB, campB, 'male', 0, 'waiting', ts(1, 12));
    for (let i = 0; i < 3; i++) {
      const uid = makeCorper(campB, 'male');
      db.run("INSERT INTO waitlist(user_id,camp_id,gender,priority,status,created_at) VALUES (?,?,?,?,?,?)", uid, campB, 'male', i === 0 ? 1 : 0, 'waiting', ts(1.5 - i * 0.2, 9));
    }

    // ------------------------------------------------ notifications and contact messages
    notify(db, corperF, 'booking', 'Booking confirmed', 'Your bunk is ready. Download your ticket under My Accommodation.', '#/app/accommodation');
    notify(db, corperMed, 'medical', 'Medical accommodation approved', 'Approved: Ground-floor room, Lower bunk. Please book a bunk in a ground-floor room.', '#/app/medical');
    db.run('INSERT INTO contact_messages(name,email,subject,message,created_at) VALUES (?,?,?,?,?)', 'Ngozi Umeh', 'ngozi@example.test', 'Can I swap bunks with a friend?', 'My friend and I booked different rooms. Is there a way to swap?', ts(1));
    db.run('INSERT INTO contact_messages(name,email,subject,message,created_at) VALUES (?,?,?,?,?)', 'Sani Garba', 'sani@example.test', 'Offline ticket question', 'If I lose internet at the gate will my ticket still open?', ts(0.4));

    audit(db, { id: null, role: 'system' }, 'seed.demo_data', 'system', null, { camps: 2 });
  });
  log('Demo data created.');
}

// ---- CLI:  node server/seed.js [--reset]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  const file = path.join(dataDir, 'campspace.db');
  if (process.argv.includes('--reset')) for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
  const db = new Db(file);
  const vault = new Vault(loadMasterKey(dataDir), path.join(dataDir, 'vault'));
  if (db.get('SELECT 1 x FROM camps LIMIT 1')) {
    console.log('Database already has data. Run "npm run seed" to reset it.');
  } else {
    await seed(db, vault);
    const n = (t) => db.get(`SELECT COUNT(*) n FROM ${t}`).n;
    console.log(`Camps ${n('camps')}, users ${n('users')}, beds ${n('beds')}, bookings ${n('bookings')}, medical requests ${n('medical_requests')}`);
    console.log(`Demo password for every demo account: ${DEMO_PASSWORD}`);
  }
  db.close();
  void STATES;
}
