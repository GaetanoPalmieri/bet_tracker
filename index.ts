// @ts-nocheck
// Bet Tracker — AVVISI LIVE + PRONOSTICI AUTOMATICI (Supabase Edge Function "pronostici-avvisi").
//
// PRONOSTICI PREPARTITA: ogni 6 ore (e quando l'app li chiede, se sono vecchi) prende da Bzzoiro le partite
// dei prossimi 3 giorni con le quote medie dei bookmaker (1X2, Over/Under 1.5-2.5-3.5, Goal) e ricava
// i gol attesi di casa e ospite. L'app li scarica come faceva con il file pronostici.json.
//
// AVVISI: ogni 2 minuti (cron di Supabase) guarda tutte le partite in corso nel mondo (Bzzoiro), le valuta con
// LO STESSO motore dell'app (copiato qui da pronostici.js a ogni versione) e, per chi ha acceso gli avvisi
// in Pronostici › Live, manda una notifica quando trova una giocata OTTIMA (e, se scelto, DA VALUTARE).
// Una sola notifica per partita e punteggio; di nuovo se una DA VALUTARE diventa OTTIMA.
// I segnali restano salvati: l'app li importa nella traccia anche se in quel momento era chiusa.
//
// Chi la chiama:
//  - il cron (intestazione x-cron-secret: segreto creato da avvisi.sql nella tabella pronostici_stato);
//  - l'app, con l'accesso della sincronizzazione: { action: "signals", since }, { action: "test" },
//    { action: "prematch" } (pronostici dei prossimi 3 giorni).
//
// Segreti già presenti: BZZOIRO_KEY, BET_VAPID_PUBLIC_KEY, BET_VAPID_PRIVATE_KEY (+ quello del cron).
// Tabelle: supabase/avvisi.sql. Pubblicare con "Verify JWT" DISATTIVATO: i controlli sono qui sotto.
// Versione app: 3.62.0

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const APP = "bet";
const env = (k: string) => Deno.env.get(k) ?? "";
const BZ_KEY = env("BZZOIRO_KEY");
const __unused = 0;
const BZ = "https://sports.bzzoiro.com";
const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
/* senza le chiavi delle notifiche la funzione lavora lo stesso (pronostici automatici), ma non manda avvisi */
let vapidOk = false;
try {
  webpush.setVapidDetails(
    env("BET_VAPID_SUBJECT") || env("GYM_VAPID_SUBJECT") || env("VAPID_SUBJECT") || "mailto:bet-tracker@example.com",
    env("BET_VAPID_PUBLIC_KEY"),
    env("BET_VAPID_PRIVATE_KEY"),
  );
  vapidOk = true;
} catch (e) { console.error("chiavi notifiche mancanti: BET_VAPID_PUBLIC_KEY / BET_VAPID_PRIVATE_KEY"); }
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/* ===================== Bzzoiro (stesse funzioni di pronostici-dati) ===================== */
let bzCalls = 0;
async function bzGet(path: string) {
  bzCalls++;
  const r = await fetch(BZ + path, { headers: { Authorization: "Token " + BZ_KEY, Accept: "application/json" } });
  { const h = r.headers.get("ratelimit") || ""; const mm = /remaining=(\d+)/.exec(h); bzRem = mm ? mm[1] : (r.headers.get("ratelimit-remaining") ?? r.headers.get("x-ratelimit-remaining") ?? bzRem); }
  if (r.status === 401) throw new Error("Bzzoiro: chiave BZZOIRO_KEY non valida");
  if (r.status === 429) throw new Error("Bzzoiro: limite di richieste raggiunto (rateLimit)");
  if (!r.ok) throw new Error("Bzzoiro " + r.status + " su " + path.split("?")[0]);
  return await r.json();
}
async function bzList(path: string, maxPages = 6) {
  let out: any[] = [];
  let url: string | null = path + (path.includes("?") ? "&" : "?") + "limit=200";
  for (let i = 0; i < maxPages && url; i++) {
    const d = await bzGet(url);
    const res = Array.isArray(d) ? d : (d.results || d.events || d.data || []);
    out = out.concat(res);
    const nx = Array.isArray(d) ? null : d.next;
    url = nx ? String(nx).replace(BZ, "") : null;
  }
  return out;
}
const num = (v: any) => (v == null || v === "" ? null : (isFinite(Number(v)) ? Number(v) : null));
const nm = (v: any) => (v == null ? "" : typeof v === "object" ? String(v.name ?? v.short_name ?? v.title ?? "") : String(v));
function bzTeam(e: any, side: "home" | "away") {
  return nm(e[side + "_team_obj"]) || nm(e[side + "_team"]) || nm(e[side]) || nm(e.teams && e.teams[side]);
}
function bzLeague(e: any) {
  const l = e.league ?? e.tournament ?? e.competition;
  if (l && typeof l === "object") return { name: nm(l), country: nm(l.country ?? l.category ?? "") };
  return { name: nm(l ?? e.league_name ?? ""), country: nm(e.country ?? e.league_country ?? "") };
}
function bzPeriod(e: any) {
  const p = String(e.period ?? e.status_period ?? "").toUpperCase(), st = String(e.status ?? "").toLowerCase();
  if (/cancel|postpon|abandon|suspend|interrupt/.test(st)) return /postpon/.test(st) ? "PST" : "CANC";
  if (p === "HT" || /half.?time|^ht$/.test(st)) return "HT";
  if (p === "FT" || /finish|ended|^ft$|after/.test(st)) return "FT";
  if (p === "2T" || p === "2H" || /second/.test(st)) return "2H";
  if (p === "1T" || p === "1H" || /first/.test(st)) return "1H";
  if (/live|inprogress|in_progress/.test(st)) return (num(e.current_minute) ?? 0) > 45 ? "2H" : "1H";
  return "NS";
}
/* punteggio del 1° tempo: cerca le varianti di nome più comuni */
function bzHT(e: any): number[] | null {
  const pairs = [["home_score_ht", "away_score_ht"], ["ht_home_score", "ht_away_score"], ["home_ht_score", "away_ht_score"],
    ["home_score_1h", "away_score_1h"], ["home_halftime_score", "away_halftime_score"], ["home_score_half", "away_score_half"]];
  for (const [a, b] of pairs) if (num(e[a]) != null && num(e[b]) != null) return [num(e[a])!, num(e[b])!];
  for (const k of ["halftime", "half_time", "ht", "ht_score", "score_ht", "first_half"]) {
    const v = e[k] ?? (e.scores && e.scores[k]) ?? (e.score && e.score[k]);
    if (v && typeof v === "object" && num(v.home) != null && num(v.away) != null) return [num(v.home)!, num(v.away)!];
    if (typeof v === "string" && /^\d+\s*[-:]\s*\d+$/.test(v)) return v.split(/[-:]/).map((x) => Number(x.trim()));
  }
  return null;
}
function bzIncMinute(i: any) {
  const m = num(i.minute ?? i.time ?? i.min) ?? 0;
  const x = num(i.added_time ?? i.extra_minute ?? i.injury_time ?? i.stoppage ?? i.extra) ?? 0;
  return { m, x };
}
function bzGoals(inc: any[]) {
  return (inc || []).filter((i) => {
    const t = String(i.type ?? i.incident_type ?? "").toLowerCase(), c = String(i.incident_class ?? i.detail ?? i.class ?? "").toLowerCase();
    return /goal/.test(t) && !/miss|disallow|cancel|no.?goal|var/.test(t + " " + c);
  });
}
function bzReds(inc: any[]) {
  return (inc || []).filter((i) => {
    const t = (String(i.type ?? "") + " " + String(i.card ?? i.card_type ?? i.incident_class ?? i.detail ?? "")).toLowerCase();
    return /card|red/.test(t) && /red|second|yellowred|yellow_red/.test(t) && !i.rescinded;
  });
}
function bzSide(i: any) {
  if (typeof i.is_home === "boolean") return i.is_home ? 0 : 1;
  if (i.is_home === 1 || i.is_home === 0) return i.is_home ? 0 : 1;
  const s = String(i.team ?? i.side ?? "").toLowerCase();
  return s === "home" ? 0 : s === "away" ? 1 : null;
}
function bzStats(e: any) {
  const ls = e.live_stats ?? e.stats ?? (e.statistics && e.statistics.stats) ?? null;
  const st = ls && (ls.home || ls.away) ? ls : (ls && ls.stats) || null;
  const out: any = { s: 0, t: 0, c: 0, red: 0, xg: null as number | null, side: [{}, {}] as any[] };
  if (!st) return out;
  let xg = 0, hasXg = 0;
  (["home", "away"] as const).forEach((k, i) => {
    const h = st[k] || {};
    const xv = h.xg && typeof h.xg === "object" ? num(h.xg.actual ?? h.xg.value) : num(h.xg ?? h.expected_goals);
    const xl = num(e[k + "_xg_live"]);
    const S: any = {
      s: num(h.total_shots ?? h.shots), t: num(h.shots_on_target ?? h.shots_on_goal),
      b: num(h.shots_inside_box ?? h.shots_insidebox ?? h.inside_box), c: num(h.corner_kicks ?? h.corners),
      red: num(h.red_cards) ?? 0, poss: num(h.ball_possession ?? h.possession), xg: xv ?? xl,
    };
    if (S.xg != null) { xg += S.xg; hasXg++; }
    out.side[i] = S;
    out.s += S.s || 0; out.t += S.t || 0; out.c += S.c || 0; out.red += S.red || 0;
  });
  if (hasXg === 2) out.xg = Math.round(xg * 100) / 100; else out.side.forEach((x: any) => (x.xg = null));
  return out;
}
/* evento Bzzoiro -> forma "fixture" usata dal resto della funzione */
function bzFixture(e: any) {
  const st = bzPeriod(e), lg = bzLeague(e);
  const inc = e.incidents || [];
  return {
    fixture: { id: "bz:" + e.id, status: { short: st, elapsed: num(e.current_minute ?? e.minute) }, timestamp: Date.parse(e.event_date ?? e.start_time ?? e.date) / 1000, date: e.event_date ?? e.start_time },
    teams: { home: { name: bzTeam(e, "home") }, away: { name: bzTeam(e, "away") } },
    goals: { home: num(e.home_score), away: num(e.away_score) },
    score: { fulltime: { home: num(e.home_score), away: num(e.away_score) }, halftime: (() => { const h = bzHT(e); return h ? { home: h[0], away: h[1] } : { home: null, away: null }; })() },
    league: lg, _e: e, _inc: inc,
  };
}
function bzLastGoal(inc: any[]) {
  const g = bzGoals(inc).map((i) => { const t = bzIncMinute(i); return t.m + t.x; });
  return g.length ? Math.max(...g) : null;
}
function bzFirstGoal(inc: any[]) {
  const g = bzGoals(inc).map(bzIncMinute).sort((a, b) => a.m - b.m || a.x - b.x);
  if (!g.length) return null;
  return g[0].m + (g[0].m === 45 && g[0].x ? g[0].x : 0);
}
function bzHTfromInc(inc: any[]): number[] | null {
  const g = bzGoals(inc);
  if (!inc || !inc.length) return null;
  const ht = [0, 0];
  for (const i of g) {
    const t = bzIncMinute(i), sd = bzSide(i), per = num(i.period);
    const first = per != null ? per === 1 : t.m <= 45;
    if (first && sd != null) ht[sd]++;
  }
  return ht;
}
async function bzIncidents(id: string) {
  try {
    const d = await bzGet(`/api/v2/events/${id}/incidents/`);
    return Array.isArray(d) ? d : (d.incidents || d.results || []);
  } catch { return []; }
}
async function bzLive() {
  let list: any[] = [];
  try { list = await bzList(`/api/live/`, 4); } catch (e) { list = await bzList(`/api/v2/events/live/`, 4); }
  return list;
}
function bzStatsInc(e: any, inc: any[]) {
  const st = bzStats(e);
  for (const r of bzReds(inc || [])) { const sd = bzSide(r); if (sd != null && st.side[sd]) st.side[sd].red = Math.max(st.side[sd].red || 0, 1); }
  st.red = (st.side[0].red || 0) + (st.side[1].red || 0);
  return st;
}
/* quote Over/Under di un evento: cerca le forme più comuni (campi odds_over_25 o liste di mercati) */
function bzParseOU(d: any) {
  const ou: Record<string, { o?: number; u?: number }> = {};
  const put = (line: string, side: "o" | "u", v: any) => { const n = num(v); if (n && n > 1) (ou[line] = ou[line] || {})[side] = n; };
  const walk = (x: any, depth: number) => {
    if (!x || depth > 4) return;
    if (Array.isArray(x)) { x.forEach((y) => walk(y, depth + 1)); return; }
    if (typeof x !== "object") return;
    for (const [k, v] of Object.entries(x)) {
      const m = /^odds_(over|under)_(\d)(\d)$/.exec(k);
      if (m) put(m[2] + "." + m[3], m[1] === "over" ? "o" : "u", v);
    }
    const name = String(x.market ?? x.name ?? x.market_name ?? "").toLowerCase();
    const line = num(x.line ?? x.handicap ?? x.total ?? x.point);
    if (/over|under|total|goals/.test(name) && line != null && !/half|team|corner|card/.test(name)) {
      if (x.over != null) put(line.toFixed(1), "o", x.over);
      if (x.under != null) put(line.toFixed(1), "u", x.under);
    }
    const sel = String(x.selection ?? x.outcome ?? x.label ?? "");
    const sm = /^(over|under)\s*(\d+(?:\.\d)?)$/i.exec(sel.trim());
    if (sm && !/half|team|corner|card/.test(name)) put(Number(sm[2]).toFixed(1), /over/i.test(sm[1]) ? "o" : "u", x.odd ?? x.odds ?? x.price ?? x.value);
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v, depth + 1);
  };
  walk(d, 0);
  return ou;
}

