import {
  S, html, raw, esc, route, go, get, post, toast, submitForm, draftForm, clearDraft, ROLE_HOME, num, refreshMe, firstName,
} from './core.js';
import { nyscLogo, TAGLINE } from './shell.js';

const ico = (c) => raw(`<div class="ic" aria-hidden="true">${c}</div>`);

// ------------------------------------------------------------------ home
route('/', 'public', async () => {
  let stats = null;
  try { stats = await get('/public/stats'); } catch { /* offline */ }
  return {
    title: 'Home',
    body: html`
      <section class="hero"><div class="container hero-grid">
        <div>
          <div class="hero-logo">${nyscLogo('lg')}<span><b style="color:var(--g900);font-size:1.2rem">CampSpace</b><br><small class="muted">NYSC orientation camp accommodation</small></span></div>
          <h1>Your Camp. Your Space. Your Comfort.</h1>
          <p class="tag">Book your hostel bunk before you arrive.</p>
          <p>CampSpace lets prospective corps members choose a bunk online, receive a digital ticket with a QR code, and get the right accommodation if they have a medical need. No double bookings, no queues at the hostel gate.</p>
          <div class="btn-row">
            ${S.user ? html`<a class="btn light lg" href="#${ROLE_HOME[S.user.role]}">Open my portal</a>`
              : html`<a class="btn light lg" href="#/register">Register and book</a><a class="btn lg" style="color:#fff;border-color:rgba(255,255,255,.6)" href="#/login">Log in</a>`}
          </div>
        </div>
        <div class="hero-panel" aria-label="Live availability">
          <h3 style="color:#fff">Live across active camps</h3>
          ${stats ? html`
            <div class="stat"><span>Orientation camps</span><b>${num(stats.camps)}</b></div>
            <div class="stat"><span>Bunks in the system</span><b>${num(stats.beds)}</b></div>
            <div class="stat"><span>Already booked</span><b>${num(stats.booked)}</b></div>
            <div class="stat"><span>Bunks still free</span><b>${num(stats.available)}</b></div>` : html`<p>Live figures appear when you are online.</p>`}
        </div>
      </div></section>

      <section class="section"><div class="container">
        <h2>Everything a camp needs, in one place</h2>
        <p class="lead">Built for corps members, accommodation officers, camp medical teams and NYSC administrators.</p>
        <div class="features">
          <div class="feature">${ico('&#9638;')}<h3>Interactive bunk selection</h3><p>See every room and bunk, lower or upper, and watch availability change live as others book.</p></div>
          <div class="feature">${ico('&#128274;')}<h3>No double bookings</h3><p>Every booking runs as a protected database transaction. A bunk can only ever belong to one person.</p></div>
          <div class="feature">${ico('&#9635;')}<h3>Digital ticket with QR code</h3><p>Download a PDF or show your ticket on your phone. Officers scan the QR code to check you in.</p></div>
          <div class="feature">${ico('&#10010;')}<h3>Medical accommodation</h3><p>Corps members with medical needs request support. The camp clinic reviews it, and ground-floor or lower-bunk allocation follows.</p></div>
          <div class="feature">${ico('&#128246;')}<h3>Works on poor networks</h3><p>Installable on your phone. Your ticket opens offline and unfinished forms are kept until you reconnect.</p></div>
          <div class="feature">${ico('&#127963;')}<h3>Ready for many camps</h3><p>Every camp has its own hostels, officers and medical team, managed from one system.</p></div>
        </div>
      </div></section>

      <section class="section alt"><div class="container">
        <h2>How it works</h2>
        <ol class="steps">
          <li><b>Register</b>Create an account with your NYSC call-up number and choose your orientation camp.</li>
          <li><b>Pick a bunk</b>Choose your hostel room and the exact bunk. Medical needs are respected automatically.</li>
          <li><b>Get your ticket</b>Receive a ticket with a QR code. Download the PDF or save it for offline use.</li>
          <li><b>Check in</b>At camp, an officer scans your QR code and your bunk is confirmed.</li>
        </ol>
        <div class="btn-row"><a class="btn ghost" href="#/how-it-works">See the full guide</a></div>
      </div></section>

      <section class="section"><div class="container">
        <div class="card notice"><h2>Your medical information stays private</h2>
        <p>Medical details are encrypted, visible only to the camp medical team, and every access is recorded. Accommodation officers see only the instruction they need, such as "ground floor, lower bunk", never the diagnosis.</p></div>
      </div></section>`,
  };
});

