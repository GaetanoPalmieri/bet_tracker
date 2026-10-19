// Bet Tracker — risultati e statistiche live dei pronostici (Supabase Edge Function).
//
// Chi la chiama: l'app (scheda Pronostici), con l'accesso della sincronizzazione.
// Fonti dati (si usa la prima che ha la chiave nei Secrets):
//   0) TotalCorner (totalcorner.com, VIP) — segreto TOTALCORNER_TOKEN. Fonte principale dal 3.53.0.
//   1) Bzzoiro Sports (sports.bzzoiro.com) — segreto BZZOIRO_KEY. Gratis, 7.500 richieste/giorno.
//   2) API-Football (api-sports.io)         — segreto API_FOOTBALL_KEY. Gratis 100 richieste/giorno.
//
// Segreti (Edge Functions › Secrets): BZZOIRO_KEY e/o API_FOOTBALL_KEY.
// La chiave resta solo qui su Supabase: non va mai messa nei file dell'app (che sono pubblici su GitHub).
// Pubblicare con "Verify JWT" ATTIVO (impostazione predefinita): la chiamano solo utenti collegati.
//
// Azioni (POST, JSON):
//  { action: "results", matches: [{ id, date, time, home, away, league, afId? }] }
//     -> per le partite finite: finale, primo tempo, minuto del primo gol, stato (rinviata/annullata).
//        Richieste usate: 1 per ogni giorno + 1 per ogni minuto del primo gol (max 12 per chiamata).
//  { action: "live", match: { id, date, time, home, away, league, afId? } }
//     -> minuto, punteggio e statistiche per squadra (tiri, in porta, in area, angoli, possesso, xG, espulsi). 1-2 richieste.
//  { action: "scan", odds?: true }
//     -> tutte le partite in corso nel mondo (minuto, punteggio, campionato). 1 richiesta,
//        +1 per le quote live (Over/Under e 1X2) se il piano le permette.

const KEY = Deno.env.get("API_FOOTBALL_KEY") ?? "";
const BZ_KEY = Deno.env.get("BZZOIRO_KEY") ?? "";
const BZ = "https://sports.bzzoiro.com";
const BASE = "https://v3.football.api-sports.io";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

let remaining: string | null = null;
async function af(path: string) {
  const r = await fetch(BASE + path, { headers: { "x-apisports-key": KEY } });
  remaining = r.headers.get("x-ratelimit-requests-remaining") ?? remaining;
  if (!r.ok) throw new Error("API-Football " + r.status);
  const d = await r.json();
  const errs = d.errors && (Array.isArray(d.errors) ? d.errors : Object.values(d.errors));
  if (errs && errs.length) throw new Error("API-Football: " + JSON.stringify(d.errors).slice(0, 200));
  return d.response || [];
}

/* ---------- Riconoscere la partita (nomi italiani o abbreviati -> nomi API) ---------- */
const ALIAS: Record<string, string> = {
  amburgo: "hamburger", stoccarda: "stuttgart", brema: "bremen", berlino: "berlin", "bayern monaco": "bayern munchen",
  lipsia: "leipzig", friburgo: "freiburg", dresda: "dresden", magdeburgo: "magdeburg", colonia: "koln",
  siviglia: "sevilla", barcellona: "barcelona", strasburgo: "strasbourg", lione: "lyon", nizza: "nice",
  marsiglia: "marseille", psg: "paris saint germain", zagabria: "zagreb", spalato: "split", varsavia: "warszawa",
  bucarest: "bucuresti", "stella rossa": "crvena zvezda", vienna: "wien", salisburgo: "salzburg",
  gladbach: "monchengladbach", "atletico madrid": "atletico madrid", "athletic bilbao": "athletic club",
  betis: "real betis", "racing santander": "racing santander", nycfc: "new york city", lafc: "los angeles fc",
  "inter miami": "inter miami", "manchester united": "manchester united", "manchester city": "manchester city",
  "wolves": "wolverhampton", "qpr": "queens park rangers", "west brom": "west bromwich",
  "rapid vienna": "rapid wien", "austria vienna": "austria wien", "dinamo zagabria": "dinamo zagreb",
  "hajduk spalato": "hajduk split", "lokomotiva zagabria": "lokomotiva zagreb", "legia varsavia": "legia warszawa",
  "rapid bucarest": "rapid bucuresti", "dinamo bucarest": "dinamo bucuresti", "viktoria colonia": "viktoria koln",
  "fortuna colonia": "fortuna koln", "norimberga": "nurnberg", "monaco": "monaco",
};
function norm(s: string) {
  let n = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  for (const [k, v] of Object.entries(ALIAS)) if (n.includes(k)) n = n.replace(k, v);
  n = n.replace(/\b(fc|fk|sc|sv|ac|as|cf|nk|hnk|gnk|bk|if|ik|sk|ssc|us|afc|vfl|vfb|tsg|ssv|rc|cd|club|calcio|u20|u21|u23|ii|b)\b/g, " ");
  return n.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}
