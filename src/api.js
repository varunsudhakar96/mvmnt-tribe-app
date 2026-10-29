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
};
export const messageFor = (code) => MESSAGES[code] ?? MESSAGES.server_error;

class ApiError extends Error {
  constructor(code) { super(code); this.code = code; }
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
  if (!res.ok || body.ok === false) throw new ApiError(body.error ?? 'server_error');
  return body;
}

// 'has_account' | 'member' | 'new'
export async function checkPhone(phone) {
  return (await memberAuth({ action: 'status', phone })).status;
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

export async function getProfile() {
  const { data, error } = await supabase.rpc('my_profile');
  if (error) throw new ApiError(/fetch|network/i.test(error.message) ? 'network' : 'server_error');
  return data;
}
