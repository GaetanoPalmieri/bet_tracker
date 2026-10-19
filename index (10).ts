// Bet Tracker — promemoria serale "Segna il saldo di oggi" (Supabase Edge Function).
//
// Chi la chiama:
//  - il cron di Supabase ogni ora (intestazione x-cron-secret): per ogni telefono iscritto (app='bet'),
//    quando nel suo fuso orario arriva l'ora scelta e oggi non ha ancora ricevuto l'avviso, controlla
//    i dati sincronizzati: se il saldo di oggi NON è ancora segnato nel diario manda il promemoria,
//    altrimenti non manda nulla;
//  - l'app, con il pulsante "Invia una prova" (token dell'utente collegato).
//
// Segreti (Edge Functions › Secrets): BET_VAPID_PUBLIC_KEY, BET_VAPID_PRIVATE_KEY (file dei segreti).
// Il mittente usa BET_VAPID_SUBJECT oppure, se manca, quello già impostato per le altre app.
// Il cron usa lo stesso segreto già impostato per Bilancio (CRON_SECRET) o RecompApp (GYM_CRON_SECRET):
// non serve crearne uno nuovo.
// In Supabase la funzione va pubblicata con "Verify JWT" disattivato: i controlli sono qui sotto.

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP = "bet";
const DEFAULT_HOUR = 21;
const env = (k: string) => Deno.env.get(k) ?? "";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});
webpush.setVapidDetails(
  env("BET_VAPID_SUBJECT") || env("GYM_VAPID_SUBJECT") || env("VAPID_SUBJECT") || "mailto:bet-tracker@example.com",
  env("BET_VAPID_PUBLIC_KEY"),
  env("BET_VAPID_PRIVATE_KEY"),
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ---------- Date nel fuso del telefono ---------- */
function localNow(tz: string) {
  let zone = tz || "Europe/Rome";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: zone }); } catch { zone = "Europe/Rome"; }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { today: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/* ---------- Saldo (stessa regola dell'app) ---------- */
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
function odds(b: any) { return (b.legs || []).reduce((n: number, l: any) => n * (l.status === "void" ? 1 : Number(l.odds) || 1), 1); }
function payout(b: any) {
  if (b.status === "pending" || b.status === "lost") return 0;
  if (b.actualPayout != null) return Number(b.actualPayout) || 0;
  if (b.status === "won") return round(b.stake * odds(b));
  if (b.status === "void") return Number(b.stake) || 0;
  return Number(b.cashout) || 0;
}
function balance(d: any) {
  const initial = Number(d?.accounts?.[0]?.initial) || 0;
  const tx = (d?.transactions || []).reduce((n: number, t: any) => n + (Number(t.amount) || 0), 0);
  const bets = (d?.bets || []).reduce((n: number, b: any) => n - (Number(b.stake) || 0) + payout(b), 0);
  return round(initial + tx + bets);
}
const money = (n: number) => {
  const v = round(n), [i, dec] = Math.abs(v).toFixed(2).split(".");
  return (v <= -0.005 ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + dec + " €";
};
const signed = (n: number) => (n > 0.004 ? "+" : n < -0.004 ? "−" : "") + money(Math.abs(n)).replace(/^-/, "");
const dayLabel = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/* ---------- Notifica schematica ---------- */
function message(d: any, today: string) {
  const diary = (Array.isArray(d?.diary) ? d.diary : []).slice().sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
  const last = diary.filter((e: any) => e.date <= today).pop();
  const cur = balance(d);
  const lines: string[] = [];
  lines.push(`💶 Saldo attuale ${money(cur)}`);
  if (last) {
    lines.push(`🕒 Ultimo segnato ${dayLabel(last.date)} · ${money(last.balance)}`);
    const diff = round(cur - last.balance);
    if (Math.abs(diff) >= 0.005) lines.push(`🎯 Da allora ${signed(diff)} da scommesse e movimenti`);
  }
  lines.push("👉 Tocca per segnarlo");
  return { title: "📝 Saldo di oggi", body: lines.join("\n"), tag: "bet-diary", url: "./?diary=today" };
}

async function send(sub: any, payload: unknown) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 6, urgency: "normal" },
    );
    return "ok";
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) {
      await admin.from("push_subscriptions").delete().eq("id", sub.id);
      return "gone";
    }
    console.error("push", e?.statusCode, e?.body || e?.message);
    return "error";
  }
}

async function loadData(userId: string) {
  const { data } = await admin.from("app_data").select("data").eq("app", APP).eq("user_id", userId).maybeSingle();
  return data?.data ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);

  const cron = req.headers.get("x-cron-secret");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");

  /* ---- Prova dall'app ---- */
  if (!cron) {
    const { data: u, error } = await admin.auth.getUser(bearer);
    if (error || !u?.user) return json({ error: "Accesso non valido: rifai l'accesso alla sincronizzazione." }, 401);
    const { data: subs } = await admin.from("push_subscriptions").select("*").eq("app", APP).eq("user_id", u.user.id).eq("enabled", true);
    if (!subs?.length) return json({ error: "Nessun telefono iscritto: attiva prima le notifiche." }, 404);
    const d = await loadData(u.user.id);
    const results: string[] = [];
    for (const s of subs) results.push(await send(s, message(d, localNow(s.tz).today)));
    return json({ sent: results.filter((r) => r === "ok").length, results });
  }

  /* ---- Giro orario dal cron ---- */
  const okSecret = [env("CRON_SECRET"), env("GYM_CRON_SECRET"), env("BET_CRON_SECRET")].some((s) => s && s === cron);
  if (!okSecret) return json({ error: "Segreto non valido" }, 401);
  const { data: subs, error } = await admin.from("push_subscriptions").select("*").eq("app", APP).eq("enabled", true);
  if (error) return json({ error: error.message }, 500);

  const cache = new Map<string, any>();
  let sent = 0, skipped = 0, alreadyDone = 0;
  for (const s of subs || []) {
    const { today, hour } = localNow(s.tz);
    if (hour < (s.notify_hour ?? DEFAULT_HOUR) || s.last_sent_day === today) { skipped++; continue; }
    if (!cache.has(s.user_id)) cache.set(s.user_id, await loadData(s.user_id));
    const d = cache.get(s.user_id);
    const done = Array.isArray(d?.diary) && d.diary.some((e: any) => e.date === today);
    const r = done ? "done" : await send(s, message(d, today));
    if (r === "ok") sent++;
    if (r === "done") alreadyDone++;
    // segna il giorno se è andata o se il saldo era già segnato: se l'invio fallisce si riprova l'ora dopo
    if (r === "ok" || r === "done") await admin.from("push_subscriptions").update({ last_sent_day: today }).eq("id", s.id);
  }
  return json({ sent, alreadyDone, skipped, total: subs?.length || 0 });
});