function sim(a: string, b: string) {
  const A = norm(a), B = norm(b);
  if (!A.length || !B.length) return 0;
  const sa = A.join(""), sb = B.join("");
  if (sa === sb) return 1;
  if (sa.includes(sb) || sb.includes(sa)) return 0.9;
  const common = A.filter((t) => B.some((u) => u === t || (t.length >= 4 && (u.startsWith(t) || t.startsWith(u)))));
  return common.length / Math.max(A.length, B.length);
}
function youth(s: string) { return /\b(u1[5-9]|u2[0-3]|ii|b|jong|primavera)\b/i.test(s); }
function kickoff(m: any) {
  const t = /^\d{1,2}:\d{2}$/.test(m.time || "") ? m.time.padStart(5, "0") : null;
  if (!t) return null;
  /* ora italiana -> UTC, con ora legale/solare corretta */
  const guess = new Date(m.date + "T" + t + ":00Z").getTime();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const asRome = new Date(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`).getTime();
  return guess - (asRome - guess);
}
function pick(m: any, list: any[]) {
  if (m.afId) return list.find((f) => f.fixture.id === m.afId) || null;
  const ko = kickoff(m);
  let best: any = null, bestS = 0;
  for (const f of list) {
    if (youth(m.home) !== youth(f.teams.home.name)) continue;
    const s1 = sim(m.home, f.teams.home.name), s2 = sim(m.away, f.teams.away.name);
    if (Math.min(s1, s2) < 0.34 || s1 + s2 < 1.1) continue;
    let s = s1 + s2;
    if (ko) {
      const dh = Math.abs(f.fixture.timestamp * 1000 - ko) / 3600e3;
      if (dh > 3) continue;
      s += dh < 0.5 ? 0.3 : 0;
    }
    if (s > bestS) { bestS = s; best = f; }
  }
  return best;
}

/* ---------- Estrarre i dati ---------- */
const FINISHED = ["FT", "AET", "PEN"];
const VOID = ["PST", "CANC", "ABD", "AWD", "WO"];
function firstGoal(f: any) {
  const goals = (f.events || []).filter((e: any) => e.type === "Goal" && e.detail !== "Missed Penalty");
  if (!goals.length) return null;
  goals.sort((a: any, b: any) => (a.time.elapsed + (a.time.extra || 0) / 100) - (b.time.elapsed + (b.time.extra || 0) / 100));
  const g = goals[0];
  return g.time.elapsed + (g.time.elapsed === 45 && g.time.extra ? g.time.extra : 0);
}
function lastGoal(f: any) {
  const g = (f.events || []).filter((e: any) => e.type === "Goal" && e.detail !== "Missed Penalty");
  if (!g.length) return null;
  return Math.max(...g.map((e: any) => e.time.elapsed + (e.time.extra || 0)));
}
function stats(f: any) {
  /* somma delle due squadre (compatibilità) + dettaglio per squadra [casa, ospite] per il modello live */
  const out: any = { s: 0, t: 0, c: 0, red: 0, xg: null as number | null, side: [{}, {}] as any[] };
  let xg = 0, hasXg = false;
  const homeId = f.teams && f.teams.home && f.teams.home.id;
  for (const side of f.statistics || []) {
    const k = side.team && side.team.id === homeId ? 0 : 1;
    const S: any = { s: 0, t: 0, b: 0, c: 0, red: 0, poss: null, xg: null };
    for (const st of side.statistics || []) {
      const v = st.value == null ? 0 : parseFloat(String(st.value));
      if (st.type === "Total Shots") S.s = v || 0;
      else if (st.type === "Shots on Goal") S.t = v || 0;
      else if (st.type === "Shots insidebox") S.b = v || 0;
      else if (st.type === "Corner Kicks") S.c = v || 0;
      else if (st.type === "Red Cards") S.red = v || 0;
      else if (st.type === "Ball Possession" && st.value != null) S.poss = v;
      else if (st.type === "expected_goals" && st.value != null) { S.xg = v || 0; xg += v || 0; hasXg = true; }
    }
    out.side[k] = S;
    out.s += S.s; out.t += S.t; out.c += S.c; out.red += S.red;
  }
  if (hasXg) out.xg = Math.round(xg * 100) / 100;
  return out;
}


/* =====================================================================
   Bzzoiro Sports — stesso formato di risposta per l'app.
   I campi si leggono "con prudenza": se il servizio cambia un nome, si prova anche con gli alternativi.
   ===================================================================== */
let bzCalls = 0;
async function bzGet(path: string) {
  bzCalls++;
  const r = await fetch(BZ + path, { headers: { Authorization: "Token " + BZ_KEY, Accept: "application/json" } });
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
async function handleBz(body: any) {
  bzCalls = 0;
  if (body.action === "scan") {
    const list = await bzLive();
    const out = list.map((e: any) => {
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
    return json({ live: out, oddsNote: null, source: "bzzoiro", calls: bzCalls });
  }
  if (body.action === "live") {
    const m = body.match || {};
    const list = await bzLive();
    const fx = list.map(bzFixture);
    const id = typeof m.afId === "string" && m.afId.startsWith("bz:") ? m.afId : null;
    let f: any = id ? fx.find((x) => x.fixture.id === id) || null : null;
    if (!f) f = pick({ ...m, afId: null }, fx);
    if (!f) f = pick({ ...m, afId: null, time: "" }, fx); /* senza controllo dell'orario */
    let stats: any = null, inc: any[] = [];
    if (!f && id) {
      /* non è nella lista live (es. appena finita o lista in ritardo): leggo direttamente l'evento */
      const raw = id.slice(3);
      try {
        const e = await bzGet(`/api/v2/events/${raw}/`);
        const ev = e && (e.event || e);
        if (ev && (ev.id != null || ev.home_team || ev.home_team_obj)) {
          if (ev.id == null) ev.id = raw;
          f = bzFixture(ev);
          try { const sd = await bzGet(`/api/v2/events/${raw}/stats/`); stats = bzStats({ stats: sd.stats || sd }); } catch { /* niente statistiche */ }
        }
      } catch { /* evento non leggibile */ }
    }
    if (!f) {
      const same = fx.filter((x) => (m.league || "") && x.league && String(x.league.name).toLowerCase().includes(String(m.league).toLowerCase().split("·").pop()!.trim().split(" ")[0]));
      const ex = (same.length ? same : fx).slice(0, 4).map((x) => x.teams.home.name + " - " + x.teams.away.name).join(", ");
      return json({ error: `Partita non trovata su Bzzoiro (${fx.length} live). Esempi: ${ex || "nessuna"}`, source: "bzzoiro" }, 404);
    }
    inc = (f._inc && f._inc.length) ? f._inc : await bzIncidents(String(f._e.id));
    if (!stats) stats = bzStatsInc(f._e, inc);
    else for (const r of bzReds(inc)) { const sd = bzSide(r); if (sd != null && stats.side[sd]) stats.side[sd].red = 1; }
    let sideOk = stats.side && stats.side[0] && (stats.side[0].s != null || stats.side[0].t != null);
    if (!sideOk) {
      /* la lista live non aveva le statistiche: le chiedo all'evento */
      try { const sd = await bzGet(`/api/v2/events/${f._e.id}/stats/`); const s2 = bzStats({ stats: sd.stats || sd }); if (s2.side[0] && s2.side[0].s != null) stats = s2; } catch { /* ok */ }
    }
    /* quote del book per l'evento (se il servizio le aggiorna durante la partita, sono quote live) */
    let ou: any = null, oddsKeys: string[] = [];
    try {
      const od = await bzGet(`/api/v2/events/${f._e.id}/odds/`);
      ou = bzParseOU(od);
      oddsKeys = od && typeof od === "object" ? Object.keys(od).slice(0, 20) : [];
      if (!Object.keys(ou).length) ou = null;
    } catch { /* quote non disponibili */ }
    return json({
      afId: f.fixture.id, status: f.fixture.status.short, elapsed: f.fixture.status.elapsed,
      goals: [f.goals.home ?? 0, f.goals.away ?? 0], stats, lastGoal: bzLastGoal(inc), ou, oddsKeys, source: "bzzoiro", calls: bzCalls,
    });
  }
  if (body.action === "results") {
    const matches = (body.matches || []).slice(0, 160);
    const byDate: Record<string, any[]> = {};
    for (const m of matches) (byDate[m.date] = byDate[m.date] || []).push(m);
    const dates = Object.keys(byDate).sort().slice(0, 4);
    const out: any[] = [];
    let asked = 0, found = 0, detailCalls = 0;
    for (const date of dates) {
      /* il giorno italiano attraversa due date UTC: prendo anche quella prima */
      const prev = new Date(Date.parse(date + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10);
      const ev = await bzList(`/api/v2/events/?date_from=${prev}&date_to=${date}`, 10);
      const fx = ev.map(bzFixture);
      for (const m of byDate[date]) {
        asked++;
        const id = typeof m.afId === "string" && m.afId.startsWith("bz:") ? m.afId : null;
        const f = (id && fx.find((x) => x.fixture.id === id)) || pick({ ...m, afId: null }, fx);
        if (!f) continue;
        found++;
        const st = f.fixture.status.short;
        const r: any = { id: m.id, afId: f.fixture.id, status: st, name: f.teams.home.name + " - " + f.teams.away.name };
        if (st === "FT" && f.goals.home != null) {
          r.ft = [f.goals.home, f.goals.away];
          let ht = bzHT(f._e);
          const needInc = (!ht || m.needFg || m.needGoals) && detailCalls < 80;
          if (needInc) {
            detailCalls++;
            const inc = (f._inc && f._inc.length) ? f._inc : await bzIncidents(String(f._e.id));
            if (!ht) ht = bzHTfromInc(inc);
            if (ht && ht[0] + ht[1] > 0) { const fg = bzFirstGoal(inc); if (fg != null) r.fg = fg; }
            if (m.needGoals) {
              const gs = bzGoals(inc).map((i) => { const t = bzIncMinute(i); return { min: t.m + t.x, side: bzSide(i) }; });
              /* solo se i minuti tornano col punteggio finale */
              if (gs.length === (f.goals.home ?? 0) + (f.goals.away ?? 0)) r.goals = gs.sort((a, b) => a.min - b.min);
            }
          }
          if (ht) r.ht = ht;
        }
        if (st === "CANC" || st === "PST") r.cancelled = true;
        out.push(r);
      }
    }
    return json({ results: out, unmatched: asked - found, more: Object.keys(byDate).length > dates.length, source: "bzzoiro", calls: bzCalls });
  }
  if (body.action === "probe") {
    /* per controllo: nomi dei campi che arrivano davvero */
    const list = await bzLive();
    const e = list[0] || null;
    return json({ live: list.length, keys: e ? Object.keys(e) : [], statsKeys: e && e.live_stats ? Object.keys(e.live_stats.home || e.live_stats) : [], incident: e && e.incidents && e.incidents[0] ? e.incidents[0] : null, sample: e, calls: bzCalls });
  }
  return json({ error: "Azione sconosciuta" }, 400);
}


/*TC-BEGIN*/
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
/*TC-END*/
async function handleTc(body: any) {
  tcCalls = 0;
  if (body.action === "scan") {
    const live = await tcLive();
    return json({ live, source: "totalcorner", calls: tcCalls, remaining: tcRem });
  }
  if (body.action === "live") {
    const m = body.match || {};
    const id = typeof m.afId === "string" && m.afId.startsWith("tc:") ? m.afId.slice(3) : null;
    let x: any = null;
    if (id) {
      try { const j = await tcGet(`/match/view/${id}`, { columns: TC_COLS }); x = Array.isArray(j?.data) ? j.data[0] : j?.data; } catch { x = null; }
    }
    if (!x || !(x.h || x.home)) {
      const live = await tcLive();
      let best: any = null, bs = 0;
      for (const f of live) { const sc = sim(m.home || "", f.home) + sim(m.away || "", f.away); if (sim(m.home || "", f.home) >= 0.34 && sim(m.away || "", f.away) >= 0.34 && sc > bs) { bs = sc; best = f; } }
      if (!best) return json({ error: `Partita non trovata su TotalCorner (${live.length} live).`, source: "totalcorner" }, 404);
      return json({ ...best, ou: null, source: "totalcorner", calls: tcCalls });
    }
    const f = tcFixture(x);
    return json({ ...f, ou: null, source: "totalcorner", calls: tcCalls });
  }
  if (body.action === "results") {
    const matches = (body.matches || []).slice(0, 160);
    const mine = matches.filter((m: any) => typeof m.afId === "string" && m.afId.startsWith("tc:"));
    const rest = matches.filter((m: any) => !(typeof m.afId === "string" && m.afId.startsWith("tc:")));
    const out: any[] = [];
    let asked = 0, found = 0;
    for (const m of mine.slice(0, 25)) {
      asked++;
      try {
        const j = await tcGet(`/match/view/${m.afId.slice(3)}`, { columns: "events" });
        const x = Array.isArray(j?.data) ? j.data[0] : j?.data;
        if (!x) continue;
        found++;
        const f = tcFixture(x), r: any = { id: m.id, afId: f.afId, status: f.status, name: f.home + " - " + f.away };
        const ko = f.kickoff ? Date.parse(f.kickoff) : null;
        const ended = f.status === "FT" || (f.status !== "1H" && f.status !== "2H" && f.status !== "HT" && ko != null && Date.now() - ko > 130 * 60e3);
        if (ended && tcNum(x.hg) != null) {
          r.status = "FT"; r.ft = f.goals;
          if (f.ht) r.ht = f.ht;
          const gs = f.goalList;
          if (gs.length === f.goals[0] + f.goals[1]) { r.goals = gs; const g1 = gs.filter((g: any) => g.min <= 45); if (g1.length) r.fg = g1[0].min; }
        }
        if (f.status === "CANC" || f.status === "PST") r.cancelled = true;
        out.push(r);
      } catch (e) { if (/rateLimit|token|VIP/.test(String((e as Error).message))) break; }
    }
    if (rest.length && BZ_KEY) {
      try { const r2 = await handleBz({ action: "results", matches: rest }); const j2 = await r2.json(); out.push(...(j2.results || [])); asked += rest.length; found += (j2.results || []).length; } catch { /* ok */ }
    }
    return json({ results: out, unmatched: asked - found, source: "totalcorner", calls: tcCalls, remaining: tcRem });
  }
  return json({ error: "Azione sconosciuta" }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Richiesta non valida" }, 400); }
  if (TC_TOKEN) {
    try { return await handleTc(body); }
    catch (e) { return json({ error: String((e as Error).message || e), source: "totalcorner" }, 502); }
  }
  if (BZ_KEY) {
    try { return await handleBz(body); }
    catch (e) { return json({ error: String((e as Error).message || e), source: "bzzoiro" }, 502); }
  }
  if (!KEY) return json({ error: "Manca il segreto BZZOIRO_KEY (o API_FOOTBALL_KEY) su Supabase." }, 500);
  try {
    if (body.action === "results") {
      const matches = (body.matches || []).slice(0, 80);
      const byDate: Record<string, any[]> = {};
      for (const m of matches) (byDate[m.date] = byDate[m.date] || []).push(m);
      const found: { m: any; f: any }[] = [];
      /* Piano gratuito: max 10 richieste al minuto. Per chiamata: max 2 giorni + 6 minuti del primo gol. */
      const dates = Object.keys(byDate).sort().slice(0, 2);
      for (const date of dates) {
        const list = await af(`/fixtures?date=${date}&timezone=Europe/Rome`);
        for (const m of byDate[date]) {
          const f = pick(m, list);
          if (f) found.push({ m, f });
        }
      }
      /* Minuto del primo gol: il piano gratuito non permette "ids", quindi 1 richiesta per partita.
         Solo dove serve (needFg dall'app, gol nel 1° tempo) e al massimo 12 per chiamata. */
      const detail: Record<number, any> = {};
      const needFg = found.filter((x) => {
        const ht = x.f.score && x.f.score.halftime;
        return x.m.needFg && FINISHED.includes(x.f.fixture.status.short) && ht && (ht.home || 0) + (ht.away || 0) > 0;
      }).slice(0, 6);
      for (const x of needFg) {
        const r = await af(`/fixtures?id=${x.f.fixture.id}`);
        if (r[0]) detail[x.f.fixture.id] = r[0];
      }
      const out = found.map(({ m, f }) => {
        const st = f.fixture.status.short;
        const r: any = { id: m.id, afId: f.fixture.id, status: st, name: f.teams.home.name + " - " + f.teams.away.name };
        if (FINISHED.includes(st)) {
          const ft = f.score.fulltime, ht = f.score.halftime;
          if (ft && ft.home != null) r.ft = [ft.home, ft.away];
          if (ht && ht.home != null) r.ht = [ht.home, ht.away];
          const d = detail[f.fixture.id];
          if (d) { const fg = firstGoal(d); if (fg != null) r.fg = fg; }
        }
        if (VOID.includes(st)) r.cancelled = true;
        return r;
      });
      const asked = dates.reduce((n, d) => n + byDate[d].length, 0);
      return json({ results: out, unmatched: asked - found.length, more: Object.keys(byDate).length > dates.length, remaining });
    }
    if (body.action === "live") {
      const m = body.match || {};
      let f: any = null;
      if (m.afId) f = (await af(`/fixtures?id=${m.afId}`))[0] || null;
      else {
        const list = await af(`/fixtures?date=${m.date}&timezone=Europe/Rome`);
        const p = pick(m, list);
        if (p) f = (await af(`/fixtures?id=${p.fixture.id}`))[0] || null;
      }
      if (!f) return json({ error: "Partita non trovata su API-Football.", remaining }, 404);
      return json({
        afId: f.fixture.id, status: f.fixture.status.short, elapsed: f.fixture.status.elapsed,
        goals: [f.goals.home, f.goals.away], stats: stats(f), lastGoal: lastGoal(f), remaining,
      });
    }
    if (body.action === "scan") {
      const list = await af(`/fixtures?live=all&timezone=Europe/Rome`);
      const out = list.map((f: any) => ({
        afId: f.fixture.id, status: f.fixture.status.short, elapsed: f.fixture.status.elapsed,
        kickoff: f.fixture.date, league: f.league.name, country: f.league.country, leagueId: f.league.id,
        home: f.teams.home.name, away: f.teams.away.name, goals: [f.goals.home, f.goals.away],
        ht: f.score && f.score.halftime && f.score.halftime.home != null ? [f.score.halftime.home, f.score.halftime.away] : null,
      }));
      let oddsNote: string | null = null;
      if (body.odds) {
        try {
          const od = await af(`/odds/live`);
          const byId: Record<number, any> = {};
          for (const o of od) {
            const r: any = {};
            for (const b of o.odds || []) {
              const name = String(b.name || "").toLowerCase();
              const vals = (b.values || []).filter((v: any) => !v.suspended);
              if (/over\/under|match goals|total/.test(name) && !/half|team|home|away|corner|card|asian/.test(name)) {
                const lines: Record<string, any> = {};
                for (const v of vals) {
                  const h = String(v.handicap ?? "").trim();
                  if (!/^\d+(\.\d+)?$/.test(h)) continue;
                  (lines[h] = lines[h] || {})[/over/i.test(v.value) ? "o" : "u"] = parseFloat(v.odd);
                  if (v.main) lines[h].main = true;
                }
                const ok = Object.entries(lines).filter(([h, x]: any) => x.o > 1 && x.u > 1 && Number(h) % 1 === 0.5);
                ok.sort((a: any, b: any) => (b[1].main ? 1 : 0) - (a[1].main ? 1 : 0) || Math.abs(a[1].o - a[1].u) - Math.abs(b[1].o - b[1].u));
                if (ok.length && !r.ou) r.ou = { line: Number(ok[0][0]), o: ok[0][1].o, u: ok[0][1].u };
              } else if (/fulltime result|match winner|^1x2/.test(name) && !/half/.test(name)) {
                const g = (re: RegExp) => { const v = vals.find((x: any) => re.test(String(x.value))); return v ? parseFloat(v.odd) : null; };
                const h = g(/^(home|1)$/i), d = g(/^(draw|x)$/i), a = g(/^(away|2)$/i);
                if (h && d && a && !r.x12) r.x12 = [h, d, a];
              }
            }
            if (r.ou || r.x12) byId[o.fixture.id] = r;
          }
          for (const x of out) if (byId[x.afId]) x.odds = byId[x.afId];
        } catch (e) {
          oddsNote = String((e as Error).message || e).slice(0, 160);
        }
      }
      return json({ live: out, oddsNote, remaining });
    }
    return json({ error: "Azione sconosciuta" }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e), remaining }, 502);
  }
});
