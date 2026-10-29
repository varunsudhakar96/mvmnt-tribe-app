// UI flow test with Supabase responses simulated (the sandbox can't reach Supabase).
import { chromium } from 'playwright';
const OUT = process.argv[2];
const BASE = 'http://localhost:4173';
const SB = 'https://lligzqocyumszoecszyf.supabase.co';

const accounts = { '9876500001': 'member', '9876500002': 'has_account', '9000000001': 'new' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const jwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', exp: now + 3600 })}.sig`;
const profiles = {
  '9876500001': { name: 'Asha', phone: '9876500001', total_km: 70.56, total_runs: 11, badge: 'STRIDER', rank: 9, runners: 140,
    last_run: '2026-10-25', next_badge: 'RANGER', next_badge_km: 100,
    recent: [{ date: '2026-10-25', km: 5 }, { date: '2026-10-17', km: 10.5 }, { date: '2026-10-10', km: 5 }] },
  '9876500002': { name: 'Ravi', phone: '9876500002', total_km: 10.06, total_runs: 2, badge: null, rank: 98, runners: 140,
    last_run: '2026-06-27', next_badge: 'PACER', next_badge_km: 25, recent: [{ date: '2026-06-27', km: 5.06 }] },
  '9000000001': { name: 'New Runner', phone: '9000000001', total_km: 0, total_runs: 0, badge: null, rank: null, runners: 140,
    last_run: null, next_badge: 'PACER', next_badge_km: 25, recent: [] },
};
let current = null; const calls = [];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

await page.route(`${SB}/**`, async (route) => {
  const req = route.request(); const url = req.url(); const body = req.postDataJSON?.() ?? {};
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  if (url.includes('/functions/v1/member-auth')) {
    calls.push(body.action + ':' + body.phone);
    const st = accounts[body.phone];
    if (body.action === 'status') return route.fulfill({ headers: cors, json: { ok: true, status: st } });
    if (body.action === 'signup') { accounts[body.phone] = 'has_account'; return route.fulfill({ headers: cors, json: { ok: true } }); }
  }
  if (url.includes('/auth/v1/token')) {
    const phone = body.email.split('@')[0];
    if (body.password !== 'right1') return route.fulfill({ status: 400, headers: cors, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } });
    current = phone;
    return route.fulfill({ headers: cors, json: { access_token: jwt(phone), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
      refresh_token: 'r', user: { id: 'u-' + phone, aud: 'authenticated', role: 'authenticated', email: body.email } } });
  }
  if (url.includes('/rest/v1/rpc/my_profile')) return route.fulfill({ headers: cors, json: profiles[current] });
  if (url.includes('/auth/v1/logout')) { current = null; return route.fulfill({ status: 204, headers: cors }); }
  return route.fulfill({ status: 404, headers: cors, json: {} });
});

const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png`, fullPage: true });
const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

await page.goto(BASE); await page.waitForSelector('#phone');
await shot('1-phone');
check('Continue disabled before a full number', await page.locator('button[type=submit]').isDisabled());
await page.fill('#phone', '+91 98765 00001');
check('pasted +91 number formats as "98765 00001"', (await page.inputValue('#phone')) === '98765 00001');
await page.click('text=Continue');
await page.waitForSelector('text=already here');
await shot('2-create-existing-member');
check('existing member: no name field', (await page.locator('#name').count()) === 0);
await page.fill('#new-password', 'right1'); await page.fill('#confirm-password', 'right2');
await page.click('text=Create account');
check('mismatched passwords rejected', (await text()).includes("don't match"));
await page.fill('#confirm-password', 'right1'); await page.click('text=Create account');
await page.waitForSelector('.hero-km');
await page.waitForTimeout(900);
await shot('3-home-strider');
const t3 = await text();
check('home shows 70.56 km', t3.includes('70.56'));
check('home shows rank #9 of 140', t3.includes('#9 of 140'));
check('home shows distance to Ranger', t3.includes('29.44 km to Ranger'));

await page.click('text=Log out'); await page.waitForSelector('#phone');
check('log out returns to phone screen', true);
await page.fill('#phone', '9876500002'); await page.click('text=Continue');
await page.waitForSelector('text=Welcome back');
await page.fill('#password', 'nope12'); await page.click('button:has-text("Log in")');
await page.waitForSelector('.error');
check('wrong password shows error', (await text()).includes("isn't right"));
await page.click('text=Forgot password?');
await shot('4-login-wrong-password-forgot');
check('forgot password explains reset', (await text()).includes('reset it'));
await page.fill('#password', 'right1'); await page.click('button:has-text("Log in")');
await page.waitForSelector('.hero-km'); await page.waitForTimeout(900);
await shot('5-home-no-badge');
check('no-badge member sees Pacer target', (await text()).includes('14.94 km to Pacer'));

await page.reload(); await page.waitForSelector('.hero-km');
check('session survives a page reload', true);

await page.click('text=Log out'); await page.waitForSelector('#phone');
await page.fill('#phone', '9000000001'); await page.click('text=Continue');
await page.waitForSelector('#name');
await page.fill('#new-password', 'right1'); await page.fill('#confirm-password', 'right1');
await page.click('text=Create account');
check('new member must give a name', (await text()).includes('Add your name'));
await shot('6-create-new');
await page.fill('#name', 'New Runner'); await page.click('text=Create account');
await page.waitForSelector('.hero-km'); await page.waitForTimeout(900);
await shot('7-home-new');
check('new member sees empty-state copy', (await text()).includes('No runs logged yet'));

await page.setViewportSize({ width: 320, height: 640 });
check('no horizontal scroll at 320px', await page.evaluate(() => document.documentElement.scrollWidth <= 320));
console.log('calls:', calls.join(', '));
await browser.close();
