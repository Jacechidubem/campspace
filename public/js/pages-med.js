// Medical personnel portal. Medical content is never cached on the device and every record view is audited server-side.
import {
  S, html, raw, route, go, get, post, toast, submitForm, openModal, badge, fmtDT, ago, floorName, empty, num, needLabel, downloadApi, pager, reload, bytes,
} from './core.js';
import { pageHead } from './shell.js';
import { kpi } from './pages-admin.js';

const MED = ['medical_personnel'];
const need = (k) => needLabel(k);
const needs = (arr) => html`<div class="pill-row">${arr.map((n) => html`<span class="pill">${need(n)}</span>`)}</div>`;
const rowLink = (r) => `#/med/assess/${r.id}`;

// ================================================================== dashboard
route('/med', MED, async () => {
  const d = await get('/med/dashboard');
  const c = d.counts;
  const list = (rows) => (rows.length ? html`<ul class="timeline">${rows.map((r) => html`<li><span><a href="${rowLink(r)}"><b>${r.full_name}</b></a><br><span class="small muted">${r.category} - ${ago(r.updated_at)}</span></span><span>${badge(r.priority)} ${badge(r.status)}</span></li>`)}</ul>` : empty('Nothing here'));
  return {
    title: 'Dashboard',
    body: html`${pageHead('Medical dashboard', S.camp?.name || '', html`<a class="btn primary" href="#/med/assess">Start assessing</a>`)}
      <div class="kpis">${kpi(c.awaiting, 'Awaiting review', c.awaiting ? 'warn' : '')}${kpi(c.urgent_open, 'Urgent open', c.urgent_open ? 'bad' : '')}${kpi(c.high_open, 'High priority open')}${kpi(c.under_review, 'Under review')}${kpi(c.more_info, 'Waiting for the corps member')}${kpi(c.approved, 'Approved')}${kpi(c.awaiting_allocation, 'Approved, no bunk yet', c.awaiting_allocation ? 'warn' : '')}${kpi(c.rejected, 'Not approved')}</div>
      <div class="cols"><div class="card"><div class="card-head"><h2>Queue</h2><a class="btn ghost sm" href="#/med/requests?status=open">All open</a></div>${list(d.queue)}</div>
      <div class="card"><div class="card-head"><h2>Recently decided</h2><a class="btn ghost sm" href="#/med/history">History</a></div>${list(d.reviewed)}</div></div>
      <div class="card notice info small">Medical records are encrypted. Every time you open one, the access is written to the audit log.</div>`,
  };
});

