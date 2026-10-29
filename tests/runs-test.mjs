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
    description: 'Easy 5K loop. Bring water.', signup_enabled: true, signup_fields: [], capacity: null,
    attend_url: FORM, check_in_code: TODAY_CODE },
  { id: '22222222-2222-4222-8222-222222222222', name: 'Hill Repeats', date: ist(3), time: '05:45', venue: 'Marudhamalai foothills',
    map_url: null, poster_url: null, description: null, attend_url: FORM, check_in_code: 'ffff00001111', capacity: 30, signup_enabled: true,
    signup_fields: [{ id: 'f_size', label: 'T-shirt size', type: 'choice', required: true, options: ['S', 'M', 'L'] },
                    { id: 'f_sos', label: 'Emergency contact', type: 'text', required: false, options: [] },
                    { id: 'f_food', label: 'Breakfast after', type: 'checkboxes', required: true, options: ['Idli', 'Pongal', 'Coffee'] }] },
  { id: '55555555-5555-4555-8555-555555555555', name: 'Track Night', date: ist(4), time: '18:30', venue: 'Nehru Stadium',
    map_url: null, poster_url: null, description: null, attend_url: null, check_in_code: 'dddd00001111', capacity: 1, signup_enabled: true, signup_fields: [] },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Old Run', date: ist(-7), time: '06:00', venue: 'Somewhere',
    map_url: null, poster_url: null, description: null, attend_url: null, check_in_code: 'eeee00001111', signup_enabled: true, signup_fields: [], capacity: null },
];
const pub = (r) => ({ id: r.id, name: r.name, date: r.date, time: r.time, venue: r.venue, map_url: r.map_url,
  poster_url: r.poster_url, description: r.description, signup_enabled: r.signup_enabled, signup_fields: r.signup_fields, capacity: r.capacity,
  spots_left: r.capacity == null ? null : Math.max(0, r.capacity - Object.keys(signed).filter((k) => k.startsWith(r.id)).length),
  my_answers: signed[`${r.id}:${current}`] || null, run_km: r.run_km ?? 5,
  my_checkin_km: checkins[`${r.id}:${current}`] ?? null,
  is_today: r.date === TODAY, is_past: r.date < TODAY, can_attend: !!(r.attend_url && r.check_in_code),
  signed_up: !!signed[`${r.id}:${current}`] });
const signed = { '55555555-5555-4555-8555-555555555555:9000000000': {} };
const adm = (r) => ({ ...pub(r), attend_url: r.attend_url, check_in_code: r.check_in_code,
  signups: Object.keys(signed).filter((k) => k.startsWith(r.id)).map((k) => ({ name: users[k.split(':')[1]]?.name || 'Someone', phone: k.split(':')[1], at: new Date().toISOString(), answers: signed[k] })),
  signup_count: Object.keys(signed).filter((k) => k.startsWith(r.id)).length,
  attendees: Object.keys(checkins).filter((k) => k.startsWith(r.id)).map((k) => { const ph = k.split(':')[1]; return { member_id: ph, name: users[ph]?.name, phone: ph, km: checkins[k], by: checkinBy[k] || 'app check-in' }; }) });

const users = {
  '9876500009': { name: 'Org Admin', phone: '9876500009', is_admin: true },
  '9876500001': { name: 'Asha Kumar', phone: '+91 98765 00001', is_admin: false },
};
const totalOf = (p) => (baseKm[p] ?? 0) + Object.entries(checkins).filter(([k]) => k.endsWith(':' + p)).reduce((t, [, v]) => t + v, 0);
const tier = (km) => (km >= 300 ? 'VOYAGER' : km >= 200 ? 'WAYFARER' : km >= 100 ? 'RANGER' : km >= 50 ? 'STRIDER' : km >= 25 ? 'PACER' : null);
const profile = (p) => ({ ...users[p], total_km: totalOf(p), total_runs: 6, badge: tier(totalOf(p)), rank: 40, runners: 140,
  last_run: ist(-4), next_badge: 'STRIDER', next_badge_km: 50, recent: [{ date: ist(-4), km: 5 }] });

let current = null; const uploads = {}; const opened = []; let attendCalls = 0;
const checkins = {}; const checkinBy = {}; const baseKm = { '9876500001': 47, '9876500009': 10 };
const poster = readFileSync(`${FIX}/poster.jpg`);

