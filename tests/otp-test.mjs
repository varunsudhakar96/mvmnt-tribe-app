// WhatsApp code flows (sign-up, code login, reset) with Supabase simulated and codes switched on.
import { chromium } from 'playwright';
const OUT = process.argv[2] || 'screenshots';
const BASE = 'http://localhost:4173';
const SB = 'https://lligzqocyumszoecszyf.supabase.co';
const CODE = '246810';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const jwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', exp: now + 3600 })}.sig`;
const session = (phone) => ({ access_token: jwt(phone), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'r',
  user: { id: 'u-' + phone, aud: 'authenticated', role: 'authenticated', email: `${phone}@members.mvmnttribe.app` } });

const accounts = { '9876500001': { pw: 'oldpass1', name: 'Asha Kumar' }, '9000000001': null };
const sent = []; const calls = []; let current = null; let tries = 0;
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.route(`${SB}/**`, async (route) => {
  const req = route.request(); const url = req.url();
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const body = (() => { try { return req.postDataJSON() ?? {}; } catch { return {}; } })();
  const ok = (json) => route.fulfill({ headers: cors, json });
  const bad = (error, status = 400, extra = {}) => route.fulfill({ status, headers: cors, json: { ok: false, error, ...extra } });
  if (url.includes('/functions/v1/member-auth')) {
    calls.push(`${body.action}:${body.purpose ?? ''}`);
    const has = Boolean(accounts[body.phone]);
    if (body.action === 'status') return ok({ ok: true, status: has ? 'has_account' : 'new', otp: true });
    if (body.action === 'signup') return bad('code_required');
    if (body.action === 'send_code') { sent.push(`${body.phone}:${body.purpose}`); tries = 0; return ok({ ok: true, sent_to: body.phone }); }
    if (body.action === 'verify_code') {
      if (body.code !== CODE) { tries++; return tries >= 5 ? bad('too_many_attempts', 400, { tries_left: 0 }) : bad('wrong_code', 400, { tries_left: 5 - tries }); }
      if (body.purpose === 'signup') { accounts[body.phone] = { pw: body.password, name: body.name }; return ok({ ok: true }); }
      if (body.purpose === 'reset') { accounts[body.phone].pw = body.password; return ok({ ok: true }); }
      if (body.purpose === 'login') return ok({ ok: true, token_hash: 'th-' + body.phone });
    }
  }
  if (url.includes('/auth/v1/verify')) { current = body.token_hash.slice(3); return ok(session(current)); }
  if (url.includes('/auth/v1/token')) {
    const phone = body.email.split('@')[0];
    if (accounts[phone]?.pw !== body.password) return route.fulfill({ status: 400, headers: cors, json: { error_code: 'invalid_credentials', msg: 'Invalid login credentials' } });
    current = phone; return ok(session(phone));
  }
  if (url.includes('/rpc/my_profile')) return ok({ name: accounts[current]?.name, phone: current, total_km: 0, total_runs: 0, badge: null, rank: null, runners: 140, next_badge: 'PACER', next_badge_km: 25, recent: [] });
  if (url.includes('/rpc/upcoming_runs')) return ok([]);
  if (url.includes('/auth/v1/logout')) { current = null; return route.fulfill({ status: 204, headers: cors }); }
  return route.fulfill({ status: 404, headers: cors, json: {} });
});
const text = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ').toLowerCase();
const loggedIn = async () => page.waitForSelector('.avatar-btn[href], .hero-km', { timeout: 8000 }).then(() => true).catch(() => false);
const logout = async () => {
  if (!(await page.locator('.hero-km').count())) await page.click('.avatar-btn');
  await page.click('text=Log out'); await page.waitForSelector('#phone');
};

// 1. New runner: details → code → account
await page.goto(`${BASE}/#/login`); await page.waitForSelector('#phone');
await page.fill('#phone', '9000000001'); await page.click('text=Continue');
await page.waitForSelector('#name');
check('sign-up button says it sends a WhatsApp code', (await text()).includes('send whatsapp code'));
await page.fill('#name', 'New Runner'); await page.fill('#new-password', 'secret1'); await page.fill('#confirm-password', 'secret1');
await page.click('button:has-text("Send WhatsApp code")');
await page.waitForSelector('#otp');
await page.screenshot({ path: `${OUT}/o1-code.png`, fullPage: false });
check('code sent for sign-up', sent.includes('9000000001:signup'));
check('resend waits 30 seconds', await page.locator('button:has-text("Resend code in")').isDisabled());
await page.fill('#otp', '111111'); await page.click('button:has-text("Confirm and create account")');
await page.waitForSelector('.error');
check('wrong code: clear message', (await text()).includes("that code isn't right"));
check('wrong code clears the box', (await page.inputValue('#otp')) === '');
await page.fill('#otp', CODE); await page.click('button:has-text("Confirm and create account")');
check('right code creates the account and logs in', await loggedIn());
check('account created with the password they chose', accounts['9000000001']?.pw === 'secret1' && accounts['9000000001']?.name === 'New Runner');

// 2. Existing runner logs in with a code, no password
await logout();
await page.fill('#phone', '9876500001'); await page.click('text=Continue');
await page.waitForSelector('#password');
await page.screenshot({ path: `${OUT}/o2-password-or-code.png`, fullPage: false });
check('password screen offers a WhatsApp code', (await page.locator('button:has-text("Send me a WhatsApp code")').count()) === 1);
check('old "message the team" reset is replaced', (await text()).includes('reset it with a code'));
await page.click('button:has-text("Send me a WhatsApp code")');
await page.waitForSelector('#otp');
await page.fill('#otp', CODE); await page.click('button[type=submit]:has-text("Log in")');
check('code login works without a password', await loggedIn());

// 3. Forgot password: code + new password
await logout();
await page.fill('#phone', '9876500001'); await page.click('text=Continue');
await page.waitForSelector('#password');
await page.click('text=Forgot password? Reset it with a code');
await page.waitForSelector('#reset-password');
await page.screenshot({ path: `${OUT}/o3-reset.png`, fullPage: false });
await page.fill('#otp', CODE); await page.fill('#reset-password', 'brandnew1'); await page.fill('#reset-confirm', 'brandnew2');
await page.click('button:has-text("Set new password")');
check('reset: mismatched passwords caught', (await text()).includes("don't match"));
await page.fill('#reset-confirm', 'brandnew1'); await page.click('button:has-text("Set new password")');
check('reset sets the new password and logs in', await loggedIn() && accounts['9876500001'].pw === 'brandnew1');

// 4. Five wrong codes
await logout();
await page.fill('#phone', '9876500001'); await page.click('text=Continue');
await page.waitForSelector('#password'); await page.click('button:has-text("Send me a WhatsApp code")'); await page.waitForSelector('#otp');
for (let i = 0; i < 5; i++) { await page.fill('#otp', '000000'); await page.click('button[type=submit]'); await page.waitForSelector('.error'); }
check('after 5 wrong codes: ask for a new one', (await text()).includes('too many wrong tries'));
await page.setViewportSize({ width: 320, height: 640 });
check('code screen fits a 320px phone', await page.evaluate(() => document.documentElement.scrollWidth <= 320));
console.log('calls:', calls.join(', '));
await browser.close();
