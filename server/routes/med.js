// Medical personnel endpoints. Every read of a medical record is written to the audit log.
import { HttpError, str, int, oneOf, arrayOf } from '../util.js';
import { NEEDS } from '../constants.js';
import { now, audit, notify, notifyRole, needLabels, ticketView } from '../services.js';
import { campOf, sameCamp, paging, like } from '../scope.js';

const PRI = { routine: 0, high: 1, urgent: 2 };

export function registerMed(r, app) {
  const { db, vault } = app;
  const P = { perm: 'medical.review' };

  const reqRow = (ctx, id) => {
    const row = db.get('SELECT * FROM medical_requests WHERE id=?', id);
    if (!row) throw new HttpError(404, 'Request not found');
    sameCamp(ctx, row.camp_id);
    return row;
  };
  const payload = (row) => vault.dec(row.payload_enc, `medreq:${row.id}`) || {};

  function listRow(row, u) {
    return {
      id: row.id, user_id: row.user_id, full_name: u.full_name, call_up_number: u.call_up_number, gender: u.gender,
      status: row.status, priority: row.priority, category: payload(row).category,
      requested_needs: JSON.parse(row.requested_needs), approved_needs: JSON.parse(row.approved_needs),
      created_at: row.created_at, updated_at: row.updated_at, reviewed_at: row.reviewed_at,
    };
  }

  function syncWaitlistPriority(userId) {
    const pri = db.get("SELECT priority FROM medical_requests WHERE user_id=? AND status='approved' ORDER BY id DESC LIMIT 1", userId)?.priority || 'routine';
    db.run("UPDATE waitlist SET priority=? WHERE user_id=? AND status='waiting'", PRI[pri], userId);
  }

  r.get('/api/med/dashboard', P, (ctx) => {
    const campId = campOf(ctx);
    const count = (sql, ...p) => db.get(sql, campId, ...p).n;
    const open = "status IN ('submitted','under_review','more_info')";
    const queue = db.all(
      `SELECT mr.* FROM medical_requests mr WHERE mr.camp_id=? AND mr.${open}
        ORDER BY CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, mr.created_at LIMIT 8`, campId)
      .map((row) => listRow(row, db.get('SELECT full_name, call_up_number, gender FROM users WHERE id=?', row.user_id)));
    const reviewed = db.all(
      `SELECT mr.* FROM medical_requests mr WHERE mr.camp_id=? AND mr.status IN ('approved','rejected') ORDER BY mr.reviewed_at DESC LIMIT 6`, campId)
      .map((row) => listRow(row, db.get('SELECT full_name, call_up_number, gender FROM users WHERE id=?', row.user_id)));
    return {
      counts: {
        awaiting: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND status='submitted'`),
        under_review: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND status='under_review'`),
        more_info: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND status='more_info'`),
        approved: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND status='approved'`),
        rejected: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND status='rejected'`),
        urgent_open: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND priority='urgent' AND ${open}`),
        high_open: count(`SELECT COUNT(*) n FROM medical_requests WHERE camp_id=? AND priority='high' AND ${open}`),
        awaiting_allocation: count(`SELECT COUNT(*) n FROM medical_requests mr WHERE mr.camp_id=? AND mr.status='approved' AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.user_id=mr.user_id AND bk.status IN ('confirmed','checked_in'))`),
      },
      queue, reviewed,
    };
  });

  r.get('/api/med/requests', P, (ctx) => {
    const campId = campOf(ctx);
    const where = ['mr.camp_id=?'];
    const p = [campId];
    if (ctx.query.status && ctx.query.status !== 'all') {
      if (ctx.query.status === 'open') where.push("mr.status IN ('submitted','under_review','more_info')");
      else { where.push('mr.status=?'); p.push(oneOf(ctx.query.status, ['submitted', 'under_review', 'more_info', 'approved', 'rejected'], 'status')); }
    }
    if (ctx.query.priority && ctx.query.priority !== 'all') { where.push('mr.priority=?'); p.push(oneOf(ctx.query.priority, ['routine', 'high', 'urgent'], 'priority')); }
    const q = (ctx.query.q || '').trim();
    if (q) { where.push("(u.full_name LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\')"); p.push(like(q), like(q)); }
    const { page, size, offset } = paging(ctx);
    const total = db.get(`SELECT COUNT(*) n FROM medical_requests mr JOIN users u ON u.id=mr.user_id WHERE ${where.join(' AND ')}`, ...p).n;
    const rows = db.all(
      `SELECT mr.*, u.full_name, u.call_up_number, u.gender FROM medical_requests mr JOIN users u ON u.id=mr.user_id
        WHERE ${where.join(' AND ')}
        ORDER BY CASE WHEN mr.status IN ('submitted','under_review','more_info') THEN 0 ELSE 1 END,
                 CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, mr.created_at
        LIMIT ? OFFSET ?`, ...p, size, offset);
    return { items: rows.map((row) => listRow(row, row)), total, page, size };
  });

  r.get('/api/med/requests/:id', P, (ctx) => {
    const row = reqRow(ctx, int(ctx.params.id, 'id'));
    const u = db.get('SELECT id, full_name, call_up_number, gender, state_of_origin, institution, phone, email FROM users WHERE id=?', row.user_id);
    const p = payload(row);
    const assessment = row.assessment_enc ? vault.dec(row.assessment_enc, `medassess:${row.id}`) : null;
    ctx.audit('medical.record.view', 'medical_request', row.id, { corper: row.user_id });
    const bk = db.get("SELECT id FROM bookings WHERE user_id=? AND status IN ('confirmed','checked_in')", row.user_id);
    const ticket = bk ? ticketView(db, vault, bk.id) : null;
    return {
      request: {
        ...listRow(row, u), category: p.category, condition: p.condition, details: p.details,
        assessment: assessment?.text || '', officer_instruction: row.officer_instruction, message_to_corper: row.message_to_corper,
        reviewer: row.reviewer_id ? db.get('SELECT full_name FROM users WHERE id=?', row.reviewer_id)?.full_name : null,
      },
      corper: u,
      documents: db.all('SELECT id, size, created_at, meta_enc FROM medical_documents WHERE request_id=? ORDER BY id', row.id)
        .map((d) => ({ id: d.id, size: d.size, created_at: d.created_at, name: vault.dec(d.meta_enc, `meddoc:${d.id}`)?.name })),
      booking: ticket && { label: ticket.bed.label, hostel: ticket.hostel.name, room: ticket.room.number, floor: ticket.room.floor, level: ticket.bed.level, status: ticket.status },
      history: db.all('SELECT id, status, priority, created_at FROM medical_requests WHERE user_id=? AND id!=? ORDER BY id DESC', row.user_id, row.id),
      needs: NEEDS,
    };
  });

  r.post('/api/med/requests/:id/assess', P, (ctx) => {
    const row = reqRow(ctx, int(ctx.params.id, 'id'));
    const b = ctx.body;
    const status = oneOf(b.status, ['under_review', 'more_info', 'approved', 'rejected'], 'Decision');
    const priority = oneOf(b.priority ?? row.priority, ['routine', 'high', 'urgent'], 'Priority');
    const assessment = str(b.assessment, 'Clinical assessment', { required: status === 'approved' || status === 'rejected', min: 3, max: 3000 });
    const approved = arrayOf(b.approved_needs, Object.keys(NEEDS), 'Approved needs');
    if (status === 'approved' && !approved.length) throw new HttpError(400, 'Choose at least one accommodation need to approve.');
    const instruction = str(b.officer_instruction, 'Instruction for accommodation officers', { required: false, max: 300 });
    const message = str(b.message_to_corper, 'Message to the corps member', { required: status === 'more_info', max: 500 });
    const ts = now();
    db.tx(() => {
      db.run(
        `UPDATE medical_requests SET status=?, priority=?, assessment_enc=?, approved_needs=?, officer_instruction=?, message_to_corper=?,
                reviewer_id=?, reviewed_at=?, updated_at=? WHERE id=?`,
        status, priority, assessment ? vault.enc({ text: assessment }, `medassess:${row.id}`) : row.assessment_enc,
        JSON.stringify(status === 'approved' ? approved : []), status === 'approved' ? instruction : null, message,
        ctx.user.id, ts, ts, row.id);
      audit(db, ctx.actor, `medical.assess.${status}`, 'medical_request', row.id, { priority, needs: status === 'approved' ? approved : [] });
      const titles = {
        under_review: ['Medical request under review', 'The camp medical team has started reviewing your request.'],
        more_info: ['More information needed', message],
        approved: ['Medical accommodation approved', `Approved: ${needLabels(approved).join(', ')}. ${message || ''}`.trim()],
        rejected: ['Medical request not approved', message || 'Please visit the camp clinic if you need to discuss this.'],
      };
      notify(db, row.user_id, 'medical', titles[status][0], titles[status][1], '#/app/medical');
      if (status === 'approved') {
        notifyRole(db, row.camp_id, 'accommodation_officer', 'medical', 'New medical accommodation instruction', 'A corps member has an approved accommodation need. See Medical Accommodation Instructions.', '#/admin/medical');
        const bk = db.get(
          `SELECT b.level, r.floor FROM bookings bk JOIN beds b ON b.id=bk.bed_id JOIN rooms r ON r.id=b.room_id WHERE bk.user_id=? AND bk.status IN ('confirmed','checked_in')`, row.user_id);
        const ground = approved.includes('ground_floor') || approved.includes('wheelchair_access');
        if (bk && ((ground && bk.floor !== 0) || (approved.includes('lower_bunk') && bk.level !== 'lower')))
          notify(db, row.user_id, 'medical', 'Your bunk may need to change', 'Your current bunk does not match your approved accommodation. An officer will contact you, or you can change your bunk.', '#/app/accommodation');
      }
      syncWaitlistPriority(row.user_id);
    });
    return { ok: true };
  });

  r.post('/api/med/requests/:id/priority', P, (ctx) => {
    const row = reqRow(ctx, int(ctx.params.id, 'id'));
    const priority = oneOf(ctx.body.priority, ['routine', 'high', 'urgent'], 'Priority');
    db.tx(() => {
      db.run('UPDATE medical_requests SET priority=?, updated_at=? WHERE id=?', priority, now(), row.id);
      audit(db, ctx.actor, 'medical.priority', 'medical_request', row.id, { priority });
      syncWaitlistPriority(row.user_id);
    });
    return { ok: true };
  });

  r.get('/api/med/profiles', P, (ctx) => {
    const campId = campOf(ctx);
    const q = (ctx.query.q || '').trim();
    const rows = db.all(
      `SELECT u.id, u.full_name, u.call_up_number, u.gender, u.state_of_origin, COUNT(mr.id) requests, MAX(mr.id) last_id
         FROM users u JOIN medical_requests mr ON mr.user_id=u.id
        WHERE u.camp_id=? ${q ? "AND (u.full_name LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\')" : ''}
        GROUP BY u.id ORDER BY u.full_name LIMIT 200`, ...(q ? [campId, like(q), like(q)] : [campId]));
    return {
      items: rows.map((x) => {
        const last = db.get('SELECT id, status, priority, approved_needs, updated_at FROM medical_requests WHERE id=?', x.last_id);
        return { ...x, last_request: { id: last.id, status: last.status, priority: last.priority, approved_needs: JSON.parse(last.approved_needs), updated_at: last.updated_at } };
      }),
    };
  });

  r.get('/api/med/recommendations', P, (ctx) => {
    const campId = campOf(ctx);
    const rows = db.all(
      `SELECT mr.id, mr.user_id, mr.priority, mr.approved_needs, mr.officer_instruction, mr.reviewed_at, u.full_name, u.call_up_number,
              (SELECT b.label FROM bookings bk JOIN beds b ON b.id=bk.bed_id WHERE bk.user_id=mr.user_id AND bk.status IN ('confirmed','checked_in') LIMIT 1) allocated
         FROM medical_requests mr JOIN users u ON u.id=mr.user_id WHERE mr.camp_id=? AND mr.status='approved'
        ORDER BY CASE mr.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, mr.reviewed_at DESC`, campId);
    return { items: rows.map((x) => ({ ...x, approved_needs: JSON.parse(x.approved_needs) })), needs: NEEDS };
  });

  r.post('/api/med/requests/:id/recommend', P, (ctx) => {
    const row = reqRow(ctx, int(ctx.params.id, 'id'));
    if (row.status !== 'approved') throw new HttpError(409, 'Only approved requests carry accommodation recommendations.');
    const approved = arrayOf(ctx.body.approved_needs, Object.keys(NEEDS), 'Approved needs');
    if (!approved.length) throw new HttpError(400, 'Choose at least one accommodation need.');
    const instruction = str(ctx.body.officer_instruction, 'Instruction', { required: false, max: 300 });
    db.tx(() => {
      db.run('UPDATE medical_requests SET approved_needs=?, officer_instruction=?, updated_at=? WHERE id=?', JSON.stringify(approved), instruction, now(), row.id);
      audit(db, ctx.actor, 'medical.recommend', 'medical_request', row.id, { needs: approved });
      notifyRole(db, row.camp_id, 'accommodation_officer', 'medical', 'Medical accommodation instruction updated', 'See Medical Accommodation Instructions.', '#/admin/medical');
    });
    return { ok: true };
  });

  r.get('/api/med/history', P, (ctx) => {
    const campId = campOf(ctx);
    const q = (ctx.query.q || '').trim();
    const rows = db.all(
      `SELECT mr.*, u.full_name, u.call_up_number, u.gender, rv.full_name reviewer FROM medical_requests mr
         JOIN users u ON u.id=mr.user_id LEFT JOIN users rv ON rv.id=mr.reviewer_id
        WHERE mr.camp_id=? AND mr.status IN ('approved','rejected') ${q ? "AND (u.full_name LIKE ? ESCAPE '\\' OR u.call_up_number LIKE ? ESCAPE '\\')" : ''}
        ORDER BY mr.reviewed_at DESC LIMIT 200`, ...(q ? [campId, like(q), like(q)] : [campId]));
    return { items: rows.map((x) => ({ ...listRow(x, x), reviewer: x.reviewer })) };
  });
}
