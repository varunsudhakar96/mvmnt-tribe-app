// Public settings. The publishable key is safe to ship in the browser:
// every table is locked down and members only reach their own data through functions.
export const SUPABASE_URL = 'https://lligzqocyumszoecszyf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_5hlYTUY5FiQEIcoOjaWfMA_BFTY9qho';

// Each member's login uses a private placeholder email built from their phone number.
// Must match EMAIL_DOMAIN in the member-auth edge function.
export const EMAIL_DOMAIN = 'members.mvmnttribe.app';

// WhatsApp number members message when they forget their password (digits only,
// with country code, e.g. '919876543210'). Leave empty to show text only.
export const ADMIN_WHATSAPP = '919150089692';