/* partite in corso nello stesso formato della scansione dell'app */
async function scanList() {
  if (TC_TOKEN) {
    const sv: any = await getState("tcOff");
    if (sv != null && tcOff == null) tcOff = Number(sv);
    const L = await tcLive();
    if (tcOff != null) await setState("tcOff", tcOff);
    return L;
  }
  const list = await bzLive();
  return list.map((e: any) => {
    const f = bzFixture(e);
    const r: any = {
      afId: f.fixture.id, status: f.fixture.status.short, elapsed: f.fixture.status.elapsed, kickoff: f.fixture.date,
      league: f.league.name, country: f.league.country, home: f.teams.home.name, away: f.teams.away.name,
      goals: [f.goals.home ?? 0, f.goals.away ?? 0], lastGoal: bzLastGoal(f._inc),
    };
    const o25 = num(e.odds_over_25), u25 = num(e.odds_under_25), oh = num(e.odds_home), od = num(e.odds_draw), oa = num(e.odds_away);
    if ((o25 && u25) || (oh && od && oa)) r.odds = { pre: { o25, u25, x12: oh && od && oa ? [oh, od, oa] : null } };
    const st = bzStatsInc(e, f._inc);
    if (st.side[0] && Object.keys(st.side[0]).length) r.stats = st;
    return r;
  });
}
/* quota live del book per "altro gol entro la fine" (Over punteggio+0,5).
   Come nell'app: si usa solo se è sicuramente live (la linea già vinta non deve essere più quotata). */
async function bookN1(afId: string, G: number) {
  if (G < 1 || String(afId).startsWith("tc:")) return null;
  try {
    const raw = String(afId).replace(/^bz:/, "");
    const ou = bzParseOU(await bzGet(`/api/v2/events/${raw}/odds/`));
    const prev = ou[(G - 0.5).toFixed(1)], cur = ou[(G + 0.5).toFixed(1)];
    if (prev && prev.o && prev.o > 1.01) return null;
    return cur && cur.o && cur.o > 1 ? cur.o : null;
  } catch { return null; }
}

/* richieste rimaste oggi (dalle intestazioni di Bzzoiro, se le manda) */
let bzRem: string | null = null;