// ------------------------------------------------------------------ about
route('/about', 'public', () => ({
  title: 'About',
  body: html`<section class="section"><div class="narrow">
    <h1>About CampSpace</h1>
    <p class="lead">${TAGLINE}</p>
    <h2>The problem</h2>
    <p>On arrival at orientation camp, thousands of corps members are allocated hostel space at the gate. Queues are long, bunks get double-allocated, and corps members who need special accommodation are not always identified in time.</p>
    <h2>What CampSpace does</h2>
    <p>CampSpace moves allocation online, before camp opens. Corps members book a specific bunk, medical needs are reviewed by the camp clinic in advance, and accommodation officers see exactly who is arriving, where they sleep and who still needs a bunk.</p>
    <div class="cols">
      <div class="card"><h3>Corps members</h3><p>Register, choose a bunk, receive a ticket, request medical accommodation and track everything from a phone.</p></div>
      <div class="card"><h3>Accommodation officers</h3><p>Manage hostels, rooms and bunks, assign and move people, run the waiting list, scan tickets and report on occupancy.</p></div>
      <div class="card"><h3>Medical personnel</h3><p>Review requests, assess, tag priority and issue accommodation recommendations while protecting confidential records.</p></div>
      <div class="card"><h3>Administrators</h3><p>Open new camps, manage users and roles, configure the system and audit every sensitive action.</p></div>
    </div>
    <h2>Security and privacy</h2>
    <p>Passwords are salted and hashed. Access is role based and limited to the user's own camp. Medical records and documents are encrypted at rest. Every sensitive action is written to a tamper-evident audit log.</p>
    <h2>Built to scale</h2>
    <p>CampSpace is multi-camp from the ground up. A new camp is a few clicks: add hostels, rooms and staff, and open booking.</p>
    <div class="card notice info"><b>Status:</b> CampSpace is a demonstration platform prepared for presentation to NYSC. The official NYSC logo is displayed only once NYSC authorises its use.</div>
  </div></section>`,
}));

// ------------------------------------------------------------------ how it works
route('/how-it-works', 'public', () => ({
  title: 'How it works',
  body: html`<section class="section"><div class="narrow">
    <h1>How CampSpace works</h1>
    <h2>For corps members</h2>
    <ol class="steps" style="grid-template-columns:1fr">
      <li><b>Create your account</b>Use your real name, email, phone and NYSC call-up number (for example AB/26C/1234). Choose your orientation camp. Officers verify your call-up number.</li>
      <li><b>Choose a hostel room</b>You only see hostels for your gender. Rooms show how many bunks are free.</li>
      <li><b>Select your bunk</b>Tap an available bunk, lower or upper, and confirm. If someone is faster you are told straight away and can pick another.</li>
      <li><b>Request medical accommodation if needed</b>Describe your need and upload a doctor's note. The camp clinic reviews it. If approved, only matching bunks are offered to you.</li>
      <li><b>Keep your ticket</b>Download the PDF, print it, or save it for offline use. Your QR code is your proof of booking.</li>
      <li><b>Check in at camp</b>Show the QR code at the accommodation desk.</li>
    </ol>
    <h2>If the hostel is full</h2>
    <p>Join the waiting list. When a bunk is released you are allocated the first suitable one automatically, and notified. Corps members with approved medical priority move up.</p>
    <h2>If your network drops</h2>
    <ul>
      <li>Unfinished forms are kept on your device.</li>
      <li>Tickets you have opened can be viewed offline.</li>
      <li>A bunk request made offline is saved as <b>pending</b>. It is <b>not confirmed</b> until it reaches the server and the bunk is still free. You are told the result.</li>
    </ul>
    <div class="btn-row"><a class="btn primary" href="#/register">Register now</a><a class="btn ghost" href="#/faq">Read the FAQ</a></div>
  </div></section>`,
}));

