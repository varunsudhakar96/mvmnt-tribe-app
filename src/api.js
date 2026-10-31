import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, EMAIL_DOMAIN } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Indian mobile numbers: accept +91, a leading 0 and spaces; return 10 digits or null.
export function normalisePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

export const formatPhone = (digits) =>
  digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5, 10)}` : digits;

const MESSAGES = {
  invalid_phone: 'Enter a 10-digit mobile number.',
  name_required: 'Add your name so the Tribe knows who you are.',
  password_too_short: 'Use at least 6 characters.',
  password_too_long: 'Keep it under 72 characters.',
  weak_password: 'Choose a stronger password.',
  has_account: 'This number already has an account. Log in with your password.',
  invalid_credentials: "That password isn't right. Try again, or tap Forgot password.",
  network: "Couldn't reach Mvmnt Tribe. Check your connection and try again.",
  server_error: 'Something went wrong on our side. Try again in a minute.',
  // WhatsApp codes
  code_required: 'Confirm your number with a WhatsApp code first.',
  otp_not_ready: "WhatsApp codes aren't switched on yet. Use your password.",
  wait_before_resend: 'Give it a few seconds before asking for another code.',
  too_many_codes: 'Too many codes asked for this number. Try again in an hour.',
  send_failed: "We couldn't send the code on WhatsApp. Try again in a minute.",
  wrong_otp: "That code isn't right. Check WhatsApp and try again.",
  code_expired: 'That code has expired. Ask for a new one.',
  too_many_attempts: 'Too many wrong tries. Ask for a new code.',
  no_account: "This number doesn't have an account yet. Create one first.",
  // runs
  run_not_found: 'This event is no longer listed.',
  not_today: 'Check-in opens on the day of the run.',
  wrong_code: "This QR code isn't for this run. Scan the code at the start line.",
  no_form: "Check-in isn't set up for this run yet. Let the organiser know.",
  not_qr: "That isn't a Mvmnt Tribe check-in code. Scan the QR at the start line.",
  camera_denied: 'Camera access is blocked. Allow the camera for this site in your browser settings, or scan the venue QR with your phone camera app.',
  camera_unavailable: "This browser can't open the camera. Scan the venue QR with your phone camera app instead.",
  // admin
  not_admin: 'Only organisers can do this.',
  run_name_required: 'Add the run name.',
  date_required: 'Pick the run date.',
  bad_link: 'Links must start with https://',
  upload_failed: "The poster didn't upload. Try a smaller image or try again.",
  // sign-ups
  not_logged_in: 'Log in first.',
  run_over: 'This run has finished.',
  signups_closed: 'Sign-ups are closed for this run.',
  answer_required: 'Answer the questions marked *.',
  answer_too_long: 'One of your answers is too long.',
  answer_not_number: 'Enter a number where it asks for one.',
  answer_bad_choice: 'Pick one of the options given.',
  run_full: 'This run is full.',
  bad_upi: 'That UPI ID looks wrong. It should look like name@okhdfc.',
  bad_distance: 'Enter a distance between 0.5 and 60 km.',
  name_needed: "That number isn't in the Tribe yet. Add their name too.",
  choice_needs_options: 'Add at least one option to every multiple-choice question.',
  // programs, badges, ending
  event_ended: 'This has ended. Check-in is closed.',
  program_not_started: "This program hasn't started yet. Check in from the first class.",
  classes_required: 'Enter how many classes the program has (1 to 100).',
  bad_class_date: 'Pick a class date between the start date and today.',
  badge_not_found: 'That badge no longer exists. Pick another.',
  badge_name_required: 'Give the badge a name.',
  badge_name_too_long: 'Keep the badge name under 60 characters.',
  badge_image_required: 'Add an image for the badge.',
};
export const messageFor = (code) => MESSAGES[code] ?? MESSAGES.server_error;

class ApiError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; Object.assign(this, extra); }
}

async function memberAuth(payload) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/member-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new ApiError('network');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new ApiError(body.error ?? 'server_error', { triesLeft: body.tries_left });
  return body;
}

// status: 'has_account' | 'member' | 'new'; otp: WhatsApp codes are switched on
export async function checkPhone(phone) {
  const r = await memberAuth({ action: 'status', phone });
  return { status: r.status, otp: Boolean(r.otp) };
}

// ---- WhatsApp codes ----
export async function sendCode(phone, purpose) {
  return (await memberAuth({ action: 'send_code', phone, purpose })).sent_to;
}

// signup: creates the account; reset: sets a new password; login: no password needed.
export async function verifyCode({ phone, purpose, code, password, name }) {
  let r;
  try {
    r = await memberAuth({ action: 'verify_code', phone, purpose, code, password, name });
  } catch (e) {
    if (e.code === 'wrong_code') throw new ApiError('wrong_otp', { triesLeft: e.triesLeft });
    throw e;
  }
  if (purpose === 'login') {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: r.token_hash, type: 'magiclink' });
    if (error) throw new ApiError('code_expired');
    return data.session;
  }
  return logIn({ phone, password });
}

export async function createAccount({ phone, password, name }) {
  await memberAuth({ action: 'signup', phone, password, name });
  return logIn({ phone, password });
}

export async function logIn({ phone, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: `${phone}@${EMAIL_DOMAIN}`,
    password,
  });
  if (error) {
    if (error.status === 400 || /invalid/i.test(error.message)) throw new ApiError('invalid_credentials');
    if (!error.status || /fetch|network/i.test(error.message)) throw new ApiError('network');
    throw new ApiError('server_error');
  }
  return data.session;
}

export async function logOut() {
  await supabase.auth.signOut();
}

async function rpc(fn, args) {
  let res;
  try {
    res = await supabase.rpc(fn, args);
  } catch {
    throw new ApiError('network');
  }
  const { data, error } = res;
  if (error) {
    const msg = String(error.message || '');
    if (/^[a-z_]+$/.test(msg) && MESSAGES[msg]) throw new ApiError(msg);
    throw new ApiError(/fetch|network/i.test(msg) ? 'network' : 'server_error');
  }
  return data;
}

export const getProfile = () => rpc('my_profile');

// ---- Runs ----
export const upcomingRuns = () => rpc('upcoming_runs');
export const pastEvents = () => rpc('past_events');
export const runDetail = (id) => rpc('run_detail', { p_id: id });
export const attendRun = (id, code) => rpc('attend_run', { p_id: id, p_code: code });
export const signUp = (id, answers) => rpc('sign_up_for_run', { p_id: id, p_answers: answers });
export const cancelSignup = (id) => rpc('cancel_signup', { p_id: id });
export const claimPayment = (id) => rpc('claim_payment', { p_id: id });
export const checkInRun = (id, code, km) => rpc('check_in_run', { p_id: id, p_code: code, p_km: km });

// Google Forms pre-fill: in the form's "Get pre-filled link", type 9999999999 in the phone
// question and NAME in the name question. We swap in the runner's own details.
export function prefill(url, { name, phone } = {}) {
  if (!url) return url;
  let u = url;
  if (phone) u = u.replace(/9999999999/g, phone);
  if (name) u = u.replace(/=NAME(?=&|#|$)/g, `=${encodeURIComponent(name)}`);
  return u;
}

// A venue QR is a link back into this app: <site>/#/run/<id>/checkin?c=<code>
export function checkinLink(id, code) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#/run/${id}/checkin?c=${code}`;
}

