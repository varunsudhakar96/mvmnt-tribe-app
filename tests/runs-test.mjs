// Upcoming runs, run page, QR check-in and the admin panel, with Supabase simulated.
// Run `node tests/make-fixtures.mjs tests/fixtures` first (needs ffmpeg).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const OUT = process.argv[2] || 'screenshots';
const FIX = 'tests/fixtures';
const BASE = 'http://localhost:4173';
const SB = 'https://lligzqocyumszoecszyf.supabase.co';
const TODAY_ID = '11111111-1111-4111-8111-111111111111';
const TODAY_CODE = 'a1b2c3d4e5f6';

const ist = (d = 0) => new Date(Date.now() + 5.5 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
const TODAY = ist();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const jwt = (sub) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, aud: 'authenticated', role: 'authenticated', exp: now + 3600 })}.sig`;

const FORM = 'https://docs.google.com/forms/d/e/TESTFORM/viewform?usp=pp_url&entry.111=9999999999&entry.222=NAME';
let runs = [
  { id: TODAY_ID, name: 'Saturday 5K', date: TODAY, time: '06:00', venue: 'Race Course, Coimbatore',
    map_url: 'https://maps.app.goo.gl/test', poster_url: `${SB}/storage/v1/object/public/run-posters/seed.jpg`,
    description: 'Easy 5K loop. Bring water.', signup_url: 'https://forms.gle/signupTEST',
    attend_url: FORM, check_in_code: TODAY_CODE },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Hill Repeats', date: ist(3), time: '05:45', venue: 'Marudhamalai foothills',
    map_url: null, poster_url: null, description: null, signup_url: 'https://forms.gle/hillsTEST', attend_url: FORM, check_in_code: 'ffff00001111' },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Old Run', date: ist(-7), time: '06:00', venue: 'Somewhere',
    map_url: null, poster_url: null, description: null, signup_url: null, attend_url: null, check_in_code: 'eeee00001111' },
];
const pub = (r) => ({ id: r.id, name: r.name, date: r.date, time: r.time, venue: r.venue, map_url: r.map_url,
  poster_url: r.poster_url, description: r.description, signup_url: r.signup_url,
  is_today: r.date === TODAY, is_past: r.date < TODAY, can_attend: !!(r.attend_url && r.check_in_code) });
const adm = (r) => ({ ...pub(r), attend_url: r.attend_url, check_in_code: r.check_in_code });

const users = {
  '9876500009': { name: 'Org Admin', phone: '9876500009', is_admin: true },
  '9876500001': { name: 'Asha Kumar', phone: '+91 98765 00001', is_admin: false },
};
const profile = (p) => ({ ...users[p], total_km: 30, total_runs: 6, badge: 'PACER', rank: 40, runners: 140,
  last_run: ist(-4), next_badge: 'STRIDER', next_badge_km: 50, recent: [{ date: ist(-4), km: 5 }] });

let current = null; const uploads = {}; const opened = []; let attendCalls = 0;
const poster = readFileSync(`${FIX}/poster.jpg`);

async function run(cameraFile, fn) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${cameraFile}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/400|404/.test(m.text())) console.log('CONSOLE', m.text()); });
  await ctx.route('https://docs.google.com/**', (r) => { opened.push(r.request().url()); r.fulfill({ contentType: 'text/html', body: '<h1>FORM</h1>' }); });
  await ctx.route(`${SB}/**`, async (route) => {
    const req = route.request(); const url = req.url();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const body = (() => { try { return req.postDataJSON() ?? {}; } catch { return {}; } })();
    const ok = (json) => route.fulfill({ headers: cors, json });
    const fail = (msg) => route.fulfill({ status: 400, headers: cors, json: { code: 'P0001', message: msg } });
    if (url.includes('/auth/v1/token')) {
      current = body.email.split('@')[0];
      return ok({ access_token: jwt(current), token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'r',
        user: { id: 'u-' + current, aud: 'authenticated', role: 'authenticated', email: body.email } });
    }
    if (url.includes('/functions/v1/member-auth')) return ok({ ok: true, status: 'has_account' });
    const rpc = url.match(/\/rest\/v1\/rpc\/(\w+)/)?.[1];
    const admin = users[current]?.is_admin;
    switch (rpc) {
      case 'my_profile': return ok(profile(current));
      case 'upcoming_runs': return ok(runs.filter((r) => r.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date)).map(pub));
      case 'run_detail': { const r = runs.find((x) => x.id === body.p_id); return ok(r ? pub(r) : null); }
      case 'attend_run': {
        attendCalls++;
        const r = runs.find((x) => x.id === body.p_id);
        if (!r) return fail('run_not_found');
        if (r.date !== TODAY) return fail('not_today');
        if (body.p_code !== r.check_in_code) return fail('wrong_code');
        return ok({ url: r.attend_url, name: users[current].name, phone: users[current].phone.replace(/\D/g, '').slice(-10) });
      }
      case 'admin_list_runs': return admin ? ok([...runs].sort((a, b) => b.date.localeCompare(a.date)).map(adm)) : fail('not_admin');
      case 'admin_save_run': {
        if (!admin) return fail('not_admin');
        const p = body.p;
        if (!p.name) return fail('run_name_required');
        if (!p.date) return fail('date_required');
        if (['map_url', 'signup_url', 'attend_url'].some((k) => p[k] && !/^https?:\/\//.test(p[k]))) return fail('bad_link');
        let r = runs.find((x) => x.id === p.id);
        if (!r) { r = { id: '44444444-4444-4444-8444-' + String(Date.now()).slice(-12), check_in_code: 'c0ffee123456' }; runs.push(r); }
        Object.assign(r, { name: p.name, date: p.date, time: p.time || null, venue: p.venue || null, map_url: p.map_url || null,
          poster_url: p.poster_url || null, description: p.description || null, signup_url: p.signup_url || null, attend_url: p.attend_url || null });
        return ok(adm(r));
      }
      case 'admin_new_qr': { const r = runs.find((x) => x.id === body.p_id); r.check_in_code = 'beef' + r.check_in_code.slice(4); return ok(adm(r)); }
      case 'admin_delete_run': runs = runs.filter((x) => x.id !== body.p_id); return ok({ ok: true });
    }
    const up = url.match(/\/storage\/v1\/object\/run-posters\/(.+)$/);
    if (up && req.method() === 'POST') { uploads[up[1]] = req.postDataBuffer(); return ok({ Key: `run-posters/${up[1]}`, Id: 'x' }); }
    const get = url.match(/\/storage\/v1\/object\/public\/run-posters\/(.+)$/);
    if (get) return route.fulfill({ headers: { ...cors, 'content-type': 'image/jpeg' }, body: poster }); // real uploads are multipart; serve the fixture
    return route.fulfill({ status: 404, headers: cors, json: {} });
  });
  try { await fn(page); } finally { await browser.close(); }
}

const text = async (page) => (await page.locator('main').innerText()).replace(/\s+/g, ' ').toLowerCase();
const check = (label, cond) => console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
const login = async (page, phone) => {
  await page.goto(BASE); await page.waitForSelector('#phone');
  await page.fill('#phone', phone); await page.click('text=Continue');
  await page.waitForSelector('#password'); await page.fill('#password', 'right1');
  await page.click('button:has-text("Log in")'); await page.waitForSelector('.hero-km');
};

// ---- Member: browse, run page, sign up, attend by scanning ----
await run(`${FIX}/qr.y4m`, async (page) => {
  await login(page, '9876500001');
  await page.waitForSelector('.run-card');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/r1-home-upcoming.png`, fullPage: true });
  const t = await text(page);
  check('home lists upcoming runs (2), not past ones', (await page.locator('.run-card').count()) === 2 && !t.includes('old run'));
  check('today run flagged TODAY', (await page.locator('.run-card').first().innerText()).includes('TODAY'));
  check('member sees no Admin link', (await page.locator('a:has-text("Admin")').count()) === 0);

  await page.locator('.run-card', { hasText: 'Hill Repeats' }).click();
  await page.waitForSelector('h1:has-text("Hill Repeats")');
  check('future run: Sign up shown, Attend hidden', (await page.locator('a:has-text("Sign up")').count()) === 1 && (await page.locator('a:has-text("Attend run")').count()) === 0);
  check('future run explains attend unlocks on run day', (await text(page)).includes('unlocks on run day'));
  await page.screenshot({ path: `${OUT}/r2-run-future.png`, fullPage: true });

  await page.click('text=‹ Runs');
  await page.locator('.run-card', { hasText: 'Saturday 5K' }).click();
  await page.waitForSelector('.event-poster');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/r3-run-today.png`, fullPage: false });
  check('today run: Attend run + Sign up + Maps link', (await page.locator('a:has-text("Attend run")').count()) === 1
    && (await page.locator('a:has-text("Sign up")').count()) === 1 && (await page.locator('a:has-text("Open in Maps")').count()) === 1);
  check('sign-up link opens the form', (await page.getAttribute('a:has-text("Sign up")', 'href')) === 'https://forms.gle/signupTEST');

  await page.click('a:has-text("Attend run")');
  await page.waitForURL(/docs\.google\.com/, { timeout: 15000 });
  const formUrl = opened.at(-1) || '';
  check('scanning the venue QR opens the attend form', formUrl.startsWith('https://docs.google.com/forms/d/e/TESTFORM'));
  check('form pre-filled with phone 9876500001', formUrl.includes('entry.111=9876500001'));
  check('form pre-filled with name', formUrl.includes('entry.222=Asha%20Kumar'));

  // Camera-app path: venue QR opened directly
  await page.goto(`${BASE}/#/run/${TODAY_ID}/checkin?c=wrongcode0000`);
  await page.waitForSelector('.error');
  check('wrong QR code is refused', (await text(page)).includes("isn't for this run"));
  await page.goto(`${BASE}/#/run/22222222-2222-4222-8222-222222222222/checkin?c=ffff00001111`);
  await page.waitForSelector('.error');
  check('check-in refused when it is not run day', (await text(page)).includes('day of the run'));
  await page.goto(`${BASE}/#/run/${TODAY_ID}/checkin?c=${TODAY_CODE}`);
  await page.waitForURL(/docs\.google\.com/, { timeout: 15000 });
  check('camera-app path checks in and opens the form', opened.at(-1).includes('entry.111=9876500001'));
});

// ---- Scanning something that is not ours ----
await run(`${FIX}/qr-other.y4m`, async (page) => {
  await login(page, '9876500001');
  await page.goto(`${BASE}/#/run/${TODAY_ID}/scan`);
  await page.waitForSelector('.error', { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/r4-scan-wrong-qr.png`, fullPage: true });
  check('a random QR is rejected with a clear message', (await text(page)).includes("isn't a mvmnt tribe check-in code"));
  await page.goto(`${BASE}/#/admin`);
  await page.waitForSelector('text=Only organisers');
  check('member cannot open the admin panel', true);
});

// ---- Organiser: add a run with poster, QR ----
await run(`${FIX}/qr.y4m`, async (page) => {
  await login(page, '9876500009');
  check('admin sees Admin link', (await page.locator('a:has-text("Admin")').count()) === 1);
  await page.click('a:has-text("Admin")');
  await page.waitForSelector('text=Add a run');
  await page.screenshot({ path: `${OUT}/r5-admin-list.png`, fullPage: true });
  await page.click('text=Add a run');
  await page.waitForSelector('text=New run');
  check('attend form link remembered from last time is empty on first use', (await page.inputValue('input[placeholder^="https://docs"]')) === '');
  await page.click('button:has-text("Publish run")');
  await page.waitForSelector('.error');
  check('publishing without a name is refused', (await text(page)).includes('add the run name'));
  await page.setInputFiles('input[type=file]', `${FIX}/poster.jpg`);
  await page.waitForSelector('.poster-pick img');
  check('poster uploads and previews', Object.keys(uploads).length === 1);
  await page.fill('input[placeholder="Saturday 5K"]', 'Sunday Long Run');
  await page.fill('input[type=date]', ist(5));
  await page.fill('input[type=time]', '05:30');
  await page.fill('input[placeholder^="Race Course"]', 'Codissia Grounds');
  await page.fill('input[placeholder^="https://maps"]', 'maps.app.goo.gl/nohttps');
  await page.click('button:has-text("Publish run")');
  await page.waitForSelector('.error');
  check('link without https is refused', (await text(page)).includes('must start with https://'));
  await page.fill('input[placeholder^="https://maps"]', 'https://maps.app.goo.gl/codissia');
  await page.fill('input[placeholder="https://forms.gle/…"]', 'https://forms.gle/longrunTEST');
  await page.fill('input[placeholder^="https://docs"]', FORM);
  await page.click('button:has-text("Publish run")');
  await page.waitForSelector('img.qr');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/r6-admin-saved-qr.png`, fullPage: true });
  check('run saved and venue QR shown', (await text(page)).includes('saved. members can see it now.'));
  const saved = runs.find((r) => r.name === 'Sunday Long Run');
  check('saved with all fields', saved && saved.venue === 'Codissia Grounds' && saved.time === '05:30' && saved.poster_url?.includes('/run-posters/'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download QR')]);
  check('QR downloads as an image', /mvmnt-qr-.*\.png/.test(dl.suggestedFilename()));
  await page.click('text=Make a new code'); await page.click('text=Yes, make a new code');
  await page.waitForTimeout(300);
  check('new code replaces the old one', saved.check_in_code.startsWith('beef'));

  await page.click('text=‹ Runs');
  await page.waitForSelector('text=Sunday Long Run');
  await page.click('text=Add a run');
  check('attend form link remembered for the next run', (await page.inputValue('input[placeholder^="https://docs"]')) === FORM);
  await page.click('text=‹ Runs');
  await page.click('text=Old Run');
  await page.waitForSelector('text=Delete this run');
  await page.click('text=Delete this run'); await page.click('text=Yes, delete it');
  await page.waitForSelector('text=Add a run');
  check('run deleted', !runs.some((r) => r.name === 'Old Run'));

  await page.click('text=‹ Home');
  await page.waitForSelector('.run-card:has-text("Sunday Long Run")', { timeout: 5000 }).catch(() => {});
  check('new run appears for members on home', (await text(page)).includes('sunday long run'));
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`${BASE}/#/admin/run/${saved.id}`); await page.waitForSelector('img.qr');
  check('admin form fits a 320px phone', await page.evaluate(() => document.documentElement.scrollWidth <= 320));
  await page.goto(`${BASE}/#/run/${TODAY_ID}`); await page.waitForSelector('.event-poster');
  check('run page fits a 320px phone', await page.evaluate(() => document.documentElement.scrollWidth <= 320));
});
console.log('attend calls:', attendCalls);