/* ===================== Pronostici prepartita automatici ===================== */
const PRE_EVERY = 6 * 3600e3;
function poisTail(need: number, L: number) { let p = 0, t = Math.exp(-L); for (let k = 0; k < need; k++) { p += t; t *= L / (k + 1); } return 1 - p; }
function devig(a?: number | null, b?: number | null) { return a && b && a > 1 && b > 1 ? (1 / a) / (1 / a + 1 / b) : null; }
/* gol attesi totali da una linea Over/Under: λ tale che P(almeno need gol) = probabilità senza aggio */
function lamFromLine(line: number, o?: number | null, u?: number | null) {
  const p = devig(o, u);
  if (p == null) return null;
  const need = Math.round(line + 0.5);
  let lo = 0.05, hi = 9;
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (poisTail(need, mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
function pois(k: number, l: number) { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; }
function hda(lh: number, la: number) {
  let h = 0, d = 0, a = 0;
  for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) { const v = pois(i, lh) * pois(j, la); if (i > j) h += v; else if (i === j) d += v; else a += v; }
  return { h, d, a };
}
function slugT(s: string) { return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function romeParts(ts: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function preMatch(e: any) {
  const st = String(e.status ?? "").toLowerCase();
  if (st && !/notstarted|not_started|scheduled|^ns$/.test(st)) return null;
  const ts = Date.parse(e.event_date ?? e.start_time ?? e.date);
  if (!isFinite(ts) || ts < Date.now() + 5 * 60e3) return null;
  const home = bzTeam(e, "home"), away = bzTeam(e, "away");
  if (!home || !away) return null;
  const lines: number[] = [];
  for (const [ln, o, u] of [[1.5, e.odds_over_15, e.odds_under_15], [2.5, e.odds_over_25, e.odds_under_25], [3.5, e.odds_over_35, e.odds_under_35]] as any) {
    const l = lamFromLine(ln, num(o), num(u)); if (l) lines.push(l);
  }
  const p1x = [num(e.odds_home), num(e.odds_draw), num(e.odds_away)];
  const has1x2 = p1x.every((x) => x && x > 1);
  let L: number | null = lines.length ? Math.exp(lines.reduce((s, x) => s + Math.log(x), 0) / lines.length) : null;
  const pr = e._pred;
  if (!L && pr && num(pr.expected_home_goals) != null && num(pr.expected_away_goals) != null) L = num(pr.expected_home_goals)! + num(pr.expected_away_goals)!;
  if (!L) return null;
  /* divisione casa/ospite: la stessa differenza vittoria casa − vittoria ospite delle quote 1X2 */
  let s = 0.53, mk: any = null;
  if (has1x2) {
    const inv = p1x.map((x) => 1 / x!), S = inv[0] + inv[1] + inv[2], ph = inv[0] / S, pd = inv[1] / S, pa = inv[2] / S, target = ph - pa;
    let lo = 0.08, hi = 0.92;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2, r = hda(L * mid, L * (1 - mid)); if (r.h - r.a < target) lo = mid; else hi = mid; }
    s = (lo + hi) / 2;
    mk = { p1: Math.round(ph * 1000) / 10, px: Math.round(pd * 1000) / 10, p2: Math.round(pa * 1000) / 10 };
  } else if (pr && num(pr.expected_home_goals) != null && num(pr.expected_away_goals) != null) {
    const a = num(pr.expected_home_goals)!, b = num(pr.expected_away_goals)!; if (a + b > 0) s = a / (a + b);
  }
  const lh = Math.round(L * s * 1000) / 1000, la = Math.round(L * (1 - s) * 1000) / 1000;
  const o15 = num(e.odds_over_15), o25 = num(e.odds_over_25), gg = num(e.odds_btts_yes);
  const odds: any = {};
  if (has1x2) { odds["1"] = p1x[0]; odds["X"] = p1x[1]; odds["2"] = p1x[2]; }
  if (o15) odds.o15 = o15; if (o25) odds.o25 = o25; if (gg) odds.gg = gg;
  if (mk) { const q15 = devig(o15, num(e.odds_under_15)), q25 = devig(o25, num(e.odds_under_25)); if (q15) mk.o15 = Math.round(q15 * 1000) / 10; if (q25) mk.o25 = Math.round(q25 * 1000) / 10; }
  const lg = bzLeague(e), rp = romeParts(ts);
  const m: any = {
    id: rp.date + "_" + slugT(home) + "_" + slugT(away), date: rp.date, time: rp.time,
    league: (lg.country ? lg.country + " · " : "") + lg.name, home, away, lh, la,
    rel: lines.length >= 2 && has1x2 ? "B" : "C", review: "auto",
    note: "Automatico: quote medie dei bookmaker (Bzzoiro)" + (lines.length ? "" : " · gol attesi dal loro modello"),
    src: lines.length ? "quote" : "modello Bzzoiro", lhM: lh, laM: la, wMkt: 1, afId: "bz:" + e.id,
    odds: Object.keys(odds).length ? odds : undefined, mkt: mk || undefined,
    fav: mk ? Math.round(Math.max(mk.p1, mk.p2)) : undefined,
  };
  if (!o15 && !o25) m.topSkip = "quote Over non ancora aperte";
  return m;
}
async function buildPrematch() {
  const now = Date.now(), from = romeParts(now).date, to = romeParts(now + 3 * 86400e3).date;
  const evs = await bzList(`/api/v2/events/?date_from=${from}&date_to=${to}`, 20);
  /* previsioni di Bzzoiro (gol attesi): servono solo dove mancano le quote Over/Under */
  try {
    const preds = await bzList(`/api/predictions/?date_from=${from}&date_to=${to}`, 12);
    const byEv = new Map<any, any>();
    for (const p of preds) { const id = p.event?.id ?? p.event_id ?? p.event; if (id != null) byEv.set(String(id), p); }
    for (const e of evs) { const p = byEv.get(String(e.id)); if (p) e._pred = p; }
  } catch { /* facoltative */ }
  const matches = evs.map(preMatch).filter(Boolean);
  const file = {
    app: "bet_tracker", kind: "pronostici", auto: true,
    batch: "auto-" + new Date(now).toISOString().slice(0, 13),
    generatedAt: new Date(now).toISOString(),
    label: "Automatico · quote Bzzoiro · " + romeParts(now).date + " " + romeParts(now).time,
    from, to, events: evs.length, matches,
  };
  await setState("prematch", file);
  return file;
}
/* TotalCorner: le partite dei prossimi giorni arrivano a pagine da 30 (circa 1.300 al giorno).
   Per stare nel limite di 30 richieste al minuto si leggono poche pagine per giro (ogni 2 minuti):
   oggi, domani e dopodomani si completano in circa un'ora (4 pagine per giro), poi si ricomincia ogni 6 ore. */
function tcPreMatch(x: any) {
  if (tcIsSim(x)) return null;
  const f = tcFixture(x);
  if (!f.home || !f.away || f.status !== "NS" || !f.kickoff) return null;
  const ts = Date.parse(f.kickoff);
  if (ts < Date.now() + 5 * 60e3) return null;
  const L = f.odds?.pre?.lam;
  if (!L) return null;
  const p1x = f.odds?.pre?.x12;
  let s = 0.53, mk: any = null;
  if (p1x) {
    const inv = p1x.map((v: number) => 1 / v), S = inv[0] + inv[1] + inv[2], ph = inv[0] / S, pd = inv[1] / S, pa = inv[2] / S, target = ph - pa;
    let lo = 0.08, hi = 0.92;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2, r = hda(L * mid, L * (1 - mid)); if (r.h - r.a < target) lo = mid; else hi = mid; }
    s = (lo + hi) / 2;
    mk = { p1: Math.round(ph * 1000) / 10, px: Math.round(pd * 1000) / 10, p2: Math.round(pa * 1000) / 10 };
  }
  const lh = Math.round(L * s * 1000) / 1000, la = Math.round(L * (1 - s) * 1000) / 1000;
  /* si tengono solo le partite che possono entrare nei pronostici (Over 1.5 o gol nel 1° tempo plausibili) */
  const p15 = 1 - Math.exp(-L) * (1 + L), pht = 1 - Math.exp(-0.45 * L);
  if (p15 < 0.72 && pht < 0.66) return null;
  const rp = romeParts(ts);
  const odds: any = { gl: f.odds.pre.line };
  if (p1x) { odds["1"] = p1x[0]; odds["X"] = p1x[1]; odds["2"] = p1x[2]; }
  const bt = tcNum(Array.isArray(x.p_btts) ? x.p_btts[0] : x.p_btts);
  if (bt && bt > 1) odds.gg = bt;
  return {
    id: rp.date + "_" + slugT(f.home) + "_" + slugT(f.away), date: rp.date, time: rp.time, league: f.league, home: f.home, away: f.away, lh, la,
    rel: p1x ? "B" : "C", review: "auto", note: "Automatico: quote bet365 (TotalCorner), linea gol " + f.odds.pre.line,
    src: "quote", lhM: lh, laM: la, wMkt: 1, afId: f.afId, odds, mkt: mk || undefined, fav: mk ? Math.round(Math.max(mk.p1, mk.p2)) : undefined,
  };
}
async function tcPrematchStep(force = false) {
  if (tcOff == null) { const sv: any = await getState("tcOff"); if (sv != null) tcOff = Number(sv); }
  const st: any = (await getState("tcpre")) || {};
  const now = Date.now();
  const days = [0, 1, 2].map((n) => romeParts(now + n * 86400e3).date);
  if (force || !st.cycleAt || now - st.cycleAt > PRE_EVERY || !days.includes(st.day)) { st.cycleAt = now; st.day = days[0]; st.page = 1; st.byDay = st.byDay || {}; st.done = false; }
  if (st.done) return st;
  let budget = 4;
  while (budget > 0 && !st.done) {
    const ymd = st.day.replace(/-/g, "");
    const r = await tcList("/match/schedule", { date: ymd, columns: "odds,goalLine,btts" }, Math.min(budget, 12), st.page);
    budget -= Math.max(1, r.nextPage - st.page);
    const keep = r.list.map(tcPreMatch).filter(Boolean);
    const cur = st.byDay[st.day] && st.page > 1 ? st.byDay[st.day] : [];
    st.byDay[st.day] = cur.concat(keep);
    if (r.nextPage > r.pages || !r.list.length) {
      const k = days.indexOf(st.day);
      if (k < days.length - 1) { st.day = days[k + 1]; st.page = 1; } else st.done = true;
    } else st.page = r.nextPage;
  }
  for (const d of Object.keys(st.byDay)) if (!days.includes(d)) delete st.byDay[d];
  await setState("tcpre", st);
  if (st.done || Object.keys(st.byDay).length) {
    const seen = new Set<string>();
    const matches = days.flatMap((d) => st.byDay[d] || []).filter((m: any) => !seen.has(m.id) && (seen.add(m.id), true));
    const file = { app: "bet_tracker", kind: "pronostici", auto: true, batch: "auto-tc-" + new Date(st.cycleAt).toISOString().slice(0, 13) + (st.done ? "" : "-p"),
      generatedAt: new Date(now).toISOString(), label: "Automatico · bet365 (TotalCorner) · " + romeParts(now).date + " " + romeParts(now).time + (st.done ? "" : " · in completamento"),
      from: days[0], to: days[2], matches };
    await setState("prematch", file);
  }
  return st;
}
async function getPrematch(force = false) {
  if (TC_TOKEN) {
    const cur: any = await getState("prematch");
    /* l'app legge solo quello che il giro ha già preparato: niente richieste in più (limite 30 al minuto) */
    if (cur && String(cur.batch || "").startsWith("auto-tc")) return cur;
    return { matches: [], error: "Pronostici automatici in preparazione: il giro ogni 2 minuti li completa in circa un'ora." };
  }
  const cur: any = await getState("prematch");
  if (!force && cur && cur.generatedAt && Date.now() - Date.parse(cur.generatedAt) < PRE_EVERY) return cur;
  return await buildPrematch();
}


/* ===================== TotalCorner (fonte principale dal 3.53.0) =====================
   Segreto TOTALCORNER_TOKEN. Una richiesta = tutte le partite live (30 per pagina) con punteggio,
   statistiche (tiri, angoli, possesso, attacchi) e quote bet365 (1X2 e linea gol pre-partita e live).
   Limite: 30 richieste al minuto. I campi si leggono "con prudenza" (nomi alternativi). */
const TC_TOKEN = Deno.env.get("TOTALCORNER_TOKEN") ?? "";
const TC = "https://api.totalcorner.com/v1";
const TC_COLS = "events,odds,asian,goalLine,attacks,dangerousAttacks,shotOn,shotOff,possession";
let tcCalls = 0, tcRem: string | null = null, tcOff: number | null = null;
const tcNum = (v: any) => (v == null || v === "" ? null : isFinite(Number(v)) ? Number(v) : null);
async function tcGet(path: string, params: Record<string, string | number> = {}) {
  tcCalls++;
  const qs = Object.entries(params).map(([k, v]) => k + "=" + encodeURIComponent(String(v))).join("&");
  const r = await fetch(TC + path + "?" + (qs ? qs + "&" : "") + "token=" + encodeURIComponent(TC_TOKEN), { headers: { Accept: "application/json" } });
  tcRem = r.headers.get("x-rate-limit-remaining") ?? tcRem;
  let j: any = null;
  try { j = await r.json(); } catch { throw new Error("TotalCorner " + r.status + ": risposta non valida"); }
  if (!r.ok || j?.success === 0 || j?.error) {
    const c = j?.error?.code || r.status, msg = j?.error?.message || "";
    if (c === "TOKEN_ERROR") throw new Error("TotalCorner: token non valido (segreto TOTALCORNER_TOKEN)");
    if (c === "NO_PERMISSION") throw new Error("TotalCorner: serve l'abbonamento VIP attivo");
    if (c === "TOO_MANY_REQUEST") throw new Error("TotalCorner: troppe richieste in un minuto (rateLimit)");
    throw new Error("TotalCorner " + c + (msg ? ": " + msg : ""));
  }
  return j;
}
async function tcList(path: string, params: Record<string, string | number>, maxPages = 8, firstPage = 1) {
  let out: any[] = [], page = firstPage, pages = firstPage;
  for (let n = 0; n < maxPages; n++) {
    const j = await tcGet(path, { ...params, page });
    const d = Array.isArray(j?.data) ? j.data : Array.isArray(j?.data?.data) ? j.data.data : [];
    out = out.concat(d);
    const pg = j?.pagination || j?.data?.pagination || {};
    pages = tcNum(pg.pages) ?? page;
    if (!pg.next || page >= pages || !d.length) { page++; break; }
    page++;
  }
  return { list: out, nextPage: page, pages };
}
function tcPair(x: any, ...keys: string[]): [number | null, number | null] {
  for (const k of keys) {
    const v = x?.[k];
    if (Array.isArray(v) && v.length >= 2) return [tcNum(v[0]), tcNum(v[1])];
    if (typeof v === "string" && v.includes(",")) { const p = v.split(","); return [tcNum(p[0]), tcNum(p[1])]; }
  }
  return [null, null];
}
/* linea gol ("2.5", "2.5,3.0", ["3.0"]) -> gol attesi della partita intera */
function tcLine(v: any): number | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (s == null || s === "") return null;
  const parts = String(s).split(",").map(Number).filter((n) => isFinite(n));
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}
function tcLamFromLine(L: number | null) {
  if (L == null || L <= 0) return null;
  const fr = L - Math.floor(L), adj = Math.abs(fr - 0.5) < 0.01 ? 0.17 : Math.abs(fr - 0.25) < 0.01 || Math.abs(fr - 0.75) < 0.01 ? 0.08 : 0;
  return Math.max(0.6, Math.min(6, L + adj));
}
/* orario d'inizio: TotalCorner non dice il fuso; lo ricavo dalle partite live (inizio + minuto ≈ adesso) */
function tcParseStart(s: any) { const t = Date.parse(String(s || "").replace(" ", "T") + "Z"); return isFinite(t) ? t : null; }
function tcCalibrate(list: any[]) {
  const d: number[] = [];
  for (const x of list) {
    const t = tcParseStart(x.start), m = tcNum(x.status);
    if (t == null || m == null) continue;
    d.push((Date.now() - t - (m + (String(x.ish) === "1" ? 15 : 0)) * 60e3) / 3600e3);
  }
  if (d.length < 3) return;
  d.sort((a, b) => a - b);
  tcOff = Math.round(-d[Math.floor(d.length / 2)] * 4) / 4;
}
function tcStartUtc(s: any) { const t = tcParseStart(s); return t == null ? null : t - (tcOff || 0) * 3600e3; }
function tcStatus(x: any) {
  const raw = String(x.status ?? "").trim(), n = tcNum(raw);
  if (n != null) return { st: String(x.ish) === "1" || n > 46 ? "2H" : "1H", el: n };
  if (/half|ht|break/i.test(raw)) return { st: "HT", el: 45 };
  if (/full|ft|end|finish/i.test(raw)) return { st: "FT", el: 90 };
  if (/post|canc|aband|susp/i.test(raw)) return { st: /post/i.test(raw) ? "PST" : "CANC", el: null };
  return { st: "NS", el: null };
}
function tcGoals(x: any) {
  return (Array.isArray(x.events) ? x.events : []).filter((e: any) => String(e.tp).toLowerCase() === "g")
    .map((e: any) => ({ min: tcNum(e.t) ?? 0, side: e.h === "h" ? 0 : e.h === "a" ? 1 : null })).sort((a: any, b: any) => a.min - b.min);
}
function tcStats(x: any) {
  const on = tcPair(x, "shot_on", "shotOn"), off = tcPair(x, "shot_off", "shotOff"), pos = tcPair(x, "possess", "possession"),
    att = tcPair(x, "attacks"), da = tcPair(x, "dangerous_attacks", "dangerousAttacks", "dattacks", "dang_attacks");
  const hc = tcNum(x.hc), ac = tcNum(x.ac), hr = tcNum(x.hrc) ?? 0, ar = tcNum(x.arc) ?? 0;
  const has = on[0] != null || hc != null;
  if (!has) return null;
  const side = [0, 1].map((i) => ({
    s: on[i] != null || off[i] != null ? (on[i] || 0) + (off[i] || 0) : null, t: on[i], c: i ? ac : hc,
    poss: pos[i], red: i ? ar : hr, att: att[i], da: da[i], xg: null,
  }));
  return { s: (side[0].s || 0) + (side[1].s || 0), t: (side[0].t || 0) + (side[1].t || 0), c: (hc || 0) + (ac || 0), red: hr + ar, xg: null, side };
}
/* partita TotalCorner -> stesso formato della scansione dell'app */
function tcFixture(x: any) {
  const s = tcStatus(x), ko = tcStartUtc(x.start), goals = tcGoals(x);
  const x12 = tcPair(x, "p_odds"), ox12 = Array.isArray(x.p_odds) && x.p_odds.length >= 3 ? x.p_odds.map(tcNum) : null;
  const lam = tcLamFromLine(tcLine(x.p_goal));
  const r: any = {
    afId: "tc:" + x.id, status: s.st, elapsed: s.el, kickoff: ko != null ? new Date(ko).toISOString() : null,
    league: String(x.l || x.league || ""), country: "", home: String(x.h || x.home || ""), away: String(x.a || x.away || ""),
    goals: [tcNum(x.hg) ?? 0, tcNum(x.ag) ?? 0], lastGoal: goals.length ? goals[goals.length - 1].min : null,
    ht: tcNum(x.hf_hg) != null && tcNum(x.hf_ag) != null ? [tcNum(x.hf_hg), tcNum(x.hf_ag)] : null, goalList: goals,
    liveLine: tcLine(x.i_goal), preLine: tcLine(x.p_goal),
  };
  if (lam || (ox12 && ox12.every((v: any) => v && v > 1))) r.odds = { pre: { lam, line: tcLine(x.p_goal), x12: ox12 && ox12.every((v: any) => v && v > 1) ? ox12 : null } };
  void x12;
  const st = tcStats(x);
  if (st) r.stats = st;
  return r;
}
/* partite simulate (eSoccer, Cyber, virtuali, FIFA/eFootball con giocatori): da escludere */
const TC_SIM = /e-?soccer|esports?|cyber|simulat|virtual|efootball|e-football|\bfifa\b|\bfc ?2[0-9]\b|\bpes\b|gt league|volta|battle|\d+ ?min(s|utes)?\b|h2h gg|ebasketball|valhalla/i;
function tcIsSim(x: any) {
  const l = String(x.l || x.league || ""), h = String(x.h || x.home || ""), a = String(x.a || x.away || "");
  if (TC_SIM.test(l)) return true;
  /* squadre con il nome del giocatore tra parentesi, tipico delle partite virtuali: "Arsenal (Kray)" */
  return /\([A-Za-z0-9_.\- ]{2,}\)\s*$/.test(h) && /\([A-Za-z0-9_.\- ]{2,}\)\s*$/.test(a);
}
async function tcLive() {
  const { list } = await tcList("/match/today", { type: "inplay", columns: TC_COLS }, 6);
  tcCalibrate(list);
  return list.filter((x: any) => !tcIsSim(x)).map(tcFixture).filter((r: any) => r.home && r.away);
}

/* ===================== Motore dell'app (generato da pronostici.js) ===================== */
const U = { finite: (n: any) => typeof n === "number" && Number.isFinite(n) };
let db: any = {};
const __ls: Record<string, string> = {};
const localStorage = { getItem: (k: string) => (k in __ls ? __ls[k] : null), setItem: (k: string, v: string) => { __ls[k] = String(v); } };
var TIP_DEFAULTS = { version: '1', threshold: 70, htShare: 0.45, drawBoost: 1, goalFactor: 1, leagueGoal: {}, rho: 0 };
var tipUI = { view: 'open', day: 'all', league: '', q: '', loading: false, fileInfo: '', panel: 'home', sort: 'time' };
function tipParams() {
  var m = db.predModel || {},
    base = Object.assign({}, TIP_DEFAULTS, m.base || {}),
    l = m.learned || null;
  if (!l) return base;
  var lg = Object.assign({}, base.leagueGoal || {});
  Object.keys(l.leagueGoal || {}).forEach(function (k) {
    lg[k] = (lg[k] || 1) * l.leagueGoal[k];
  });
  return Object.assign({}, base, {
    htShare: l.htShare != null ? l.htShare : base.htShare,
    drawBoost: (base.drawBoost || 1) * (l.drawBoost || 1),
    goalFactor: (base.goalFactor || 1) * (l.goalFactor || 1),
    leagueGoal: lg,
    htLeague: l.htLeague || {},
    early: l.early || null,
  });
}
function tipPois(k, l) {
  var p = Math.exp(-l);
  for (var i = 1; i <= k; i++) p *= l / i;
  return p;
}
var TIP_CTX = [
  { k: 'must', label: 'Deve vincere / recuperare', self: 1.06 },
  { k: 'relax', label: 'Niente in palio / testa ad altro', self: 0.94 },
  { k: 'turn', label: 'Turnover pesante', self: 0.9, opp: 1.04 },
  { k: 'att', label: 'Manca un attaccante chiave', self: 0.92 },
  { k: 'def', label: 'Mancano difensori o il portiere titolare', opp: 1.07 },
];
function tipCtxMult(m) {
  var cx = m.ctx;
  if (!cx || (!(cx.h || []).length && !(cx.a || []).length)) return [1, 1];
  var mult = [1, 1];
  [['h', 0], ['a', 1]].forEach(function (s) {
    (cx[s[0]] || []).forEach(function (k) {
      var d = TIP_CTX.find(function (x) { return x.k === k; });
      if (!d) return;
      if (d.self) mult[s[1]] *= d.self;
      if (d.opp) mult[1 - s[1]] *= d.opp;
    });
  });
  var hasOdds = U.finite(m.lhM) || (m.odds && Object.keys(m.odds).length);
  var w = cx.late || !hasOdds ? 1 : 1 - (U.finite(m.wMkt) ? m.wMkt : 0.7);
  return mult.map(function (x) { return 1 + (x - 1) * w; });
}
function tipCalc(m, P) {
  P = P || tipParams();
  var cm = tipCtxMult(m),
    f = (P.goalFactor || 1) * ((P.leagueGoal || {})[m.league] || 1),
    lh = m.lh * f * cm[0],
    la = m.la * f * cm[1],
    N = 11,
    g = [],
    s = 0,
    i,
    j;
  for (i = 0; i < N; i++) {
    g.push([]);
    for (j = 0; j < N; j++) {
      var v = tipPois(i, lh) * tipPois(j, la);
      /* 3.7.0 — correzione Dixon-Coles sui punteggi bassi (0-0, 1-0, 0-1, 1-1) */
      var rho = P.rho || 0;
      if (rho) {
        if (i === 0 && j === 0) v *= 1 - lh * la * rho;
        else if (i === 0 && j === 1) v *= 1 + lh * rho;
        else if (i === 1 && j === 0) v *= 1 + la * rho;
        else if (i === 1 && j === 1) v *= 1 - rho;
        if (v < 0) v = 0;
      }
      if (i === j) v *= P.drawBoost || 1;
      g[i].push(v);
      s += v;
    }
  }
  var p1 = 0,
    px = 0,
    p2 = 0,
    u05 = 0,
    u15 = 0,
    u25 = 0,
    gg = 0,
    cells = [];
  for (i = 0; i < N; i++)
    for (j = 0; j < N; j++) {
      var q = g[i][j] / s;
      if (i > j) p1 += q;
      else if (i === j) px += q;
      else p2 += q;
      if (i + j === 0) u05 += q;
      if (i + j <= 1) u15 += q;
      if (i + j <= 2) u25 += q;
      if (i > 0 && j > 0) gg += q;
      cells.push([i, j, q]);
    }
  if (Array.isArray(m.p1x2) && m.p1x2.length === 3) {
    var t = m.p1x2[0] + m.p1x2[1] + m.p1x2[2];
    p1 = m.p1x2[0] / t;
    px = m.p1x2[1] / t;
    p2 = m.p1x2[2] / t;
  }
  cells.sort(function (a, b) {
    return b[2] - a[2];
  });
  var pc = function (x) {
    return Math.round(x * 100);
  };
  return {
    lh: lh,
    la: la,
    p1: pc(p1),
    px: pc(px),
    p2: pc(p2),
    o05: pc(1 - u05),
    o15: pc(1 - u15),
    o25: pc(1 - u25),
    /* 3.9.0 — quota di gol nel 1° tempo ricavata dalle quote del primo tempo, se presente */
    ht05: pc(1 - Math.exp(-(U.finite(m.hts) ? m.hts : P.htShare || 0.45) * ((P.htLeague || {})[m.league] || 1) * (lh + la))),
    gg: pc(gg),
    cs: cells.slice(0, 3).map(function (c) {
      return { s: c[0] + '-' + c[1], p: Math.round(c[2] * 1000) / 10 };
    }),
  };
}
function tipKickoff(m) {
  var t = /^\d{1,2}:\d{2}$/.test(m.time || '') ? m.time : '23:59';
  return new Date(m.date + 'T' + (t.length === 4 ? '0' + t : t) + ':00');
}
var TIP_LM = /*LM*/{"H1":0.4403,"R":{"5":0.9701,"10":0.9267,"15":0.8813,"20":0.8354,"25":0.7892,"30":0.7409,"35":0.6924,"40":0.6423,"42":0.6228,"50":0.5157,"55":0.4584,"60":0.3993,"65":0.344,"70":0.2897,"75":0.2361,"80":0.182,"85":0.1247,"88":0.092},"R1":{"5":0.4104,"10":0.367,"15":0.3216,"20":0.2757,"25":0.2295,"30":0.1811,"35":0.1326,"40":0.0826,"42":0.0631},"K":{"s":9.584,"t":3.29,"b":5.652,"c":3.826,"x":0.978},"models":{"full":{"keys":["xg","xgo","sot","box","sh","cor","soto","gl","rxg","rsot","rsh","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0216,0.0591,0.0215,-0.0055,0.0128,0.0614,0.0365,0.0115,-0.0045,0.0127,-0.0173,0.0292,0.1235,-0.1096,0.1403,0.0713,-0.0028,0.0312,-0.0104,-0.021,-0.0394,0.0617,-0.0093],"c1":0.9827},"noxg":{"keys":["sot","box","sh","cor","soto","gl","rsot","rsh","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0197,0.0,0.0314,0.0692,0.0358,0.0187,0.0083,-0.0148,0.0347,0.1226,-0.1096,0.142,0.0735,-0.0035,0.0332,-0.0109,-0.022,-0.0402,0.0625,-0.0072],"c1":0.9833},"norec":{"keys":["xg","xgo","sot","box","sh","cor","soto","gl","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0148,0.0816,0.0309,-0.0251,0.0016,0.1039,0.036,0.0104,-0.0095,0.2608,-0.2196,0.2452,0.088,0.005,0.047,-0.0236,-0.0393,-0.0574,0.0495,-0.0157],"c1":0.9828},"basic":{"keys":["sot","box","sh","cor","soto","gl","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0131,-0.0174,0.027,0.1176,0.0345,0.0216,0.0097,0.2578,-0.2195,0.2488,0.0926,0.0016,0.0468,-0.0249,-0.0408,-0.0586,0.0514,-0.0143],"c1":0.9834},"book":{"keys":["red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0099,-0.2897,0.2816,0.1023,-0.0028,0.0341,0.0153,-0.0524,-0.0019,0.0302,-0.0044],"c1":0.9995}}}/*LM*/;
var TIP_MIN_ODDS = 1.5;
function tipLmInterp(tab, t) {
  var ks = Object.keys(tab).map(Number).sort(function (a, b) { return a - b; });
  if (t <= ks[0]) return tab[ks[0]];
  for (var i = 1; i < ks.length; i++) if (t <= ks[i]) {
    var a = ks[i - 1], b = ks[i];
    return tab[a] + (tab[b] - tab[a]) * (t - a) / (b - a);
  }
  return tab[ks[ks.length - 1]];
}
function tipRemain(min, half, hts) {
  var M = TIP_LM, H1 = M.H1, R = Object.assign({ 0: 1 }, M.R), R1 = Object.assign({ 0: H1 }, M.R1);
  hts = U.finite(hts) ? hts : H1;
  if (half !== 2 && min < 46 + 6) {
    var t = Math.max(0, min),
      r1 = t <= 42 ? tipLmInterp(R1, t) : R1[42] * Math.max(0, (49 - t) / 7),
      ht = r1 / H1 * hts;
    return { all: ht + (1 - hts), ht: ht, lg: r1 + (1 - H1) };
  }
  var t2 = Math.max(45, min), r2start = 1 - H1, r;
  if (t2 <= 50) r = r2start + (R[50] - r2start) * (t2 - 45) / 5;
  else if (t2 <= 88) r = tipLmInterp(R, t2);
  else r = R[88] * Math.max(0, (98 - t2) / 10);
  return { all: r / (1 - H1) * (1 - hts), ht: 0, lg: r };
}
var TIP_LM_SCALE = { h2: 1.5, h1late: 1.2 };
var TIP_LM_STATE = ['red', 'redo', 'lose', 'win1', 'win2', 'lose_l', 'win_l', 'draw_l', 'fav', 'rg'];
function tipLmCal(p) { return p < 0.7 ? p : 0.7 + (p - 0.7) * 0.82; }
function tipInplay(m, inp, book) {
  var P = tipParams(),
    c = tipCalc(m, P),
    M = TIP_LM;
  var lam = [c.lh, c.la];
  if (book && U.finite(m.lhM) && U.finite(m.laM)) lam = [m.lhM, m.laM];
  var hts = (U.finite(m.hts) ? m.hts : P.htShare || M.H1) * ((P.htLeague || {})[m.league] || 1),
    min = Math.max(0, Math.min(inp.min || 0, 100)),
    half = inp.half || (min > 46 ? 2 : 1),
    R = tipRemain(min, half, hts),
    e = Math.max(0.01, 1 - R.lg),
    S = inp.side || [{}, {}],
    g = [inp.gh || 0, inp.ga || 0],
    has = function (k) { return U.finite(S[0][k]) && U.finite(S[1][k]); },
    hasStats = has('s') || has('t'),
    hasXg = has('xg'),
    pv = inp.prev && inp.prev.side && (inp.prev.half || 1) === half && min - inp.prev.min >= 5 && min - inp.prev.min <= 30 ? inp.prev : null;
  var name = book ? 'book' : !hasStats ? 'book' : hasXg ? (pv ? 'full' : 'norec') : (pv ? 'noxg' : 'basic'),
    mod = M.models[name], K = M.K;
  var lg = function (a, b, cst) { return Math.log(((a || 0) + cst) / (b + cst)); };
  var out = [0, 1].map(function (i) {
    var j = 1 - i, si = S[i] || {}, sj = S[j] || {},
      Ei = lam[i] * e, Ej = lam[j] * e,
      d = g[i] - g[j], late = min >= 60 || half === 2 && min >= 60;
    var f = {
      xg: lg(si.xg, K.x * Ei, 0.4), xgo: lg(sj.xg, K.x * Ej, 0.4),
      sot: lg(si.t, K.t * Ei, 1), box: lg(U.finite(si.b) ? si.b : (si.s || 0) * K.b / K.s, K.b * Ei, 1), sh: lg(si.s, K.s * Ei, 2), cor: lg(si.c, K.c * Ei, 1),
      soto: lg(sj.t, K.t * Ej, 1), gl: lg(g[i], Ei, 0.7),
      poss: U.finite(si.poss) ? Math.max(-0.3, Math.min(0.3, si.poss / 100 - 0.5)) : 0,
      red: (si.red || 0) > 0 ? 1 : 0, redo: (sj.red || 0) > 0 ? 1 : 0,
      lose: d < 0 ? 1 : 0, win1: d === 1 ? 1 : 0, win2: d >= 2 ? 1 : 0,
      lose_l: d < 0 && late ? 1 : 0, win_l: d > 0 && late ? 1 : 0, draw_l: d === 0 && late ? 1 : 0,
      fav: Math.log(lam[i] / lam[j]),
      rg: inp.rg ? 1 : 0,
    };
    if (pv) {
      var p = pv.side[i] || {}, w = Math.max(0.005, tipRemain(pv.min, half, hts).lg - R.lg) * lam[i];
      f.rxg = lg(Math.max(0, (si.xg || 0) - (p.xg || 0)), K.x * w, 0.25);
      f.rsot = lg(Math.max(0, (si.t || 0) - (p.t || 0)), K.t * w, 0.7);
      f.rsh = lg(Math.max(0, (si.s || 0) - (p.s || 0)), K.s * w, 1);
    }
    var x = mod.b[0], parts = [],
      SC = half === 2 ? TIP_LM_SCALE.h2 : min >= 25 ? TIP_LM_SCALE.h1late : 1;
    mod.keys.forEach(function (k, n) {
      var v = (f[k] || 0) * mod.b[n + 1] * (TIP_LM_STATE.indexOf(k) >= 0 ? 1 : SC);
      x += v;
      parts.push({ k: k, v: v });
    });
    x = Math.max(-1.2, Math.min(1.2, x));
    return { all: lam[i] * R.all * Math.exp(x), ht: lam[i] * R.ht * Math.exp(x) * mod.c1, mult: Math.exp(x), parts: parts };
  });
  /* 3.29.0 — correzione dalla simulazione (partite da gol, 60'-70'): il modello era ottimista
     sul pareggio nel 2° tempo (68% contro 65% reale) e soprattutto subito dopo un gol che pareggia
     (68% contro 61%); un po' anche dopo un gol con scarto 1 (69% contro 67%). */
  if (!book && half === 2 && min >= 55) {
    var dd = Math.abs(g[0] - g[1]), kf = 1;
    if (dd === 0) kf = inp.rg ? 0.83 : 0.92;
    else if (dd === 1 && inp.rg) kf = 0.94;
    if (kf !== 1) out.forEach(function (o) { o.all *= kf; o.ht *= kf; o.mult *= kf; });
  }
  var rh = out[0].all, ra = out[1].all, L = rh + ra, Lht = out[0].ht + out[1].ht, p0 = Math.exp(-L),
    G = g[0] + g[1], lines = [];
  lines.push({ k: 'n1', label: 'Over ' + (G + 0.5) + ' finale', sub: 'almeno un altro gol', p: 1 - p0 });
  lines.push({ k: 'n2', label: 'Over ' + (G + 1.5) + ' finale', sub: 'almeno altri due gol', p: 1 - p0 * (1 + L) });
  if (R.ht > 0) {
    var hg = U.finite(inp.hg) ? inp.hg : G;
    lines.push({ k: 'h1', label: 'Over ' + (hg + 0.5) + ' 1° tempo', sub: 'gol prima dell’intervallo', p: 1 - Math.exp(-Lht) });
  }
  if (g[0] === 0 || g[1] === 0) {
    var ph = g[0] > 0 ? 1 : 1 - Math.exp(-rh), pa = g[1] > 0 ? 1 : 1 - Math.exp(-ra);
    lines.push({ k: 'gg', label: 'Goal (entrambe segnano)', sub: g[0] === 0 && g[1] === 0 ? 'servono due gol, uno per parte' : 'deve segnare ' + (g[0] === 0 ? m.home : m.away), p: ph * pa });
  }
  /* 3.21.0 — finestre: gol entro un certo minuto (per giocare a step) */
  var multL = function (t2) {
    var h2 = t2 > 45 ? 2 : 1, Rt = tipRemain(t2, h2, hts).all;
    return Math.max(0, out[0].all * (1 - Rt / Math.max(1e-6, R.all)) + out[1].all * (1 - Rt / Math.max(1e-6, R.all)));
  };
  var wins = half === 2 || min > 45 ? [60, 70, 80] : [30, 60, 70];
  wins.forEach(function (t2) {
    if (t2 < min + 8) return;
    if (half === 1 && t2 === 30 && min > 22) return;
    var Lw = multL(t2);
    lines.push({ k: 'w' + t2, label: 'Gol entro il ' + t2 + '’', sub: 'almeno un gol da qui al ' + t2 + '’', p: 1 - Math.exp(-Lw), Lw: Lw, t2: t2, win: true });
  });
  lines.push({ k: 'nh', label: 'Prossimo gol ' + m.home, sub: '', p: (1 - p0) * (L ? rh / L : 0.5) });
  lines.push({ k: 'na', label: 'Prossimo gol ' + m.away, sub: '', p: (1 - p0) * (L ? ra / L : 0.5) });
  lines.forEach(function (x) {
    if (x.k !== 'nh' && x.k !== 'na') x.p = tipLmCal(x.p);
    x.fair = x.p > 0.001 ? 1 / x.p : null;
  });
  var base = (lam[0] + lam[1]) * R.all;
  /* probabilità (calibrata) di almeno un gol da adesso al minuto t2 */
  var pWin = function (t2) { return tipLmCal(1 - Math.exp(-multL(t2))); };
  return { lgTier: tipLeagueTier(m), goals: G, pWin: pWin, F: L / Math.max(0.001, base), used: hasStats, model: name, recent: !!pv, xg: hasXg, rem: R, L: L, rh: rh, ra: ra, lines: lines, lam: lam[0] + lam[1], teams: out };
}
function tipPoisAtLeast(n, L) {
  var p = 0, t = Math.exp(-L);
  for (var k = 0; k < n; k++) { p += t; t *= L / (k + 1); }
  return 1 - p;
}
function tipNameTok(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\b(fc|fk|sc|sv|ac|as|cf|nk|club|calcio|cd|afc|ssc|us|if|bk|sk)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
function tipNameSim(a, b) {
  var A = tipNameTok(a), B = tipNameTok(b);
  if (!A.length || !B.length) return 0;
  if (A.join('') === B.join('')) return 1;
  var c = A.filter(function (t) { return B.some(function (u) { return u === t || (t.length >= 4 && u.length >= 4 && (u.indexOf(t) === 0 || t.indexOf(u) === 0)); }); }).length;
  return c / Math.min(A.length, B.length);
}
function tipFindApp(home, away, ko) {
  var t = ko ? ko.getTime() : Date.now(), best = null, bs = 0;
  (db.predictions || []).forEach(function (m) {
    if (Math.abs(tipKickoff(m).getTime() - t) > 4 * 3600e3) return;
    var sc = tipNameSim(m.home, home) + tipNameSim(m.away, away);
    if (tipNameSim(m.home, home) >= 0.5 && tipNameSim(m.away, away) >= 0.5 && sc > bs) { bs = sc; best = m; }
  });
  return best;
}
function tipScanMatch(x) {
  var st = x.status;
  if (['1H', 'HT', '2H'].indexOf(st) < 0 || x.elapsed == null) return null;
  var half = st === '1H' ? 1 : 2,
    min = st === 'HT' ? 45 : x.elapsed,
    gh = x.goals[0] || 0, ga = x.goals[1] || 0, G = gh + ga,
    R = tipRemain(min, half, TIP_LM.H1),
    lam = 2.7, src = 'media';
  var ou = x.odds && x.odds.ou, pre = x.odds && x.odds.pre;
  if (pre && pre.lam > 0) {
    /* 3.53.0 — TotalCorner: gol attesi dalla linea gol bet365 pre-partita */
    lam = Math.max(1, Math.min(5.5, pre.lam));
    src = 'quote';
    ou = null;
  } else if (pre && pre.o25 > 1 && pre.u25 > 1) {
    /* quote prepartita Over/Under 2.5 (Bzzoiro): gol attesi della partita intera */
    var p25 = (1 / pre.o25) / (1 / pre.o25 + 1 / pre.u25), a = 0.3, z = 7;
    for (var j = 0; j < 40; j++) { var md = (a + z) / 2; if (tipPoisAtLeast(3, md) < p25) a = md; else z = md; }
    lam = Math.max(1, Math.min(5, (a + z) / 2));
    src = 'quote';
    ou = null;
  }
  if (ou && R.all > 0.03) {
    var need = Math.ceil(ou.line - G);
    if (need >= 1) {
      var po = (1 / ou.o) / (1 / ou.o + 1 / ou.u), lo = 0.01, hi = 8;
      for (var i = 0; i < 40; i++) { var mid = (lo + hi) / 2; if (tipPoisAtLeast(need, mid) < po) lo = mid; else hi = mid; }
      lam = Math.max(0.8, Math.min(5.5, (lo + hi) / 2 / R.all));
      src = 'quote live';
    }
  }
  var sh = 0.53, x12 = (pre && pre.x12) || (x.odds && x.odds.x12);
  if (x12 && (gh === ga || (pre && pre.x12))) {
    var ih = 1 / x12[0], ia = 1 / x12[2], sum = ih + 1 / x12[1] + ia;
    sh = Math.max(0.25, Math.min(0.75, 0.5 + 0.45 * (ih - ia) / sum));
  }
  var ko = x.kickoff ? new Date(x.kickoff) : new Date();
  var m = {
    id: 'scan_' + x.afId, afId: x.afId, scan: true, scanSrc: src,
    home: x.home, away: x.away, league: (x.country ? x.country + ' · ' : '') + x.league,
    date: ko.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }),
    time: ko.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }),
    lh: lam * sh, la: lam * (1 - sh), rel: 'C',
  };
  /* 3.24.1 — se la partita è anche nei pronostici, uso quella: stessa forza prepartita
     (statistiche + quote + contesto) e stesso risultato, da qualunque parte la apri */
  var am = tipFindApp(x.home, x.away, ko);
  if (am) {
    m = am;
    tipUI.scanLink = tipUI.scanLink || {};
    tipUI.scanLink[am.id] = x.afId;
  }
  /* i dati live della scansione valgono come una sincronizzazione, ma non sovrascrivono una sincronizzazione più recente */
  tipUI.liveData = tipUI.liveData || {};
  var scanAt = (tipUI.scan && tipUI.scan.at) || Date.now(), have = tipUI.liveData[m.id];
  var dd = { afId: x.afId, status: st, elapsed: x.elapsed, goals: x.goals, stats: x.stats, lastGoal: x.lastGoal, at: scanAt };
  if (have && have.at > scanAt && have.elapsed != null) dd = have;
  else if (x.stats) tipUI.liveData[m.id] = dd;
  var inp = tipLiveInput(m, dd);
  min = inp.min; half = inp.half; gh = inp.gh; ga = inp.ga;
  var r = tipInplay(m, inp),
    main = r.lines.find(function (y) { return y.k === (r.rem.ht > 0 ? 'h1' : 'n1'); }) || r.lines[0];
  return { m: m, x: Object.assign({}, x, { goals: dd.goals || x.goals, elapsed: dd.elapsed, status: dd.status || x.status, stats: dd.stats || x.stats }), min: min, half: half, main: main, r: r };
}
function tipIsStar(m) {
  if (!m) return false;
  var lid = m.scan ? m.afId : (tipUI.scanLink || {})[m.id] || m.afId;
  if (!m.scan) {
    var cur = (db.predictions || []).find(function (x) { return x.id === m.id; });
    if (cur && cur.star) return true;
  }
  return !!lid && tipLiveStars().some(function (z) { return z.afId === lid; });
}
function tipLiveStars() {
  var cut = Date.now() - 14 * 3600e3;
  return ((db.predModel || {}).liveStars || []).filter(function (x) { return x.at > cut; });
}
var TIP_PLAY_THR = {
  t1s15: { 15: 61, 20: 57, 25: 51, 30: 44, 35: 34, 40: 23 },
  t1s18: { 15: 54, 20: 53, 25: 50, 30: 43, 35: 34, 40: 23 },
  t1st: { 10: 68, 15: 63, 20: 58, 25: 52, 30: 44 },
  t2st3: { 45: 80, 50: 79, 55: 75 },
  t2st2: { 50: 77, 55: 75, 60: 71, 65: 65, 70: 59, 75: 52 },
  t2u15: { 46: 65, 55: 65, 60: 64, 65: 62, 70: 58, 75: 52, 80: 43, 85: 32 },
  t2u18: { 46: 54, 60: 54, 65: 53, 70: 53, 75: 50, 80: 43, 85: 32 },
};
var TIP_PLAY_NAME = {
  t1st: '1° tempo · step (gol entro X’, poi entro l’intervallo)',
  t1s15: '1° tempo · gol entro l’intervallo, quota ≥ 1.50',
  t1s18: '1° tempo · gol entro l’intervallo, quota ≥ 1.80',
  t2st3: '2° tempo · step 60’ → 80’ → fine',
  t2st2: '2° tempo · mezzo step 80’ → fine',
  t2u15: '2° tempo · unico, altro gol entro la fine a quota ≥ 1.50',
  t2u18: '2° tempo · unico, altro gol entro la fine a quota ≥ 1.80',
  t2w: '2° tempo · aspetta e gioca l’unico a quota 1.50',
  t1w: '1° tempo · aspetta e gioca il gol entro l’intervallo a quota 1.50',
};
var TIP_PLAY_SHORT = { t2w: 'aspetta unico', t1w: 'aspetta 1T', t1st: 'step 1T', t1s15: '1T ≥1.50', t1s18: '1T ≥1.80', t2st3: 'step 60-80-fine', t2st2: 'step 80-fine', t2u15: 'unico ≥1.50', t2u18: 'unico ≥1.80' };
function tipPlayBest(plays) { return (plays || []).filter(function (x) { return x.green || x.warm; })[0] || null; }
function tipPlayKey(id, ctx) { return id + '|' + (ctx.half || 1) + '|' + (ctx.gh || 0) + '-' + (ctx.ga || 0); }
function tipPlayGroup(e) { return e.id + '|' + (e.half || 1) + '|' + (e.gh || 0) + '-' + (e.ga || 0); }
function tipPlayFind(id, ctx) {
  var g = tipPlayKey(id, ctx);
  return (((db.predModel || {}).playLog) || []).filter(function (e) { return tipPlayGroup(e) === g; })
    .sort(function (a, b) { return (a.tier === 'try' ? 1 : 0) - (b.tier === 'try' ? 1 : 0) || (a.t || 0) - (b.t || 0); })[0] || null;
}
function tipPlayEntry(m, ctx, x, lid) {
  return { key: tipPlayKey(m.id, ctx), id: m.id, afId: lid, home: m.home, away: m.away, league: m.league, date: m.date, time: m.time,
    k: x.k, tier: x.green ? 'excellent' : 'try', conditional: !!x.at, costly: !!x.costly, res: (x.at || x.costly || x.lowBook) ? 'skip' : null, min: ctx.min, half: ctx.half, gh: ctx.gh || 0, ga: ctx.ga || 0, p: Math.round((x.evalP == null ? x.p : x.evalP) * 1000) / 1000, rawP: Math.round(x.p * 1000) / 1000,
    legs: x.legs.map(function (l) { return Math.round(l.p * 1000) / 1000; }), at: x.at, ts: x.ts, minQ: x.minQ ? Math.round(x.minQ * 100) / 100 : undefined, book: x.book || undefined,
    risk: Math.round(x.cost.risk * 100) / 100, win: Math.round(x.cost.win * 100) / 100, t: Date.now() };
}
function tipPlayThr(k, min) { var t = TIP_PLAY_THR[k]; return t ? tipLmInterp(t, min) / 100 : 1; }
function tipLiveSafety(r, min, half, x) {
  if (!r || !r.used) return 'statistiche live assenti';
  if (!r.xg && !r.recent) return 'mancano xG e andamento recente dei tiri';
  if (!U.finite(r.L) || !U.finite(r.F)) return 'stima live non disponibile';
  if (half === 1 && (min < 15 || min >= 45)) return 'finestra del primo tempo non attiva';
  if (half === 2 && (min < 45 || min >= 90)) return 'finestra del secondo tempo non attiva';
  if (x && x.k === 't2st3' && min > 55) return 'ingresso nello step 60–80–fine non piu disponibile';
  if (x && x.k === 't2st2' && min > 75) return 'ingresso nello step 80–fine non piu disponibile';
  if (x && x.at && x.at <= min) return 'orario di ingresso da rivalutare';
  return null;
}
function tipPlayEstimate(r, min, half, x) {
  if (!x || !U.finite(x.p)) return null;
  return Math.max(0, Math.min(1, x.p));
}
var TIP_GREEN_MINP = 0.50;
var TIP_GREEN_MINP_1T = 0.55;
function tipMinP(x) { return x && x.k && x.k.indexOf('t1') === 0 ? TIP_GREEN_MINP_1T : TIP_GREEN_MINP; }
var TIP_LG_MAJOR = /la ?liga|laliga|segunda divisi|serie a|serie b|bundesliga|3\. liga|ligue 1|ligue 2|eredivisie|eerste divisie|keuken|primeira liga|liga portugal|super lig|eliteserien|allsvenskan|superettan|veikkausliiga|ekstraklasa|scottish premiership|\bmls\b|major league soccer|usl championship|brasileir|liga mx|j1 league|j2 league|k league 1|a-league|saudi pro|uae pro|champions league|europa league|conference league|copa libertadores|copa sudamericana|nations league|world cup|besta deild|urvalsdeild|úrvalsdeild|challenge league|chinese super league|2\. liga/i;
var TIP_LG_GENERIC = /premier league|championship|league one|league two|super ?league|superliga|pro league|first league|primera divisi|liga profesional|1\. liga|first division|division 1/i;
var TIP_LG_COUNTRY = /england|scotland|spain|italy|germany|france|netherlands|holland|portugal|belgium|turkey|denmark|norway|sweden|finland|poland|austria|switzerland|greece|czech|croatia|serbia|romania|hungary|iceland|usa|brazil|argentina|mexico|japan|korea|australia|china|saudi|qatar|ukraine|scottish|english|spanish|italian|german|french|dutch|swiss|danish|swedish|norwegian/i;
var TIP_LG_YOUTH = /\bu-?1[5-9]\b|\bu-?2[0-3]\b|under ?1[5-9]|under ?2[0-3]|youth|junior|primavera|reserve|reserves|\bii\b|\bb team\b|jong |academy|amateur|regional|women|femenin|feminin|frauen|w$|\(w\)/i;
var TIP_LG_STRONG = /england|english|spain|spanish|italy|italian|germany|german|france|french|netherlands|dutch|holland|portugal|belgium|brazil|argentina|japan|scotland|denmark|sweden|norway|austria|switzerland|swiss|turkey|usa|mexico|croatia|serbia|czech|poland|korea|australia/i;
function tipLeagueStrong(m) { return TIP_LG_STRONG.test(String((m && m.league) || '')); }
function tipLeagueTier(m) {
  var t = String((m && m.league) || '') + ' ' + String((m && m.home) || '') + ' ' + String((m && m.away) || '');
  if (TIP_LG_YOUTH.test(t)) return tipLeagueStrong(m) ? 'youth+' : 'youth';
  var lg = String((m && m.league) || '');
  if (TIP_LG_MAJOR.test(lg)) return 'major';
  if (TIP_LG_GENERIC.test(lg) && TIP_LG_COUNTRY.test(lg)) return 'major';
  return tipLeagueStrong(m) ? 'minor+' : 'minor';
}
var TIP_LG_EXTRA = { major: 0, 'minor+': 0.04, minor: 0.07, 'youth+': 0.06, youth: 0.10 };
function tipGreenFloor(x) {
  var f = Math.max(tipMinP(x), x.thr) + (TIP_LG_EXTRA[x.lg] || 0);
  /* 3.55.0 — partite che hanno già segnato tanto (3+ gol): il gol successivo non è più probabile, serve margine */
  if (x.goals >= 3) f += 0.05;
  return Math.min(0.9, f);
}
var TIP_LAM_MIN = { major: 2.2, 'minor+': 2.5, 'youth+': 2.6, minor: 2.7, youth: 2.8 };
function tipPlayTier(r, min, half, x) {
  if (!x || !U.finite(x.p) || !U.finite(x.thr)) return 'none';
  if (tipLiveSafety(r, min, half, x)) return 'none';
  var p = U.finite(x.evalP) ? x.evalP : tipPlayEstimate(r, min, half, x);
  if (!U.finite(p) || p < tipAmberFloor(x)) return 'none';
  /* 3.62.0 — gol attesi prima della partita (dalle quote): nei campionati minori e giovanili
     le partite che il book prezza "da pochi gol" non si chiamano, anche se le statistiche live spingono. */
  if (U.finite(x.lamPre) && x.lamPre < (TIP_LAM_MIN[x.lg] || TIP_LAM_MIN.major)) return 'none';
  /* quota live del book molto più alta di quanto pensa il modello: il book sa qualcosa, si scarta */
  if (x.book && x.lg !== 'major' && 1 / (x.book * 1.05) < p - 0.12) return 'none';
  if (x.at || x.costly || x.lowBook) return 'try';
  /* Non usare una soglia assoluta irraggiungibile per mercati a quota minima.
     Il verde richiede margine positivo + osservazioni live disponibili. */
  if (p >= tipGreenFloor(x) && (r.xg || r.recent)) return 'excellent';
  return 'try';
}
function tipAmberFloor(x) { return Math.max(TIP_GREEN_MINP, x.thr + ({ youth: 0.04, 'youth+': 0.02, minor: 0.02, 'minor+': 0.01 }[x.lg] || 0), tipGreenFloor(x) - 0.05); }
function tipDecisionThresholds(x) {
  return 'Per DA VALUTARE ≥' + Math.ceil(tipAmberFloor(x) * 1000) / 10 +
    '% · per OTTIMA ≥' + Math.round(tipGreenFloor(x) * 100) + '%';
}
function tipPlayDecision(r, min, half, x) {
  var p = U.finite(x.evalP) ? x.evalP : x.p;
  if (x.warm && x.at) return 'DA VALUTARE · IN ATTESA: rivalutare al ' + x.at + '’; non entrare adesso';
  if (x.warm && x.costly) return 'DA VALUTARE · STEP COSTOSO: rischi ' + Math.round(x.cost.risk) + '€ per vincerne ' + Math.round(x.cost.win) + ' · progressione non consigliata';
  if (x.warm && x.lowBook) return 'DA VALUTARE · il book paga ' + x.book.toFixed(2) + ', sotto la quota minima ' + x.minQ.toFixed(2) + ': aspetta che salga';
  if (x.green) return 'OTTIMA · stima ' + Math.round(p * 100) + '% sopra la soglia del minuto (' + Math.round(x.thr * 100) + '%)' + (x.book ? ' · book ' + x.book.toFixed(2) + ' ✓' : ' · gioca solo se il book paga almeno la quota minima');
  if (x.warm) return 'DA VALUTARE · stima ' + Math.round(p * 100) + '% · ' + tipDecisionThresholds(x);
  var blocker = tipLiveSafety(r, min, half, x);
  if (blocker) return 'Non consigliata: ' + blocker + ' · ' + tipDecisionThresholds(x);
  if (!U.finite(p) || !U.finite(x.thr)) return 'Non consigliata: stima non disponibile';
  if (p < tipAmberFloor(x)) return 'Non consigliata: stima ' + Math.round(p * 100) + '% inferiore al minimo per DA VALUTARE (' + (Math.ceil(tipAmberFloor(x) * 1000) / 10) + '%)';
  return 'Non consigliata: requisiti non raggiunti · ' + tipDecisionThresholds(x);
}
function tipPlays(r, min, half, book) {
  var out = [], Q = TIP_MIN_ODDS, ok = function (p) { return p > 0.02 && 1 / p >= Q; };
  var h1 = (r.lines.find(function (x) { return x.k === 'h1'; }) || {}).p, n1 = (r.lines.find(function (x) { return x.k === 'n1'; }) || {}).p;
  /* 3.34.0 — costo: puntate a step che recuperano le perdite e vincono sempre come il primo step.
     Base = puntata del primo step (10€ di default). rischio = somma delle puntate se perdono tutti. */
  var base = (tipUI.step && tipUI.step.s1) || 10;
  var cost = function (legs) {
    var q = legs.map(function (l) { return Math.max(TIP_MIN_ODDS, 1 / l.p); }), win = base * (q[0] - 1), spent = 0, st = [];
    q.forEach(function (qq, i) { var sk = i === 0 ? base : (win + spent) / (qq - 1); st.push(sk); spent += sk; });
    return { stakes: st, risk: spent, win: win, ratio: spent / win };
  };
  var add = function (k, p, legs, note, thrK, thrMin) {
    var thr = tipPlayThr(thrK || k, thrMin || min), c = cost(legs);
    /* 3.48.0 — step costoso: rischio oltre 2,5 volte la vincita oppure oltre 4 puntate base */
    var x = { k: k, name: TIP_PLAY_NAME[k], short: TIP_PLAY_SHORT[k], p: p, legs: legs, thr: thr, note: note || '', cost: c, costly: legs.length > 1 && (c.ratio > 2.5 || c.risk > 4 * base) };
    x.lg = r.lgTier || 'major'; x.goals = r.goals || 0; x.lamPre = U.finite(r.lam) ? r.lam : null;
    x.minQ = Math.max(k === 't2u18' || k === 't1s18' ? 1.8 : TIP_MIN_ODDS, 1 / Math.max(0.01, legs[0].p));
    /* 3.48.0 — quota live del book: se c'è ed è sotto la minima, al massimo DA VALUTARE */
    if (book && U.finite(book.n1) && book.n1 > 1 && (k === 't2u15' || k === 't2u18')) { x.book = book.n1; x.lowBook = book.n1 < x.minQ; }
    x.evalP = tipPlayEstimate(r, min, half, x); x.tier = tipPlayTier(r, min, half, x); x.green = x.tier === 'excellent'; x.warm = x.tier === 'try'; out.push(x);
  };
  if (half === 1 && h1 != null) {
    if (min >= 15 && min <= 35) { /* 3.48.0 — niente gol 1T secco dopo il 35' */
      if (1 / h1 >= 1.5) add('t1s15', h1, [{ l: 'gol entro l’intervallo', p: h1 }]);
      if (1 / h1 >= 1.8) add('t1s18', h1, [{ l: 'gol entro l’intervallo', p: h1 }]);
    }
    if (min >= 10 && min <= 30) {
      var bestS = null;
      for (var t1 = 25; t1 <= 40; t1 += 5) {
        if (t1 < min + 5) continue;
        var a1 = r.pWin(t1), a2 = 1 - (1 - h1) / Math.max(1e-6, 1 - a1);
        if (ok(a1) && ok(a2) && (!bestS || Math.abs(a1 - a2) < bestS.d)) bestS = { t: t1, a1: a1, a2: a2, d: Math.abs(a1 - a2) }; /* step bilanciati */
      }
      if (bestS) { add('t1st', h1, [{ l: 'gol entro il ' + bestS.t + '’', p: bestS.a1 }, { l: 'se no, entro l’intervallo', p: bestS.a2 }]); out[out.length - 1].ts = [bestS.t, 45]; }
    }
  }
  if (half === 2 && n1 != null) {
    var w60 = r.pWin(60), w80 = r.pWin(80);
    if (min <= 55) {
      var b1 = w60, b2 = 1 - (1 - w80) / Math.max(1e-6, 1 - w60), b3 = 1 - (1 - n1) / Math.max(1e-6, 1 - w80);
      if (ok(b1) && ok(b2) && ok(b3)) add('t2st3', n1, [{ l: 'gol entro il 60’', p: b1 }, { l: 'se no, entro l’80’', p: b2 }, { l: 'se no, entro la fine', p: b3 }]);
    }
    if (min >= 50 && min <= 75) {
      var c1 = w80, c2 = 1 - (1 - n1) / Math.max(1e-6, 1 - w80);
      if (ok(c1) && ok(c2)) add('t2st2', n1, [{ l: 'gol entro l’80’', p: c1 }, { l: 'se no, entro la fine', p: c2 }]);
    }
    if (min <= 88) {
      if (1 / n1 >= 1.5) add('t2u15', n1, [{ l: 'altro gol entro la fine', p: n1 }]);
      if (1 / n1 >= 1.8) add('t2u18', n1, [{ l: 'altro gol entro la fine', p: n1 }]);
    }
    /* aspetta che l'unico arrivi a quota 1.50: se segnano prima non giochi (niente perso) */
    if (1 / n1 < 1.5 && min <= 82) {
      for (var tw = Math.ceil(min) + 3; tw <= 85; tw++) {
        var pc = 1 - (1 - n1) / Math.max(1e-6, 1 - r.pWin(tw));
        if (pc > 0 && 1 / pc >= 1.5) { add('t2w', pc, [{ l: 'al ' + tw + '’ se ancora nessun gol: altro gol entro la fine', p: pc }], 'se segnano prima non giochi e non perdi niente', 't2u15', tw); out[out.length - 1].at = tw; out[out.length - 1].tier = tipPlayTier(r, min, half, out[out.length - 1]); out[out.length - 1].green = false; out[out.length - 1].warm = out[out.length - 1].tier === 'try'; break; }
      }
    }
  }
  if (half === 1 && h1 != null && min >= 10 && min <= 36 && 1 / h1 < 1.5) {
    for (var tw1 = Math.ceil(Math.max(min, 15)) + 2; tw1 <= 40; tw1++) {
      var pc1 = 1 - (1 - h1) / Math.max(1e-6, 1 - r.pWin(tw1));
      if (pc1 > 0 && 1 / pc1 >= 1.5) { add('t1w', pc1, [{ l: 'al ' + tw1 + '’ se ancora nessun gol: gol entro l’intervallo', p: pc1 }], 'se segnano prima non giochi e non perdi niente', 't1s15', tw1); out[out.length - 1].at = tw1; out[out.length - 1].tier = tipPlayTier(r, min, half, out[out.length - 1]); out[out.length - 1].green = false; out[out.length - 1].warm = out[out.length - 1].tier === 'try'; break; }
    }
  }
  /* ordine: prima le ottime; tra queste conta anche il costo (gli step costosi scendono) */
  var score = function (x) { return (x.p - x.thr) - (x.costly ? 0.02 * (x.cost.ratio - 2) : 0); };
  out.sort(function (a, b) { return ((b.green ? 2 : b.warm ? 1 : 0) - (a.green ? 2 : a.warm ? 1 : 0)) || score(b) - score(a) || b.p - a.p; });
  /* se uno step ottimo costa troppo e c'è l'attesa per l'unico, consiglia l'attesa */
  out.forEach(function (x) {
    if (!x.costly) return;
    var w = out.find(function (y) { return (y.k === 't2w' && x.k.indexOf('t2') === 0) || (y.k === 't1w' && x.k.indexOf('t1') === 0); });
    if (w) x.alt = 'costa troppo: meglio aspettare il ' + w.at + '’ e fare l’unico (' + Math.round(w.p * 100) + '%)';
  });
  return out;
}
function tipQuickAction(y) {
  /* 3.33.0 — la giocata migliore del momento tra i tipi di giocata (verde = ottima per quel minuto) */
  var pl = tipPlays(y.r, y.min, y.half);
  y.plays = pl;
  var g = pl.filter(function (x) { return x.green || x.warm; })[0];
  if (!g) return { k: 'no', t: 'no', c: 'negative', p: pl[0] ? pl[0].p : 0, w: y.half === 1 ? '1T' : 'fine', s: tipLiveSafety(y.r, y.min, y.half) || 'nessun segnale sufficientemente solido' };
  var gl = (y.x && y.x.goals) || ((tipUI.liveData || {})[y.m && y.m.id] || {}).goals || [0, 0],
    prev = y.m ? tipPlayFind(y.m.id, { half: y.half, gh: gl[0] || 0, ga: gl[1] || 0 }) : null;
  return { k: g.k, t: (g.green ? 'OTTIMA' : 'DA VALUTARE') + ' · ' + Math.round((g.evalP == null ? g.p : g.evalP) * 100) + '%', c: g.green ? 'positive' : 'tip-amber-text', p: g.p, w: g.k.indexOf('t1') === 0 ? '1T' : 'fine',
    s: g.short + ({ youth: ' · giovanili: soglia alta', 'youth+': ' · giovanili (paese forte): soglia media', minor: ' · campionato minore: soglia alta', 'minor+': ' · serie minore (paese forte): soglia media' }[g.lg] || '') + (prev && prev.k !== g.k ? ' · già segnalata al ' + prev.min + '’ (' + (TIP_PLAY_SHORT[prev.k] || prev.k) + ')' : '') };
}
function tipLiveInput(m, d) {
  var half = d.status === '2H' || d.status === 'HT' || d.status === 'ET' || Number(d.elapsed) > 46 ? 2 : 1,
    min = d.status === 'HT' ? 45 : Number(d.elapsed);
  var inp = { min: min, half: half, gh: (d.goals && d.goals[0]) || 0, ga: (d.goals && d.goals[1]) || 0 };
  if (d.stats && d.stats.side) inp.side = d.stats.side;
  if (d.lastGoal != null && min - d.lastGoal >= 0 && min - d.lastGoal <= 5) inp.rg = true;
  var pv = tipLivePrev(m.id, min, half);
  if (pv) inp.prev = pv;
  return inp;
}
function tipLiveHist(id, snap) {
  var all = {};
  try { all = JSON.parse(localStorage.getItem('tipLiveHist') || '{}') || {}; } catch (e) { all = {}; }
  if (snap) {
    var L = (all[id] = (all[id] || []).filter(function (x) { return x.min !== snap.min || x.half !== snap.half; }));
    L.push(snap);
    if (L.length > 12) L.splice(0, L.length - 12);
    var cut = Date.now() - 4 * 3600e3;
    Object.keys(all).forEach(function (k) { all[k] = all[k].filter(function (x) { return x.at > cut; }); if (!all[k].length) delete all[k]; });
    try { localStorage.setItem('tipLiveHist', JSON.stringify(all)); } catch (e) { /* solo comodità */ }
  }
  return all[id] || [];
}
function tipLiveHistMany(list) {
  if (!list.length) return;
  var all = {};
  try { all = JSON.parse(localStorage.getItem('tipLiveHist') || '{}') || {}; } catch (e) { all = {}; }
  list.forEach(function (it) {
    var snap = it.snap, L = (all[it.id] = (all[it.id] || []).filter(function (x) { return x.min !== snap.min || x.half !== snap.half; }));
    L.push(snap);
    if (L.length > 12) L.splice(0, L.length - 12);
  });
  var cut = Date.now() - 4 * 3600e3;
  Object.keys(all).forEach(function (k) { all[k] = all[k].filter(function (x) { return x.at > cut; }); if (!all[k].length) delete all[k]; });
  try { localStorage.setItem('tipLiveHist', JSON.stringify(all)); } catch (e) { /* solo comodità */ }
}
function tipLivePrev(id, min, half) {
  var L = tipLiveHist(id).filter(function (x) { return (x.half || 1) === half && min - x.min >= 5 && min - x.min <= 30; });
  /* la più vicina a 15 minuti fa */
  L.sort(function (a, b) { return Math.abs(min - a.min - 15) - Math.abs(min - b.min - 15); });
  return L[0] || null;
}

/* ===================== Avvisi ===================== */
const TIP_SHORT = TIP_PLAY_SHORT;
async function getState(k: string) {
  const { data } = await admin.from("pronostici_stato").select("v").eq("k", k).maybeSingle();
  return data?.v ?? null;
}
async function setState(k: string, v: unknown) {
  await admin.from("pronostici_stato").upsert({ k, v, updated_at: new Date().toISOString() });
}
async function send(sub: any, payload: unknown) {
  if (!vapidOk) return "novapid";
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 10, urgency: "high" },
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
function message(e: any, x: any, upgraded: boolean) {
  /* 3.61.0 — notifica essenziale: tipo e colore, partita, risultato e minuto, campionato */
  void x;
  const lines = [`${e.gh}-${e.ga} al ${e.min}'`, `${e.league || ""}`];
  return {
    title: `${e.tier === "excellent" ? "🟢 OTTIMA" : "🟠 DA VALUTARE"} · ${e.home} – ${e.away}`,
    body: lines.filter(Boolean).join("\n"),
    upgraded,
    tag: "bet-live-" + (e.afId || e.id),
    renotify: true,
    url: "./?live=" + encodeURIComponent(e.afId || ""),
  };
}

async function loadData(userId: string) {
  const { data } = await admin.from("app_data").select("data").eq("app", APP).eq("user_id", userId).maybeSingle();
  return data?.data ?? null;
}

/* 3.57.0 — TotalCorner: una sola lettura delle partite live per giro, salvata e riusata dall'app
   (azione "scan"); se TotalCorner dice "troppe richieste" ci si ferma 3 minuti. */
async function tcBlocked() { const b: any = await getState("tcBlock"); return b && b.until > Date.now(); }
async function tcBlock(e: any) { if (/rateLimit|troppe/.test(String(e?.message || e))) await setState("tcBlock", { until: Date.now() + 3 * 60e3 }); }
let liveCache: any[] | null = null;
async function runCron() {
  let pre: any = null, liveErr: any = null;
  if (TC_TOKEN) {
    if (await tcBlocked()) return { note: "TotalCorner in pausa per il limite di richieste" };
    try { liveCache = await scanList(); await setState("tcLive", { at: Date.now(), live: liveCache }); }
    catch (e) { liveErr = (e as Error).message; await tcBlock(e); return { error: liveErr }; }
  }
  try {
    if (TC_TOKEN) { const st: any = await tcPrematchStep(false); const f: any = await getState("prematch"); pre = { at: f?.generatedAt, matches: f?.matches?.length, day: st.day, page: st.page, done: st.done }; }
    else { const f: any = await getPrematch(false); pre = { at: f.generatedAt, matches: f.matches?.length }; }
  } catch (e) { pre = { error: (e as Error).message }; await tcBlock(e); }
  let res: any;
  try { res = await runAlerts(); } catch (e) { res = { error: (e as Error).message }; }
  res.prematch = pre;
  res.bzRemaining = bzRem;
  res.tcCalls = tcCalls; res.tcRemaining = tcRem; res.tcOffset = tcOff;
  if (bzRem != null) await setState("bzRemaining", { v: bzRem, at: Date.now() });
  return res;
}
async function runAlerts() {
  const { data: subs, error } = await admin.from("push_subscriptions").select("*").eq("app", APP).eq("enabled", true);
  if (error) return { error: error.message };
  const byUser = new Map<string, any[]>();
  for (const s of subs || []) { if (!byUser.has(s.user_id)) byUser.set(s.user_id, []); byUser.get(s.user_id)!.push(s); }
  const users: { id: string; data: any; prefs: any; subs: any[] }[] = [];
  for (const [uid, ss] of byUser) {
    const d = await loadData(uid);
    const prefs = Object.assign({ on: false, amber: false, stars: false }, d?.predModel?.alerts || {});
    if (prefs.on) users.push({ id: uid, data: d, prefs, subs: ss });
  }
  if (!users.length) return { users: 0, note: "nessuno ha gli avvisi attivi" };
  if (!BZ_KEY && !TC_TOKEN) return { error: "manca il segreto TOTALCORNER_TOKEN" };

  const now = Date.now();
  const list = liveCache || await scanList();
  const oddsCache = new Map<string, number | null>();
  let sent = 0, newSig = 0, evaluated = 0;
  for (const u of users) {
    /* stato del motore per questo utente: i suoi pronostici, i suoi parametri, lo storico delle scansioni */
    db = { predictions: (u.data?.predictions || []).filter((m: any) => m && m.date && Math.abs(Date.parse(m.date) - now) < 2 * 86400e3), predModel: u.data?.predModel || {} };
    tipUI = { view: "open", panel: "live", scan: { at: now, list }, liveData: {}, scanLink: {}, step: { s1: 10 } };
    for (const k of Object.keys(__ls)) delete __ls[k];
    const hist = (await getState("hist:" + u.id)) || {};
    __ls["tipLiveHist"] = JSON.stringify(hist);

    const since = new Date(now - 8 * 3600e3).toISOString();
    const { data: old } = await admin.from("pronostici_segnali").select("key,tier").eq("user_id", u.id).gte("created_at", since);
    const known = new Map((old || []).map((r: any) => [r.key, r.tier]));
    const snaps: any[] = [];
    for (const x of list) {
      if (!x.stats) continue;
      let y: any = null;
      try { y = tipScanMatch(x); } catch (e) { console.error("motore", x.afId, (e as Error).message); continue; }
      if (!y) continue;
      evaluated++;
      if (y.x.stats && y.x.stats.side && y.min != null) snaps.push({ id: y.m.id, snap: { min: y.min, half: y.half, side: y.x.stats.side, at: now } });
      if (y.half === 1 && y.min < 15) continue;
      let plays = tipPlays(y.r, y.min, y.half);
      let best = tipPlayBest(plays);
      if (!best) continue;
      if (u.prefs.stars && !tipIsStar(y.m)) continue;
      const G = (y.x.goals[0] || 0) + (y.x.goals[1] || 0);
      if (best.green && (best.k === "t2u15" || best.k === "t2u18") && G > 0) {
        if (!oddsCache.has(x.afId)) oddsCache.set(x.afId, await bookN1(x.afId, G));
        const q = oddsCache.get(x.afId);
        if (q) { plays = tipPlays(y.r, y.min, y.half, { n1: q }); best = tipPlayBest(plays); if (!best) continue; }
      }
      const ctx = { min: y.min, half: y.half, gh: y.x.goals[0] || 0, ga: y.x.goals[1] || 0 };
      const e = tipPlayEntry(y.m, ctx, best, x.afId);
      e.src = "server";
      e.t = now;
      const was = known.get(e.key);
      const upgraded = was === "try" && e.tier === "excellent";
      if (was && !upgraded) continue;
      const wantPush = e.tier === "excellent" || (u.prefs.amber && e.tier === "try");
      const row = { user_id: u.id, key: e.key, tier: e.tier, data: e, updated_at: new Date().toISOString(), pushed: wantPush ? e.tier : null };
      const { error: insErr } = await admin.from("pronostici_segnali").upsert(row, { onConflict: "user_id,key" });
      if (insErr) { console.error("segnali", insErr.message); continue; }
      known.set(e.key, e.tier);
      newSig++;
      if (wantPush) for (const s of u.subs) if ((await send(s, message(e, best, upgraded))) === "ok") sent++;
    }
    /* storico delle scansioni (serve al modello completo dopo 5 minuti) */
    if (snaps.length) {
      tipLiveHistMany(snaps);
      try { await setState("hist:" + u.id, JSON.parse(__ls["tipLiveHist"] || "{}")); } catch { /* ok */ }
    }
  }
  /* pulizia: segnali più vecchi di 10 giorni */
  if (new Date(now).getUTCMinutes() < 3) await admin.from("pronostici_segnali").delete().lt("created_at", new Date(now - 10 * 86400e3).toISOString());
  return { users: users.length, live: list.length, evaluated, newSignals: newSig, sent, bzCalls };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  const cron = req.headers.get("x-cron-secret");
  if (cron) {
    /* segreto del giro: creato da avvisi.sql nella tabella pronostici_stato (oppure uno dei segreti delle altre app) */
    const own: any = await getState("cron_secret");
    const okSecret = [env("CRON_SECRET"), env("GYM_CRON_SECRET"), env("BET_CRON_SECRET"), typeof own === "string" ? own : ""].some((s) => s && s === cron);
    if (!okSecret) return json({ error: "Segreto non valido" }, 401);
    bzCalls = 0;
    try { return json(await runCron()); } catch (e) { console.error(e); return json({ error: (e as Error).message }, 500); }
  }
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: au, error } = await admin.auth.getUser(bearer);
  if (error || !au?.user) return json({ error: "Accesso non valido: rifai l'accesso alla sincronizzazione." }, 401);
  let body: any = {};
  try { body = await req.json(); } catch { /* vuoto */ }
  if (body.action === "signals") {
    const since = Number(body.since) || Date.now() - 2 * 86400e3;
    const { data, error: e2 } = await admin.from("pronostici_segnali").select("data,updated_at").eq("user_id", au.user.id)
      .gte("updated_at", new Date(since - 60e3).toISOString()).order("updated_at", { ascending: true }).limit(300);
    if (e2) return json({ error: e2.message }, 500);
    const rem: any = await getState("bzRemaining");
    return json({ signals: (data || []).map((r: any) => r.data), bzRemaining: rem?.v ?? null });
  }
  if (body.action === "scan") {
    /* l'app legge le partite live già scaricate dal giro (al massimo 2-3 minuti fa): nessuna richiesta in più a TotalCorner */
    const c: any = await getState("tcLive");
    if (c && c.live && Date.now() - c.at < 5 * 60e3) return json({ live: c.live, at: c.at, source: "totalcorner-cache" });
    return json({ error: "Dati live non ancora pronti: il giro ogni 2 minuti li aggiorna." }, 503);
  }
  if (body.action === "prematch") {
    try {
      const f: any = await getPrematch(!!body.force);
      const rem: any = await getState("bzRemaining");
      return json(Object.assign({}, f, { bzRemaining: bzRem ?? rem?.v ?? null }));
    } catch (e) { return json({ error: (e as Error).message }, 500); }
  }
  if (body.action === "test") {
    const { data: subs } = await admin.from("push_subscriptions").select("*").eq("app", APP).eq("user_id", au.user.id).eq("enabled", true);
    if (!subs?.length) return json({ error: "Nessun telefono iscritto: attiva prima le notifiche in Altro › Notifiche." });
    let sent = 0;
    for (const s of subs) if ((await send(s, { title: "🟢 Prova avvisi live", body: "Così arriverà una giocata OTTIMA.\n👉 Tocca per aprire il Live", tag: "bet-live-test", url: "./?live=1" })) === "ok") sent++;
    if (!vapidOk) return json({ error: "Su Supabase mancano i segreti BET_VAPID_PUBLIC_KEY e BET_VAPID_PRIVATE_KEY (GUIDA_NOTIFICHE, passo 2)." });
    return json({ sent });
  }
  return json({ error: "Azione sconosciuta" }, 400);
});
