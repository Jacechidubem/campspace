# CampSpace

**Your Camp. Your Space. Your Comfort.**

NYSC orientation-camp hostel booking, bunk allocation and medical accommodation platform. A responsive, installable web app (PWA) with a real backend and database. Not a native app: it runs in any browser on Android, iPhone, tablet, laptop and desktop.

## Run it

Requires Node.js 22.13 or newer. There are **no npm dependencies** to install.

```bash
npm start            # http://localhost:3000, creates demo data on first run
npm run seed         # wipe and recreate the demonstration data
npm test             # 21 API tests (concurrency, RBAC, privacy, QR, waiting list, audit)
```

Demo accounts (password `Demo@1234`, shown on the login page while `DEMO_MODE=1`):

| Portal | Email |
|---|---|
| Corps member, no bunk yet | `corper@campspace.demo` |
| Corps member, has a ticket | `corper.f@campspace.demo` |
| Corps member, approved medical need | `corper.med@campspace.demo` |
| Accommodation officer (Camp A) | `officer@campspace.demo` |
| Medical personnel (Camp A) | `medic@campspace.demo` |
| Super administrator | `super@campspace.demo` |

Camp A is one large hostel block (2,688 bunks, 84 rooms of 32, 28 ground-floor rooms, 8 reserved for medical cases). Camp B is small and full, so the waiting list can be demonstrated (`corper.b@campspace.demo`). All people, call-up numbers and emails are fictional.

## What is built

All pages in the brief exist and work against the real API:

* **Public:** home, about, how it works, FAQ, contact, login, registration.
* **Corps member:** dashboard, hostel booking, bunk selection (interactive bunk map), my accommodation (ticket, QR, PDF, cancel, change bunk, waiting list), medical support, booking history, notifications, profile settings.
* **Accommodation officer:** dashboard, hostels, rooms (bulk create), bunks (block, medical reserve, assign, move, release), booking management (bookings, corps members and call-up verification, waiting list, CSV export), check-in (camera QR scan or manual), medical accommodation instructions, reports.
* **Medical personnel:** dashboard, incoming requests, medical profiles, assessment, priority tagging, accommodation recommendations, history.
* **Super administrator:** system dashboard, camps, users (temporary passwords), role/permission matrix, configuration, cross-camp reports, audit log with integrity check.

## How the requirements are met

| Requirement | Implementation |
|---|---|
| Double-booking prevention | Every booking runs in a `BEGIN IMMEDIATE` transaction, and **partial unique indexes** (one active booking per bunk, one per person) refuse duplicates at the database level even if application code is wrong. Tested with 30 simultaneous requests for one bunk: exactly one wins. |
| Real-time availability | Server-sent events push a signal on every change; open bunk maps and dashboards refresh. |
| QR generation and verification | Own QR encoder (checked against an independent decoder). Codes are `CS1-<ref>-<HMAC>`; forged or edited codes are rejected, other-camp and cancelled tickets are flagged. |
| PDF tickets | Server-generated PDF with the QR code. |
| Medical privacy | Condition, details and clinical notes are AES-256-GCM encrypted in the database; documents are encrypted files in a vault directory. Officers only ever see the approved instruction (never the diagnosis). Every record view is audited. Medical data is never cached on the device by the service worker. |
| RBAC | Permission-based, editable by the super administrator at runtime. Staff are confined to their own camp; corps members see only their own data. |
| Audit | Append-only, hash-chained log (database triggers block edits and deletes; tampering is detected by the integrity check). |
| Multi-camp | Every hostel, room, booking, request, user and report is camp-scoped; a new camp needs no code change (tested). |
| Waiting list | Automatic allocation in priority order (medical priority first, then first-come) whenever a suitable bunk is released. |
| Offline | Service worker caches the app shell. Tickets opened online are saved for offline viewing and labelled "Offline copy". Unfinished forms are saved as you type. A bunk request made offline is saved as **"Pending - not confirmed"**, is never shown as a ticket, and is sent when connectivity returns, using an idempotency key so it cannot double-book. The user is told the outcome. Tested in a real browser. |

## Where this differs from the suggested stack (please read)

The brief recommended Next.js/React and Supabase/PostgreSQL. The build environment had no package-registry access, so this version uses **plain JavaScript on Node's built-in HTTP server and SQLite** (`node:sqlite`) with a dependency-free front end. It is a genuine backend and database, not a mock, but:

* **It is not Supabase/PostgreSQL yet.** The schema, constraints and transaction logic port directly (the partial unique indexes are identical in PostgreSQL; `BEGIN IMMEDIATE` becomes a transaction with row locks). Moving to Supabase means: tables into Postgres, `server/db.js` onto a Postgres driver, the vault onto Supabase Storage (with the same encryption), sign-in onto Supabase Auth, and SSE onto Realtime. The API surface the front end uses would not change.
* **SQLite on one server** comfortably serves a single camp's booking rush, but it cannot run across several servers. For national rollout use PostgreSQL.
* The front end is not React. It is small, fast on poor networks, and easy to port.

## Known limits and decisions for NYSC

* **NYSC logo.** Not included: it needs NYSC's authorisation. A labelled slot is shown. Drop the authorised file at `public/img/nysc-logo.png` and it appears everywhere automatically.
* **Call-up verification is "readiness" only.** Numbers are format-checked, unique, and verified manually by officers. There is no NYSC API integration; if NYSC provides one, plug it into `/api/admin/corps/:id/verify`.
* **Notifications are in-app only.** No SMS, email or push yet (the notification records are in place to drive them).
* **QR camera scanning** uses the browser's `BarcodeDetector` (Chrome on Android, desktop Chrome/Edge). iPhone Safari lacks it, so officers there use the manual reference/call-up box.
* **Offline medical requests are not queued**, deliberately: the text is kept as a draft (24 hours, removed on sign-out) and sent when online, to avoid leaving medical details in a queue on the device. Offline PDF generation is not provided; the ticket page itself works offline and can be printed.
* **Not yet done:** load testing at national scale, an independent security review and penetration test, accessibility audit with assistive-technology users, data-protection (NDPA) assessment, backups and monitoring.

## Deploying

Put it behind HTTPS (a reverse proxy such as Caddy or nginx) and set:

```
COOKIE_SECURE=1  TRUST_PROXY=1  DEMO_MODE=0  DATA_DIR=/var/lib/campspace
CAMPSPACE_MASTER_KEY=<32 random bytes, base64>   # keep safe: without it medical data cannot be decrypted
```

Back up `DATA_DIR` (database and vault) together with the master key, kept separately. With `DEMO_MODE=0` the demo data and demo-account hints are off; create the first super administrator directly in the database or by running the seed once, changing its password, and deleting the demo accounts.

## Layout

```
server/        API (app.js, routes/, services.js, security.js, pdf.js, seed.js, db.js schema)
public/        PWA: index.html, sw.js, manifest, css/, js/ (core, shell, pages-*), icons/
test/          API test suite
```