// ------------------------------------------------------------------ faq
const FAQ = [
  ['Is CampSpace free?', 'Yes. The booking service is free for corps members.'],
  ['Do I need to register with my call-up number?', 'Yes. Your NYSC call-up number links your account to your official record. An accommodation officer verifies it. You can already choose a bunk while verification is pending, unless the camp requires verification first.'],
  ['Can two people book the same bunk?', 'No. Each booking is a protected database transaction and the database itself refuses a second booking on the same bunk. If someone is faster than you, you will see a message and can choose again.'],
  ['Why can I not see some bunks?', 'You only see hostels for your gender. Some ground-floor bunks are reserved for approved medical accommodation. If you have an approved need, only matching bunks are offered to you.'],
  ['How do I request medical accommodation?', 'Open Medical Support, describe your condition and the accommodation you need, and optionally attach a doctor\'s note (PDF, JPG or PNG, up to 3 MB). The camp medical team reviews it and tells you the result.'],
  ['Who can see my medical information?', 'Only you and the camp medical team. Accommodation officers see an approved instruction such as "ground-floor room", not your diagnosis. Every access to a medical record is logged.'],
  ['Can I change or cancel my bunk?', 'Yes, while you are not yet checked in. You can change to another free bunk or cancel. The number of self-service cancellations is limited by the camp.'],
  ['What if the hostel is full?', 'Join the waiting list. You are allocated automatically as soon as a suitable bunk is free, and notified.'],
  ['What if I have no data or the signal is poor?', 'Install CampSpace on your phone (Add to Home Screen). Your downloaded ticket opens offline and unfinished forms are saved. A bunk request made offline stays pending until it is confirmed online.'],
  ['What do I bring to camp?', 'Your ticket (PDF, printed or on your phone) and your NYSC call-up letter. An officer will scan the QR code.'],
];
route('/faq', 'public', () => ({
  title: 'FAQ',
  body: html`<section class="section"><div class="narrow"><h1>Frequently asked questions</h1>
    ${FAQ.map(([q, a]) => html`<details class="faq"><summary>${q}</summary><div>${a}</div></details>`)}
    <p style="margin-top:1.5rem">Still have a question? <a href="#/contact">Contact us</a>.</p></div></section>`,
}));

// ------------------------------------------------------------------ contact
route('/contact', 'public', () => ({
  title: 'Contact us',
  body: html`<section class="section"><div class="container"><div class="cols">
    <div><h1>Contact us</h1>
      <p class="lead">Questions about booking, medical accommodation or the platform? Send a message and the support team will reply by email.</p>
      <div class="card"><dl class="kv"><dt>Email</dt><dd>${S.meta?.config?.support_email || 'support@campspace.example'}</dd><dt>Phone</dt><dd>${S.meta?.config?.support_phone || '-'}</dd><dt>At camp</dt><dd>Accommodation desk, main hostel block</dd></dl></div>
    </div>
    <form class="card" id="contact" novalidate>
      <h2>Send a message</h2>
      <div class="draft-note" hidden>We restored what you had typed earlier.</div>
      <div class="field"><label for="c-name">Your name</label><input id="c-name" name="name" required minlength="2" maxlength="100" autocomplete="name"></div>
      <div class="field"><label for="c-email">Email</label><input id="c-email" name="email" type="email" required autocomplete="email"></div>
      <div class="field"><label for="c-sub">Subject</label><input id="c-sub" name="subject" required minlength="3" maxlength="140"></div>
      <div class="field"><label for="c-msg">Message</label><textarea id="c-msg" name="message" required minlength="10" maxlength="3000"></textarea></div>
      <button class="btn primary" type="submit">Send message</button><div class="form-error" role="alert"></div>
    </form></div></div></section>`,
  mount(el) {
    const f = el.querySelector('#contact');
    f.noValidate = false;
    draftForm(f, 'contact');
    submitForm(f, async (d) => { await post('/contact', d); f.reset(); clearDraft('contact'); toast('Message sent. We will reply by email.'); });
  },
}));

// ------------------------------------------------------------------ login
route('/login', 'public', ({ query }) => {
  const demo = S.meta?.demo;
  return {
    title: 'Log in',
    body: html`<div class="auth-wrap"><div class="card auth-card">
      <h1>Log in</h1>
      ${query.expired ? html`<div class="card notice warn">Your session expired. Please log in again.</div>` : ''}
      <form id="login">
        <div class="field"><label for="l-email">Email</label><input id="l-email" name="email" type="email" required autocomplete="username" inputmode="email"></div>
        <div class="field"><label for="l-pw">Password</label><input id="l-pw" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn primary lg" style="width:100%" type="submit">Log in</button>
        <div class="form-error" role="alert"></div>
      </form>
      <p style="margin-top:1rem">New corps member? <a href="#/register">Create an account</a></p>
      ${demo ? html`<div class="demo-box"><b>Demonstration accounts</b> <span class="muted">(password ${demo.password})</span>
        ${demo.accounts.map((a) => html`<button type="button" data-email="${a.email}">${a.role} <span>${a.email}</span></button>`)}</div>` : ''}
    </div></div>`,
    mount(el) {
      const f = el.querySelector('#login');
      submitForm(f, async (d) => {
        const r = await post('/auth/login', d);
        await refreshMe();
        window.dispatchEvent(new Event('cs:login'));
        toast(`Welcome, ${firstName(r.user.full_name)}.`);
        go(r.user.must_change_password ? '/settings' : (query.next && /^\/[a-z]/.test(query.next) ? query.next : ROLE_HOME[r.user.role]));
      });
      el.querySelectorAll('[data-email]').forEach((b) => b.addEventListener('click', () => {
        f.email.value = b.dataset.email; f.password.value = S.meta.demo.password; f.querySelector('button[type=submit]').click();
      }));
    },
  };
}, { guestOnly: true });

