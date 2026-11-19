// Camp scoping: staff only ever touch their own camp; super administrators choose a camp explicitly.
import { HttpError } from './util.js';

export function campOf(ctx) {
  const u = ctx.user;
  if (u.role === 'super_admin') {
    const id = Number(ctx.query.camp_id || ctx.body?.camp_id || 0)
      || ctx.db.get('SELECT id FROM camps WHERE active=1 ORDER BY id LIMIT 1')?.id;
    if (!id) throw new HttpError(400, 'No camp is available. Create a camp first.');
    if (!ctx.db.get('SELECT 1 x FROM camps WHERE id=?', id)) throw new HttpError(404, 'Camp not found');
    return id;
  }
  if (!u.camp_id) throw new HttpError(403, 'Your account is not assigned to a camp yet');
  return u.camp_id;
}

/** Entities from another camp look like they do not exist. */
export function sameCamp(ctx, entityCampId) {
  if (entityCampId !== campOf(ctx)) throw new HttpError(404, 'Not found');
}

export function paging(ctx, def = 25, max = 100) {
  const page = Math.max(1, parseInt(ctx.query.page || '1', 10) || 1);
  const size = Math.min(max, Math.max(1, parseInt(ctx.query.size || String(def), 10) || def));
  return { page, size, offset: (page - 1) * size };
}

export const like = (q) => '%' + String(q || '').replace(/[\\%_]/g, (c) => '\\' + c) + '%';