async function run(cameraFile, fn) {
  current = null;
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
    if (url.includes('/auth/v1/user')) return ok({ id: 'u-' + current, aud: 'authenticated', role: 'authenticated', email: current + '@members.mvmnttribe.app' });
    if (url.includes('/functions/v1/member-auth')) return ok({ ok: true, status: 'has_account' });
    const rpc = url.match(/\/rest\/v1\/rpc\/(\w+)/)?.[1];
    const admin = users[current]?.is_admin;
    switch (rpc) {
      case 'my_profile': return ok(profile(current));
      case 'set_my_avatar': users[current].avatar_url = body.p_url; return ok({ avatar_url: body.p_url });
      case 'upcoming_runs': return ok(runs.filter((r) => r.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date)).map(pub));
      case 'run_detail': { const r = runs.find((x) => x.id === body.p_id); return ok(r ? pub(r) : null); }
      case 'sign_up_for_run': {
        if (!current) return fail('not_logged_in');
        const r = runs.find((x) => x.id === body.p_id);
        for (const f of r.signup_fields) {
          const v = (body.p_answers || {})[f.id];
          if (f.required && f.type !== 'checkboxes' && !v) return fail('answer_required');
          if (v && f.type === 'choice' && !f.options.includes(v)) return fail('answer_bad_choice');
          if (f.type === 'checkboxes' && f.required && !(Array.isArray(v) && v.length)) return fail('answer_required');
          if (f.type === 'checkboxes' && v && !Array.isArray(v)) return fail('answer_bad_choice');
        }
        const key = `${r.id}:${current}`;
        if (!signed[key] && r.capacity != null && pub(r).spots_left <= 0) return fail('run_full');
        signed[key] = body.p_answers || {};
        return ok(pub(r));
      }
      case 'cancel_signup': { const r = runs.find((x) => x.id === body.p_id); delete signed[`${r.id}:${current}`]; return ok(pub(r)); }
      case 'check_in_run': {
        attendCalls++;
        const r = runs.find((x) => x.id === body.p_id);
        if (!current) return fail('not_logged_in');
        if (r.date !== TODAY) return fail('not_today');
        if (body.p_code !== r.check_in_code) return fail('wrong_code');
        if (!(body.p_km >= 0.5 && body.p_km <= 60)) return fail('bad_distance');
        const key = `${r.id}:${current}`; const first = checkins[key] == null;
        const before = totalOf(current) - (checkins[key] ?? 0);
        checkins[key] = body.p_km;
        return ok({ ok: true, run: r.name, km: body.p_km, first_time: first, total_km: totalOf(current), badge_before: tier(before), badge: tier(totalOf(current)), total_runs: 7 });
      }
      case 'admin_add_attendee': {
        const r = runs.find((x) => x.id === body.p_id);
        if (!users[body.p_phone] && !body.p_name) return fail('name_needed');
        if (!users[body.p_phone]) users[body.p_phone] = { name: body.p_name, phone: body.p_phone };
        checkins[`${r.id}:${body.p_phone}`] = body.p_km ?? r.run_km ?? 5; checkinBy[`${r.id}:${body.p_phone}`] = 'admin check-in';
        return ok(adm(r));
      }
      case 'admin_remove_attendee': { const r = runs.find((x) => x.id === body.p_id); delete checkins[`${r.id}:${body.p_member}`]; return ok(adm(r)); }
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
        if ((p.signup_fields || []).some((f) => f.label && f.type === 'choice' && !(f.options || []).filter((o) => o.trim()).length)) return fail('choice_needs_options');
        if (['map_url', 'attend_url'].some((k) => p[k] && !/^https?:\/\//.test(p[k]))) return fail('bad_link');
        let r = runs.find((x) => x.id === p.id);
        if (!r) { r = { id: '44444444-4444-4444-8444-' + String(Date.now()).slice(-12), check_in_code: 'c0ffee123456' }; runs.push(r); }
        Object.assign(r, { name: p.name, date: p.date, time: p.time || null, venue: p.venue || null, map_url: p.map_url || null,
          poster_url: p.poster_url || null, description: p.description || null, run_km: p.run_km ? Number(p.run_km) : 5,
          signup_enabled: p.signup_enabled !== false, capacity: p.capacity ? Number(p.capacity) : null,
          signup_fields: (p.signup_fields || []).filter((f) => f.label?.trim()).map((f) => ({ ...f, options: (f.type === 'choice' || f.type === 'checkboxes') ? f.options.map((o) => o.trim()).filter(Boolean) : [] })) });
        return ok(adm(r));
      }
      case 'admin_new_qr': { const r = runs.find((x) => x.id === body.p_id); r.check_in_code = 'beef' + r.check_in_code.slice(4); return ok(adm(r)); }
      case 'admin_delete_run': runs = runs.filter((x) => x.id !== body.p_id); return ok({ ok: true });
    }
    if (/\/storage\/v1\/object\/avatars\//.test(url) && req.method() === 'POST') return ok({ Key: 'avatars/x' });
    if (/\/storage\/v1\/object\/public\/avatars\//.test(url)) return route.fulfill({ headers: { ...cors, 'content-type': 'image/jpeg' }, body: poster });
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
  await page.goto(`${BASE}/#/login`); await page.waitForSelector('#phone');
  await page.fill('#phone', phone); await page.click('text=Continue');
  await page.waitForSelector('#password'); await page.fill('#password', 'right1');
  await page.click('button:has-text("Log in")'); await page.waitForSelector('.avatar-btn[href]');
};

// ---- Member: browse, run page, sign up, attend by scanning ----
await run(`${FIX}/qr.y4m`, async (page) => {
  await login(page, '9876500001');
  await page.waitForSelector('.run-card');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/r1-home-upcoming.png`, fullPage: true });
  const t = await text(page);
  check('home lists upcoming runs (3), not past ones', (await page.locator('.run-card').count()) === 3 && !t.includes('old run'));
  check('today run flagged TODAY', (await page.locator('.run-card').first().innerText()).includes('TODAY'));
  check('home: profile photo, quote and runs', (await page.locator('.hero-quote').count()) === 1);
  await page.click('.avatar-btn'); await page.waitForSelector('.hero-km');
  check('profile photo opens your runs page', true);
  check('no photo yet: shows initials', (await page.locator('.profile-head .initials').innerText()) === 'AK');
  await page.setInputFiles('.avatar-edit input[type=file]', `${FIX}/poster.jpg`);
  await page.waitForSelector('.profile-head img.avatar');
  check('runner can add a profile photo', (users['9876500001'].avatar_url || '').includes('/avatars/u-9876500001/'));
  await page.screenshot({ path: `${OUT}/p1-metrics-photo.png`, fullPage: false });
  check('member sees no Admin link', (await page.locator('a:has-text("Admin")').count()) === 0);
  await page.click('text=‹ Home'); await page.waitForSelector('.run-card');
  check('home shows the photo in the corner', (await page.locator('.avatar-btn img.avatar').count()) === 1);
  await page.screenshot({ path: `${OUT}/p2-home-logged-in.png`, fullPage: false });

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
  check('Sign up goes to the in-app form', (await page.getAttribute('a:has-text("Sign up")', 'href')) === `#/run/${TODAY_ID}/signup`);

  await page.click('a:has-text("Attend run")');
  await page.waitForSelector('text=How far did you run?', { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/c1-checkin.png`, fullPage: false });
  check('scanning the venue QR opens the in-app check-in', (await text(page)).includes('saturday 5k'));
  check('distance starts at the run distance (5)', (await page.inputValue('input[aria-label="Distance in km"]')) === '5');
  await page.click('button[aria-label="More"]');
  check('stepper adds 0.5 km', (await page.inputValue('input[aria-label="Distance in km"]')) === '5.5');
  await page.fill('input[aria-label="Distance in km"]', '99');
  await page.click('button:has-text("Log my run")');
  check('silly distance refused', (await text(page)).includes('between 0.5 and 60'));
  await page.fill('input[aria-label="Distance in km"]', '5.5');
  await page.click('button:has-text("Log my run")');
  await page.waitForSelector('text=Run logged.');
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `${OUT}/c2-logged-badge.png`, fullPage: false });
  check('run logged with km and new total', (await text(page)).includes('+5.5') && (await text(page)).includes('52.5 km'));
  check('crossing 50 km shows Strider unlocked', (await text(page)).includes('strider unlocked'));
  check('check-in stored straight away', checkins[`${TODAY_ID}:9876500001`] === 5.5);
  await page.click('button:has-text("Done")');
  await page.waitForSelector('.avatar-btn[href]'); await page.click('.avatar-btn');
  await page.waitForSelector('.hero-km');
  await page.waitForTimeout(400);
  check('home total updates immediately (52.5)', (await page.locator('.hero-km').innerText()).includes('52.5'));

  await page.goto(`${BASE}/#/run/${TODAY_ID}`); await page.waitForSelector('.signed-banner');
  check('run page shows "Run logged · 5.5 km"', (await text(page)).includes('run logged · 5.5 km'));
  check('Sign up hidden after checking in; fix-distance option offered', (await page.locator('a:has-text("Sign up")').count()) === 0
    && (await page.locator('a:has-text("Scan again to fix distance")').count()) === 1);

  // Camera-app path: venue QR opened directly
  await page.goto(`${BASE}/#/run/${TODAY_ID}/checkin?c=wrongcode0000`);
  await page.waitForSelector('text=How far did you run?');
  check('fixing distance starts from what they logged', (await page.inputValue('input[aria-label="Distance in km"]')) === '5.5');
  await page.click('button:has-text("Log my run")');
  await page.waitForSelector('.error');
  check('wrong QR code is refused', (await text(page)).includes("isn't for this run"));
  await page.goto(`${BASE}/#/run/22222222-2222-4222-8222-222222222222/checkin?c=ffff00001111`);
  await page.waitForSelector('.error');
  check('check-in refused when it is not run day', (await text(page)).includes('day of the run') && (await page.locator('button:has-text("Log my run")').count()) === 0);
  await page.goto(`${BASE}/#/run/${TODAY_ID}/checkin?c=${TODAY_CODE}`);
  await page.waitForSelector('text=How far did you run?');
  await page.fill('input[aria-label="Distance in km"]', '6');
  await page.click('button:has-text("Log my run")');
  await page.waitForSelector('text=Distance updated.');
  check('re-scan updates distance instead of adding a second run', checkins[`${TODAY_ID}:9876500001`] === 6 && !(await text(page)).includes('unlocked'));
});

// ---- Logged out: view a run, log in to sign up, answer questions, change, cancel ----
await run(`${FIX}/qr.y4m`, async (page) => {
  await page.goto(`${BASE}/#/run/22222222-2222-4222-8222-222222222222`);
  await page.waitForSelector('h1:has-text("Hill Repeats")');
  await page.screenshot({ path: `${OUT}/u1-public-run.png`, fullPage: false });
  check('run page opens without logging in', (await page.locator('#phone').count()) === 0);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  await page.evaluate(() => { delete Navigator.prototype.share; });
  await page.click('button:has-text("Share")');
  await page.waitForSelector('text=Link copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('Share copies the run name and link', clip.includes('Hill Repeats') && clip.includes('#/run/22222222-2222-4222-8222-222222222222'));
  check('logged out: shows spots left', (await text(page)).includes('30 of 30 spots left'));
  check('logged out: tells them they will log in first', (await text(page)).includes("you'll log in with your number first"));
  await page.click('a:has-text("Sign up")');
  await page.waitForSelector('#phone');
  check('Sign up asks them to log in', (await text(page)).includes('log in to sign up for this run'));
  await page.fill('#phone', '9876500001'); await page.click('text=Continue');
  await page.waitForSelector('#password'); await page.fill('#password', 'right1');
  await page.click('button:has-text("Log in")');
  await page.waitForSelector('text=Signing up as');
  check('after login they land on the sign-up form', (await text(page)).includes('asha kumar') && (await text(page)).includes('98765 00001'));
  await page.click('button:has-text("Confirm sign-up")');
  check('required question enforced', (await text(page)).includes('answer the questions marked'));
  await page.screenshot({ path: `${OUT}/u2-form-required.png`, fullPage: false });
  await page.click('label.option:has-text("M")');
  await page.fill('#q-f_sos', 'Mum 98400 00000');
  await page.click('button:has-text("Confirm sign-up")');
  check('required checkbox question enforced', (await text(page)).includes('tick at least one'));
  await page.click('label.option.box:has-text("Coffee")');
  await page.click('label.option.box:has-text("Idli")');
  await page.click('label.option.box:has-text("Pongal")');
  await page.click('label.option.box:has-text("Pongal")');
  await page.screenshot({ path: `${OUT}/u3-form-filled.png`, fullPage: false });
  await page.click('button:has-text("Confirm sign-up")');
  await page.waitForSelector("text=You're in.");
  check('confirmation screen after signing up', (await text(page)).includes('signed up for hill repeats'));
  check('answers saved', signed['22222222-2222-4222-8222-222222222222:9876500001']?.f_size === 'M' && signed['22222222-2222-4222-8222-222222222222:9876500001']?.f_sos === 'Mum 98400 00000');
  check('checkboxes saved as a list in option order (Idli, Coffee)', JSON.stringify(signed['22222222-2222-4222-8222-222222222222:9876500001']?.f_food) === '["Idli","Coffee"]');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/u4-confirmation.png`, fullPage: false });
  await page.click('button:has-text("Done")');
  await page.waitForSelector('.signed-banner');
  await page.screenshot({ path: `${OUT}/u5-signed-up.png`, fullPage: true });
  check('signed-up page lists ticked boxes', (await text(page)).includes('idli, coffee'));
  check('run page shows "You\'re signed up" with their answers', (await text(page)).includes("you're signed up") && (await text(page)).includes('t-shirt size'));
  check('Attend run shown but greyed out', await page.locator('button:has-text("Attend run")').isDisabled());
  check('subtext: activates on run day, scan the QR', (await text(page)).includes('activates on the day of the run. scan the qr at the start line'));
  check('Sign up button gone once signed up', (await page.locator('a:has-text("Sign up")').count()) === 0);

  await page.click('text=Change answers');
  await page.waitForSelector('text=Your answers');
  check('change answers: form remembers M', await page.locator('label.option.on:has-text("M")').count() === 1);
  check('change answers: ticked boxes remembered', (await page.locator('label.option.box.on').count()) === 2);
  await page.click('label.option:has-text("L")'); await page.click('button:has-text("Save answers")');
  await page.waitForSelector("text=You're in."); await page.click('button:has-text("Done")');
  check('answer updated to L', signed['22222222-2222-4222-8222-222222222222:9876500001'].f_size === 'L');

  await page.waitForSelector('.signed-banner');
  await page.click("text=Can't make it?"); await page.click('text=Yes, cancel my sign-up');
  await page.waitForSelector('a:has-text("Sign up")');
  check('cancel removes the sign-up', !signed['22222222-2222-4222-8222-222222222222:9876500001']);
  await page.click('a:has-text("Sign up")'); await page.waitForSelector('text=Signing up as');
  await page.click('label.option:has-text("L")'); await page.click('label.option.box:has-text("Pongal")');
  await page.click('button:has-text("Confirm sign-up")');
  await page.waitForSelector("text=You're in."); await page.click('button:has-text("Done")');

  await page.click('text=‹ Runs'); await page.waitForSelector('.run-card');
  check('home card shows Signed up', (await page.locator('.run-card', { hasText: 'Hill Repeats' }).innerText()).includes('Signed up'));
  await page.goto(`${BASE}/#/run/55555555-5555-4555-8555-555555555555`); await page.waitForSelector('h1');
  check('full run: Sign up replaced by "Run is full"', await page.locator('button:has-text("Run is full")').isDisabled());
  await page.goto(`${BASE}/#/run/22222222-2222-4222-8222-222222222222`); await page.waitForSelector('.signed-banner');
  await page.click('text=Log out').catch(() => {});
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
  await page.click('.avatar-btn'); await page.waitForSelector('.hero-km');
  check('admin sees Admin link', (await page.locator('a:has-text("Admin")').count()) === 1);
  await page.click('a:has-text("Admin")');
  await page.waitForSelector('text=Add a run');
  await page.screenshot({ path: `${OUT}/r5-admin-list.png`, fullPage: true });
  await page.click('text=Add a run');
  await page.waitForSelector('text=New run');
  check('distance defaults to 5 km', (await page.inputValue('input[placeholder="5"]')) === '5');
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
  await page.fill('input[placeholder="No limit"]', '50');
  await page.click('text=+ Add a question');
  await page.fill('input[aria-label="Question 1"]', 'T-shirt size');
  await page.selectOption('select[aria-label="Answer type"]', 'choice');
  await page.click('button:has-text("Publish run")');
  await page.waitForSelector('.error');
  check('multiple choice without options is refused', (await text(page)).includes('add at least one option'));
  await page.fill('textarea[placeholder^="S"]', 'S\nM\nL\n');
  await page.locator('.q-card .check input').check();
  await page.click('text=+ Add a question');
  await page.fill('input[aria-label="Question 2"]', 'Pace group');
  await page.click('text=+ Add a question');
  await page.fill('input[aria-label="Question 3"]', 'Bringing');
  await page.locator('select[aria-label="Answer type"]').nth(2).selectOption('checkboxes');
  await page.locator('textarea[placeholder^="S"]').nth(1).fill('Water\nTowel\nFriend');
  await page.screenshot({ path: `${OUT}/a1-form-builder.png`, fullPage: true });
  await page.fill('input[placeholder="5"]', '10');
  await page.click('button:has-text("Publish run")');
  await page.waitForSelector('img.qr');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/r6-admin-saved-qr.png`, fullPage: true });
  check('admin edit page lists sign-ups section', (await text(page)).includes('signed up ·'));
  check('run saved and venue QR shown', (await text(page)).includes('saved. members can see it now.'));
  const saved = runs.find((r) => r.name === 'Sunday Long Run');
  check('saved with all fields', saved && saved.venue === 'Codissia Grounds' && saved.time === '05:30' && saved.poster_url?.includes('/run-posters/'));
  check('questions saved (choice S/M/L required + short answer), spots 50',
    saved.capacity === 50 && saved.signup_fields.length === 3 && saved.signup_fields[2].type === 'checkboxes' && saved.signup_fields[2].options.join() === 'Water,Towel,Friend' && saved.signup_fields[0].required && saved.signup_fields[0].options.join() === 'S,M,L');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download QR')]);
  check('QR downloads as an image', /mvmnt-qr-.*\.png/.test(dl.suggestedFilename()));
  await page.click('text=Make a new code'); await page.click('text=Yes, make a new code');
  await page.waitForTimeout(300);
  check('new code replaces the old one', saved.check_in_code.startsWith('beef'));

  await page.click('text=‹ Runs');
  await page.waitForSelector('text=Sunday Long Run');
  await page.click('text=Add a run');
  check('distance remembered for the next run (10)', (await page.inputValue('input[placeholder="5"]')) === '10');
  check('questions carried over to the next new run', (await page.inputValue('input[aria-label="Question 1"]')) === 'T-shirt size');
  await page.click('text=‹ Runs');
  await page.click('text=Hill Repeats');
  await page.waitForSelector('.su-list');
  await page.screenshot({ path: `${OUT}/a2-signups.png`, fullPage: true });
  await page.click('text=+ Add someone who couldn\'t scan');
  await page.fill('input[placeholder="98765 43210"]', '9123456789');
  await page.click('button:has-text("Add to this run")');
  await page.waitForSelector('text=Their name');
  check('unknown number asks for a name', (await text(page)).includes("isn't in the tribe yet"));
  await page.fill('.add-att input:not([type=tel]):not([inputmode])', 'Walk Up');
  await page.click('button:has-text("Add to this run")');
  await page.waitForSelector('text=Walk Up');
  check('organiser can add someone who could not scan', checkins['22222222-2222-4222-8222-222222222222:9123456789'] === 5);
  await page.click('button[aria-label="Remove Walk Up"]');
  await page.waitForTimeout(400);
  check('organiser can remove a check-in', checkins['22222222-2222-4222-8222-222222222222:9123456789'] == null);
  check('admin sees who signed up with answers', (await text(page)).includes('asha kumar') && (await text(page)).includes('t-shirt size: l'));
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('text=Download list (CSV)')]);
  const csvText = readFileSync(await csv.path(), 'utf8');
  check('CSV has name, number and answers', csvText.includes('"Asha Kumar","9876500001"') && csvText.includes('"T-shirt size"') && csvText.includes('"L"'));
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
