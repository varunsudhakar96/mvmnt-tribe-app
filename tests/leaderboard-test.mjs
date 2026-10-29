// Public leaderboard page: loads from Supabase and never renders names as HTML.
import { chromium } from 'playwright';
const FILE = process.argv[2];
const OUT = process.argv[3] || 'screenshots';
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

const runners = [
  { name: 'Asha Kumar', km: 130, runs: 25, badge: 'RANGER' },
  { name: 'Ravi S', km: 52.5, runs: 10, badge: 'STRIDER' },
  { name: '<img src=x onerror="window.__pwned=1">Mallory', km: 30, runs: 6, badge: 'PACER' },
  { name: 'New Runner', km: 5, runs: 1, badge: null },
];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
let hits = 0;
await page.route('https://lligzqocyumszoecszyf.supabase.co/**', (r) => {
  hits++;
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
  check('request sends the publishable key', r.request().headers().apikey?.startsWith('sb_publishable_'));
  r.fulfill({ headers: cors, json: { updated_at: new Date().toISOString(), runners } });
});
await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
await page.goto(`file://${FILE}`);
await page.waitForSelector('.runner-card');
await page.waitForTimeout(800);
await page.screenshot({ path: `${OUT}/lb-1.png`, fullPage: false });
const cards = await page.locator('.runner-card').count();
check('all runners listed from the database (4)', cards === 4);
check('top runner first', (await page.locator('.runner-card').first().innerText()).toLowerCase().includes('asha kumar'));
check('a name containing HTML is shown as text, not run', !(await page.evaluate(() => window.__pwned)) && (await page.locator('.runner-card img').count()) === 0);
check('the odd name is visible as plain text', (await page.locator('.runner-name', { hasText: /mallory/i }).textContent()).includes('<img'));
check('stats total km', (await page.locator('#stat-km').innerText()) === '218');
check('called Supabase once', hits >= 1);
await browser.close();
