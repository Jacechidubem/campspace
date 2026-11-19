// Room/bunk generation shared by the admin API and the demo seed.
export function makeBeds(db, roomId, roomNumber, capacity) {
  const bunks = Math.floor(capacity / 2);
  for (let n = 1; n <= bunks; n++)
    for (const level of ['lower', 'upper'])
      db.run('INSERT INTO beds(room_id,bunk_no,level,label) VALUES (?,?,?,?)', roomId, n, level,
        `${roomNumber}-B${String(n).padStart(2, '0')}${level === 'lower' ? 'L' : 'U'}`);
}