// ------------------------------------------------------------------ register
route('/register', 'public', () => {
  const m = S.meta;
  const closed = m && m.config.registration_open === false;
  return {
    title: 'Register',
    body: html`<div class="auth-wrap"><div class="card auth-card wide">
      <h1>Create your account</h1>
      <p class="muted">For prospective corps members. You will need your NYSC call-up number.</p>
      ${closed ? html`<div class="card notice warn">Registration is currently closed.</div>` : ''}
      ${!m ? html`<div class="card notice warn">You are offline. Connect to register. Anything you type here is kept on this device.</div>` : ''}
      <form id="reg" novalidate>
        <div class="draft-note" hidden>We restored what you had typed earlier. Passwords are never saved.</div>
        <div class="grid2">
          <div class="field"><label for="r-name">Full name (as on your call-up letter)</label><input id="r-name" name="full_name" required minlength="3" maxlength="100" autocomplete="name"></div>
          <div class="field"><label for="r-cu">NYSC call-up number</label><input id="r-cu" name="call_up_number" required placeholder="AB/26C/1234" maxlength="20" autocapitalize="characters" pattern="[A-Za-z]{2}/\\d{2}[A-Za-z]/\\d{3,6}"><div class="hint">Format: state code / year and batch / serial, for example EN/26C/4521</div></div>
          <div class="field"><label for="r-email">Email</label><input id="r-email" name="email" type="email" required autocomplete="email" inputmode="email"></div>
          <div class="field"><label for="r-ph">Phone number</label><input id="r-ph" name="phone" type="tel" required autocomplete="tel" placeholder="+234 801 234 5678"></div>
          <div class="field"><label for="r-g">Gender (decides which hostel you are placed in)</label><select id="r-g" name="gender" required><option value="">Choose...</option><option value="male">Male</option><option value="female">Female</option></select></div>
          <div class="field"><label for="r-st">State of origin</label><select id="r-st" name="state_of_origin" required><option value="">Choose...</option>${(m?.states || []).map((s) => html`<option>${s}</option>`)}</select></div>
          <div class="field"><label for="r-in">Institution attended</label><input id="r-in" name="institution" maxlength="120" autocomplete="organization"></div>
          <div class="field"><label for="r-camp">Orientation camp</label><select id="r-camp" name="camp_id" required><option value="">Choose your camp...</option>${(m?.camps || []).map((c) => html`<option value="${c.id}">${c.name} (${c.state}) - ${c.batch}</option>`)}</select></div>
          <div class="field"><label for="r-pw">Password</label><input id="r-pw" name="password" type="password" required minlength="8" autocomplete="new-password"><div class="hint">At least 8 characters, with letters and numbers.</div></div>
          <div class="field"><label for="r-pw2">Confirm password</label><input id="r-pw2" name="password2" type="password" required autocomplete="new-password"></div>
        </div>
        <label class="check"><input type="checkbox" name="consent" required><span>I confirm the details are correct and agree that CampSpace may process them to allocate my accommodation.</span></label>
        <button class="btn primary lg" style="width:100%" type="submit" ${closed ? 'disabled' : ''}>Create account</button>
        <div class="form-error" role="alert"></div>
      </form>
      <p style="margin-top:1rem">Already registered? <a href="#/login">Log in</a></p>
    </div></div>`,
    mount(el) {
      const f = el.querySelector('#reg');
      draftForm(f, 'register');
      submitForm(f, async (d) => {
        if (d.password !== d.password2) throw new Error('The two passwords do not match.');
        delete d.password2; delete d.consent;
        d.call_up_number = d.call_up_number.toUpperCase().replace(/\s+/g, '');
        d.camp_id = Number(d.camp_id);
        const r = await post('/auth/register', d);
        await refreshMe();
        window.dispatchEvent(new Event('cs:login'));
        toast(`Welcome to CampSpace, ${esc(firstName(r.user.full_name))}.`);
        go('/app');
      }, { draft: 'register' });
    },
  };
}, { guestOnly: true });
