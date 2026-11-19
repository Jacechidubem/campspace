// Minimal dependency-free PDF writer, just enough for the accommodation ticket.
import { qrEncode } from '../public/js/qr.js';

const GREEN = [0.043, 0.416, 0.243];
const DARK = [0.1, 0.13, 0.12];
const MUTED = [0.4, 0.45, 0.42];

function clean(s) {
  // Standard PDF fonts only cover WinAnsi: strip accents, replace anything else.
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '?');
}
const esc = (s) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const n = (x) => (Math.round(x * 100) / 100).toString();

class Page {
  constructor() { this.ops = []; }
  color(rgb, stroke = false) { this.ops.push(`${rgb.map(n).join(' ')} ${stroke ? 'RG' : 'rg'}`); }
  rect(x, y, w, h, fill = true) { this.ops.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re ${fill ? 'f' : 'S'}`); }
  line(x1, y1, x2, y2, width = 1, dash = null) {
    this.ops.push(`${n(width)} w ${dash ? `[${dash}] 0 d` : '[] 0 d'} ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }
  text(x, y, s, size = 11, bold = false, rgb = DARK) {
    this.color(rgb);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${n(x)} ${n(y)} Td (${esc(s)}) Tj ET`);
  }
  wrap(x, y, s, size, maxChars, leading, bold = false, rgb = DARK) {
    const words = clean(s).split(/\s+/);
    let line = '';
    let yy = y;
    for (const w of words) {
      if ((line + ' ' + w).trim().length > maxChars) { this.text(x, yy, line, size, bold, rgb); yy -= leading; line = w; }
      else line = (line + ' ' + w).trim();
    }
    if (line) { this.text(x, yy, line, size, bold, rgb); yy -= leading; }
    return yy;
  }
}

function assemble(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(''); // placeholder
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pg of pages) {
    const content = pg.ops.join('\n');
    const cid = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    const pid = add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`);
    kids.push(`${pid} 0 R`);
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Build the one-page accommodation ticket PDF from a ticket view object (see services.ticketView). */
export function ticketPdf(t) {
  const pg = new Page();
  // header band
  pg.color(GREEN); pg.rect(0, 742, 595, 100);
  pg.text(40, 800, 'CampSpace', 26, true, [1, 1, 1]);
  pg.text(40, 778, 'Your Camp. Your Space. Your Comfort.', 11, false, [0.85, 0.95, 0.89]);
  pg.text(40, 756, 'NYSC ORIENTATION CAMP ACCOMMODATION TICKET', 10, true, [1, 1, 1]);

  // status
  const confirmed = t.status === 'confirmed' || t.status === 'checked_in';
  pg.text(40, 710, confirmed ? (t.status === 'checked_in' ? 'CHECKED IN' : 'CONFIRMED') : String(t.status).toUpperCase(), 14, true, confirmed ? GREEN : [0.7, 0.15, 0.1]);
  pg.text(40, 692, `Booking reference: ${t.ref}`, 11, true);

  // QR
  const qr = qrEncode(t.qr, 'M');
  const mod = 4.2, quiet = 4, size = (qr.size + quiet * 2) * mod;
  const qx = 595 - 40 - size, qy = 706 - size;
  pg.color([1, 1, 1]); pg.rect(qx, qy, size, size);
  pg.color([0, 0, 0]);
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.modules[y][x]) pg.rect(qx + (x + quiet) * mod, qy + size - (y + quiet + 1) * mod, mod + 0.15, mod + 0.15);
  pg.color(GREEN); pg.rect(qx, qy, size, size, false);
  pg.text(qx, qy - 14, t.qr, 8, false, MUTED);

  // details
  let y = 650;
  const field = (label, value) => {
    pg.text(40, y, label.toUpperCase(), 8, true, MUTED);
    pg.text(40, y - 15, String(value ?? '-'), 13, true);
    y -= 42;
  };
  field('Corps member', t.corper.name);
  field('NYSC call-up number', t.corper.call_up_number);
  field('Camp', `${t.camp.name} (${t.camp.state} State)`);
  y = Math.min(y, qy - 40);
  field('Hostel', t.hostel.name);
  field('Room', `${t.room.number}  -  ${t.room.floor === 0 ? 'Ground floor' : `Floor ${t.room.floor}`}`);
  field('Bunk', `Bunk ${t.bed.bunk_no} - ${t.bed.level === 'lower' ? 'Lower' : 'Upper'}   (${t.bed.label})`);
  if (t.medical && t.medical.length)
    field('Approved medical accommodation', t.medical.join(', '));

  pg.line(40, y + 6, 555, y + 6, 0.8, '3 3');
  y -= 14;
  pg.text(40, y, 'ON ARRIVAL', 9, true, GREEN);
  y -= 16;
  for (const l of [
    'Present this ticket (printed or on your phone) and your NYSC call-up letter at the accommodation desk.',
    'An officer will scan the QR code to confirm your bunk and check you in.',
    'This ticket is valid only for the bunk shown above. Do not share the QR code.',
    'Offline copies show the booking as it was when last verified online; the officer scan is the final check.',
  ]) y = pg.wrap(40, y, '- ' + l, 9, 100, 13, false, DARK);

  pg.line(40, 70, 555, 70, 0.5);
  pg.text(40, 54, `Issued ${t.generated_at.slice(0, 16).replace('T', ' ')} UTC  |  Booking made ${String(t.created_at).slice(0, 16).replace('T', ' ')} UTC`, 8, false, MUTED);
  pg.text(40, 42, 'CampSpace is an accommodation management system. It does not replace official NYSC documents.', 8, false, MUTED);
  return assemble([pg]);
}