// ================================================================== incoming requests
route('/med/requests', MED, async ({ query }) => {
  const qs = new URLSearchParams({ size: 25, page: query.page || 1 });
  for (const k of ['status', 'priority', 'q']) if (query[k]) qs.set(k, query[k]);
  const d = await get('/med/requests?' + qs);
  const link = (p) => `#/med/requests?${new URLSearchParams({ ...query, page: p })}`;
  return {
    title: 'Incoming Medical Requests',
    body: html`${pageHead('Incoming medical requests', `${num(d.total)} matching`)}
      <form class="toolbar" id="f"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search name or call-up number" aria-label="Search">
        <select name="status" aria-label="Status">${[['open', 'Open (needs action)'], ['all', 'All'], ['submitted', 'Submitted'], ['under_review', 'Under review'], ['more_info', 'More info needed'], ['approved', 'Approved'], ['rejected', 'Not approved']].map(([v, l]) => html`<option value="${v}" ${(query.status || 'open') === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <select name="priority" aria-label="Priority">${[['all', 'Any priority'], ['urgent', 'Urgent'], ['high', 'High'], ['routine', 'Routine']].map(([v, l]) => html`<option value="${v}" ${(query.priority || 'all') === v ? raw('selected') : ''}>${l}</option>`)}</select>
        <button class="btn ghost" type="submit">Filter</button></form>
      <div class="table-wrap"><table><thead><tr><th>Corps member</th><th>Type</th><th>Requested</th><th>Priority</th><th>Status</th><th>Received</th><th></th></tr></thead><tbody>
      ${d.items.length ? d.items.map((r) => html`<tr><td><b>${r.full_name}</b><div class="small muted mono">${r.call_up_number}</div></td><td>${r.category}</td><td>${needs(r.requested_needs)}</td><td>${badge(r.priority)}</td><td>${badge(r.status)}</td><td class="small">${ago(r.created_at)}</td><td><a class="btn primary sm" href="${rowLink(r)}">${['approved', 'rejected'].includes(r.status) ? 'View' : 'Assess'}</a></td></tr>`) : html`<tr><td colspan="7">${empty('No requests match')}</td></tr>`}</tbody></table></div>${pager(d.page, d.size, d.total, link)}`,
    mount(el) {
      el.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const p = new URLSearchParams(new FormData(e.target)); [...p].forEach(([k, v]) => { if (!v || v === 'all') p.delete(k); }); go('/med/requests' + (p.size ? '?' + p : '?status=all')); });
    },
  };
});

// ================================================================== medical profiles
route('/med/profiles', MED, async ({ query }) => {
  const d = await get('/med/profiles' + (query.q ? '?q=' + encodeURIComponent(query.q) : ''));
  return {
    title: 'Corps Member Medical Profiles',
    body: html`${pageHead('Medical profiles', 'Corps members with a medical request in this camp.')}
      <form class="toolbar" id="f"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search name or call-up number" aria-label="Search"><button class="btn ghost" type="submit">Search</button></form>
      ${d.items.length ? html`<div class="cols">${d.items.map((p) => html`<a class="card" style="text-decoration:none;color:inherit" href="#/med/assess/${p.last_request.id}"><div class="card-head"><h3>${p.full_name}</h3>${badge(p.last_request.status)}</div>
        <p class="small muted mono" style="margin:0 0 .5rem">${p.call_up_number} - ${p.gender}${p.state_of_origin ? ', ' + p.state_of_origin : ''}</p>
        ${p.last_request.approved_needs.length ? needs(p.last_request.approved_needs) : html`<span class="muted small">No approved accommodation</span>`}
        <p class="small muted" style="margin:.6rem 0 0">${p.requests} request${p.requests > 1 ? 's' : ''}. Last update ${ago(p.last_request.updated_at)}</p></a>`)}</div>` : html`<div class="card">${empty('No profiles found')}</div>`}`,
    mount(el) { el.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const q = new FormData(e.target).get('q'); go('/med/profiles' + (q ? '?q=' + encodeURIComponent(q) : '')); }); },
  };
});

// ================================================================== assessment queue
route('/med/assess', MED, async () => {
  const d = await get('/med/requests?status=open&size=50');
  return {
    title: 'Medical Assessment',
    body: html`${pageHead('Medical assessment', 'Open requests, most urgent first. Open one to review the record and decide.')}
      ${d.items.length ? d.items.map((r) => html`<div class="card"><div class="card-head"><div><h3>${r.full_name}</h3><span class="small muted mono">${r.call_up_number} - ${r.category}</span></div><div>${badge(r.priority)} ${badge(r.status)}</div></div>${needs(r.requested_needs)}<div class="btn-row"><a class="btn primary" href="${rowLink(r)}">Start assessment</a><span class="small muted">Received ${ago(r.created_at)}</span></div></div>`)
        : html`<div class="card">${empty('All caught up', 'There are no open medical requests right now.')}</div>`}`,
  };
});

route('/med/assess/:id', MED, async ({ params }) => {
  const d = await get('/med/requests/' + params.id);
  const r = d.request;
  const done = ['approved', 'rejected'].includes(r.status);
  const preselect = r.approved_needs.length ? r.approved_needs : r.requested_needs;
  return {
    title: `Assessment: ${r.full_name}`,
    body: html`${pageHead(r.full_name, `${r.call_up_number} - ${r.gender} - ${d.corper.state_of_origin || ''}`, html`<a class="btn ghost" href="#/med/requests">Back to requests</a>`)}
      <div class="cols">
        <div>
          <div class="card"><div class="card-head"><h2>Medical record</h2><div>${badge(r.status)} ${badge(r.priority)}</div></div>
            <dl class="kv"><dt>Type</dt><dd>${r.category}</dd><dt>Condition</dt><dd>${r.condition}</dd><dt>Details</dt><dd style="white-space:pre-wrap;font-weight:500">${r.details || '-'}</dd><dt>Received</dt><dd>${fmtDT(r.created_at)}</dd>
            <dt>Requested</dt><dd>${needs(r.requested_needs)}</dd>${d.booking ? html`<dt>Current bunk</dt><dd>${d.booking.hostel}, room ${d.booking.room}, ${d.booking.label} (${floorName(d.booking.floor)}, ${d.booking.level})</dd>` : ''}
            ${d.corper.phone ? html`<dt>Contact</dt><dd>${d.corper.phone}</dd>` : ''}</dl>
            ${d.documents.length ? html`<h3 style="margin-top:1rem">Documents</h3><div class="btn-row" style="margin-top:.3rem">${d.documents.map((x) => html`<button class="btn ghost sm" data-doc="${x.id}" data-name="${x.name}">${x.name} (${bytes(x.size)})</button>`)}</div>` : ''}
          </div>
          ${d.history.length ? html`<div class="card"><h3>Earlier requests</h3><ul class="timeline">${d.history.map((h) => html`<li><a href="#/med/assess/${h.id}">${fmtDT(h.created_at)}</a><span>${badge(h.status)} ${badge(h.priority)}</span></li>`)}</ul></div>` : ''}
        </div>
        <form class="card" id="assess">
          <h2>${done ? 'Update decision' : 'Assessment'}</h2>
          ${r.reviewer ? html`<p class="small muted">Last reviewed by ${r.reviewer}.</p>` : ''}
          <div class="field"><label for="a-st">Decision</label><select id="a-st" name="status" required>${[['under_review', 'Mark as under review'], ['more_info', 'Ask the corps member for more information'], ['approved', 'Approve accommodation'], ['rejected', 'Do not approve']].map(([v, l]) => html`<option value="${v}" ${(r.status === v || (r.status === 'submitted' && v === 'under_review')) ? raw('selected') : ''}>${l}</option>`)}</select></div>
          <fieldset style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.92rem;margin-bottom:.4rem">Priority</legend>
            <div class="pill-row">${['routine', 'high', 'urgent'].map((p) => html`<label class="check" style="margin:0"><input type="radio" name="priority" value="${p}" ${r.priority === p ? raw('checked') : ''}><span>${p[0].toUpperCase() + p.slice(1)}</span></label>`)}</div></fieldset>
          <div class="field"><label for="a-as">Clinical assessment <span class="muted">(visible only to medical personnel)</span></label><textarea id="a-as" name="assessment" maxlength="3000">${r.assessment}</textarea></div>
          <fieldset id="needs-set" style="border:0;padding:0;margin:0 0 1rem"><legend style="font-weight:600;font-size:.92rem;margin-bottom:.4rem">Approved accommodation</legend>
            ${Object.entries(d.needs).map(([k, v]) => html`<label class="check"><input type="checkbox" name="approved_needs" value="${k}" data-multi ${preselect.includes(k) ? raw('checked') : ''}><span>${v}</span></label>`)}</fieldset>
          <div class="field" id="instr"><label for="a-in">Instruction for accommodation officers <span class="muted">(no diagnosis)</span></label><input id="a-in" name="officer_instruction" maxlength="300" value="${r.officer_instruction || ''}" placeholder="For example: ground-floor room, lower bunk"></div>
          <div class="field"><label for="a-ms">Message to the corps member</label><textarea id="a-ms" name="message_to_corper" maxlength="500">${r.message_to_corper || ''}</textarea></div>
          <button class="btn primary" type="submit">Save decision</button><div class="form-error" role="alert"></div>
        </form>
      </div>`,
    mount(el) {
      el.querySelectorAll('[data-doc]').forEach((b) => b.addEventListener('click', () => downloadApi('/medical/documents/' + b.dataset.doc, b.dataset.name)));
      const f = el.querySelector('#assess');
      const sync = () => { const ap = f.status.value === 'approved'; el.querySelector('#needs-set').hidden = !ap; el.querySelector('#instr').hidden = !ap; };
      f.status.addEventListener('change', sync); sync();
      submitForm(f, async (d2) => {
        await post(`/med/requests/${r.id}/assess`, { status: d2.status, priority: d2.priority, assessment: d2.assessment, approved_needs: d2.status === 'approved' ? d2.approved_needs : [], officer_instruction: d2.officer_instruction, message_to_corper: d2.message_to_corper });
        toast('Decision saved. The corps member was notified.');
        go(d2.status === 'approved' || d2.status === 'rejected' ? '/med/assess' : '/med');
      });
    },
  };
});

// ================================================================== priority tagging
route('/med/priority', MED, async () => {
  const d = await get('/med/requests?status=all&size=100');
  const rows = d.items.filter((r) => !['rejected'].includes(r.status));
  return {
    title: 'Priority Tagging',
    body: html`${pageHead('Priority tagging', 'Priority decides the order of review and the corps member\'s place on the waiting list.')}
      <div class="table-wrap"><table><thead><tr><th>Corps member</th><th>Type</th><th>Status</th><th>Priority</th></tr></thead><tbody>
      ${rows.length ? rows.map((r) => html`<tr><td><b>${r.full_name}</b><div class="small muted mono">${r.call_up_number}</div></td><td>${r.category}</td><td>${badge(r.status)}</td>
        <td><div class="pill-row" role="group" aria-label="Priority for ${r.full_name}">${['routine', 'high', 'urgent'].map((p) => html`<button class="btn sm ${r.priority === p ? 'primary' : 'ghost'}" data-id="${r.id}" data-p="${p}" aria-pressed="${r.priority === p}">${p[0].toUpperCase() + p.slice(1)}</button>`)}</div></td></tr>`) : html`<tr><td colspan="4">${empty('No requests to tag')}</td></tr>`}</tbody></table></div>`,
    mount(el) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-p]'); if (!b || b.classList.contains('primary')) return;
        try { await post(`/med/requests/${b.dataset.id}/priority`, { priority: b.dataset.p }); toast('Priority updated.'); reload(); } catch (err) { toast(err.message, 'bad'); }
      });
    },
  };
});

// ================================================================== accommodation recommendations
route('/med/recommend', MED, async () => {
  const d = await get('/med/recommendations');
  return {
    title: 'Accommodation Recommendations',
    body: html`${pageHead('Accommodation recommendations', 'Approved needs and the instruction passed to accommodation officers.')}
      ${d.items.length ? d.items.map((x) => html`<div class="card"><div class="card-head"><div><h3>${x.full_name}</h3><span class="small muted mono">${x.call_up_number}</span></div><div>${badge(x.priority)} ${x.allocated ? badge('ok', 'Bunk ' + x.allocated) : badge('warn', 'No bunk yet')}</div></div>
        ${needs(x.approved_needs)}<p style="margin:.7rem 0 0"><b>Instruction:</b> ${x.officer_instruction || html`<span class="muted">none</span>`}</p>
        <div class="btn-row"><button class="btn ghost sm" data-edit="${x.id}">Edit recommendation</button><a class="btn ghost sm" href="#/med/assess/${x.id}">Open record</a></div></div>`)
        : html`<div class="card">${empty('No approved recommendations yet')}</div>`}`,
    mount(el) {
      el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
        const x = d.items.find((i) => i.id === Number(b.dataset.edit));
        const m = openModal(`Recommendation: ${x.full_name}`, html`<form>${Object.entries(d.needs).map(([k, v]) => html`<label class="check"><input type="checkbox" name="approved_needs" value="${k}" data-multi ${x.approved_needs.includes(k) ? raw('checked') : ''}><span>${v}</span></label>`)}
          <div class="field"><label for="ri">Instruction for officers</label><input id="ri" name="officer_instruction" maxlength="300" value="${x.officer_instruction || ''}"></div>
          <div class="btn-row end"><button type="button" class="btn ghost" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div><div class="form-error"></div></form>`.toString());
        submitForm(m.el.querySelector('form'), async (f) => { await post(`/med/requests/${x.id}/recommend`, f); m.close(); toast('Recommendation updated. Officers were notified.'); reload(); });
      }));
    },
  };
});

// ================================================================== history
route('/med/history', MED, async ({ query }) => {
  const d = await get('/med/history' + (query.q ? '?q=' + encodeURIComponent(query.q) : ''));
  return {
    title: 'Request History',
    body: html`${pageHead('Request history', 'Requests that have been decided.')}
      <form class="toolbar" id="f"><input class="grow" name="q" type="search" value="${query.q || ''}" placeholder="Search name or call-up number" aria-label="Search"><button class="btn ghost" type="submit">Search</button></form>
      <div class="table-wrap"><table><thead><tr><th>Corps member</th><th>Type</th><th>Decision</th><th>Priority</th><th>Approved</th><th>By</th><th>Decided</th><th></th></tr></thead><tbody>
      ${d.items.length ? d.items.map((r) => html`<tr><td><b>${r.full_name}</b><div class="small muted mono">${r.call_up_number}</div></td><td>${r.category}</td><td>${badge(r.status)}</td><td>${badge(r.priority)}</td><td>${r.approved_needs.length ? needs(r.approved_needs) : '-'}</td><td class="small">${r.reviewer || '-'}</td><td class="small">${fmtDT(r.reviewed_at)}</td><td><a class="btn ghost sm" href="${rowLink(r)}">Open</a></td></tr>`) : html`<tr><td colspan="8">${empty('No decided requests')}</td></tr>`}</tbody></table></div>`,
    mount(el) { el.querySelector('#f').addEventListener('submit', (e) => { e.preventDefault(); const q = new FormData(e.target).get('q'); go('/med/history' + (q ? '?q=' + encodeURIComponent(q) : '')); }); },
  };
});
void ago;
