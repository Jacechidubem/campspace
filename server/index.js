import path from 'node:path';
import { createApp } from './app.js';
import { seed } from './seed.js';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const port = Number(process.env.PORT || 3000);
const demoMode = process.env.DEMO_MODE !== '0';

const campspace = createApp({
  dataDir,
  demoMode,
  cookieSecure: process.env.COOKIE_SECURE === '1',
  trustProxy: process.env.TRUST_PROXY === '1',
});

// First run in demo mode: create the demonstration data so every portal has something to show.
if (demoMode && !campspace.db.get('SELECT 1 x FROM camps LIMIT 1')) {
  console.log('Empty database: creating demonstration data...');
  await seed(campspace.db, campspace.vault);
}

const actual = await campspace.listen(port);
console.log(`CampSpace is running at http://localhost:${actual}  (demo mode ${demoMode ? 'ON' : 'off'})`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await campspace.close(); process.exit(0); });
}
