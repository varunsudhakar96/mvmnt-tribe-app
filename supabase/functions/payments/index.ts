// payments: Razorpay for paid events.
//
// POST { action: "config" }                                  -> { ready, key_id }
// POST { action: "check" }                                   -> { mode, keys: valid|rejected|missing, webhook_secret_set }
// POST { action: "order", event_id }        (logged in)      -> Razorpay order + checkout options
// POST { action: "verify", order_id, payment_id, signature }  (logged in) -> confirms the sign-up
// POST from Razorpay with X-Razorpay-Signature (webhook)     -> confirms the sign-up even if the member closed the app
//
// Secrets: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const KEY_ID = (Deno.env.get("RAZORPAY_KEY_ID") ?? "").trim();
const KEY_SECRET = (Deno.env.get("RAZORPAY_KEY_SECRET") ?? "").trim();
const WEBHOOK_SECRET = (Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "").trim();
const READY = Boolean(KEY_ID && KEY_SECRET);
const RZP = "https://api.razorpay.com/v1";
const basic = () => "Basic " + btoa(`${KEY_ID}:${KEY_SECRET}`);

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const code = (msg: string | undefined) => (msg ?? "").match(/^[a-z_]+$/) ? msg! : "server_error";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- Webhook from Razorpay ----
  const hook = req.headers.get("x-razorpay-signature");
  if (hook) {
    if (!WEBHOOK_SECRET) return reply({ ok: false, error: "webhook_not_configured" }, 503);
    const raw = await req.text();
    if (!safeEqual(await hmacHex(WEBHOOK_SECRET, raw), hook)) return reply({ ok: false, error: "bad_signature" }, 401);
    const evt = JSON.parse(raw);
    if (evt.event === "payment.captured" || evt.event === "order.paid") {
      const pay = evt.payload?.payment?.entity;
      const order = evt.payload?.order?.entity;
      const reg = order?.notes?.registration_id ?? pay?.notes?.registration_id;
      if (reg && pay?.id && pay.status === "captured") {
        const r = await db.rpc("pay_confirm", { p_registration: reg, p_order: pay.order_id ?? order?.id ?? null, p_payment: pay.id, p_amount_paise: pay.amount, p_user: null });
        if (r.error) console.error("webhook confirm failed", reg, r.error.message);
      }
    }
    return reply({ ok: true });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ ok: false, error: "bad_request" }, 400); }
  if (body.action === "config") return reply({ ok: true, ready: READY, key_id: READY ? KEY_ID : null });
  if (body.action === "check") {
    // Organiser diagnostics: are the keys accepted by Razorpay, and is the webhook password set? Reveals no secrets.
    let keys = "missing";
    if (READY) {
      const r = await fetch(`${RZP}/orders?count=1`, { headers: { Authorization: basic() } });
      keys = r.ok ? "valid" : r.status === 401 ? "rejected" : `error_${r.status}`;
    }
    return reply({ ok: true, mode: KEY_ID.startsWith("rzp_live_") ? "live" : KEY_ID.startsWith("rzp_test_") ? "test" : "unknown", keys, webhook_secret_set: Boolean(WEBHOOK_SECRET) });
  }

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: who, error: authErr } = await db.auth.getUser(jwt);
  if (authErr || !who?.user) return reply({ ok: false, error: "not_logged_in" }, 401);
  if (!READY) return reply({ ok: false, error: "payments_not_ready" }, 503);

  if (body.action === "order") {
    const prep = await db.rpc("pay_prepare", { p_user: who.user.id, p_event: String(body.event_id ?? "") });
    if (prep.error) return reply({ ok: false, error: code(prep.error.message) }, 400);
    const p = prep.data as { registration_id: string; amount: number; event: string; name: string; phone: string };
    const res = await fetch(`${RZP}/orders`, {
      method: "POST",
      headers: { Authorization: basic(), "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: p.amount, currency: "INR", receipt: p.registration_id,
        notes: { registration_id: p.registration_id, event: p.event.slice(0, 250), phone: p.phone },
      }),
    });
    if (!res.ok) {
      console.error("razorpay order failed", res.status, await res.text());
      return reply({ ok: false, error: res.status === 401 ? "payments_not_ready" : "order_failed" }, 502);
    }
    const order = await res.json();
    await db.rpc("pay_attach_order", { p_registration: p.registration_id, p_order: order.id });
    return reply({
      ok: true, key_id: KEY_ID, order_id: order.id, amount: order.amount, currency: order.currency,
      name: "Mvmnt Tribe", description: p.event, prefill: { name: p.name, contact: p.phone ? `+91${p.phone}` : undefined },
    });
  }

  if (body.action === "verify") {
    const orderId = String(body.order_id ?? ""), paymentId = String(body.payment_id ?? ""), sig = String(body.signature ?? "");
    if (!orderId || !paymentId || !sig) return reply({ ok: false, error: "bad_request" }, 400);
    if (!safeEqual(await hmacHex(KEY_SECRET, `${orderId}|${paymentId}`), sig)) return reply({ ok: false, error: "bad_signature" }, 400);
    // Trust Razorpay's records, not the browser, for which sign-up and how much.
    const [o, pay] = await Promise.all([
      fetch(`${RZP}/orders/${orderId}`, { headers: { Authorization: basic() } }).then((r) => r.json()),
      fetch(`${RZP}/payments/${paymentId}`, { headers: { Authorization: basic() } }).then((r) => r.json()),
    ]);
    const reg = o?.notes?.registration_id;
    if (!reg || pay?.order_id !== orderId) return reply({ ok: false, error: "bad_request" }, 400);
    if (!["captured", "authorized"].includes(pay?.status)) return reply({ ok: false, error: "payment_not_complete" }, 400);
    const r = await db.rpc("pay_confirm", { p_registration: reg, p_order: orderId, p_payment: paymentId, p_amount_paise: pay.amount, p_user: who.user.id });
    if (r.error) return reply({ ok: false, error: code(r.error.message) }, 400);
    return reply({ ok: true, event_id: (r.data as { event_id: string }).event_id });
  }

  return reply({ ok: false, error: "unknown_action" }, 400);
});
