// notify: (1) sends the WhatsApp confirmation queued in wa_outbox when a sign-up is confirmed —
//         the database calls this with { id } of a queued row; each row is sent at most once;
//         (2) sends organiser alerts to Telegram — the database calls this with { alert: { title, body } }
//         plus an X-Alert-Key header that must match app_settings.alert_key.
// Telegram secrets: TELEGRAM_BOT_TOKEN. The chat is linked automatically the first time you message the bot.
//
// Secrets: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID (same as member-auth),
//          WHATSAPP_CONFIRM_TEMPLATE (default "registration_confirmed"), WHATSAPP_CONFIRM_LANG (default "en").
// The template needs 4 body variables: {{1}} first name, {{2}} event, {{3}} date and time, {{4}} venue.
import { createClient } from "npm:@supabase/supabase-js@2";

const WA_TOKEN = (Deno.env.get("WHATSAPP_TOKEN") ?? "").trim();
const WA_PHONE_ID = (Deno.env.get("WHATSAPP_PHONE_ID") ?? "").trim();
const TEMPLATE = (Deno.env.get("WHATSAPP_CONFIRM_TEMPLATE") ?? "registration_confirmed").trim();
const LANG = (Deno.env.get("WHATSAPP_CONFIRM_LANG") ?? "en").trim();
// Quotes, spaces or a "bot" prefix pasted along with the token are ignored.
const TG_TOKEN = (Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "").replace(/[^A-Za-z0-9:_-]/g, "").replace(/^bot(?=\d)/i, "");
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
type DB = ReturnType<typeof createClient>;

async function setting(db: DB, key: string) {
  const { data } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
  return (data?.value as string) ?? "";
}
// The organiser's private chat: the most recent private chat that messaged the bot.
async function telegramChat(db: DB): Promise<string> {
  const saved = await setting(db, "telegram_chat_id");
  if (saved) return saved;
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`).then((x) => x.json()).catch(() => null);
  const chats = (r?.result ?? []).map((u: any) => u.message?.chat).filter((c: any) => c && c.type === "private");
  const chat = chats.at(-1);
  if (!chat) return "";
  await db.from("app_settings").upsert({ key: "telegram_chat_id", value: String(chat.id), updated_at: new Date().toISOString() });
  await db.from("app_settings").upsert({ key: "telegram_chat_name", value: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "", updated_at: new Date().toISOString() });
  return String(chat.id);
}
async function telegramSend(db: DB, title: string, body: string) {
  if (!TG_TOKEN) return { ok: false, error: "telegram_not_configured" };
  const chat = await telegramChat(db);
  if (!chat) return { ok: false, error: "telegram_not_linked" };
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text: `<b>${esc(title)}</b>\n${esc(body)}`, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!r.ok) { const e = await r.text(); console.error("telegram send failed", r.status, e); return { ok: false, error: "send_failed", detail: e.slice(0, 200) }; }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- Organiser alert (from the database trigger) ----
  if (body.alert || body.telegram_check) {
    const key = await setting(db, "alert_key");
    if (!key || req.headers.get("x-alert-key") !== key) return json({ ok: false, error: "forbidden" }, 403);
    if (body.telegram_check) {
      // Diagnostics: is the token accepted, which bot is it, how many updates are waiting? No secrets in the answer.
      const me = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
      const up = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
      const hook = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo`).then((x) => x.json()).catch(() => null);
      const raw = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
      const shape = { well_formed: /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(TG_TOKEN), starts_with_bot: /^bot/i.test(TG_TOKEN), colon_at: TG_TOKEN.indexOf(":"),
        has_space_or_quote: /[\s"'`]/.test(raw), odd_chars: (TG_TOKEN.match(/[^A-Za-z0-9:_-]/g) ?? []).length, digits_before_colon: (TG_TOKEN.split(":")[0].match(/^\d+$/) ? TG_TOKEN.split(":")[0].length : 0) };
      return json({ ok: true, shape, token_set: Boolean(TG_TOKEN), token_len: TG_TOKEN.length, me: me?.ok ? { username: me.result.username } : { error: me?.description ?? me?.error ?? "unknown" },
        updates: up?.ok ? up.result.length : (up?.description ?? up?.error ?? "unknown"), chat_types: up?.ok ? up.result.map((u: any) => u.message?.chat?.type ?? Object.keys(u).filter((k) => k !== "update_id")[0]) : null,
        webhook: hook?.result?.url || null, linked: await setting(db, "telegram_chat_id") || null });
    }
    const r = await telegramSend(db, String(body.alert.title ?? "Mvmnt Tribe"), String(body.alert.body ?? ""));
    return json(r, r.ok ? 200 : 502);
  }

  const id = String(body.id ?? "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ ok: false, error: "bad_request" }, 400);
  // Claim the row so it can't be sent twice.
  const { data: row } = await db.from("wa_outbox").update({ status: "sending" }).eq("id", id).eq("status", "queued").select().maybeSingle();
  if (!row) return json({ ok: true, skipped: true });

  if (!WA_TOKEN || !WA_PHONE_ID) {
    await db.from("wa_outbox").update({ status: "not_configured", error: "WhatsApp secrets not set" }).eq("id", id);
    return json({ ok: true, sent: false });
  }
  const params = (row.params as string[]).map((t) => ({ type: "text", text: String(t).slice(0, 200) }));
  const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: `91${row.phone}`, type: "template",
      template: { name: TEMPLATE, language: { code: LANG }, components: [{ type: "body", parameters: params }] },
    }),
  });
  if (!res.ok) {
    const err = (await res.text()).slice(0, 500);
    console.error("whatsapp send failed", res.status, err);
    await db.from("wa_outbox").update({ status: "failed", error: err }).eq("id", id);
    return json({ ok: false, error: "send_failed" }, 502);
  }
  await db.from("wa_outbox").update({ status: "sent", error: null, sent_at: new Date().toISOString() }).eq("id", id);
  return json({ ok: true, sent: true });
});
