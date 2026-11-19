import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

export class Db {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.raw.exec(SCHEMA);
    this.cache = new Map();
    this.inTx = false;
    this.afterCommit = [];
  }
  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }
  get(sql, ...p) { return this.stmt(sql).get(...p.map(norm)); }
  all(sql, ...p) { return this.stmt(sql).all(...p.map(norm)); }
  run(sql, ...p) { return this.stmt(sql).run(...p.map(norm)); }
  exec(sql) { this.raw.exec(sql); }

  /** Run fn inside an immediate transaction. Nested calls join the outer transaction. */
  tx(fn) {
    if (this.inTx) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    this.afterCommit = [];
    let result;
    try {
      result = fn();
      this.raw.exec('COMMIT');
    } catch (e) {
      try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
      this.inTx = false;
      this.afterCommit = [];
      throw e;
    }
    this.inTx = false;
    const jobs = this.afterCommit;
    this.afterCommit = [];
    for (const j of jobs) { try { j(); } catch { /* side-effects must never fail a committed write */ } }
    return result;
  }
  /** Queue a side-effect (e.g. a live-update push) to run only once the transaction commits. */
  onCommit(fn) {
    if (this.inTx) this.afterCommit.push(fn);
    else fn();
  }
  close() { this.raw.close(); }
}

export const inList = (arr) => arr.map(() => '?').join(',');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS camps (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  address TEXT,
  batch TEXT NOT NULL,
  starts_on TEXT,
  ends_on TEXT,
  booking_open INTEGER NOT NULL DEFAULT 1,
  booking_opens_at TEXT,
  booking_closes_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('corps_member','accommodation_officer','medical_personnel','super_admin')),
  full_name TEXT NOT NULL,
  call_up_number TEXT UNIQUE,
  gender TEXT CHECK (gender IN ('male','female')),
  state_of_origin TEXT,
  institution TEXT,
  camp_id INTEGER REFERENCES camps(id),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_users_camp_role ON users(camp_id, role);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  ua TEXT
);

CREATE TABLE IF NOT EXISTS hostels (
  id INTEGER PRIMARY KEY,
  camp_id INTEGER NOT NULL REFERENCES camps(id),
  name TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male','female')),
  description TEXT,
  floors INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (camp_id, name)
);

CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY,
  hostel_id INTEGER NOT NULL REFERENCES hostels(id),
  number TEXT NOT NULL,
  floor INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER NOT NULL DEFAULT 32,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','maintenance')),
  medical_reserved INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (hostel_id, number)
);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  bunk_no INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('lower','upper')),
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','blocked')),
  medical_reserved INTEGER NOT NULL DEFAULT 0,
  UNIQUE (room_id, bunk_no, level)
);
CREATE INDEX IF NOT EXISTS ix_beds_room ON beds(room_id);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  camp_id INTEGER NOT NULL REFERENCES camps(id),
  bed_id INTEGER NOT NULL REFERENCES beds(id),
  status TEXT NOT NULL CHECK (status IN ('confirmed','checked_in','cancelled','released')),
  source TEXT NOT NULL DEFAULT 'self' CHECK (source IN ('self','officer','waitlist','offline_sync')),
  client_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  checked_in_at TEXT,
  checked_in_by INTEGER,
  cancelled_at TEXT,
  cancel_reason TEXT
);
-- Database-level double-booking guards (the transaction logic is the first line of defence, these are the backstop)
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_bed_active ON bookings(bed_id) WHERE status IN ('confirmed','checked_in');
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_user_active ON bookings(user_id) WHERE status IN ('confirmed','checked_in');
CREATE UNIQUE INDEX IF NOT EXISTS ux_booking_client_ref ON bookings(user_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bookings_camp_status ON bookings(camp_id, status);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  camp_id INTEGER NOT NULL REFERENCES camps(id),
  gender TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','fulfilled','cancelled')),
  note TEXT,
  created_at TEXT NOT NULL,
  fulfilled_at TEXT,
  booking_id INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_waitlist_user_waiting ON waitlist(user_id) WHERE status = 'waiting';

CREATE TABLE IF NOT EXISTS medical_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  camp_id INTEGER NOT NULL REFERENCES camps(id),
  payload_enc TEXT NOT NULL,           -- encrypted: category, condition, details
  requested_needs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','more_info','approved','rejected')),
  priority TEXT NOT NULL DEFAULT 'routine' CHECK (priority IN ('routine','high','urgent')),
  assessment_enc TEXT,                 -- encrypted clinical notes (never shown to accommodation staff)
  approved_needs TEXT NOT NULL DEFAULT '[]',
  officer_instruction TEXT,            -- plain, non-diagnostic instruction for accommodation officers
  message_to_corper TEXT,
  reviewer_id INTEGER,
  reviewed_at TEXT,
  client_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_medreq_client_ref ON medical_requests(user_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_medreq_camp_status ON medical_requests(camp_id, status);

CREATE TABLE IF NOT EXISTS medical_documents (
  id INTEGER PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES medical_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  meta_enc TEXT NOT NULL,              -- encrypted: original filename, mime
  size INTEGER NOT NULL,
  vault_file TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, read, id);

CREATE TABLE IF NOT EXISTS role_permissions (
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by INTEGER,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  user_id INTEGER,
  role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
`;
