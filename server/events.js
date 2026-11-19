// Server-sent events hub: pushes live bunk availability and notification pings to connected browsers.
const clients = new Set();

export function addClient(res, meta) {
  const c = { res, ...meta };
  clients.add(c);
  res.on('close', () => clients.delete(c));
  return c;
}

export function emit(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (data.user_id && c.user_id !== data.user_id) continue;
    if (data.camp_id && c.camp_id && c.camp_id !== data.camp_id) continue;
    try { c.res.write(payload); } catch { clients.delete(c); }
  }
}

export const clientCount = () => clients.size;

const timer = setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 25000);
timer.unref();