export function readScan(text) {
  const t = String(text || '').trim();
  const m = t.match(/#\/run\/([0-9a-f-]{36})\/checkin\?c=([0-9a-z]+)/i);
  if (m) return { kind: 'checkin', id: m[1], code: m[2] };
  if (/^https:\/\/(docs\.google\.com\/forms\/|forms\.gle\/)/i.test(t)) return { kind: 'form', url: t };
  return { kind: 'unknown' };
}

// ---- Admin ----
export const adminListRuns = () => rpc('admin_list_runs');
export const adminMembers = () => rpc('admin_members');
export const adminSetPayment = (id, memberId, status) => rpc('admin_set_payment', { p_id: id, p_member: memberId, p_status: status });
export const adminSaveRun = (run) => rpc('admin_save_run', { p: run });
export const adminDeleteRun = (id) => rpc('admin_delete_run', { p_id: id });
export const adminNewQr = (id) => rpc('admin_new_qr', { p_id: id });
export const adminAddAttendee = (id, phone, km, name, date) => rpc('admin_add_attendee', { p_id: id, p_phone: phone, p_km: km, p_name: name || null, p_date: date || null });
export const adminRemoveAttendee = (id, memberId, date) => rpc('admin_remove_attendee', { p_id: id, p_member: memberId, p_date: date || null });
export const adminEndEvent = (id, end = true) => rpc('admin_end_event', { p_id: id, p_end: end });
export const adminListBadges = () => rpc('admin_list_badges');
export const adminSaveBadge = (b) => rpc('admin_save_badge', { p: b });

// Shrink big phone photos before upload (max 1600px, JPEG).
async function shrink(file, max = 1600, type = 'image/jpeg') {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, type, 0.85));
    return blob || file;
  } catch {
    return file;
  }
}

// Badges keep their transparent background, so they stay PNG.
export const uploadBadgeImage = (file) => uploadPoster(file, 600, 'image/png');

export async function uploadPoster(file, max = 1600, as = 'image/jpeg') {
  const blob = await shrink(file, max, as);
  const type = blob.type || 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage
    .from('run-posters')
    .upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });
  if (error) throw new ApiError('upload_failed');
  return supabase.storage.from('run-posters').getPublicUrl(path).data.publicUrl;
}

// ---- Profile photo ----
export async function uploadAvatar(file) {
  const { data } = await supabase.auth.getUser();
  const uid = data?.user?.id;
  if (!uid) throw new ApiError('not_logged_in');
  const blob = await shrink(file, 512);
  const path = `${uid}/${Date.now()}.jpg`;
  const { error } = await supabase.storage.from('avatars')
    .upload(path, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw new ApiError('upload_failed');
  const url = supabase.storage.from('avatars').getPublicUrl(path).data.publicUrl;
  await rpc('set_my_avatar', { p_url: url });
  return url;
}

// ---- Share a run ----
export async function shareRun(run) {
  const url = `${window.location.origin}${window.location.pathname}#/run/${run.id}`;
  const when = [runDate(run.date, { weekday: 'short', day: 'numeric', month: 'short' }), runTime(run.time)].filter(Boolean).join(', ');
  const text = `${run.name}${when ? ` · ${when}` : ''}${run.venue ? ` · ${run.venue}` : ''}. Sign up on the Mvmnt Tribe app:`;
  if (navigator.share) {
    try { await navigator.share({ title: run.name, text, url }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  try { await navigator.clipboard.writeText(`${text} ${url}`); return 'copied'; }
  catch { window.prompt('Copy this link', url); return 'copied'; }
}

// ---- Formatting ----
export const runDate = (iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', opts) : '';

export function runTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${ap}`;
}
