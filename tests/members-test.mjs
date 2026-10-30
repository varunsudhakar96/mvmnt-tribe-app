// Admin → Members page with Supabase simulated.
import { chromium } from 'playwright';
const OUT = process.argv[2] || 'screenshots';
const BASE = 'http://localhost:4173';
const SB = 'https://lligzqocyumszoecszyf.supabase.co';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const jwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', exp: now + 3600 })}.sig`;
const day = (d) => new Date(Date.now() - d * 864e5).toISOString();
const data = {
  totals: { accounts: 3, new_7d: 2, active_7d: 3, not_joined: 3, runners: 6 },
  joined: [
    { name: 'Asha Kumar', phone: '9876500001', joined: day(0), last_seen: day(0), km: 52.5, runs: 10 },
    { name: 'Ravi S', phone: '9876500002', joined: day(2), last_seen: day(1), km: 30, runs: 6 },
    { name: 'Org Admin', phone: '9876500009', joined: day(20), last_seen: day(0), km: 10, runs: 2 },
  ],
  not_joined: [
    { name: 'Meena R', phone: '9876500011', km: 130, runs: 25, last_run: day(4).slice(0, 10) },
    { name: 'Karthik', phone: '9876500012', km: 40, runs: 8, last_run: day(11).slice(0, 10) },
    { name: 'Old Timer', phone: '9876500013', km: 15, runs: 3, last_run: day(90).slice(0, 10) },
  ],
  bad_numbers: [{ name: 'Siddharth', phone: 'name:siddharth', km: 5 }],
  same_name: [{ name: 'akash', people: [{ name: 'Akash', phone: '9876500021', km: 55, joined: true }, { name: 'Akash', phone: '987650002', km: 5, joined: false }] }],
};
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
let who = '9876500009';
await page.route(`${SB}/**`, (route) => {
  const req = route.request(); const url = req.url();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const ok = (json) => route.fulfill({ headers: cors, json });
  if (url.includes('/functions/v1/member-auth')) return ok({ ok: true, status: 'has_account', otp: false });
  if (url.includes('/auth/v1/token')) { const body = req.postDataJSON(); who = body.email.split('@')[0];
    return ok({ access_token: jwt(who), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'r', user: { id: 'u-' + who, aud: 'authenticated', role: 'authenticated', email: body.email } }); }
  if (url.includes('/rpc/my_profile')) return ok({ name: who === '9876500009' ? 'Org Admin' : 'Asha', phone: who, is_admin: who === '9876500009', total_km: 10, total_runs: 2, recent: [] });
  if (url.includes('/rpc/admin_members')) return who === '9876500009' ? ok(data) : route.fulfill({ status: 400, headers: cors, json: { message: 'not_admin' } });
  if (url.includes('/rpc/admin_list_runs')) return ok([]);
  if (url.includes('/rpc/upcoming_runs')) return ok([]);
  return route.fulfill({ status: 404, headers: cors, json: {} });
});
const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ').toLowerCase();
await page.goto(`${BASE}/#/login`); await page.waitForSelector('#phone');
await page.fill('#phone', '9876500009'); await page.click('text=Continue');
await page.waitForSelector('#password'); await page.fill('#password', 'x123456'); await page.click('button:has-text("Log in")');
await page.waitForSelector('.avatar-btn[href]');
await page.goto(`${BASE}/#/admin`); await page.waitForSelector('.tabs');
check('admin has Runs and Members tabs', (await page.locator('.tabs a').count()) === 2);
await page.click('.tabs a:has-text("Members")');
await page.waitForSelector('.tiles');
await page.screenshot({ path: `${OUT}/m1-members.png`, fullPage: true });
const t = await text();
check('totals shown (3 accounts of 6 runners, 3 not joined)', t.includes('accounts 3 of 6 runners') && t.includes('not joined yet 3'));
check('not-joined list defaults to recent runners (2 of 3)', (await page.locator('.su-list li').count()) === 2 && !t.includes('old timer'));
check('most recent runner first', (await page.locator('.su-list li').first().innerText()).includes('Meena R'));
await page.click('text=Only people who ran in the last 30 days');
check('untick shows everyone (3)', (await page.locator('.su-list li').count()) === 3);
await page.click('button:has-text("Copy names")');
const clip = await page.evaluate(() => navigator.clipboard.readText());
check('Copy names gives a numbered WhatsApp-ready list', clip.includes('1. Meena R') && clip.includes('3. Old Timer') && !clip.includes('98765'));
await page.click('button:has-text("Copy with numbers")');
check('Copy with numbers includes numbers', (await page.evaluate(() => navigator.clipboard.readText())).includes('Meena R (98765 00011)'));
await page.fill('input[type=search]', 'karth');
check('search filters', (await page.locator('.su-list li').count()) === 1);
await page.fill('input[type=search]', '');
await page.click('.seg button >> text=/^Joined$/');
check('joined list with last opened', (await page.locator('.su-list li').count()) === 3 && (await text()).includes('last opened'));
await page.click('.seg button:has-text("Check")');
await page.screenshot({ path: `${OUT}/m2-checks.png`, fullPage: true });
check('checks show same-name pairs and broken numbers', (await text()).includes('akash') && (await text()).includes('no number · siddharth'));
await page.setViewportSize({ width: 320, height: 640 });
check('fits a 320px phone', await page.evaluate(() => document.documentElement.scrollWidth <= 320));
await browser.close();
