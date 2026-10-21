/* =====================================================================
   3.9.0 — PRONOSTICI (modello v3: statistiche + quote del book, liste Top)
   Modello di Poisson dentro l'app. Claude o GPT preparano il file pronostici.json
   (partite, gol attesi λ di casa e trasferta, parametri del modello);
   l'app calcola le probabilità, tiene solo i pronostici oltre la soglia,
   segna vinto/perso dai risultati e impara dai propri errori
   (correzioni gol, quota di gol nel 1° tempo, pareggi).

   Dati in db (si sincronizzano con il resto dell'app):
   - db.predictions: [{ id, date, time, league, home, away, lh, la, rel, note,
       p1x2?, batch, picks:[{m, sel, p}], ft:[h,a]|null, ht:[h,a]|null,
       cancelled?, ov:{mercato:'V'|'P'|'N'} }]
   - db.predModel: { base:{...parametri dal file}, learned:{...correzioni}|null,
       lastBatch, lastCheck }
   NB: var (non let/const) per lo stato del modulo, come nel resto di app.js.
   ===================================================================== */
var TIP_FILE = 'pronostici.json';
var TIP_DEFAULTS = { version: '1', threshold: 70, htShare: 0.45, drawBoost: 1, goalFactor: 1, leagueGoal: {}, rho: 0 };
/* 3.9.0 — Soglie per mercato (per entrare in lista) e media minima delle liste Top.
   Il file può sovrascriverle con model.thresholds / model.topTargets. */
var TIP_THR = { ht05: 75, o15: 80, o25: 71, gg: 71 };
var TIP_TOP = { ht05: 80, o15: 85, o25: 75, gg: 75 };
function tipThr(P, k) {
  var t = (P && P.thresholds) || {};
  return t[k] != null ? t[k] : TIP_THR[k] != null ? TIP_THR[k] : (P && P.threshold) || 70;
}
function tipTarget(P, k) {
  var t = (P && P.topTargets) || {};
  return t[k] != null ? t[k] : TIP_TOP[k] || 80;
}
/* Quota del book per il pronostico (se c'è nel file). */
function tipOdd(m, p) {
  var o = m.odds || {};
  if (p.m === '1x2') return o[p.sel.replace('Segno ', '')] || null;
  if (p.m === 'o15' && p.sel === 'Over 1.5') return o.o15 || null;
  if (p.m === 'o25' && p.sel === 'Over 2.5') return o.o25 || null;
  if (p.m === 'gg' && p.sel === 'Goal') return o.gg || null;
  return null;
}
/* 3.9.1 — 1X2 tolto dai mercati (resta solo come informazione sulla favorita). */
var TIP_MARKETS = [
  ['o15', 'Over/Under 1.5'],
  ['o25', 'Over/Under 2.5'],
  ['ht05', 'O/U 0.5 1° tempo'],
  ['gg', 'Goal / No goal'],
];
var TIP_SHORT = { '1x2': '1X2', o05: 'O/U 0.5', o15: 'O/U 1.5', o25: 'O/U 2.5', ht05: '1° tempo', gg: 'GG/NG' };
var tipUI = { view: 'open', day: 'all', league: '', q: '', loading: false, fileInfo: '', panel: 'home', sort: 'time' };

/* ---------- Modello ---------- */
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
/* ---------- 3.17.0 — Contesto prepartita (motivazioni, turnover, assenze) ----------
   Lo segni tu partita per partita. Effetti prudenti sui gol attesi. Se le quote sono state
   prese DOPO la notizia, il book l'ha già prezzata: si applica solo alla parte statistica. */
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
/* Il pronostico scelto per ogni mercato: il lato più probabile. */
function tipChoices(c) {
  var one = c.p1 >= c.px && c.p1 >= c.p2 ? ['1', c.p1] : c.p2 >= c.px ? ['2', c.p2] : ['X', c.px];
  var two = function (p, a, b) {
    return p >= 50 ? [a, p] : [b, 100 - p];
  };
  return {
    '1x2': { sel: 'Segno ' + one[0], p: one[1] },
    o05: (function (x) {
      return { sel: x[0], p: x[1] };
    })(two(c.o05, 'Over 0.5', 'Under 0.5')),
    o15: (function (x) {
      return { sel: x[0], p: x[1] };
    })(two(c.o15, 'Over 1.5', 'Under 1.5')),
    o25: (function (x) {
      return { sel: x[0], p: x[1] };
    })(two(c.o25, 'Over 2.5', 'Under 2.5')),
    ht05: (function (x) {
      return { sel: x[0], p: x[1] };
    })(two(c.ht05, 'Over 0.5 1T', 'Under 0.5 1T')),
    gg: (function (x) {
      return { sel: x[0], p: x[1] };
    })(two(c.gg, 'Goal', 'No goal')),
  };
}
function tipPicksFor(m, P) {
  P = P || tipParams();
  var ch = tipChoices(tipCalc(m, P)),
    out = [];
  TIP_MARKETS.forEach(function (k) {
    var x = ch[k[0]];
    if (x.p >= tipThr(P, k[0]) + (TIP_PRE_LG_EXTRA[tipLeagueTier(m)] || 0) + (TIP_PRE_MK_EXTRA[k[0]] || 0)) out.push({ m: k[0], sel: x.sel, p: x.p });
  });
  return out;
}

/* 3.70.0 — Pronostico e Top restano PROVVISORI fino al calcio d'inizio della partita:
   a ogni aggiornamento (nuove partite, quote, risultati per la calibrazione) si ricalcolano.
   Al calcio d'inizio si bloccano e non cambiano più: lo storico conserva ciò che era in Top
   prima della partita, mai una selezione rifatta con il suo risultato.
   Ogni giorno ha al massimo 10 posti per mercato: quelli delle partite già bloccate restano,
   gli altri si assegnano alle partite ancora aperte, in ordine di probabilità. */
function tipIssueOpen(m, now) {
  return !m.cancelled && !tipNum(m.ft) && !tipNum(m.ht) && !(m.ov && Object.keys(m.ov).length) && tipKickoff(m).getTime() > now;
}
function tipIssueInputs(m) {
  var inputs = {};
  ['lh', 'la', 'hts', 'p1x2', 'odds', 'src', 'fav', 'ctx', 'rel', 'lhS', 'laS', 'lhM', 'laM', 'wMkt', 'warn', 'topSkip', 'league', 'home', 'away'].forEach(function (k) {
    if (m[k] != null) inputs[k] = m[k];
  });
  return inputs;
}
function tipFreezePrematch(state, now) {
  var keep = db, cal = tipUI._cal;
  db = state; tipUI._cal = null;
  try {
    var P = tipParams(), list = state.predictions || [], changed = 0;
    /* 3.69.0 bloccava alla prima comparsa: quelle Top non ancora giocate si riaprono */
    var reopen = function (i) { return i && !i.legacy && (i.provisional || i.schemaVersion === 2); };
    var open = list.filter(function (m) { return (!m.preIssue || reopen(m.preIssue)) && tipIssueOpen(m, now); });
    /* 1. blocco: partite iniziate (o con risultato) che avevano un pronostico provvisorio */
    list.forEach(function (m) {
      var i = m.preIssue;
      if (i && i.provisional && !tipIssueOpen(m, now)) {
        var at = Math.min(now, tipKickoff(m).getTime());
        i.provisional = false; i.lockedAt = new Date(now).toISOString(); i.issuedAt = new Date(at).toISOString();
        i.id = (m.afId || m.id) + '|pre|' + at;
        changed++;
      } else if (!i && !tipIssueOpen(m, now)) {
        /* mai visto prima del calcio d'inizio: Top non documentata */
        m.preIssue = JSON.parse(JSON.stringify({ schemaVersion: 3, id: (m.afId || m.id) + '|pre|legacy', issuedAt: null,
          recordedAt: new Date(now).toISOString(), legacy: true, provisional: false, modelVersion: 'unknown', parameters: null,
          top: null, why: null, picks: m.picks || [], inputs: tipIssueInputs(m) }));
        changed++;
      }
    });
    if (!open.length) return changed;
    /* 2. pronostici aggiornati: soglie sulla stima del modello, poi calibrazione con lo storico */
    var raw = {};
    open.forEach(function (m) { raw[m.id] = tipPicksFor(m, P); });
    var cands = open.map(function (m) { return Object.assign({}, m, { picks: raw[m.id] }); });
    /* 3. Top: posti liberi del giorno = 10 − Top delle partite già bloccate */
    var ranks = {}, why = {}, days = {};
    open.forEach(function (m) { days[m.date] = true; });
    Object.keys(days).forEach(function (day) {
      var T = tipTopCandidates(day, cands, P);
      TIP_TOP_MK.forEach(function (mk) {
        var k = mk[0], used = list.reduce(function (n, m) {
          var i = m.preIssue;
          return n + (m.date === day && i && !reopen(i) && i.top && i.top[k] && open.indexOf(m) < 0 ? 1 : 0);
        }, 0), free = Math.max(0, 10 - used);
        T[k].items.forEach(function (c, i) {
          if (i < free) (ranks[c.m.id] = ranks[c.m.id] || {})[k] = used + i + 1;
          else (why[c.m.id] = why[c.m.id] || {})[k] = 'già 10 partite più probabili in Top';
        });
        Object.keys(T[k].skip).forEach(function (id) { (why[id] = why[id] || {})[k] = T[k].skip[id]; });
      });
    });
    open.forEach(function (m) {
      var picks = raw[m.id].map(function (p) { return Object.assign({}, p, { raw: p.p, p: tipCal(p.m, p.p) }); });
      var body = { picks: picks, top: ranks[m.id] || {}, why: why[m.id] || {}, inputs: tipIssueInputs(m) };
      var old = m.preIssue;
      if (old && old.provisional && JSON.stringify({ picks: old.picks, top: old.top, why: old.why, inputs: old.inputs }) === JSON.stringify(body)) return;
      m.preIssue = JSON.parse(JSON.stringify(Object.assign({
        schemaVersion: 3, id: (m.afId || m.id) + '|pre|open', issuedAt: null, recordedAt: (old && old.recordedAt) || new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(), legacy: false, provisional: true, modelVersion: '3.71.0', parameters: P
      }, body)));
      m.picks = JSON.parse(JSON.stringify(picks));
      changed++;
    });
    return changed;
  } finally { db = keep; tipUI._cal = cal; }
}
function tipEnsurePrematch() {
  var L = db.predictions || [];
  if (!L.length || tipUI._freezePending) return;
  /* ricontrollo al massimo una volta al minuto, o subito se cambiano partite o risultati */
  var key = L.length + '|' + L.filter(function (m) { return tipNum(m.ft) || tipNum(m.ht) || m.cancelled; }).length + '|' + Math.floor(Date.now() / 60e3);
  if (tipUI._freezeKey === key) return;
  tipUI._freezeKey = key;
  var now = Date.now(), probe = JSON.parse(JSON.stringify({ predictions: L, predModel: db.predModel || {} }));
  if (!tipFreezePrematch(probe, now)) return;
  tipUI._freezePending = true;
  setTimeout(function () {
    try { mutate(function (n) { tipFreezePrematch(n, now); }); }
    finally { tipUI._freezePending = false; }
  }, 0);
}
function tipValidIssue(issue) {
  return issue && (issue.schemaVersion === 2 || issue.schemaVersion === 3) && issue.inputs && typeof issue.inputs === 'object' &&
    Array.isArray(issue.picks) && issue.picks.every(function (p) {
      return p && TIP_MARKETS.some(function (k) { return k[0] === p.m; }) && typeof p.sel === 'string' && U.finite(p.p) && p.p >= 0 && p.p <= 100;
    }) && (issue.top === null || (issue.top && typeof issue.top === 'object' && Object.keys(issue.top).every(function (k) {
      return TIP_TOP_MK.some(function (mk) { return mk[0] === k; }) && Number.isInteger(issue.top[k]) && issue.top[k] >= 1 && issue.top[k] <= 10;
    })));
}

/* ---------- Esiti ---------- */
function tipNum(v) {
  return Array.isArray(v) && v.length === 2 && v.every(function (n) {
    return Number.isInteger(n) && n >= 0;
  });
}
function tipAutoOutcome(m, pick) {
  if (m.cancelled) return 'N';
  var ft = tipNum(m.ft) ? m.ft : null,
    ht = tipNum(m.ht) ? m.ht : null;
  if (pick.m === 'ht05') {
    if (!ht) return '';
    var over = ht[0] + ht[1] >= 1;
    return (pick.sel.indexOf('Over') === 0) === over ? 'V' : 'P';
  }
  if (!ft) return '';
  var h = ft[0],
    a = ft[1],
    t = h + a;
  if (pick.m === '1x2') {
    var r = h > a ? '1' : h < a ? '2' : 'X';
    return pick.sel === 'Segno ' + r ? 'V' : 'P';
  }
  if (pick.m === 'o05') return (pick.sel.indexOf('Over') === 0) === t >= 1 ? 'V' : 'P';
  if (pick.m === 'o15') return (pick.sel.indexOf('Over') === 0) === t >= 2 ? 'V' : 'P';
  if (pick.m === 'o25') return (pick.sel.indexOf('Over') === 0) === t >= 3 ? 'V' : 'P';
  if (pick.m === 'gg') return (pick.sel === 'Goal') === (h > 0 && a > 0) ? 'V' : 'P';
  return '';
}
function tipOutcome(m, pick) {
  var ov = (m.ov || {})[pick.m];
  return ov ? { s: ov, man: true } : { s: tipAutoOutcome(m, pick), man: false };
}
function tipKickoff(m) {
  var t = /^\d{1,2}:\d{2}$/.test(m.time || '') ? m.time : '23:59';
  return new Date(m.date + 'T' + (t.length === 4 ? '0' + t : t) + ':00');
}
function tipState(m) {
  if (m.cancelled) return 'done';
  var all = (m.picks || []).every(function (p) {
    return tipOutcome(m, p).s;
  });
  if ((m.picks || []).length && all) return 'done';
  var kickoff = tipKickoff(m).getTime(), now = Date.now();
  if (now < kickoff) return 'open';
  return now < kickoff + 2 * 3600e3 ? 'live' : 'check';
}

/* ---------- Import dal file di Claude ---------- */
function tipValidFile(d) {
  return (
    d &&
    typeof d === 'object' &&
    Array.isArray(d.matches) &&
    d.matches.every(function (m) {
      return (
        m &&
        typeof m.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
        typeof m.home === 'string' &&
        typeof m.away === 'string' &&
        U.finite(m.lh) &&
        U.finite(m.la) &&
        m.lh >= 0 &&
        m.la >= 0
      );
    })
  );
}
function tipSlug(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
/* 3.9.0 — Dati aggiuntivi del modello v3: quote del book, gol attesi dalle sole
   statistiche e dalle sole quote, quota di gol nel 1° tempo, forza della favorita. */
var TIP_EXTRA = ['hts', 'odds', 'mkt', 'fav', 'src', 'topSkip', 'lhS', 'laS', 'lhM', 'laM', 'wMkt', 'warn'];
function tipCopyExtra(m, fm) {
  /* 3.10.0 — movimento quote: si conservano le prime quote viste (apertura) */
  if (m.odds && fm.odds && JSON.stringify(m.odds) !== JSON.stringify(fm.odds) && !m.oddsOpen) m.oddsOpen = m.odds;
  TIP_EXTRA.forEach(function (k) {
    if (fm[k] != null && fm[k] !== '') m[k] = fm[k];
    else delete m[k];
  });
}
/* 3.3.0 — Rispetto dei pronostici già giocati: solo le partite future senza
   risultati/esiti manuali ricevono nuovi lambda, note e picks. Il batch non
   rappresenta un retraining: le correzioni già apprese restano attive. */
function tipMerge(file, { manual = false } = {}) {
  if (!tipValidFile(file)) {
    U.toast('File dei pronostici non valido. Nessun dato modificato.');
    return false;
  }
  var res = { added: 0, results: 0, updated: 0, retired: 0, archived: 0 };
  var ok = mutate(function (n) {
    n.predictions = n.predictions || [];
    n.predModel = n.predModel || {};
    tipFreezePrematch(n, Date.now());
    var fp = Object.assign({}, TIP_DEFAULTS, file.model || {});
    var oldV = n.predModel.base && n.predModel.base.version;
    /* Azzerare l'apprendimento soltanto se cambia DAVVERO la versione del modello,
       non quando cambia il batch delle previsioni. */
    if (oldV != null && oldV !== fp.version) n.predModel.learned = null;
    n.predModel.base = fp;
    if (file.label) n.predModel.lastLabel = String(file.label);
    var P = (function () {
      var keep = db;
      db = n;
      try { return tipParams(); } finally { db = keep; }
    })();
    /* Ritiri documentati: elimina esclusivamente eventuali pronostici non
       ancora conclusi e senza interventi manuali, mai lo storico. */
    (file.retiredMatches || []).forEach(function (rm) {
      n.predictions = n.predictions.filter(function (m) {
        var same = m.date === rm.date && tipSlug(m.home) === tipSlug(rm.home) && tipSlug(m.away) === tipSlug(rm.away);
        if (!same) return true;
        if (tipNum(m.ft) || tipNum(m.ht) || (m.ov && Object.keys(m.ov).length)) return true;
        res.retired++;
        return false;
      });
    });
    var byId = {};
    n.predictions.forEach(function (m) { byId[m.id] = m; });
    file.matches.forEach(function (fm) {
      var id = fm.id || fm.date + '_' + tipSlug(fm.home) + '_' + tipSlug(fm.away);
      var cur = byId[id];
      if (!cur) {
        /* Evita di pubblicare come nuovi pronostici partite gia' iniziate
           nel momento in cui il dispositivo importa il file. */
        if (!tipNum(fm.ft) && !tipNum(fm.ht) && !fm.cancelled && tipKickoff(fm).getTime() <= Date.now()) return;
        var m = {
          id: id,
          date: fm.date,
          time: String(fm.time || 'n.d.'),
          league: String(fm.league || ''),
          home: fm.home,
          away: fm.away,
          lh: Math.round(fm.lh * 1000) / 1000,
          la: Math.round(fm.la * 1000) / 1000,
          rel: ['A', 'B', 'C'].indexOf(fm.rel) >= 0 ? fm.rel : 'B',
          note: fm.note ? String(fm.note) : '',
          review: String(fm.review || 'unknown'),
          batch: String(file.batch || fm.date),
          ft: tipNum(fm.ft) ? fm.ft : null,
          ht: tipNum(fm.ht) ? fm.ht : null,
          ov: {},
        };
        if (Number.isInteger(fm.fg)) m.fg = fm.fg;
        if (typeof fm.afId === 'string') m.afId = fm.afId;
        if (Array.isArray(fm.p1x2) && fm.p1x2.length === 3) m.p1x2 = fm.p1x2.map(Number);
        if (fm.cancelled) m.cancelled = true;
        tipCopyExtra(m, fm);
        m.picks = tipPicksFor(m, P);
        if (tipValidIssue(fm.preIssue)) {
          m.preIssue = JSON.parse(JSON.stringify(fm.preIssue));
          m.picks = JSON.parse(JSON.stringify(m.preIssue.picks));
        } else if ((tipNum(fm.ft) || tipNum(fm.ht)) && Array.isArray(fm.picks)) {
          m.picks = fm.picks.filter(function (p) { return p && typeof p.sel === 'string' && U.finite(p.p) && p.p >= 0 && p.p <= 100 && TIP_MARKETS.some(function (k) { return k[0] === p.m; }); });
        }
        if (!m.picks.length) return;
        n.predictions.push(m);
        byId[id] = m;
        res.added++;
      } else {
        if (!cur.preIssue && tipValidIssue(fm.preIssue)) {
          cur.preIssue = JSON.parse(JSON.stringify(fm.preIssue));
          cur.picks = JSON.parse(JSON.stringify(cur.preIssue.picks));
        }
        var noScores = !tipNum(cur.ft) && !tipNum(cur.ht);
        var manualOutcomes = cur.ov && Object.keys(cur.ov).length > 0;
        var nextKickoff = new Date(fm.date + 'T' + (/^\d{2}:\d{2}$/.test(fm.time || '') ? fm.time : '23:59') + ':00');
        var future = nextKickoff.getTime() > Date.now() && tipKickoff(cur).getTime() > Date.now();
        if (future && noScores && !cur.cancelled && !manualOutcomes) {
          /* Versione 3.2.0: le partite esistenti non potevano essere aggiornate.
             Da 3.3.0 si sostituiscono anche mercati/pesi oltre la soglia. */
          var oldSnapshot = JSON.stringify([cur.lh, cur.la, cur.p1x2, cur.picks, cur.rel, cur.note, cur.time, cur.league, cur.review]);
          cur.lh = Math.round(fm.lh * 1000) / 1000;
          cur.la = Math.round(fm.la * 1000) / 1000;
          cur.rel = ['A', 'B', 'C'].indexOf(fm.rel) >= 0 ? fm.rel : 'B';
          cur.note = fm.note ? String(fm.note) : '';
          cur.review = String(fm.review || 'unknown');
          cur.league = String(fm.league || cur.league || '');
          cur.time = String(fm.time || cur.time);
          if (Array.isArray(fm.p1x2) && fm.p1x2.length === 3) cur.p1x2 = fm.p1x2.map(Number);
          else delete cur.p1x2;
          tipCopyExtra(cur, fm);
          cur.batch = String(file.batch || fm.date);
          if (!cur.preIssue) cur.picks = tipPicksFor(cur, P);
          if (JSON.stringify([cur.lh, cur.la, cur.p1x2, cur.picks, cur.rel, cur.note, cur.time, cur.league, cur.review]) !== oldSnapshot) res.updated++;
        } else if (fm.time && cur.time !== String(fm.time) && noScores && future) {
          cur.time = String(fm.time);
          res.updated++;
        }
        /* 3.14.1 — i risultati del file prevalgono su quelli segnati a mano */
        if (tipNum(fm.ft)) {
          if (!tipNum(cur.ft) || cur.ft[0] !== fm.ft[0] || cur.ft[1] !== fm.ft[1]) res.results++;
          cur.ft = fm.ft;
          cur.ov = {};
        }
        if (tipNum(fm.ht)) {
          cur.ht = fm.ht;
          if (cur.ov) delete cur.ov.ht05;
        }
        if (!Number.isInteger(cur.fg) && Number.isInteger(fm.fg)) cur.fg = fm.fg;
        if (!cur.afId && typeof fm.afId === 'string') cur.afId = fm.afId;
        if (fm.cancelled && !cur.cancelled) { cur.cancelled = true; res.updated++; }
      }
    });
    /* 3.3.1: gli incontri precedenti non contenuti nel nuovo batch erano
       mostrati come pronostici ancora aggiornati. Conserviamo pronostici
       originali e risultati (utile per audit/retraining), ma li marchiamo. */
    if (file.coverage && file.coverage.from && file.coverage.to) {
      var present = new Set(file.matches.map(function (m) {
        return String(m.id || m.date + '_' + tipSlug(m.home) + '_' + tipSlug(m.away));
      }));
      n.predictions.forEach(function (m) {
        if (m.date < file.coverage.from || m.date > file.coverage.to || present.has(m.id)) return;
        if (m.batch === String(file.batch || '')) return;
        if (m.review !== 'not_revised') {
          m.review = 'not_revised';
          res.archived++;
        }
      });
    }
    n.predModel.lastBatch = String(file.batch || '');
    n.predModel.lastCheck = new Date().toISOString();
    tipFreezePrematch(n, Date.now());
  });
  if (ok) {
    var msg = [];
    if (res.added) msg.push(res.added + ' nuove partite');
    if (res.results) msg.push(res.results + ' risultati');
    if (res.updated) msg.push(res.updated + ' previsioni aggiornate');
    if (res.retired) msg.push(res.retired + ' partite ritirate');
    if (res.archived) msg.push(res.archived + ' partite segnate come non riviste');
    if (msg.length || manual) U.toast(msg.length ? 'Pronostici: ' + msg.join(', ') : 'Pronostici già aggiornati');
  }
  return ok;
}
/* 3.2.0 — Import da CSV (separatore ; o , e decimali con virgola o punto).
   Colonne lette: data, ora, campionato, casa, trasferta, lambda_casa, lambda_trasferta,
   affidabilita, nota, finale (es. 2-1), primo_tempo, annullata. Le altre (probabilità) si ignorano. */
function tipParseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  var first = text.split(/\r?\n/)[0] || '',
    sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ';' : ',';
  var rows = [],
    row = [],
    cell = '',
    q = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(function (c) { return c.trim() !== ''; })) rows.push(row);
  if (rows.length < 2) return null;
  var head = rows[0].map(function (h) {
    return tipSlug(h).replace(/-/g, '_');
  });
  var col = function (r, names) {
    for (var k = 0; k < names.length; k++) {
      var ix = head.indexOf(names[k]);
      if (ix >= 0) return (r[ix] || '').trim();
    }
    return '';
  };
  var num = function (v) {
    return v === '' ? NaN : Number(String(v).replace(',', '.'));
  };
  var score = function (v) {
    var m = /^(\d{1,2})\s*[-:]\s*(\d{1,2})$/.exec(v || '');
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  var toIso = function (v) {
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : v;
  };
  var matches = rows.slice(1).map(function (r) {
    var m = {
      date: toIso(col(r, ['data', 'date'])),
      time: col(r, ['ora', 'time']) || 'n.d.',
      league: col(r, ['campionato', 'league']),
      home: col(r, ['casa', 'home']),
      away: col(r, ['trasferta', 'away']),
      lh: num(col(r, ['lambda_casa', 'gol_attesi_casa', 'lh'])),
      la: num(col(r, ['lambda_trasferta', 'gol_attesi_trasferta', 'la'])),
      rel: col(r, ['affidabilita', 'rel']) || 'B',
      note: col(r, ['nota', 'note']),
    };
    var ft = score(col(r, ['finale', 'ft'])),
      ht = score(col(r, ['primo_tempo', 'ht'])),
      an = col(r, ['annullata', 'cancelled']).toLowerCase();
    if (ft) m.ft = ft;
    if (ht) m.ht = ht;
    if (an === 'si' || an === 'sì' || an === '1' || an === 'true' || an === 'x') m.cancelled = true;
    return m;
  });
  return {
    batch: 'csv-' + new Date().toISOString().slice(0, 16),
    model: (db.predModel || {}).base || TIP_DEFAULTS,
    matches: matches,
  };
}
async function tipFetch({ manual = false } = {}) {
  if (tipUI.loading) return;
  tipUI.loading = true;
  try {
    var r = await fetch(TIP_FILE + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw Error(r.status === 404 ? 'Nessun file pronostici pubblicato.' : 'Errore ' + r.status);
    var d = await r.json();
    tipUI.fileInfo = d.batch ? 'File del ' + d.batch : '';
    var known = (db.predModel || {}).lastBatch;
    if (manual || d.batch !== known || d.matches.some(function (m) { return tipNum(m.ft); })) tipMerge(d, { manual: manual });
  } catch (e) {
    if (manual) U.toast(e.message || 'Impossibile leggere il file dei pronostici.');
  } finally {
    tipUI.loading = false;
    if (tab === 'tips') render();
  }
}

/* ---------- 3.49.0 — Pronostici prepartita automatici ----------
   La funzione pronostici-avvisi prepara da sola le partite dei prossimi 3 giorni dalle quote medie dei
   bookmaker (Bzzoiro): niente più file da far preparare a Claude o GPT. Il file manuale resta possibile. */
async function tipAutoPrematch({ manual = false } = {}) {
  if (!tipCanSync() || tipUI.preBusy) { if (manual && !tipCanSync()) U.toast('Fai l’accesso in Altro › Sincronizzazione per i pronostici automatici.'); return; }
  tipUI.preBusy = true;
  try {
    var f = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'prematch' } });
    if (f && f.bzRemaining != null) tipUI.bzRem = f.bzRemaining;
    if (!f || !Array.isArray(f.matches) || (!f.matches.length && f.error)) { if (manual) U.toast((f && f.error) || 'Pronostici automatici non disponibili.'); return; }
    var pm = db.predModel || {};
    if (!manual && f.batch === pm.lastAutoBatch) return;
    var file = { batch: f.batch, label: f.label, model: pm.base || TIP_DEFAULTS, matches: f.matches };
    tipMerge(file, { manual: manual });
    mutate(function (d) { d.predModel = d.predModel || {}; d.predModel.lastAutoBatch = f.batch; d.predModel.lastAutoAt = f.generatedAt; });
  } catch (e) {
    if (manual) U.toast(tipFnErr(e).replace('pronostici-dati', 'pronostici-avvisi').replace('GUIDA_DATI_AUTOMATICI', 'GUIDA_AVVISI'));
  } finally {
    tipUI.preBusy = false;
    if (tab === 'tips') render();
  }
}

/* ---------- 3.12.0 — Risultati e statistiche live automatici ----------
   Funzione Supabase "pronostici-dati" (dati API-Football; la chiave sta solo su Supabase).
   Serve l'accesso in Altro › Sincronizzazione. Guida: GUIDA_DATI_AUTOMATICI.txt */
var TIP_FN = '/functions/v1/pronostici-dati';
function tipCanSync() {
  return !!(window.SuiteSync && SuiteSync.signedIn);
}
function tipFnErr(e) {
  var t = String((e && e.message) || e || '');
  if (e && e.auth) return 'Fai l’accesso in Altro › Sincronizzazione per i dati automatici.';
  if (/404/.test(t) && /function|not found|NOT_FOUND/i.test(t)) return 'Su Supabase manca la funzione pronostici-dati: vedi GUIDA_DATI_AUTOMATICI.';
  if (/API_FOOTBALL_KEY/.test(t)) return 'Su Supabase manca il segreto API_FOOTBALL_KEY.';
  if (/suspended/i.test(t)) {
    tipUI.afOff = Date.now(); /* niente tentativi automatici finché l'account non torna attivo */
    return 'Account API-Football sospeso: entra su dashboard.api-football.com e controlla email/messaggi, o scrivi al supporto. I dati automatici ripartono da soli quando lo riattivano.';
  }
  if (/rateLimit|Too many requests|per minute/i.test(t)) return 'Troppe richieste in un minuto alla fonte dati. Riprova tra un minuto.';
  if (/request limit for the day|"requests"/i.test(t)) return 'Richieste giornaliere di API-Football finite: si azzerano alle 2 di notte.';
  if (/429|limit/i.test(t)) return 'Limite di richieste della fonte dati raggiunto. Riprova tra qualche minuto.';
  return t.replace(/^Errore \d+:\s*/, '').slice(0, 140) || 'Dati automatici non disponibili.';
}
/* 3.64.2 — controllo dei consigli ancora in attesa: perché non si chiudono (dopo ↻ Risultati automatici) */
function tipResultsCheck(note) {
  var D = tipUI.resDbg || {}, now = Date.now();
  var L = (((db.predModel || {}).playLog) || []).filter(function (e) { return e.res == null && tipKindActive(e.k) && (e.t || 0) > now - 3 * 86400e3; }).sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
  var rows = L.map(function (e) {
    var id = tipResKey(e), r = (D.by || {})[id], q = (D.endBy || {})[e.id], why;
    var endEst = (function () { var ko = tipKickoff({ date: e.date, time: e.time }).getTime(), e1 = ko + 125 * 60e3; if (U.finite(e.t) && U.finite(e.min)) { var rest = e.half === 1 ? (45 - e.min) + 15 + 50 : Math.max(0, 95 - e.min); e1 = Math.min(e1, e.t + (rest + 10) * 60e3); } return e1; })();
    if (!q && (e.miss || 0) < 10 && endEst < now) why = 'finita: la chiude il server o il prossimo giro (automatico)';
    else if (!q) why = (e.miss || 0) >= 10 ? 'tentativi finiti' : 'non ancora finita (fine stimata ' + (function () { var t = tipKickoff({ date: e.date, time: e.time }).getTime(); return new Date(t + 125 * 60e3).toLocaleString('it-IT', { day: '2-digit', hour: '2-digit', minute: '2-digit' }); })() + ')';
    else if ((D.sent || []).indexOf(id) < 0) why = 'in coda: la cerco al prossimo giro (automatico)';
    else if (!r) why = D.ver ? 'nessuna risposta dal server' : 'nessuna risposta: su Supabase c’è ancora la vecchia pronostici-dati';
    else if (r.dbg && r.dbg.queued) why = 'in coda: la cerco al prossimo giro (automatico)';
    else if (r.dbg && r.dbg.err) why = 'errore: ' + r.dbg.err;
    else if (!Array.isArray(r.ft)) why = 'non finita per TotalCorner · stato "' + (r.dbg ? r.dbg.st : '?') + '" · gol ' + (r.dbg ? r.dbg.hg + '-' + r.dbg.ag : '?') + ' · inizio ' + (r.dbg && r.dbg.ko ? new Date(r.dbg.ko).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '?');
    else why = 'risultato ' + r.ft.join('-') + (r.ht ? ' (1T ' + r.ht.join('-') + ')' : ' (manca il 1° tempo)') + ' · esito non calcolabile';
    return '<div class="tip-memory-row"><div class="tip-memory-info"><b>' + U.esc((e.home || '') + ' – ' + (e.away || '')) + '</b><small>' + U.esc(TIP_PLAY_SHORT[e.k] || e.k) + ' · ' + U.esc(e.date || '') + ' ' + U.esc(e.time || '') + ' · ' + (e.min || 0) + '’ · id ' + U.esc(e.afId || 'nessuno') + ' · tentativi ' + (e.miss || 0) + '</small><small class="tip-amber-text">' + U.esc(why) + '</small></div></div>';
  }).join('');
  if (typeof note !== 'string' && D.sent) note = D.ver ? 'Server pronostici-dati ' + D.ver : 'Server pronostici-dati vecchio: ripubblicalo con l’ultimo file';
  if (tipUI.serverVer) note = (typeof note === 'string' ? note + ' · ' : '') + 'pronostici-avvisi ' + tipUI.serverVer;
  var d = sheetModal(sheetHead('Consigli in attesa', { sub: L.length ? L.length + ' negli ultimi 3 giorni' : 'Nessuno' }) + '<div class="tip-sheet">' + (typeof note === 'string' ? '<p class="tip-amber-text">' + U.esc(note) + '</p>' : '') + '<p class="muted">Fai uno screenshot e mandalo a Claude se restano in attesa.</p><div class="tip-tlist">' + (rows || '<p class="muted">Tutti chiusi.</p>') + '</div></div>');
  d.classList.add('tip-dlg');
}
/* 3.86.0 — una richiesta per PARTITA (non per segnale): più segnali della stessa partita condividono il risultato */
function tipResKey(x) { return x.afId ? 'af:' + x.afId : 'log:' + x.id; }
async function tipAutoResults(opts) {
  opts = opts || {};
  if (tipUI.resBusy) { if (opts.manual) U.toast('Ricerca dei risultati già in corso, attendi qualche secondo.'); return; }
  if (!opts.manual && tipUI.afOff && Date.now() - tipUI.afOff < 6 * 3600e3) return;
  if (!tipCanSync()) {
    if (opts.manual) U.toast('Fai l’accesso in Altro › Sincronizzazione per i risultati automatici.');
    return;
  }
  var now = Date.now();
  /* 3.64.1 — una volta: i consigli rimasti in attesa per l'errore dei risultati ripartono da zero tentativi */
  /* 3.90.0 — una volta: le partite fermate a 3 tentativi (contati anche quando erano solo in coda) ripartono */
  if (!((db.predModel || {}).missReset390)) mutate(function (d) { d.predModel = d.predModel || {}; (d.predictions || []).forEach(function (m) { if (!tipNum(m.ft) && m.afId && (m.afMiss || 0) >= 3) m.afMiss = 0; }); d.predModel.missReset390 = true; });
  if (!((db.predModel || {}).missReset364)) mutate(function (d) { d.predModel = d.predModel || {}; (d.predModel.playLog || []).forEach(function (e) { if (e.res == null) e.miss = 0; }); d.predModel.missReset364 = true; });
  var hasHt = function (m) { return (m.picks || []).some(function (p) { return p.m === 'ht05'; }); };
  var todo = (db.predictions || []).filter(function (m) {
    /* 3.90.0 — con l'identificativo si riprova più a lungo: il registro dei finali non costa richieste a TotalCorner */
    if (m.cancelled || (m.afMiss || 0) >= (m.afId ? 8 : 3)) return false;
    var ko = tipKickoff(m).getTime();
    if (!(ko + 125 * 60e3 < now && ko > now - 5 * 86400e3)) return false;
    if (!tipNum(m.ft)) return true;
    if (m.ov && Object.keys(m.ov).length && !m.afId) return true; /* esiti a mano da sostituire */
    /* 3.14.1 — partite già chiuse ma senza minuto del primo gol (serve al piano 30') */
    return hasHt(m) && !Number.isInteger(m.fg) && tipNum(m.ht) && m.ht[0] + m.ht[1] > 0 && !m.fgTried;
  });
  /* 3.23.0 — partite valutate nel live ancora senza esito */
  var logTodo = {};
  /* 3.64.1 — prima i consigli (playLog), poi le altre partite valutate nel live: prima i consigli restavano
     fuori dal lotto. Fine partita stimata anche dal minuto del consiglio (l'orario d'inizio può essere sbagliato). */
  var endOf = function (x) {
    var ko = tipKickoff({ date: x.date, time: x.time }).getTime(), e1 = ko + 125 * 60e3;
    if (U.finite(x.t) && U.finite(x.min)) { var rest = x.half === 1 ? (45 - x.min) + 15 + 50 : Math.max(0, 95 - x.min); e1 = Math.min(e1, x.t + (rest + 10) * 60e3); }
    return e1;
  };
  (((db.predModel || {}).playLog) || []).forEach(function (x) {
    if ((x.res != null && !(x.played && x.played.res == null)) || (x.miss || 0) >= 10 || logTodo[x.id]) return;
    var end = endOf(x);
    if (!(end < now) || end < now - 7 * 86400e3) return;
    logTodo[x.id] = { id: 'log:' + x.id, date: x.date, time: x.time, endBy: end, home: x.home, away: x.away, league: x.league, afId: x.afId || null, needFg: true, needGoals: true };
  });
  (((db.predModel || {}).liveLog) || []).forEach(function (x) {
    if (x.res || (x.miss || 0) >= 10 || logTodo[x.id]) return;
    var ko = tipKickoff({ date: x.date, time: x.time }).getTime();
    if (!(ko + 125 * 60e3 < now) || ko < now - 7 * 86400e3) return;
    logTodo[x.id] = { id: 'log:' + x.id, date: x.date, time: x.time, home: x.home, away: x.away, league: x.league, afId: x.afId || null, needFg: true, needGoals: true };
  });
  /* 3.86.0 — richieste uniche per partita, prima quelle finite da più tempo */
  var reqMap = {};
  Object.keys(logTodo).forEach(function (k) {
    var x = logTodo[k], src = (((db.predModel || {}).playLog) || []).find(function (e) { return e.id === k; }) || (((db.predModel || {}).liveLog) || []).find(function (e) { return e.id === k; }) || { id: k, afId: x.afId };
    var key = tipResKey({ id: k, afId: x.afId || src.afId }), cur = reqMap[key];
    if (!cur) reqMap[key] = Object.assign({}, x, { id: key });
    else if ((x.endBy || 0) < (cur.endBy || Infinity)) cur.endBy = x.endBy;
  });
  var logList = Object.keys(reqMap).map(function (k) { return reqMap[k]; }).sort(function (a, b) { return (a.endBy || 0) - (b.endBy || 0); });
  if (!todo.length && !logList.length) {
    if (opts.manual) { tipUI.resDbg = { at: Date.now(), sent: [], by: {}, endBy: {} }; tipResultsCheck('Nessun consiglio è ancora da cercare: le partite risultano non finite.'); }
    return;
  }
  tipUI.resBusy = true;
  try {
    var r = await SuiteSync.api(TIP_FN, {
      method: 'POST',
      json: { action: 'results', matches: todo.slice(0, 80).map(function (m) { return { id: m.id, date: m.date, time: m.time, home: m.home, away: m.away, league: m.league, afId: m.afId || null, needFg: hasHt(m) && !Number.isInteger(m.fg) }; }).concat(logList.slice(0, 60)).sort(function (a, b) { return (b.endBy ? 1 : 0) - (a.endBy ? 1 : 0) || (a.endBy || 0) - (b.endBy || 0); }) },
    });
    var byId = {};
    (r.results || []).forEach(function (x) { byId[x.id] = x; });
    var n = 0, voids = 0;
    mutate(function (d) {
      d.predictions.forEach(function (m) {
        if (!todo.some(function (t) { return t.id === m.id; })) return;
        var x = byId[m.id];
        /* 3.90.0 — un tentativo si conta solo se la partita è stata davvero cercata (non se era in coda) */
        if (!x || (x.dbg && x.dbg.err)) { if (tipResChecked(x)) m.afMiss = (m.afMiss || 0) + 1; return; }
        m.afId = x.afId || m.afId;
        if (x.cancelled && !m.cancelled) { m.cancelled = true; m.ov = {}; voids++; }
        /* 3.14.1 — il risultato automatico prevale su quello segnato a mano:
           si aggiornano punteggi e si tolgono gli esiti manuali */
        if (Array.isArray(x.ft)) {
          if (!tipNum(m.ft) || m.ft[0] !== x.ft[0] || m.ft[1] !== x.ft[1]) n++;
          m.ft = x.ft;
          m.resultConfirmed = x.resultConfirmed === true;
          m.resultSource = x.resultSource || x.afId || null;
          m.confirmedAt = x.confirmedAt || null;
          m.ov = {};
        }
        if (Array.isArray(x.ht)) m.ht = x.ht;
        if (Number.isInteger(x.fg) && !Number.isInteger(m.fg)) m.fg = x.fg;
        if (tipNum(m.ft) && !Number.isInteger(m.fg) && m.ht && m.ht[0] + m.ht[1] > 0) m.fgTried = true;
      });
      d.predModel = d.predModel || {};
      (d.predModel.liveLog || []).forEach(function (rec) {
        if (rec.res || !logTodo[rec.id]) return;
        var x = byId[tipResKey({ id: rec.id, afId: logTodo[rec.id].afId })];
        if (!x || !Array.isArray(x.ft)) { if (tipResChecked(x)) rec.miss = (rec.miss || 0) + 1; return; }
        var res = tipLiveLogResolve(rec, x);
        if (res) rec.res = res;
      });
      (d.predModel.playLog || []).forEach(function (e) {
        var needP = e.played && e.played.res == null;
        if ((e.res != null && !needP) || !logTodo[e.id]) return;
        var x = byId[tipResKey({ id: e.id, afId: logTodo[e.id].afId })];
        /* 3.86.0 — un tentativo si conta solo se il server ha davvero cercato la partita (non se era in coda) */
        if (!x || !Array.isArray(x.ft)) { if (tipResChecked(x)) e.miss = (e.miss || 0) + 1; return; }
        if (e.res == null) {
          var o = tipPlayOutcome(e, x);
          if (o != null) { e.res = o; e.ft = x.ft; e.ht = x.ht || null; e.cornersFinal = x.corners || null; e.cornersHt = x.htCorners || null; e.resultConfirmed = x.resultConfirmed === true; e.resultSource = x.resultSource || x.afId || null; e.confirmedAt = x.confirmedAt || null; if (Array.isArray(x.goals)) e.goalsAt = x.goals; }
          else e.miss = (e.miss || 0) + 1;
        }
        if (e.initial && e.initial.res == null) e.initial.res = tipPlayOutcome(e.initial, x);
        if (needP) { var op = tipPlayedOutcome(e, x); if (op != null) e.played.res = op; }
      });
      d.predModel.lastResults = new Date().toISOString();
      if (r.remaining != null) d.predModel.afRemaining = r.remaining;
    });
    setTimeout(tipDailyReports, 300);
    if (opts.manual) { tipUI.resDbg = { at: Date.now(), ver: r.ver || null, sent: logList.slice(0, 60).map(function (x) { return x.id; }), by: byId, endBy: logTodo }; setTimeout(function () { tipResultsCheck(); }, 400); }
    /* 3.86.0 — se ne restano in coda, nuovo giro tra 75 secondi (limite TotalCorner: 30 richieste al minuto) */
    var queued = (r.results || []).filter(function (x) { return x.dbg && x.dbg.queued; }).length + Math.max(0, logList.length - 60);
    if (queued && (tipUI._resLoop || 0) < 8) { tipUI._resLoop = (tipUI._resLoop || 0) + 1; setTimeout(function () { tipAutoResults(); }, 75e3); }
    else tipUI._resLoop = 0;
    if (n || voids || opts.manual)
      U.toast(n || voids ? 'Risultati automatici: ' + n + ' partite' + (voids ? ', ' + voids + ' rinviate' : '') : 'Nessun nuovo risultato (' + (r.unmatched || 0) + ' partite non trovate)');
  } catch (e) {
    var net = /load failed|failed to fetch|networkerror|network request|aborted|timeout/i.test(String((e && e.message) || e));
    /* 3.87.0 — connessione interrotta (app in background, rete): nuovo tentativo da solo; i risultati li chiude comunque il server */
    if (net && (tipUI._resLoop || 0) < 8) { tipUI._resLoop = (tipUI._resLoop || 0) + 1; setTimeout(function () { tipAutoResults(); }, 60e3); }
    if (opts.manual) tipResultsCheck(net ? 'Connessione interrotta durante la ricerca (succede se l’app va in background o la rete cade): riprovo da solo. Gli esiti li chiude anche il server ogni 2 minuti.' : 'Errore dal server: ' + tipFnErr(e));
  } finally {
    tipUI.resBusy = false;
    if (tab === 'tips') render();
  }
}
function tipResChecked(x) { return !!x && !(x.dbg && (x.dbg.queued || /in coda|limite di richieste/.test(String(x.dbg.err || '')))); }
async function tipLiveFetch(m) {
  if (!tipCanSync()) throw Object.assign(new Error('auth'), { auth: true });
  var r = await SuiteSync.api(TIP_FN, {
    method: 'POST',
    json: { action: 'live', match: { id: m.id, date: m.date, time: m.time, home: m.home, away: m.away, league: m.league, afId: (tipUI.scanLink || {})[m.id] || m.afId || null } },
  });
  if (r.afId && !m.afId && !m.scan) mutate(function (d) { var x = d.predictions.find(function (y) { return y.id === m.id; }); if (x) x.afId = r.afId; });
  return r;
}
/* ---------- 3.17.0 — Modello live allenato su dati veri ----------
   Allenato su ~1.900 partite StatsBomb (eventi minuto per minuto): per ogni squadra e ogni minuto
   impara quanto contano tiri, tiri in porta, tiri in area, xG, angoli, possesso, momento degli
   ultimi minuti, punteggio, espulsioni e forza prepartita sui gol che arrivano dopo.
   Base: i gol attesi prepartita dell'app (statistiche + quote) e la curva reale dei gol nel tempo.
   TIP_LM è generato dallo script di allenamento (coefficienti e curve). */
var TIP_LM = /*LM*/{"H1":0.4403,"R":{"5":0.9701,"10":0.9267,"15":0.8813,"20":0.8354,"25":0.7892,"30":0.7409,"35":0.6924,"40":0.6423,"42":0.6228,"50":0.5157,"55":0.4584,"60":0.3993,"65":0.344,"70":0.2897,"75":0.2361,"80":0.182,"85":0.1247,"88":0.092},"R1":{"5":0.4104,"10":0.367,"15":0.3216,"20":0.2757,"25":0.2295,"30":0.1811,"35":0.1326,"40":0.0826,"42":0.0631},"K":{"s":9.584,"t":3.29,"b":5.652,"c":3.826,"x":0.978},"models":{"full":{"keys":["xg","xgo","sot","box","sh","cor","soto","gl","rxg","rsot","rsh","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0216,0.0591,0.0215,-0.0055,0.0128,0.0614,0.0365,0.0115,-0.0045,0.0127,-0.0173,0.0292,0.1235,-0.1096,0.1403,0.0713,-0.0028,0.0312,-0.0104,-0.021,-0.0394,0.0617,-0.0093],"c1":0.9827},"noxg":{"keys":["sot","box","sh","cor","soto","gl","rsot","rsh","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0197,0.0,0.0314,0.0692,0.0358,0.0187,0.0083,-0.0148,0.0347,0.1226,-0.1096,0.142,0.0735,-0.0035,0.0332,-0.0109,-0.022,-0.0402,0.0625,-0.0072],"c1":0.9833},"norec":{"keys":["xg","xgo","sot","box","sh","cor","soto","gl","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0148,0.0816,0.0309,-0.0251,0.0016,0.1039,0.036,0.0104,-0.0095,0.2608,-0.2196,0.2452,0.088,0.005,0.047,-0.0236,-0.0393,-0.0574,0.0495,-0.0157],"c1":0.9828},"basic":{"keys":["sot","box","sh","cor","soto","gl","poss","red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0131,-0.0174,0.027,0.1176,0.0345,0.0216,0.0097,0.2578,-0.2195,0.2488,0.0926,0.0016,0.0468,-0.0249,-0.0408,-0.0586,0.0514,-0.0143],"c1":0.9834},"book":{"keys":["red","redo","lose","win1","win2","lose_l","win_l","draw_l","fav","rg"],"b":[0.0099,-0.2897,0.2816,0.1023,-0.0028,0.0341,0.0153,-0.0524,-0.0019,0.0302,-0.0044],"c1":0.9995}}}/*LM*/;
var TIP_MIN_ODDS = 1.5; /* 3.23.0 — mai sotto quota 1.50 */
function tipNeedQ(fair) { return Math.max(TIP_MIN_ODDS, tipLiveMinQ(), fair || 0); }
var TIP_LIVE_MINP = 0.6; /* 3.19.1 — si gioca solo se è più probabile che segnino (almeno 60%) */
var TIP_SCAN_MINP = 0.5; /* 3.17.2 — il verdetto considera solo giocate più probabili che no, come il tuo metodo */
var TIP_LIVE_MARGIN = 1.07; /* aggio tipico dei book sui mercati live */
function tipLmInterp(tab, t) {
  var ks = Object.keys(tab).map(Number).sort(function (a, b) { return a - b; });
  if (t <= ks[0]) return tab[ks[0]];
  for (var i = 1; i < ks.length; i++) if (t <= ks[i]) {
    var a = ks[i - 1], b = ks[i];
    return tab[a] + (tab[b] - tab[a]) * (t - a) / (b - a);
  }
  return tab[ks[ks.length - 1]];
}
/* quota dei gol della partita che deve ancora arrivare: totale e solo 1° tempo */
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
/* 3.21.0 — peso delle statistiche per fase (simulazione su 2.632 partite: 2° tempo ×1.5, 1° tempo dopo il 25' ×1.2)
   e correzione dell'ottimismo sopra il 70% (reale ≈ 70% + (previsto − 70%) × 0.82). */
var TIP_LM_SCALE = { h2: 1.5, h1late: 1.2 };
var TIP_LM_STATE = ['red', 'redo', 'lose', 'win1', 'win2', 'lose_l', 'win_l', 'draw_l', 'fav', 'rg'];
function tipLmCal(p) { return p < 0.7 ? p : 0.7 + (p - 0.7) * 0.82; }
var TIP_LM_LABEL = {
  xg: 'xG', xgo: 'xG avversari (partita aperta)', sot: 'tiri in porta', box: 'tiri in area', sh: 'tiri', cor: 'angoli',
  soto: 'tiri in porta avversari', gl: 'gol già segnati', rxg: 'xG ultimi minuti', rsot: 'tiri in porta ultimi minuti',
  rsh: 'tiri ultimi minuti', poss: 'possesso', red: 'espulso', redo: 'avversario in 10', lose: 'in svantaggio',
  win1: 'avanti di 1', win2: 'avanti di 2+', lose_l: 'in svantaggio dopo il 60’', win_l: 'in vantaggio dopo il 60’',
  draw_l: 'pari dopo il 60’', fav: 'forza prepartita', rg: 'gol appena segnato', altro: 'altri fattori',
};
/* inp: { min, half, gh, ga, side:[{s,t,b,c,xg,poss,red},{...}], prev:{min, side} } */
var TIP_DA_PER_GOAL = 37;
/* 3.63.0 — media gol del campionato, costruita dal server con le partite finite (stato "lgAvg").
   Con le quote il book ne tiene già conto: correzione leggera; senza quote: correzione più forte.
   Sotto le 8 partite non si usa; si "tira" verso 2,7 con 12 partite virtuali. */
function tipLgFactor(league, withOdds) {
  var A = tipUI.lgAvg && tipUI.lgAvg[league];
  if (!A || !(A.n >= 8)) return 1;
  var avg = (A.g + 2.7 * 12) / (A.n + 12);
  return Math.max(0.85, Math.min(1.15, Math.pow(avg / 2.7, withOdds ? 0.35 : 0.7)));
}
function tipLgAvgOf(league) { var A = tipUI.lgAvg && tipUI.lgAvg[league]; return A && A.n >= 8 ? { avg: A.g / A.n, n: A.n } : null; }
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
    /* 3.63.0 — attacchi pericolosi (TotalCorner): pressione rispetto a quella attesa per i gol previsti.
       Circa 37 attacchi pericolosi per gol atteso; peso prudente, finché non lo ricalibriamo sui risultati. */
    if (U.finite(si.da) && si.da > 0 && min >= 10) {
      var vda = Math.max(-0.25, Math.min(0.25, 0.12 * lg(si.da, TIP_DA_PER_GOAL * Ei, 3)));
      x += vda; parts.push({ k: 'da', v: vda });
    }
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
  /* 3.62.0 — gol attesi pre-partita dalle quote del book (null se la partita non ha quote) */
  var lamPre = U.finite(m.lhM) && U.finite(m.laM) ? m.lhM + m.laM : m.scanSrc === 'quote' ? (m.lh + m.la) / (m.lgF || 1) : null;
  return { lamPre: lamPre, lgTier: tipLeagueTier(m), goals: G, lead: g[0] !== g[1], pWin: pWin, F: L / Math.max(0.001, base), used: hasStats, model: name, recent: !!pv, xg: hasXg, rem: R, L: L, rh: rh, ra: ra, lines: lines, lam: lam[0] + lam[1], teams: out };
}
function tipIsLiveNow(m) {
  if (m.cancelled || tipNum(m.ft)) return false;
  var ko = tipKickoff(m).getTime(), now = Date.now();
  return now >= ko - 5 * 60e3 && now <= ko + 135 * 60e3;
}
/* ---------- 3.18.0 — Scanner: tutte le partite live del mondo ---------- */
async function tipScanFetch() {
  if (!tipCanSync()) throw Object.assign(new Error('auth'), { auth: true });
  /* 3.57.0 — prima le partite già scaricate dal giro sul server (nessuna richiesta in più a TotalCorner), poi la lettura diretta */
  var r = null;
  try { r = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'scan' } }); } catch (e) { r = null; }
  if (!r || !Array.isArray(r.live)) r = await SuiteSync.api(TIP_FN, { method: 'POST', json: { action: 'scan', odds: true } });
  if (r.lgAvg) tipUI.lgAvg = r.lgAvg;
  tipUI.scan = { at: Date.now(), list: r.live || [], oddsNote: r.oddsNote || null, remaining: r.remaining };
  return tipUI.scan;
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
/* 3.63.0 — parole comuni che da sole non identificano una squadra ("Al" Hilal / "Al" Nassr, "Real", "United"...):
   prima bastava "Al" per scambiare due partite saudite. Ora serve almeno una parola distintiva in comune,
   e la categoria (U19, U21, femminile, riserve) deve essere la stessa. */
var TIP_NAME_STOP = { al: 1, el: 1, de: 1, del: 1, da: 1, la: 1, le: 1, los: 1, las: 1, the: 1, real: 1, united: 1, utd: 1, city: 1, town: 1, sporting: 1, sport: 1, athletic: 1, atletico: 1, deportivo: 1, dinamo: 1, dynamo: 1, olympic: 1, olimpia: 1, union: 1, fc: 1, sc: 1 };
var TIP_NAME_CAT_RE = /^(u\d{2}|w|women|femminile|fem|ii|b|reserves?|youth|res)$/;
function tipNameCat(T) { var N = { res: 'reserves', reserve: 'reserves', women: 'w', femminile: 'w', fem: 'w' }; return T.filter(function (t) { return TIP_NAME_CAT_RE.test(t); }).map(function (t) { return N[t] || t; }).sort().join(' '); }
function tipNameSim(a, b) {
  var A0 = tipNameTok(a), B0 = tipNameTok(b);
  if (!A0.length || !B0.length) return 0;
  if (A0.join('') === B0.join('')) return 1;
  if (tipNameCat(A0) !== tipNameCat(B0)) return 0;
  /* 3.90.0 — la categoria (Reserves, U19, Women...) non è una parola distintiva: "Watford Reserves" e "Sarmiento Reserves" non hanno nulla in comune */
  var sig = function (T) { var r = T.filter(function (t) { return !TIP_NAME_STOP[t] && t.length >= 3 && !TIP_NAME_CAT_RE.test(t); }); return r.length ? r : T.filter(function (t) { return !TIP_NAME_CAT_RE.test(t); }); };
  var A = sig(A0), B = sig(B0);
  if (!A.length || !B.length) return 0;
  var c = A.filter(function (t) { return B.some(function (u) { return u === t || (t.length >= 4 && u.length >= 4 && (u.indexOf(t) === 0 || t.indexOf(u) === 0)); }); }).length;
  return c / Math.min(A.length, B.length);
}
/* 3.90.0 — prima l'identificativo della partita: se il pronostico ne ha già uno diverso, è un'altra partita.
   Per nome solo se l'abbinamento è chiaro (nessun secondo candidato quasi uguale). */
function tipFindApp(home, away, ko, afId) {
  var t = ko ? ko.getTime() : Date.now(), best = null, bs = 0, second = 0, list = db.predictions || [];
  if (afId) { var ex = list.find(function (m) { return m.afId === afId && !m.cancelled; }); if (ex) return ex; }
  list.forEach(function (m) {
    if (afId && m.afId && m.afId !== afId) return;
    if (Math.abs(tipKickoff(m).getTime() - t) > 4 * 3600e3) return;
    var a = tipNameSim(m.home, home), b = tipNameSim(m.away, away), sc = a + b;
    if (a < 0.5 || b < 0.5) return;
    if (sc > bs) { second = bs; bs = sc; best = m; } else if (sc > second) second = sc;
  });
  return best && bs - second >= 0.25 ? best : null;
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
  var lgF = tipLgFactor(x.league, src !== 'media');
  lam *= lgF;
  var sh = 0.53, x12 = (pre && pre.x12) || (x.odds && x.odds.x12);
  if (x12 && (gh === ga || (pre && pre.x12))) {
    var ih = 1 / x12[0], ia = 1 / x12[2], sum = ih + 1 / x12[1] + ia;
    sh = Math.max(0.25, Math.min(0.75, 0.5 + 0.45 * (ih - ia) / sum));
  }
  var ko = x.kickoff ? new Date(x.kickoff) : new Date();
  var m = {
    id: 'scan_' + x.afId, afId: x.afId, scan: true, scanSrc: src, lgF: lgF,
    home: x.home, away: x.away, league: (x.country ? x.country + ' · ' : '') + x.league,
    date: ko.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }),
    time: ko.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' }),
    lh: lam * sh, la: lam * (1 - sh), rel: 'C',
  };
  /* 3.24.1 — se la partita è anche nei pronostici, uso quella: stessa forza prepartita
     (statistiche + quote + contesto) e stesso risultato, da qualunque parte la apri */
  var am = tipFindApp(x.home, x.away, ko, x.afId);
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
/* ---------- 3.20.0 — Preferiti ---------- */
function tipIsStar(m) {
  if (!m) return false;
  var lid = m.scan ? m.afId : (tipUI.scanLink || {})[m.id] || m.afId;
  if (!m.scan) {
    var cur = (db.predictions || []).find(function (x) { return x.id === m.id; });
    if (cur && cur.star) return true;
  }
  return !!lid && tipLiveStars().some(function (z) { return z.afId === lid; });
}
function tipToggleStar(id) {
  var was = tipIsStar((db.predictions || []).find(function (y) { return y.id === id; }));
  mutate(function (d) {
    var x = (d.predictions || []).find(function (y) { return y.id === id; });
    if (!x) return;
    var lid = (tipUI.scanLink || {})[id] || x.afId;
    if (was) {
      delete x.star;
      if (d.predModel && d.predModel.liveStars) d.predModel.liveStars = d.predModel.liveStars.filter(function (z) { return z.afId !== lid; });
    } else x.star = true;
  });
}
function tipLiveStars() {
  var cut = Date.now() - 14 * 3600e3;
  return ((db.predModel || {}).liveStars || []).filter(function (x) { return x.at > cut; });
}
function tipToggleLiveStar(afId, info) {
  mutate(function (d) {
    var cut = Date.now() - 14 * 3600e3;
    d.predModel = d.predModel || {};
    var L = (d.predModel.liveStars || []).filter(function (x) { return x.at > cut; });
    var i = L.findIndex(function (x) { return x.afId === afId; });
    if (i >= 0) L.splice(i, 1);
    else L.push({ afId: afId, home: info.home, away: info.away, league: info.league, at: Date.now() });
    d.predModel.liveStars = L;
  });
}
function tipStarPanel(list) {
  var stars = tipLiveStars(),
    apps = list.filter(function (m) { return m.star && !tipNum(m.ft) && !m.cancelled && tipKickoff(m).getTime() < Date.now() + 3 * 3600e3 && tipKickoff(m).getTime() > Date.now() - 135 * 60e3; });
  if (!stars.length && !apps.length) return '';
  var S = tipUI.scan, rows = '';
  apps.forEach(function (m) {
    var d = (tipUI.liveData || {})[m.id];
    rows += '<div class="tip-srowx"><button type="button" class="tip-trow" data-tip-live="' + U.esc(m.id) + '"><span class="tip-tn tip-ln">' + (d && d.elapsed != null ? d.elapsed + '\'' : U.esc(m.time)) + '</span><span class="tip-tmain"><b>' + U.esc(m.home) + ' – ' + U.esc(m.away) + '</b><small>' + U.esc(m.league) + ' · dai pronostici</small></span><span class="tip-tpick"><b>' + (d && d.goals ? d.goals[0] + '-' + d.goals[1] : 'vs') + '</b><small>valuta ›</small></span></button>' +
      '<button type="button" class="tip-star on" data-tip-star="' + U.esc(m.id) + '" aria-label="Togli dai preferiti">★</button></div>';
  });
  stars.forEach(function (st) {
    var x = S && S.list.find(function (y) { return y.afId === st.afId; }),
      y = x ? tipScanMatch(x) : null;
    if (y) { tipUI.scanMap = tipUI.scanMap || {}; tipUI.scanMap[y.x.afId] = y.m; }
    rows += '<div class="tip-srowx">' + (y
      ? '<button type="button" class="tip-trow" data-scan-open="' + U.esc(st.afId) + '"><span class="tip-tn tip-ln">' + (y.x.status === 'HT' ? 'HT' : y.min + '\'') + '</span><span class="tip-tmain"><b>' + U.esc(st.home) + ' – ' + U.esc(st.away) + '</b><small>' + U.esc(st.league || '') + '</small></span><span class="tip-tpick"><b>' + y.x.goals[0] + '-' + y.x.goals[1] + ' · ' + Math.round(y.main.p * 100) + '%</b><small>' + (y.r.rem.ht > 0 ? 'gol 1T' : 'altro gol') + ' ›</small></span></button>'
      : '<div class="tip-trow tip-trow-off"><span class="tip-tn tip-ln">—</span><span class="tip-tmain"><b>' + U.esc(st.home) + ' – ' + U.esc(st.away) + '</b><small>' + (S ? 'non è tra le partite in corso (finita?)' : 'tocca Scansiona per aggiornarla') + '</small></span></div>') +
      '<button type="button" class="tip-star on" data-live-star="' + U.esc(st.afId) + '" aria-label="Togli dai preferiti">★</button></div>';
  });
  return '<section class="card tip-top"><div class="tip-top-head"><b>★ Preferite</b><span>' + (stars.length + apps.length) + '</span></div><div class="tip-tlist">' + rows + '</div></section>';
}
/* 3.55.0 — una sola valutazione per scansione, usata da Live, Home dei Pronostici e numero sulla barra (sempre uguali) */
function tipScanEval() {
  var S = tipUI.scan;
  if (!S) return [];
  if (tipUI._evAt === S.at && tipUI._ev) return tipUI._ev;
  var all = S.list.map(tipScanMatch).filter(Boolean);
  tipUI.scanRows = all;
  tipUI.scanMap = {};
  all.forEach(function (y) {
    tipUI.scanMap[y.x.afId] = y.m;
    y.tempo = y.r.L / Math.max(0.03, y.r.rem.all);
    y.ritmo = y.x.stats ? y.r.F : 1;
    y.grp = !y.x.stats ? 1 : y.ritmo >= 1.08 ? 0 : y.ritmo <= 0.92 ? 2 : 1;
    y.act = tipQuickAction(y);
    y.best = tipPlayBest(y.plays);
    y.trials = tipTrialPlays(y.r, y.min, y.half, y.x, tipLivePrev(y.m.id, y.min, y.half));
    if (y.x.stats) { tipPlayLogAdd(y.m, { min: y.min, half: y.half, gh: y.x.goals[0], ga: y.x.goals[1] }, y.plays); tipTrialLogAdd(y.m, { min: y.min, half: y.half, gh: y.x.goals[0], ga: y.x.goals[1] }, y.trials, y.x.afId); }
  });
  if (tipUI._histAt !== S.at) {
    tipUI._histAt = S.at;
    tipLiveHistMany(all.filter(function (y) { return y.x.stats && y.x.stats.side && y.min != null; }).map(function (y) { return { id: y.m.id, snap: { min: y.min, half: y.half, side: y.x.stats.side, at: S.at } }; }));
  }
  tipUI._evAt = S.at; tipUI._ev = all;
  return all;
}
/* giocate consigliate in questo momento (scansione degli ultimi 6 minuti) */
function tipLiveNowPlays() {
  if (!tipUI.scan || Date.now() - tipUI.scan.at > 6 * 60e3) return null;
  return tipScanEval().filter(function (y) { return y.best && !(y.half === 1 && y.min < 15); })
    .map(function (y) { return { id: y.m.id, home: y.m.home, away: y.m.away, min: y.min, k: y.best.k, p: y.best.p, tier: y.best.green ? 'excellent' : 'try', lg: y.r.lgTier }; })
    .sort(function (a, b) { return (a.tier === 'try' ? 1 : 0) - (b.tier === 'try' ? 1 : 0) || b.p - a.p; });
}
function tipScanPanel() {
  var S = tipUI.scan;
  var head = '<section class="card tip-top tip-live-section"><div class="tip-top-head"><b>Scanner live</b><span>' + (S ? 'Aggiornate alle ' + new Date(S.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'In attesa della scansione') + '</span></div>';
  if (!S) return head + '<p class="muted tip-tnone">Partite live nel mondo, dalla più probabile per un gol.</p></section>';
  var all = tipScanEval(), showAll = !!tipUI.scanAll;
  var freshS = tipUI.freshIds || {};
  /* 3.25.0 — non per probabilità grezza (premia le partite appena iniziate e quelle forti ma bloccate):
     prima le partite che SPINGONO (statistiche sopra le attese), poi normali, poi bloccate;
     dentro ogni gruppo per ritmo gol attuale. Le appena iniziate (sotto il 15') a parte. */
  var early = all.filter(function (y) { return y.half === 1 && y.min < 15; }),
    rows = all.filter(function (y) {
      if (showAll) return true;
      return !(y.half === 1 && y.min < 15) && y.min <= 80 && y.m.scanSrc !== 'media' && y.act.k !== 'no';
    }).sort(function (a2, b2) { return a2.grp - b2.grp || b2.tempo - a2.tempo; }).slice(0, 40);
  var withOdds = all.filter(function (y) { return y.m.scanSrc !== 'media'; }).length;
  var GRP = ['<b class="positive">spingono</b>', 'normale', '<b class="negative">bloccata</b>'];
  var rowH = function (y) {
    var on = tipIsStar(y.m), next = y.x.goals[0] + y.x.goals[1] + 1;
    var nw = y.act.k !== 'no' && freshS[y.m.id];
    return '<div class="tip-srowx"><button type="button" class="tip-trow' + (y.act.k !== 'no' ? (y.act.c === 'positive' ? ' tip-hot' : ' tip-warm') : '') + (nw ? ' tip-new' : '') + '" data-scan-open="' + y.x.afId + '"><span class="tip-tn tip-ln">' + (y.x.status === 'HT' ? 'HT' : y.min + '\'') + '</span><span class="tip-tmain"><b>' + (nw ? '<i class="tip-newtag">NUOVA</i> ' : '') + U.esc(y.m.home) + ' – ' + U.esc(y.m.away) + '</b><small>' + (y.x.stats ? GRP[y.grp] + ' ' + (y.ritmo >= 1 ? '+' : '') + Math.round((y.ritmo - 1) * 100) + '%' : U.esc(y.m.league)) + (y.act.s ? ' · ' + y.act.s : '') + '</small><small class="tip-next-goal">⚽ Next gol: ' + next + '° della partita · ' + (y.act.k !== 'no' ? 'consiglio riferito al ' + y.x.goals[0] + '-' + y.x.goals[1] : 'nessun ingresso ottimo ora') + '</small></span><span class="tip-tpick"><b>' + y.x.goals[0] + '-' + y.x.goals[1] + ' <span class="' + y.act.c + '">' + y.act.t + '</span></b><small>gol ' + y.act.w + ' ' + Math.round(y.act.p * 100) + '% ›</small></span></button>' +
      '<button type="button" class="tip-star' + (on ? ' on' : '') + '" data-live-star="' + U.esc(y.x.afId) + '" aria-label="Preferita">' + (on ? '★' : '☆') + '</button></div>';
  };
  return head +
    '<p class="muted tip-hint">Copertura Live: tutte le competizioni restituite dal provider, incluse femminili e giovanili se presenti nel feed. Quelle non fornite non possono essere mostrate.</p><div class="tip-live-counts"><span><strong>' + S.list.length + '</strong> trovate</span><span><strong>' + all.length + '</strong> valutate</span><span><strong>' + rows.length + '</strong> ' + (showAll ? 'mostrate' : 'selezionate') + '</span></div>' +
    '<p class="tip-live-caution">OTTIMA: stima almeno 50% e sopra la soglia di quel minuto. Gli ingressi futuri e gli step costosi restano DA VALUTARE. Gioca solo se il book paga almeno la quota minima.</p><p class="muted tip-hint">Ogni indicazione riguarda il prossimo gol rispetto al risultato dell’ultima scansione.</p>' +
    (rows.length ? '<div class="tip-tlist">' + rows.map(rowH).join('') + '</div>' : '<p class="muted tip-tnone">Niente da giocare adesso: nessuna partita da gol, non bloccata, con quota 1.50 raggiungibile. Riscansiona tra qualche minuto.</p>') +
    (early.length && !showAll ? '<p class="muted tip-hint">' + early.length + ' appena iniziate (sotto il 15’): rivaluta più avanti.</p>' : '') +
    '<button type="button" class="tip-ctx-btn" data-scan-all>' + (showAll ? 'Mostra solo le giocabili' : 'Mostra tutte le partite') + '</button>' +
    '</section>';
}
/* 3.25.1 — si consiglia solo su partite "da gol": prepartita sopra la soglia delle Top
   (1T ≥ soglia Over 0.5 1T, fine partita ≥ soglia Over 1.5), non bloccate, e non prima del 15'.
   Così un consiglio dato presto non diventa "non giocare" un quarto d'ora dopo solo perché passa il tempo. */
function tipLiveGate(m, r, min, half, kind) {
  var P = tipParams(), c = tipCalc(m, P);
  if (half === 1 && min < 15) return 'rivaluta dal 15’, prima le statistiche non dicono niente';
  if (r.used && r.F <= 0.92) return 'partita bloccata (ritmo ' + Math.round((r.F - 1) * 100) + '%)';
  /* 3.32.0 — se la partita spinge forte (statistiche +15% sulle attese) basta un prepartita un po' più basso */
  var strong = r.used && r.F >= 1.15, slack = strong ? 10 : 0;
  if (kind === 'h1' && c.ht05 < tipThr(P, 'ht05') - slack) return 'non è una partita da gol nel 1° tempo (prepartita ' + Math.round(c.ht05) + '%' + (r.used ? ', ritmo ' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%' : '') + ')';
  if (kind === 'n1' && c.o15 < tipThr(P, 'o15') - slack) return 'non è una partita da gol (prepartita Over 1.5 ' + Math.round(c.o15) + '%' + (r.used ? ', ritmo ' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%' : '') + ')';
  return null;
}
/* ---------- 3.33.0 — Giocate per tipo, con probabilità di riuscita ----------
   Ogni tipo di giocata ha la sua probabilità di riuscita (vince se arriva almeno un gol nella finestra
   della giocata; a step = almeno uno step vinto). "Ottima" (verde) se è nel 30% migliore delle partite
   in quello stesso minuto per quel tipo: soglie dalla simulazione su 8.534 partite (sim5). */
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
var TIP_PLAY_SHORT = { t2w: 'aspetta unico', t1w: 'aspetta 1T', t1st: 'step 1T', t1s15: '1T ≥1.50', t1s18: '1T ≥1.80', t2st3: 'step 60-80-fine', t2st2: 'step 80-fine', t2u15: 'unico ≥1.50', t2u18: 'unico ≥1.80',
  tp1: '1T a pressione', tp2: '2T a pari', tc1: '+1 angolo finale', tc2: '+2 angoli finali', th1: '+1 angolo 1T', th2: '+2 angoli 1T', tq1: '1T sotto pressione', tq2: 'favorita spinge', tg1: 'gol 1T presto', tn2: 'gol 70-80' };
TIP_PLAY_NAME.tp1 = 'IN PROVA · 1° tempo a pressione (dal 25’ allo 0-0, tanti tiri in porta e angoli)';
TIP_PLAY_NAME.tp2 = 'IN PROVA · 2° tempo a punteggio pari (46’-65’, ritmo alto)';
TIP_PLAY_NAME.tc1 = 'IN PROVA · almeno 1 angolo in più entro la fine (dall’82’)';
TIP_PLAY_NAME.tc2 = 'IN PROVA · almeno 2 angoli in più entro la fine (dall’82’)';
TIP_PLAY_NAME.tg1 = 'IN PROVA · gol nel 1° tempo, segnalato presto (8’-20’, 0-0)';
TIP_PLAY_NAME.tn2 = 'IN PROVA · prossimo gol entro la fine, ingresso 70’-80’';
TIP_PLAY_NAME.tq1 = 'IN PROVA · 1° tempo sotto pressione (20’-38’, ritmo degli ultimi minuti molto sopra la media)';
TIP_PLAY_NAME.tq2 = 'IN PROVA · 2° tempo, la favorita non vince e spinge (55’-78’)';
TIP_PLAY_NAME.th1 = 'IN PROVA · almeno 1 angolo in più entro l’intervallo (dal 36’)';
TIP_PLAY_NAME.th2 = 'IN PROVA · almeno 2 angoli in più entro l’intervallo (dal 36’)';
/* 3.68.0 — SEGNALI IN PROVA: regole provvisorie, niente notifiche, tracciati a parte (una voce per partita, punteggio e tipo).
   Servono a misurare quanto vincono prima di tararli con i dati registrati sul server. */
var TIP_TRIAL = { tp1: 1, tp2: 1, tq1: 1, tq2: 1, tg1: 1, tn2: 1, tc1: 1, tc2: 1, th1: 1, th2: 1 };
/* 3.71.0 — ANGOLI 1° e 2° tempo (IN PROVA). Finestre: 1T 36’-42’ (+1/+2 entro l’intervallo), 2T 82’-87’ (+1/+2 entro la fine).
   Ritmo atteso = quote pre-partita della linea angoli (se c’è) + storico delle due squadre (angoli fatti/subiti, ultime 10
   partite verificate) + media del campionato; poi si corregge con gli angoli già visti, l’andamento recente e il punteggio.
   Se il book ha la linea angoli live con le quote Over/Under, la stima si avvicina a quella del book (pesa 60%) e la quota
   vera della giocata viene registrata: con quota sotto la quota giusta la giocata resta al massimo DA VALUTARE. */
var TIP_CORNER_WIN = { 1: { from: 36, to: 42, end: 45, stop: 2, K: 15, base: 10 }, 2: { from: 82, to: 87, end: 90, stop: 4, K: 27, base: 10 } };
function tipCornerLineMean(L) {
  if (!U.finite(L) || L <= 0) return null;
  var fr = L - Math.floor(L);
  return Math.abs(fr - 0.5) < 0.01 ? L + 0.17 : fr < 0.01 ? L - 0.33 : L - 0.08;
}
function tipCornerTeam(t) {
  if (!t || !U.finite(t.n) || t.n < 1 || !U.finite(t.cf) || !U.finite(t.ca)) return null;
  return t;
}
function tipCornerPrior(x) {
  var H = (x && x.cornerHist) || {}, lg = H.lg && U.finite(H.lg.avg) && H.lg.n >= 5 ? H.lg : null;
  var lgAvg = lg ? lg.avg : 10, lgHt = lg && U.finite(lg.htAvg) ? lg.htAvg : null;
  var h = tipCornerTeam(H.h), a = tipCornerTeam(H.a), hist = null, n = 0;
  if (h && a) {
    var sh = function (t, v) { return (v * t.n + (lgAvg / 2) * 5) / (t.n + 5); };
    hist = (sh(h, h.cf) + sh(a, a.ca)) / 2 + (sh(a, a.cf) + sh(h, h.ca)) / 2;
    n = Math.min(h.n, a.n);
  }
  var share = 0.46, sh2 = [];
  [h, a].forEach(function (t) { if (t && U.finite(t.htShare) && t.nHt >= 3) sh2.push([t.htShare, t.nHt]); });
  if (lgHt != null && lgAvg > 0) sh2.push([lgHt / lgAvg, Math.min(10, lg.n)]);
  if (sh2.length) { var w = sh2.reduce(function (s, z) { return s + z[1]; }, 0); share = (sh2.reduce(function (s, z) { return s + z[0] * z[1]; }, 0) + 0.46 * 8) / (w + 8); }
  share = Math.max(0.36, Math.min(0.56, share));
  var mkt = tipCornerLineMean(x && x.corner && x.corner.pre), E, src;
  if (mkt != null && hist != null) { E = 0.6 * mkt + 0.4 * hist; src = 'quote+storico'; }
  else if (mkt != null) { E = 0.75 * mkt + 0.25 * lgAvg; src = 'quote'; }
  else if (hist != null) { E = hist; src = 'storico'; }
  else { E = lgAvg; src = lg ? 'campionato' : 'media'; }
  E = Math.max(5, Math.min(16, E));
  var htMkt = tipCornerLineMean(x && x.corner && x.corner.preHt);
  var Eht = htMkt != null ? 0.6 * htMkt + 0.4 * E * share : E * share;
  return { E: Math.round(E * 100) / 100, Eht: Math.round(Eht * 100) / 100, share: Math.round(share * 1000) / 1000, src: src, n: n, mkt: mkt, hist: hist == null ? null : Math.round(hist * 100) / 100 };
}
/* Quote angoli live: riga [minuto, linea, Over, Under] del book. Linea x.5 con quote: lambda implicita dei prossimi angoli. */
function tipCornerMarket(o, cor, min) {
  if (!o || !U.finite(o.line) || o.line <= cor) return null;
  if (U.finite(o.min) && Math.abs(o.min - min) > 4) return null; /* quote vecchie */
  var fr = o.line - Math.floor(o.line), odds = U.finite(o.over) && U.finite(o.under) && o.over > 1.01 && o.under > 1.01;
  if (Math.abs(fr - 0.5) > 0.01) return null;
  var need = Math.floor(o.line - cor) + 1, pOver = odds ? (1 / o.over) / (1 / o.over + 1 / o.under) : 0.5, lo = 0.01, hi = 12;
  for (var i = 0; i < 40; i++) { var md = (lo + hi) / 2; if (tipPoisAtLeast(need, md) < pOver) lo = md; else hi = md; }
  return { lam: (lo + hi) / 2, need: need, pOver: pOver, odds: odds, line: o.line, over: odds ? o.over : null };
}
var TIP_CORNER_HT_SHRINK = 0.7;
function tipCornerEstimate(min, goals, stats, prev, addedTime, half, x) {
  if (half == null) half = min > 45 ? 2 : 1;
  var W = TIP_CORNER_WIN[half];
  if (!W || !stats || !Array.isArray(goals) || goals.length !== 2 || !goals.every(function (v) { return Number.isInteger(v) && v >= 0; }) || !U.finite(min) || min < W.from || min > W.to) return null;
  var side = stats.side || [{}, {}], valid = function (v) { return Number.isInteger(v) && v >= 0; };
  var cor = valid(stats.c) ? stats.c : valid(side[0].c) && valid(side[1].c) ? side[0].c + side[1].c : null;
  if (cor == null) return null;
  var pr = x ? tipCornerPrior(x) : null;
  var priorRate = pr ? (half === 1 ? pr.Eht / 45 : pr.E / 90) : W.base / 90;
  var baseRate = (cor + priorRate * W.K) / (min + W.K), rate = baseRate, recent = null;
  if (prev && prev.half === half && prev.side && min - prev.min >= 5 && min - prev.min <= 20 &&
      (!prev.at || Date.now() - prev.at <= 25 * 60e3) && valid(prev.side[0].c) && valid(prev.side[1].c)) {
    var before = prev.side[0].c + prev.side[1].c, elapsed = min - prev.min;
    if (cor >= before) {
      recent = { minutes: elapsed, corners: cor - before };
      var recentRate = (cor - before + baseRate * 10) / (elapsed + 10);
      rate *= Math.max(0.85, Math.min(1.15, 0.75 + 0.25 * recentRate / baseRate));
    }
  }
  var extra = U.finite(addedTime) && addedTime >= 0 && addedTime <= 20 ? addedTime : W.stop;
  var rem = W.end - min + extra, diff = Math.abs(goals[0] - goals[1]);
  var boost = half === 2 ? (diff === 1 ? 1.25 : diff === 0 ? 1.1 : 0.85) : (diff === 1 ? 1.1 : diff === 0 ? 1 : 0.9);
  if ((side[0].red || 0) + (side[1].red || 0) > 0) boost *= 0.95;
  var lamModel = rate * rem * boost, lambda = lamModel, mk = null, wMkt = 0;
  var odds = x && x.cornerOdds ? x.cornerOdds[half === 1 ? 'ht' : 'ft'] : null;
  mk = tipCornerMarket(odds, cor, min);
  if (!mk && x && x.corner) mk = tipCornerMarket({ line: half === 1 ? x.corner.liveHt : x.corner.live }, cor, min);
  /* 3.90.0 — la sola linea senza quote non dice da che parte pende il book (si assumeva 50%): sui dati
     12 segnali così ne hanno vinti 2. Ora conta solo con le quote vere. */
  if (mk && mk.odds) { wMkt = 0.6; lambda = Math.exp(wMkt * Math.log(mk.lam) + (1 - wMkt) * Math.log(lamModel)); }
  /* 3.90.0 — angoli 1° tempo senza quote angoli prepartita né live: sui dati 54% vinte contro 77% stimato
     (con le quote prepartita 81%). Stima ridotta finché non ci sono più dati. */
  var shrink = 1;
  if (half === 1 && !(mk && mk.odds) && !(pr && /quote/.test(pr.src || ''))) { shrink = TIP_CORNER_HT_SHRINK; lambda *= shrink; }
  var book = {};
  if (mk && mk.odds && mk.need === 1) book[1] = mk.over;
  if (mk && mk.odds && mk.need === 2) book[2] = mk.over;
  return { model: 'corners-3.90.0', half: half, cn: cor, lamC: lambda, lamModel: lamModel, lamMkt: mk ? mk.lam : null, wMkt: wMkt, shrink: shrink,
    prior: pr, baseRate: baseRate, rate: rate, recent: recent,
    stoppage: extra, stoppageKnown: U.finite(addedTime), remaining: rem, boost: boost, book: book, line: mk ? mk.line : null,
    p1: 1 - Math.exp(-lambda), p2: 1 - Math.exp(-lambda) * (1 + lambda) };
}
/* Pressione recente: differenza con la scansione di 6-15 minuti fa. Medie di riferimento per minuto (due squadre):
   tiri in porta 0,09 · attacchi pericolosi 1,0 · angoli 0,11. R = 1 vuol dire ritmo normale. */
function tipRecentPressure(sd, prev, min, half) {
  if (!prev || prev.half !== half || !prev.side || !sd) return null;
  var w = min - prev.min;
  if (w < 6 || w > 18) return null;
  var ok = function (v) { return Number.isInteger(v) && v >= 0; }, d = [0, 1].map(function (i) {
    var a = sd[i] || {}, b = prev.side[i] || {};
    var dl = function (k) { return ok(a[k]) && ok(b[k]) && a[k] >= b[k] ? a[k] - b[k] : null; };
    return { t: dl('t'), da: dl('da'), c: dl('c') };
  });
  if (d.some(function (z) { return z.t == null || z.da == null; })) return null;
  var T = d[0].t + d[1].t, DA = d[0].da + d[1].da, C = d[0].c != null && d[1].c != null ? d[0].c + d[1].c : null;
  var R = C == null ? 0.55 * (T / w) / 0.09 + 0.45 * (DA / w) / 1.0 : 0.45 * (T / w) / 0.09 + 0.35 * (DA / w) / 1.0 + 0.2 * (C / w) / 0.11;
  var wt = d.map(function (z) { return z.da + 3 * z.t; }), all = wt[0] + wt[1];
  return { w: w, R: Math.round(R * 100) / 100, t: T, da: DA, c: C, share: all ? [wt[0] / all, wt[1] / all] : [0.5, 0.5],
    side: d.map(function (z) { return { t: z.t / w, da: z.da / w }; }) };
}
/* 3.82.0 — fattori comuni dei nuovi segnali: forza delle squadre (favorita dalle quote 1X2 pre-partita),
   campionato (livello e media gol verificata), pressione recente rispetto al ritmo già nel modello.
   Ogni fattore è limitato: corregge la probabilità del modello, non la sostituisce. */
var TIP_NEW_LG = { major: 1, 'minor+': 1, 'youth+': 1 };
function tipLiveFactors(r, x, pr, g) {
  var x12 = x && x.odds && x.odds.pre && x.odds.pre.x12, fp = null, fav = null;
  if (Array.isArray(x12) && x12[0] > 1 && x12[2] > 1) {
    var i1 = 1 / x12[0], i2 = 1 / x12[2], iX = x12[1] > 1 ? 1 / x12[1] : 0, tot = i1 + i2 + iX;
    fav = i1 >= i2 ? 0 : 1; fp = (fav ? i2 : i1) / tot;
  }
  var A = x && tipUI.lgAvg && tipUI.lgAvg[x.league], lgAvg = A && A.n >= 8 ? A.g / A.n : null;
  var mStr = fp == null ? 1 : fp >= 0.65 ? 1.06 : fp < 0.42 ? 0.95 : 1;
  var mLg = lgAvg == null ? 1 : lgAvg >= 3 ? 1.05 : lgAvg < 2.3 ? 0.93 : 1;
  var mPr = pr ? Math.max(0.9, Math.min(1.25, Math.sqrt(pr.R / Math.max(0.8, (r && r.F) || 1)))) : 1;
  var diffFav = fav == null || !g ? null : (g[fav] || 0) - (g[1 - fav] || 0);
  return { fp: fp == null ? null : Math.round(fp * 100) / 100, fav: fav, lgAvg: lgAvg == null ? null : Math.round(lgAvg * 100) / 100, lg: (r && r.lgTier) || 'major',
    mStr: mStr, mLg: mLg, mPr: Math.round(mPr * 100) / 100, R: pr ? pr.R : null, diffFav: diffFav };
}
function tipTrialPlays(r, min, half, x, prev) {
  var out = [], st = x && x.stats, g = (x && x.goals) || [0, 0], G = (g[0] || 0) + (g[1] || 0);
  if (!r || !st || min == null) return out;
  var sd = st.side || [{}, {}], sum = function (k) { return (sd[0][k] || 0) + (sd[1][k] || 0); };
  var on = U.finite(st.t) ? st.t : sum('t'), cor = U.finite(st.c) ? st.c : sum('c'), da = sum('da');
  var line = function (k) { var l = (r.lines || []).find(function (z) { return z.k === k; }); return l ? l.p : null; };
  var mk = function (k, p, green, warm, extra) {
    var fair = Math.max(1.05, 1 / Math.max(0.02, p)), book = extra && U.finite(extra.book) && extra.book > 1 ? extra.book : null, q = book || fair;
    var tier = p >= green ? 'excellent' : p >= warm ? 'try' : 'none';
    /* quota vera sotto la quota giusta: niente OTTIMA */
    if (book && book < fair && tier === 'excellent') tier = 'try';
    return Object.assign({ k: k, name: TIP_PLAY_NAME[k], short: TIP_PLAY_SHORT[k], p: p, evalP: p, legs: [{ l: TIP_PLAY_SHORT[k], p: p }], thr: warm, trial: true,
      cost: { stakes: [10], risk: 10, win: 10 * (q - 1), ratio: 1 / (q - 1) }, minQ: Math.round(fair * 100) / 100, green: tier === 'excellent', warm: tier === 'try',
      tier: tier, lg: r.lgTier || 'major', goals: G, book: book || undefined, lowBook: book ? book < fair : undefined }, tipLabels(r), extra || {});
  };
  /* 3.74.0 — i vecchi "1T a pressione" e "2T a pari" usavano la stessa probabilità delle giocate stabili con soglie più basse:
     doppioni meno severi. I nuovi segnali guardano cosa succede ORA (ultimi 6-18 minuti, dalla scansione precedente)
     e partono solo quando le giocate stabili tacciono: servono a scoprire partite che il modello non vede. */
  var pr = tipRecentPressure(sd, prev, min, half);
  var stable = pr ? tipPlays(r, min, half).filter(function (z) { return (z.green || z.warm) && !z.at && z.k.indexOf('t' + half) === 0; }) : [];
  /* 1T sotto pressione: 20'-38', ritmo recente (tiri in porta, attacchi pericolosi, angoli) almeno +40% sulla media */
  if (pr && half === 1 && min >= 20 && min <= 38 && !stable.length) {
    var h1 = line('h1');
    if (h1 != null && pr.R >= 1.4) {
      var m1 = Math.max(1, Math.min(1.5, Math.sqrt(pr.R / Math.max(0.8, r.F || 1))));
      out.push(mk('tq1', 1 - Math.pow(1 - h1, m1), 0.62, 0.52, { pressure: Object.assign({ mult: Math.round(m1 * 100) / 100 }, pr) }));
    }
  }
  /* 2T favorita che non vince: 55'-78', favorita da quote (≥55%) pari o sotto di un gol, che negli ultimi minuti fa almeno il 60% del gioco offensivo */
  var x12 = x && x.odds && x.odds.pre && x.odds.pre.x12;
  if (pr && half === 2 && min >= 55 && min <= 78 && !stable.length && Array.isArray(x12) && x12[0] > 1 && x12[2] > 1) {
    var i1 = 1 / x12[0], i2 = 1 / x12[2], iX = x12[1] > 1 ? 1 / x12[1] : 0, tot = i1 + i2 + iX, fav = i1 >= i2 ? 0 : 1, fp = (fav ? i2 : i1) / tot;
    var diff = (g[fav] || 0) - (g[1 - fav] || 0), n1 = line('n1');
    if (fp >= 0.55 && diff <= 0 && diff >= -1 && n1 != null && pr.share[fav] >= 0.6 && (pr.side[fav].da >= 0.6 || pr.side[fav].t * pr.w >= 2)) {
      var m2 = Math.max(1, Math.min(1.4, Math.sqrt(pr.share[fav] / 0.5) * Math.sqrt(Math.max(1, pr.R))));
      out.push(mk('tq2', 1 - Math.pow(1 - n1, m2), 0.70, 0.60, { pressure: Object.assign({ mult: Math.round(m2 * 100) / 100, fav: fav, favP: Math.round(fp * 100) / 100 }, pr) }));
    }
  }
  /* 3.82.0 — GOL 1T PRESTO (8'-20', 0-0): gol entro l'intervallo. Modello + forza squadre + campionato + pressione.
     Solo campionati forti; soglie alte: deve chiamare poco. */
  if (half === 1 && min >= 8 && min <= 20 && G === 0) {
    var hE = line('h1'), fE = tipLiveFactors(r, x, pr, g);
    if (hE != null && TIP_NEW_LG[fE.lg]) {
      var mE = fE.mStr * fE.mLg * fE.mPr;
      out.push(mk('tg1', 1 - Math.pow(1 - hE, mE), 0.74, 0.66, { factors: Object.assign({ base: Math.round(hE * 1000) / 1000, mult: Math.round(mE * 100) / 100 }, fE) }));
    }
  }
  /* 3.82.0 — PROSSIMO GOL 70'-80' (scarto al massimo di un gol): altro gol entro la fine. Come sopra, più lo stato della
     favorita: se non vince spinge (+12%), se vince di un gol tende a chiudersi (−8%). */
  if (half === 2 && min >= 70 && min <= 80 && Math.abs((g[0] || 0) - (g[1] || 0)) <= 1) {
    var nL = line('n1'), fL = tipLiveFactors(r, x, pr, g);
    if (nL != null && TIP_NEW_LG[fL.lg]) {
      var mS = fL.fp != null && fL.fp >= 0.55 ? (fL.diffFav <= 0 ? 1.12 : 0.92) : 1, mL = fL.mStr * fL.mLg * fL.mPr * mS;
      out.push(mk('tn2', 1 - Math.pow(1 - nL, mL), 0.62, 0.55, { factors: Object.assign({ base: Math.round(nL * 1000) / 1000, mult: Math.round(mL * 100) / 100, mState: mS }, fL) }));
    }
  }
  /* angoli: 1T 36'-42' (entro l'intervallo), 2T 82'-87' (entro la fine) */
  var corner = tipCornerEstimate(min, x.goals, st, prev, x.addedTime, half, x);
  if (corner) {
    var extra = function (need) { return { cn: corner.cn, need: need, lamC: corner.lamC, snap: corner, book: corner.book[need] }; };
    if (half === 2) { out.push(mk('tc1', corner.p1, 0.80, 0.72, extra(1))); out.push(mk('tc2', corner.p2, 0.50, 0.42, extra(2))); }
    else { out.push(mk('th1', corner.p1, 0.78, 0.68, extra(1))); out.push(mk('th2', corner.p2, 0.50, 0.40, extra(2))); }
  }
  return out.filter(function (z) { return z.tier !== 'none' && !TIP_K_OFF[z.k]; });
}
function tipTrialLogAdd(m, ctx, trials, lid) {
  (trials || []).forEach(function (x) {
    var key = tipPlayKey(m.id, ctx) + '|' + x.k;
    tipUI._pl = tipUI._pl || {};
    if (tipUI._pl[key] === 'excellent' || tipUI._pl[key] === x.tier) return;
    var old = (((db.predModel || {}).playLog) || []).find(function (e) { return e.key === key; });
    if (old && (old.tier === 'excellent' || x.tier === 'try')) { tipUI._pl[key] = old.tier; return; }
    tipUI._pl[key] = x.tier;
    var e = tipPlayEntry(m, ctx, x, lid || (tipUI.scanLink || {})[m.id] || m.afId || null);
    e.key = key; e.trial = true; if (x.cn != null) { e.cn = x.cn; e.need = x.need; e.lamC = x.lamC; }
    tipPlayQueue({ e: e });
  });
}
/* ---------- 3.35.0 — Traccia delle giocate consigliate (ottime) e resoconto giornaliero ----------
   3.48.0 — UNA giocata per partita e per punteggio: la migliore del momento. Se la stessa partita
   poi propone un altro tipo (step 60-80-fine → step 80-fine → unico) con lo stesso punteggio, è la
   stessa scommessa: resta quella già segnalata. Una DA VALUTARE che diventa OTTIMA viene aggiornata.
   Dopo un gol (punteggio diverso) è una giocata nuova. */
function tipPlayBest(plays) { return (plays || []).filter(function (x) { return x.green || x.warm; })[0] || null; }
function tipPlayKey(id, ctx) { return id + '|' + (ctx.half || 1) + '|' + (ctx.gh || 0) + '-' + (ctx.ga || 0); }
function tipPlayGroup(e) { return e.id + '|' + (e.half || 1) + '|' + (e.gh || 0) + '-' + (e.ga || 0) + (e.trial ? '|' + e.k : ''); }
function tipPlayFind(id, ctx) {
  var g = tipPlayKey(id, ctx);
  return (((db.predModel || {}).playLog) || []).filter(function (e) { return !e.trial && tipPlayGroup(e) === g; })
    .sort(function (a, b) { return (a.tier === 'try' ? 1 : 0) - (b.tier === 'try' ? 1 : 0) || (a.t || 0) - (b.t || 0); })[0] || null;
}
function tipPlayEntry(m, ctx, x, lid) {
  var data = (tipUI.liveData || {})[m.id] || {};
  return JSON.parse(JSON.stringify({ schemaVersion: 2, engineVersion: '3.90.0',
    input: { lh: m.lh, la: m.la, odds: m.odds || null, preIssueId: m.preIssue ? m.preIssue.id : null,
      parameters: tipParams(), observedAt: data.at || null, status: data.status || null, prev: tipLivePrev(m.id, ctx.min, ctx.half) },
    key: tipPlayKey(m.id, ctx), id: m.id, afId: lid, home: m.home, away: m.away, league: m.league, date: m.date, time: m.time,
    k: x.k, tier: x.green ? 'excellent' : 'try', conditional: !!x.at, costly: !!x.costly, res: (x.at || x.costly || x.lowBook) ? 'skip' : null, min: ctx.min, half: ctx.half, gh: ctx.gh || 0, ga: ctx.ga || 0, p: Math.round((x.evalP == null ? x.p : x.evalP) * 1000) / 1000, rawP: Math.round(x.p * 1000) / 1000,
    legs: x.legs.map(function (l) { return Math.round(l.p * 1000) / 1000; }), prof: x.prof, rit: x.rit, lg: x.lg, snap: x.snap, pressure: x.pressure, factors: x.factors, stats: (function () { var d = (tipUI.liveData || {})[m.id]; return d && d.stats ? d.stats : undefined; })(), at: x.at, ts: x.ts, minQ: x.minQ ? Math.round(x.minQ * 100) / 100 : undefined, book: x.book || undefined,
    risk: Math.round(x.cost.risk * 100) / 100, win: Math.round(x.cost.win * 100) / 100, t: Date.now() }));
}
function tipSignalRevision(previous, next) {
  var original = Object.assign({}, previous.initial || previous);
  delete original.revisions;
  var history = (previous.revisions || []).slice(), revision = Object.assign({}, next);
  delete revision.initial; delete revision.revisions;
  if (!history.some(function (e) { return e.t === revision.t && e.tier === revision.tier; })) history.push(revision);
  return Object.assign({}, next, { initial: original, revisions: history, first: previous.first || { k: previous.k, min: previous.min, tier: previous.tier } });
}
/* applica in coda (dopo il disegno della pagina: salvare ridisegna) */
function tipPlayQueue(op) {
  tipUI._plQ = tipUI._plQ || [];
  tipUI._plQ.push(op);
  if (!tipUI._plT) tipUI._plT = setTimeout(function () {
    tipUI._plT = null;
    var Q = tipUI._plQ || [];
    tipUI._plQ = [];
    if (!Q.length) return;
    mutate(function (d) {
      d.predModel = d.predModel || {};
      var L = d.predModel.playLog = d.predModel.playLog || [];
      Q.forEach(function (o) { tipPlayApply(L, o); });
      if (L.length > 3000) L.splice(0, L.length - 3000);
    });
  }, 0);
}
/* o: { e: voce } (nuova o aggiornamento da DA VALUTARE a OTTIMA) oppure { played: {...}, e: voce se manca } */
function tipPlayApply(L, o) {
  var g = tipPlayGroup(o.e), cur = L.filter(function (z) { return tipPlayGroup(z) === g; })
    .sort(function (a, b) { return (a.tier === 'try' ? 1 : 0) - (b.tier === 'try' ? 1 : 0) || (a.t || 0) - (b.t || 0); })[0];
  if (o.played) {
    if (!cur) { cur = o.e; L.push(cur); }
    cur.played = o.played;
    return;
  }
  if (!cur) { L.push(o.e); return; }
  if (o.e.push) cur.push = o.e.push; /* 3.82.0 — esito della notifica dal server */
  /* 3.87.0 — esito chiuso dal server (registro dei finali): si copia se qui è ancora in attesa */
  if (cur.res == null && o.e.res != null && o.e.settledBy) ['res', 'ft', 'ht', 'cornersFinal', 'cornersHt', 'resultConfirmed', 'resultSource', 'confirmedAt', 'goalsAt', 'settledBy'].forEach(function (k) { if (o.e[k] !== undefined) cur[k] = o.e[k]; });
  if (cur.tier === 'try' && o.e.tier === 'excellent') {
    o.e = tipSignalRevision(cur, o.e);
    var keep = { key: cur.key, played: cur.played, first: cur.first || { k: cur.k, min: cur.min, tier: 'try' } };
    Object.keys(o.e).forEach(function (k) { cur[k] = o.e[k]; });
    cur.key = keep.key; cur.first = keep.first; if (keep.played) cur.played = keep.played;
  }
}
function tipPlayLogAdd(m, ctx, plays) {
  var x = tipPlayBest(plays);
  if (!x || !m || !m.id) return;
  var key = tipPlayKey(m.id, ctx), tier = x.green ? 'excellent' : 'try';
  tipUI._pl = tipUI._pl || {};
  if (tipUI._pl[key] === 'excellent' || tipUI._pl[key] === tier) return;
  var old = tipPlayFind(m.id, ctx);
  if (old && (old.tier !== 'try' || tier === 'try')) { tipUI._pl[key] = old.tier === 'try' ? 'try' : 'excellent'; return; }
  tipUI._pl[key] = tier;
  var lid = (tipUI.scanLink || {})[m.id] || m.afId || null;
  tipPlayQueue({ e: tipPlayEntry(m, ctx, x, lid) });
}
/* 3.48.0 — "L'ho giocata": quota e puntata vere (per gli step: quota e puntata del primo step) */
function tipPlayMark(m, ctx, x, q, st) {
  var lid = (tipUI.scanLink || {})[m.id] || m.afId || null, e = tipPlayEntry(m, ctx, x, lid), base = (tipUI.step && tipUI.step.s1) || 10;
  tipPlayQueue({ e: e, played: { k: x.k, q: q, s: st, min: ctx.min, legs: e.legs, at: x.at, risk: Math.round(x.cost.risk * st / base * 100) / 100, n: x.legs.length, t: Date.now() } });
}
/* una sola voce per partita e punteggio anche nello storico già salvato (prima della 3.48 si salvava ogni tipo) */
function tipPlayDedup(L) {
  var by = {};
  (L || []).forEach(function (e) {
    var g = tipPlayGroup(e), b = by[g], rk = function (z) { return z.tier === 'try' ? 1 : 0; };
    if (!b || rk(e) < rk(b) || (rk(e) === rk(b) && (e.t || 0) < (b.t || 0))) by[g] = e;
  });
  return Object.keys(by).map(function (k) { return by[k]; });
}
/* esito della giocata segnata da te (può essere di un tipo diverso da quella consigliata) */
function tipPlayedOutcome(e, x) {
  var p = e.played;
  if (!p) return null;
  return tipPlayOutcome(Object.assign({}, e, { k: p.k, min: p.min, at: p.at }), x);
}
function tipPlayedPL(e) {
  var p = e.played;
  if (!p || (p.res !== 0 && p.res !== 1)) return 0;
  return p.res ? p.s * (p.q - 1) : -(p.n > 1 ? p.risk : p.s);
}
/* esito di una giocata: 1 vinta, 0 persa, 'skip' non giocata (attesa con gol prima), null se non si sa ancora */
function tipPlayOutcome(e, x) {
  if (!Array.isArray(x.ft)) return null;
  if (x.ft[0] < e.gh || x.ft[1] < e.ga || (e.half === 1 && Array.isArray(x.ht) && (x.ht[0] < e.gh || x.ht[1] < e.ga))) return null;
  var G = e.gh + e.ga, FT = x.ft[0] + x.ft[1], HT = Array.isArray(x.ht) ? x.ht[0] + x.ht[1] : null,
    mins = Array.isArray(x.goals) && x.goals.length === FT ? x.goals.map(function (g) { return g.min; }) : null; /* 3.90.0 — solo elenco completo */
  if (e.k === 'tc1' || e.k === 'tc2') {
    if (!Array.isArray(x.corners) || x.corners[0] == null || x.corners[1] == null || e.cn == null) return null;
    if (!x.corners.every(function (n) { return Number.isInteger(n) && n >= 0; }) || x.corners[0] + x.corners[1] < e.cn) return null;
    return x.corners[0] + x.corners[1] - e.cn >= (e.need || (e.k === 'tc2' ? 2 : 1)) ? 1 : 0;
  }
  if (e.k === 'th1' || e.k === 'th2') {
    var hc = x.htCorners;
    if (!Array.isArray(hc) || hc.length !== 2 || !hc.every(function (n) { return Number.isInteger(n) && n >= 0; }) || e.cn == null || hc[0] + hc[1] < e.cn) return null;
    return hc[0] + hc[1] - e.cn >= (e.need || (e.k === 'th2' ? 2 : 1)) ? 1 : 0;
  }
  if (e.k === 'tp1' || e.k === 'tq1' || e.k === 'tg1') return HT == null ? null : HT > G ? 1 : 0;
  if (e.k === 'tq2' || e.k === 'tn2') return FT > G ? 1 : 0;
  if (e.k === 'tp2') return FT > G ? 1 : 0;
  if (e.k === 't2w' || e.k === 't1w') {
    var tot = e.k === 't1w' ? HT : FT;
    if (tot == null) return null;
    if (tot === G) return 0;
    if (!mins) return null;
    if (mins.some(function (mm) { return mm > e.min && mm <= e.at; })) return 'skip';
    return mins.some(function (mm) { return mm > e.at && mm <= (e.k === 't1w' ? 45 : 200); }) ? 1 : 0;
  }
  if (e.k.indexOf('t1') === 0) return HT == null ? null : HT > G ? 1 : 0;
  return FT > G ? 1 : 0;
}
function tipReportFor(date) {
  var day = (((db.predModel || {}).playLog) || []).filter(function (e) { return e.date === date && tipStatsOk(e); });
  var by = {}, tot = { n: 0, w: 0, p: 0, pl: 0, risk: 0 }, trial = { n: 0, w: 0, p: 0, pl: 0, risk: 0 }, mine = { n: 0, w: 0, pl: 0, st: 0 };
  [false, true].forEach(function (isT) {
    var L = tipPlayDedup(day.filter(function (e) { return !!e.trial === isT; })).filter(function (e) { return e.res != null && (!e.tier || e.tier === 'excellent'); });
    L.forEach(function (e) {
      if (e.res === 'skip') return;
      var b = by[e.k] = by[e.k] || { n: 0, w: 0, p: 0, pl: 0 }, T = isT ? trial : tot;
      var pl = e.res ? e.win : -e.risk;
      b.n++; b.w += e.res ? 1 : 0; b.p += e.p; b.pl += pl;
      T.n++; T.w += e.res ? 1 : 0; T.p += e.p; T.pl += pl; T.risk += e.risk;
    });
  });
  /* 3.48.0 — le giocate che hai segnato davvero, con quota e puntata vere */
  day.forEach(function (e) {
    if (!e.played || (e.played.res !== 0 && e.played.res !== 1)) return;
    mine.n++; mine.w += e.played.res; mine.pl += tipPlayedPL(e); mine.st += e.played.n > 1 ? e.played.risk : e.played.s;
  });
  return { date: date, by: by, tot: tot, trial: trial, mine: mine };
}
/* a fine giornata: quando tutte le giocate del giorno hanno l'esito (o dopo 2 giorni) il resoconto si salva da solo */
function tipDailyReports() {
  var M = db.predModel || {}, L = M.playLog || [], today = U.local().slice(0, 10), done = M.reports || {}, fresh = [];
  /* 3.48.0 — i resoconti salvati prima contavano più tipi della stessa partita: si ricalcolano una volta */
  if (M.reportsV !== 5) done = {};
  var fromDay = M.statsFrom ? new Date(M.statsFrom).toLocaleDateString('sv-SE') : '0000-00-00';
  var days = [];
  L.forEach(function (e) { if (e.date < today && e.date >= fromDay && days.indexOf(e.date) < 0) days.push(e.date); });
  days.forEach(function (d) {
    if (done[d]) return;
    var pend = L.filter(function (e) { return e.date === d && e.res == null && (e.miss || 0) < 3; }).length;
    var old = (Date.parse(today) - Date.parse(d)) / 86400e3 >= 2;
    if (pend && !old) return;
    fresh.push(tipReportFor(d));
  });
  if (!fresh.length) return;
  mutate(function (n) {
    n.predModel = n.predModel || {};
    n.predModel.reports = n.predModel.reports || {};
    fresh.forEach(function (r) { n.predModel.reports[r.date] = { tot: r.tot, trial: r.trial, by: r.by, mine: r.mine, at: Date.now() }; });
    n.predModel.reportsV = 5;
  });
  var last = fresh[fresh.length - 1];
  if (last.tot.n) U.toast('Resoconto ' + tipDayLabel(last.date) + ': ' + last.tot.w + '/' + last.tot.n + ' giocate ottime vinte · ' + (last.tot.pl >= 0 ? '+' : '') + last.tot.pl.toFixed(2) + '€ (a quota minima)' + (last.mine && last.mine.n ? ' · tue ' + last.mine.w + '/' + last.mine.n + ' ' + (last.mine.pl >= 0 ? '+' : '') + last.mine.pl.toFixed(2) + '€' : ''));
}
function tipReportPanel() {
  var R = (db.predModel || {}).reports || {}, fromD = tipStatsFromDay(), keys = Object.keys(R).filter(function (k) { return k >= fromD; }).sort().reverse().slice(0, 10);
  var today = U.local().slice(0, 10), live = tipReportFor(today);
  if (!keys.length && !live.tot.n && !(live.trial && live.trial.n) && !(((db.predModel || {}).playLog) || []).length) return '';
  var rowT = function (label, t) {
    return '<tr><th>' + label + '</th><td>' + t.n + '</td><td>' + (t.n ? Math.round(t.p / t.n * 100) + '%' : '—') + '</td><td class="' + (t.n && t.w / t.n >= t.p / t.n - 0.03 ? 'positive' : 'negative') + '">' + (t.n ? Math.round(t.w / t.n * 100) + '%' : '—') + '</td><td class="' + (t.pl >= 0 ? 'positive' : 'negative') + '">' + (t.pl >= 0 ? '+' : '') + t.pl.toFixed(1) + '€</td></tr>';
  };
  var mineTxt = function (mn) {
    if (!mn || !mn.n) return '';
    return '<p class="tip-mine">Giocate da te: <b>' + mn.w + '/' + mn.n + '</b> vinte · puntati ' + Math.round(mn.st) + '€ · <b class="' + (mn.pl >= 0 ? 'positive' : 'negative') + '">' + (mn.pl >= 0 ? '+' : '') + mn.pl.toFixed(2) + '€ veri</b></p>';
  };
  var dayBlock = function (d, rep, partial) {
    var types = Object.keys(rep.by);
    return '<details class="tip-repday"><summary><b>' + U.esc(tipCap(tipDayLabel(d))) + (partial ? ' (in corso)' : '') + '</b> · ' + rep.tot.w + '/' + rep.tot.n + ' vinte · <span class="' + (rep.tot.pl >= 0 ? 'positive' : 'negative') + '">' + (rep.tot.pl >= 0 ? '+' : '') + rep.tot.pl.toFixed(2) + '€</span>' + (rep.trial && rep.trial.n ? ' · 🧪 ' + rep.trial.w + '/' + rep.trial.n : '') + (rep.mine && rep.mine.n ? ' · tue <span class="' + (rep.mine.pl >= 0 ? 'positive' : 'negative') + '">' + (rep.mine.pl >= 0 ? '+' : '') + rep.mine.pl.toFixed(2) + '€</span>' : '') + '</summary>' +
      '<table class="tip-caltab"><tr><th></th><th>n</th><th>Previsto</th><th>Vinte</th><th>€</th></tr>' + types.map(function (k) { return rowT(U.esc(tipKindLabel(k)), rep.by[k]); }).join('') + rowT('◆ Totale stabili', rep.tot) + (rep.trial && rep.trial.n ? rowT('🧪 Totale in prova', rep.trial) : '') + '</table>' + mineTxt(rep.mine) + '</details>';
  };
  /* totale per tipo su tutti i giorni chiusi */
  var all = {}, allT = { n: 0, w: 0, p: 0, pl: 0 }, allX = { n: 0, w: 0, p: 0, pl: 0 }, allM = { n: 0, w: 0, pl: 0, st: 0 };
  keys.forEach(function (d) { var r = R[d]; Object.keys(r.by).forEach(function (k) { var a = all[k] = all[k] || { n: 0, w: 0, p: 0, pl: 0 }, b = r.by[k]; a.n += b.n; a.w += b.w; a.p += b.p; a.pl += b.pl; }); allT.n += r.tot.n; allT.w += r.tot.w; allT.p += r.tot.p; allT.pl += r.tot.pl; if (r.trial) { allX.n += r.trial.n; allX.w += r.trial.w; allX.p += r.trial.p; allX.pl += r.trial.pl; } if (r.mine) { allM.n += r.mine.n; allM.w += r.mine.w; allM.pl += r.mine.pl; allM.st += r.mine.st; } });
  return '<section class="card diary-card tip-markets"><h2>Resoconto giocate ottime</h2><p class="muted">Una giocata verde per partita, chiusa con il risultato; ◆ stabili e 🧪 in prova con totali separati. € a quota minima con puntata base ' + ((tipUI.step && tipUI.step.s1) || 10) + '€; “tue” = quelle che hai segnato con “L’ho giocata”, a quota vera.</p>' +
    (live.tot.n ? dayBlock(today, live, true) : '') + keys.map(function (d) { return dayBlock(d, R[d], false); }).join('') +
    (keys.length ? '<details class="tip-repday" open><summary><b>Ultimi ' + keys.length + ' giorni per tipo</b></summary><table class="tip-caltab"><tr><th></th><th>n</th><th>Previsto</th><th>Vinte</th><th>€</th></tr>' + Object.keys(all).map(function (k) { return rowT(U.esc(tipKindLabel(k)), all[k]); }).join('') + rowT('◆ Totale stabili', allT) + (allX.n ? rowT('🧪 Totale in prova', allX) : '') + '</table>' + mineTxt(allM) + '</details>' : '') +
    '<div class="actions"><button type="button" data-live-export>Esporta traccia per il retraining</button></div></section>';
}
function tipPlayThr(k, min) { var t = TIP_PLAY_THR[k]; return t ? tipLmInterp(t, min) / 100 : 1; }
/* 3.46.0 — Distinzione tra probabilita del mercato e ranking relativo.
   Una quota teorica e ricavata come 1/p: con una quota minima 1.50,
   p non puo superare ~66,7%; per 1.80 non supera ~55,6%.
   La precedente soglia verde al 78% rendeva quindi impossibile
   classificare come OTTIMA quasi tutte le giocate singole.
   Le fasce seguenti sono euristiche di ranking, NON probabilita validate
   e NON dimostrano che la quota reale sia conveniente. */
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
/* 3.47.0 — niente riduzioni a mano: sul 18/10 (191 giocate chiuse) il motore live era già prudente
   (previsto 61%, reale 69%); togliere 2-4 punti spegneva tutte le OTTIME. */
function tipPlayEstimate(r, min, half, x) {
  if (!x || !U.finite(x.p)) return null;
  return Math.max(0, Math.min(1, x.p));
}
/* Margine richiesto rispetto alla soglia relativa. Il 5% e un margine
   euristico di ranking: non costituisce prova di un vantaggio atteso. */
/* 3.47.0 — OTTIMA = sopra la soglia del minuto (70° percentile su 8.534 partite) e almeno 50%.
   Verifica sul 18/10: con questa regola 128 vinte su 170 (75%); sotto il 50% 1 vinta su 16. */
var TIP_GREEN_MINP = 0.50;
/* 3.48.0 — 1° tempo più severo: sul 18/10 "1T ≥1.50" 5 vinte su 11 e "step 1T" 5 su 8 */
var TIP_GREEN_MINP_1T = 0.55;
function tipMinP(x) { return x && x.k && x.k.indexOf('t1') === 0 ? TIP_GREEN_MINP_1T : TIP_GREEN_MINP; }
/* 3.55.0 — affidabilità del campionato. Nei campionati maggiori lo storico è solido; nei minori,
   giovanili e riserve le statistiche gonfiano (squadre che tirano tanto ma segnano poco) e mancano dati storici:
   lì OTTIMA solo con margine molto ampio. */
var TIP_LG_MAJOR = /la ?liga|laliga|segunda divisi|serie a|serie b|bundesliga|3\. liga|ligue 1|ligue 2|eredivisie|eerste divisie|keuken|primeira liga|liga portugal|super lig|eliteserien|allsvenskan|superettan|veikkausliiga|ekstraklasa|scottish premiership|\bmls\b|major league soccer|usl championship|brasileir|liga mx|j1 league|j2 league|k league 1|a-league|saudi pro|uae pro|champions league|europa league|conference league|copa libertadores|copa sudamericana|nations league|world cup|besta deild|urvalsdeild|úrvalsdeild|challenge league|chinese super league|2\. liga/i;
/* nomi generici (Premier League, Super League, Primera División...): maggiori solo nei paesi con campionati robusti */
var TIP_LG_GENERIC = /premier league|championship|league one|league two|super ?league|superliga|pro league|first league|primera divisi|liga profesional|1\. liga|first division|division 1/i;
var TIP_LG_COUNTRY = /england|scotland|spain|italy|germany|france|netherlands|holland|portugal|belgium|turkey|denmark|norway|sweden|finland|poland|austria|switzerland|greece|czech|croatia|serbia|romania|hungary|iceland|usa|brazil|argentina|mexico|japan|korea|australia|china|saudi|qatar|ukraine|scottish|english|spanish|italian|german|french|dutch|swiss|danish|swedish|norwegian/i;
var TIP_LG_YOUTH = /\bu-?1[5-9]\b|\bu-?2[0-3]\b|under ?1[5-9]|under ?2[0-3]|youth|junior|primavera|reserve|reserves|\bii\b|\bb team\b|jong |academy|amateur|regional|women|femenin|feminin|frauen|w$|\(w\)/i;
/* 3.56.0 — paesi con calcio forte e dati buoni anche nelle giovanili e nelle serie minori (es. U21 inglese ≠ U19 kosovara) */
var TIP_LG_STRONG = /england|english|spain|spanish|italy|italian|germany|german|france|french|netherlands|dutch|holland|portugal|belgium|brazil|argentina|japan|scotland|denmark|sweden|norway|austria|switzerland|swiss|turkey|usa|mexico|croatia|serbia|czech|poland|korea|australia/i;
function tipLeagueStrong(m) { return TIP_LG_STRONG.test(String((m && m.league) || '')); }
function tipLeagueTier(m) {
  var t = String((m && m.league) || '') + ' ' + String((m && m.home) || '') + ' ' + String((m && m.away) || '');
  /* 3.65.0 — calcio femminile: tier a parte, affidabilità bassa anche nei Paesi forti */
  if (TIP_LG_WOMEN.test(t)) return 'women';
  if (TIP_LG_YOUTH.test(t)) return tipLeagueStrong(m) ? 'youth+' : 'youth';
  var lg = String((m && m.league) || '');
  if (TIP_LG_MAJOR.test(lg)) return 'major';
  if (TIP_LG_GENERIC.test(lg) && TIP_LG_COUNTRY.test(lg)) return 'major';
  return tipLeagueStrong(m) ? 'minor+' : 'minor';
}
var TIP_LG_WOMEN = /women|femenin|feminin|frauen|damallsvenskan|toppserien|\bwsl\b|liga f\b|\(w\)|\bw$/i;
var TIP_LG_EXTRA = { major: 0, 'minor+': 0.02, minor: 0.04, 'youth+': 0.03, youth: 0.06, women: 0.06 };
/* 3.65.0 — prepartita: punti in più richiesti per pronostici e Top fuori dai campionati maggiori */
/* 3.66.0 — Over 2.5: 54% vinte con 72% previsto (13 pronostici), serve più margine */
var TIP_PRE_MK_EXTRA = { o25: 8 }; /* 3.89.0 — Over 2.5 7/13 (54%) con 72% previsto */
var TIP_PRE_LG_EXTRA = { major: 0, 'minor+': 2, minor: 4, 'youth+': 4, youth: 6, women: 6 };
var TIP_STEP1T_ON = false;
/* 3.67.0 — tolte le giocate a 1.80: 42-43% vinte, lontane dall'obiettivo 80% */
var TIP_K_OFF = { t1s18: 1, t2u18: 1, tp1: 1, tp2: 1, tc2: 1, th2: 1, tq1: 1 }; /* 3.89.0 — tq1: 40/76 (53%) con 60% previsto, anche quando OTTIMA: spento */
 /* 3.74.0 — tp1/tp2 sostituiti da tq1/tq2; 3.78.0 — +2 angoli spenti (sbagliano) */
/* 3.71.0 — statistiche azzerate: contano solo i consigli dei tipi ATTIVI, dal momento dell'azzeramento.
   Tutto resta salvato (export, retraining, calibrazione) e si può rivedere con "Archivio". */
function tipKindActive(k) { return !TIP_K_OFF[k] && !(k === 't1st' && !TIP_STEP1T_ON); }
function tipStatsFrom() { return tipUI.stArchive ? 0 : (((db.predModel || {}).statsFrom) || 0); }
function tipStatsFromDay() { var f = tipStatsFrom(); return f ? new Date(f).toLocaleDateString('sv-SE') : '0000-00-00'; }
function tipStatsOk(e) { return !e.idBad && (!!tipUI.stArchive || ((e.t || 0) >= tipStatsFrom() && tipKindActive(e.k))); }
/* 3.90.0 — una volta: segnali agganciati alla partita sbagliata (nome simile, identificativo diverso da quello del
   pronostico). Escono da statistiche e storico: dati live di una partita, forza prepartita di un'altra. */
function tipIdCheckOnce() {
  if (((db.predModel || {}).idCheck390) || tipUI._idChk) return;
  tipUI._idChk = true;
  setTimeout(function () {
    mutate(function (d) {
      d.predModel = d.predModel || {};
      var by = {};
      (d.predictions || []).forEach(function (m) { if (m.afId && !m.scan) by[m.id] = m.afId; });
      var n = 0;
      ['playLog', 'liveLog'].forEach(function (k) { (d.predModel[k] || []).forEach(function (e) { if (e.afId && by[e.id] && by[e.id] !== e.afId) { e.idBad = true; n++; } }); });
      d.predModel.idCheck390 = { at: Date.now(), n: n };
    });
  }, 0);
}
function tipStatsResetOnce() {
  if (((db.predModel || {}).statsFrom) || tipUI._stReset) return;
  tipUI._stReset = true;
  setTimeout(function () { mutate(function (d) { d.predModel = d.predModel || {}; if (!d.predModel.statsFrom) d.predModel.statsFrom = Date.now(); }); }, 0);
}
function tipClosedStats() { var f = tipStatsFrom(); return tipClosed().filter(function (r) { return tipKickoff(r.m).getTime() >= f; }); }
/* 3.66.0 — soglia minima per tipo di giocata legata alla QUOTA che si va a cercare:
   a 1.50 si va in pari al 66,7%, a 1.80 al 55,6%. OTTIMA = pari + ~4-5 punti di margine.
   Così le giocate a quota bassa escono solo con percentuali alte, quelle a 1.80 anche più basse. */
/* 3.66.1 — rivisto sui 84 consigli chiusi: le soglie "di pareggio" (71%) lasciavano 2 giocate al giorno.
   Le vinte si separano dalle perse soprattutto per probabilità (≥60%: 75% vinte) e punteggio (in vantaggio: 40%).
   OTTIMA = valore qui sotto; DA VALUTARE = 3 punti meno. */
var TIP_K_FLOOR = { t1s15: 0.65, t2u15: 0.63, t1s18: 0.65, t2u18: 0.63, t2st2: 0.63, t2st3: 0.63, t1st: 0.74, t1w: 0.65, t2w: 0.65 };
var TIP_K_EXTRA = {};
function tipGreenFloor(x) {
  var f = Math.max(tipMinP(x), x.thr, TIP_K_FLOOR[x.k] || 0) + (TIP_LG_EXTRA[x.lg] || 0);
  /* 3.55.0 — partite che hanno già segnato tanto (3+ gol): il gol successivo non è più probabile, serve margine */
  if (x.goals >= 3) f += 0.05;
  /* 3.64.7 — retraining sui consigli del 19/10 (84 chiusi): 1° tempo e quote ≥1.80 promettevano 10-20 punti
     più del reale; con un gol già segnato (1-0 / 0-1) 45% vinte contro 63% previste */
  f += TIP_K_EXTRA[x.k] || 0;
  /* una squadra in vantaggio: 1-0 40% vinte, 2-0 33% (contro 59% a punteggio pari) */
  if (x.lead) f += 0.03;
  return Math.min(0.9, f);
}
function tipLiveSafetyReason(r, min, half, x) {
  var v = tipLiveSafety(r, min, half, x);
  if (v) return v;
  if (!x || !U.finite(x.evalP)) return 'stima non disponibile';
  if (x.costly || x.at) return 'ingresso condizionato o progressione costosa';
  if (x.evalP < tipGreenFloor(x)) return 'margine rispetto alla soglia insufficiente';
  return null;
}
function tipPlayTier(r, min, half, x) {
  if (!x || !U.finite(x.p) || !U.finite(x.thr)) return 'none';
  if (tipLiveSafety(r, min, half, x)) return 'none';
  var p = U.finite(x.evalP) ? x.evalP : tipPlayEstimate(r, min, half, x);
  if (!U.finite(p) || p < tipAmberFloor(x)) return 'none';
  if (x.at || x.costly || x.lowBook) return 'try';
  /* Non usare una soglia assoluta irraggiungibile per mercati a quota minima.
     Il verde richiede margine positivo + osservazioni live disponibili. */
  if (p >= tipGreenFloor(x) && (r.xg || r.recent)) return 'excellent';
  return 'try';
}
/* 3.46.2: le tre soglie sono diverse: stima, minimo arancione e minimo verde. */
/* 3.61.0 — DA VALUTARE più severo: almeno la soglia del minuto e al massimo 5 punti sotto OTTIMA */
function tipAmberFloor(x) { return Math.max(TIP_GREEN_MINP, x.thr + ({ youth: 0.04, women: 0.04, 'youth+': 0.02, minor: 0.02, 'minor+': 0.01 }[x.lg] || 0), tipGreenFloor(x) - 0.03); } /* 3.64.8 — DA VALUTARE al massimo 3 punti sotto OTTIMA: il 19/10 vinceva il 47% contro il 59% previsto */
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
/* 3.76.0 — intestazione della sezione per tipo di segnale: nome breve + STABILE/IN PROVA, descrizione sotto
   a tutta larghezza, conteggi a destra (prima il nome lungo restava schiacciato in una colonna stretta) */
/* 3.77.0 — stabile / in prova solo come icona: 🧪 in prova (viola), ◆ stabile (grigio) */
function tipSampleIcon(trial, cls) {
  var t = trial ? 'Segnale in prova' : 'Segnale stabile';
  return '<i class="tip-sample-ico ' + cls + (trial ? ' tip-sample-trial' : '') + '" role="img" aria-label="' + t + '" title="' + t + '">' + (trial ? '🧪' : '◆') + '</i>';
}
function tipKindLabel(k) { return (TIP_PLAY_SHORT[k] || k) + (TIP_TRIAL[k] ? ' 🧪' : ''); }
function tipTypeHead(k, total, found, possible) {
  var desc = String(TIP_PLAY_NAME[k] || '').replace(/^IN PROVA · /, '');
  return '<div class="tip-top-head tip-type-head"><div class="tip-type-title">' + tipSampleIcon(TIP_TRIAL[k], 'tip-type-icon') + '<b>' + U.esc(TIP_PLAY_SHORT[k] || k) + '</b>' +
    '</div>' + tipCountSummary(total, found, possible) + (desc ? '<small class="tip-type-desc">' + U.esc(desc) + '</small>' : '') + '</div>';
}
function tipCountSummary(total, excellent, maybe) {
  return '<div class="tip-count-summary" aria-label="' + excellent + ' ottime, ' + maybe + ' da valutare, ' + total + ' partite analizzate">' +
    '<div class="tip-count-strong tip-count-green"><b>' + excellent + '</b><small>OTTIME</small></div>' +
    '<div class="tip-count-strong tip-count-amber"><b>' + maybe + '</b><small>DA VALUTARE</small></div>' +
    '<div class="tip-count-total">su ' + total + '</div></div>';
}
/* book (facoltativo): { n1: quota live del book per "altro gol entro la fine" } */
/* 3.62.0 — etichette della partita.
   Profilo (quote pre-partita = come segnano di solito le due squadre secondo il book):
     DA GOL (quote Over basse, ≥2,9 gol attesi) · MEDIA · POCHI GOL (quote Over alte, <2,4).
   Ritmo (statistiche live rispetto a quanto previsto prima): ALTO (≥ +20%) · NORMALE · BASSO (≤ −15%). */
var TIP_PROF = { gol: 'DA GOL', medio: 'MEDIA', pochi: 'POCHI GOL', nq: 'SENZA QUOTE' };
var TIP_RIT = { alto: 'RITMO ALTO', norm: 'RITMO NORMALE', basso: 'RITMO BASSO' };
function tipLabels(r) {
  var L = r && U.finite(r.lamPre) ? r.lamPre : null, F = r && U.finite(r.F) ? r.F : 1;
  return { prof: L == null ? 'nq' : L >= 2.9 ? 'gol' : L < 2.4 ? 'pochi' : 'medio', rit: !r || !r.used ? 'norm' : F >= 1.2 ? 'alto' : F <= 0.85 ? 'basso' : 'norm' };
}
function tipLabelChips(prof, rit) {
  if (!prof && !rit) return '';
  return '<span class="tip-lbls">' + (prof ? '<i class="tip-lbl tip-lbl-' + prof + '">' + TIP_PROF[prof] + '</i>' : '') + (rit ? '<i class="tip-lbl tip-lbl-r' + rit + '">' + TIP_RIT[rit] + '</i>' : '') + '</span>';
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
    if (TIP_K_OFF[k]) return; /* 3.67.0 — giocate sospese */
    var thr = tipPlayThr(thrK || k, thrMin || min), c = cost(legs);
    /* 3.48.0 — step costoso: rischio oltre 2,5 volte la vincita oppure oltre 4 puntate base */
    var x = { k: k, name: TIP_PLAY_NAME[k], short: TIP_PLAY_SHORT[k], p: p, legs: legs, thr: thr, note: note || '', cost: c, costly: legs.length > 1 && (c.ratio > 2.5 || c.risk > 4 * base) };
    x.lg = r.lgTier || 'major'; x.goals = r.goals || 0; x.lead = !!r.lead;
    var lb = tipLabels(r); x.prof = lb.prof; x.rit = lb.rit;
    /* 3.64.6 — istantanea del modello al momento del consiglio, per il retraining */
    x.snap = { lam: Math.round((r.lam || 0) * 100) / 100, lamPre: U.finite(r.lamPre) ? Math.round(r.lamPre * 100) / 100 : null, F: Math.round((r.F || 0) * 100) / 100, model: r.model, xg: !!r.xg, recent: !!r.recent, thr: Math.round(thr * 1000) / 1000 };
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
      /* 3.66.0 — step 1T sospeso: 50% vinte con 69% previsto, la giocata che faceva perdere di più */
      if (bestS && TIP_STEP1T_ON) { add('t1st', h1, [{ l: 'gol entro il ' + bestS.t + '’', p: bestS.a1 }, { l: 'se no, entro l’intervallo', p: bestS.a2 }]); out[out.length - 1].ts = [bestS.t, 45]; }
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
/* 3.39.0: etichette trasparenti e prudenza quando mancano statistiche live. */
function tipSignalLabel(p, used) {
  if (!used) return 'Dati insufficienti';
  if (p >= 0.80) return 'Stima alta';
  if (p >= 0.70) return 'Stima buona';
  if (p >= 0.60) return 'Stima moderata';
  return 'Stima debole';
}
function tipSignalExplain(p, used, thr) {
  return 'Probabilità stimata ' + Math.round(100 * p) + '% · ' + tipSignalLabel(p, used) +
    (used ? ' · con statistiche live' : ' · senza statistiche live complete') +
    ' · soglia relativa ' + Math.round(100 * thr) + '%. Non è una garanzia e non sostituisce la verifica della quota.';
}
/* azione veloce per lo scanner: stessa logica di "Cosa fare" */
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
/* 3.30.0 — un solo modo di costruire i dati live di una partita (scanner, In corso e Live · sintonizza danno lo stesso risultato) */
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
/* 3.28.0 — valutazione veloce di una partita dei pronostici con i dati live già arrivati (scansione o sincronizzazione) */
function tipLiveEval(m) {
  var d = (tipUI.liveData || {})[m.id];
  /* 3.29.0 — partite da giocare per il prepartita (Top / consigli prepartita): verdi anche appena iniziate */
  var preAct = function () {
    var rec = tipPreValue(m, tipTopIds()[m.id])[0];
    if (!rec) return null;
    return { r: null, min: d && d.elapsed != null ? Number(d.elapsed) : 0, act: { k: 'pre', t: 'SOLO PREMATCH', c: 'muted', p: rec.p, w: rec.k === 'ht05' ? '1T' : 'fine', s: 'da prematch: ' + rec.label + ' da ' + rec.need.toFixed(2) } };
  };
  if (!d || d.elapsed == null || !d.goals) return tipKickoff(m).getTime() < Date.now() + 10 * 60e3 ? preAct() : null;
  if ((d.status !== '2H' && Number(d.elapsed) < 15)) { var pa = preAct(); if (pa) return pa; }
  var inp = tipLiveInput(m, d), min = inp.min, half = inp.half;
  var r = tipInplay(m, inp), y = { m: m, r: r, min: min, half: half, x: { stats: d.stats } };
  var act = tipQuickAction(y);
  tipPlayLogAdd(m, { min: min, half: half, gh: inp.gh, ga: inp.ga }, y.plays);
  return { r: r, min: min, half: half, act: act };
}
/* 3.36.0 — Storico permanente delle opportunità ottime, distinto dalla raccomandazione corrente. */
/* 3.62.0 — filtro per etichette (Live e riepilogo di oggi) */
function tipLblPass(prof, rit) {
  var f = tipUI.lblF || {};
  return (!f.p || f.p === prof) && (!f.r || f.r === rit);
}
/* 3.63.0 — filtri compatti: una sola riga con "Filtri" (apre un pannello) e i filtri attivi rimovibili */
function tipLblFilterBar() {
  var f = tipUI.lblF || {}, act = [];
  if (f.p) act.push('<button type="button" class="tip-lchip on" data-lblf="p:">' + TIP_PROF[f.p] + ' ✕</button>');
  if (f.r) act.push('<button type="button" class="tip-lchip on" data-lblf="r:">' + TIP_RIT[f.r] + ' ✕</button>');
  return '<div class="tip-lblf"><button type="button" class="tip-lchip tip-lfbtn" data-lblsheet>⚲ Filtri' + (act.length ? ' (' + act.length + ')' : '') + '</button>' + act.join('') + '</div>';
}
function tipLblSheet() {
  var f = tipUI.lblF || {}, chip = function (kind, v, t) { return '<button type="button" class="tip-lchip' + ((f[kind] || '') === v ? ' on' : '') + '" data-lblf="' + kind + ':' + v + '">' + t + '</button>'; };
  var d = sheetModal(sheetHead('Filtri', { sub: 'Valgono per le giocate live e per i consigli di oggi' }) +
    '<div class="tip-sheet"><p class="tip-lfsec">Profilo (quote pre-partita)</p><div class="tip-lfgrid">' + chip('p', '', 'Tutte') + chip('p', 'gol', 'Da gol') + chip('p', 'medio', 'Media') + chip('p', 'pochi', 'Pochi gol') + chip('p', 'nq', 'Senza quote') + '</div>' +
    '<p class="tip-lfsec">Ritmo (statistiche live)</p><div class="tip-lfgrid">' + chip('r', '', 'Ogni ritmo') + chip('r', 'alto', 'Alto') + chip('r', 'norm', 'Normale') + chip('r', 'basso', 'Basso') + '</div></div>');
  d.classList.add('tip-dlg');
  d.querySelectorAll('[data-lblf]').forEach(function (b) {
    b.onclick = function (ev) { ev.stopPropagation(); var kv = b.getAttribute('data-lblf').split(':'); tipUI.lblF = tipUI.lblF || {}; tipUI.lblF[kv[0]] = kv[1] || ''; d.close(); render(); };
  });
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('[data-lblsheet]');
  if (b) tipLblSheet();
});
/* 3.60.0 — spaccato per tipo di segnale · 3.62.0 — e per profilo × ritmo */
/* 3.79.0 — riepilogo a matrice e selettore Totale / Stabili / In prova, uguali nel Live e nelle Statistiche */
var TIP_SAMPLES = [['', 'Totale'], ['stable', '◆ Stabili'], ['trial', '🧪 In prova']];
function tipSampleOf(L, smp) { return !smp ? L : L.filter(function (e) { return smp === 'trial' ? !!e.trial : !e.trial; }); }
function tipSampleSeg(cur, attr) {
  return '<div class="tip-smpseg" role="tablist" aria-label="Campione">' + TIP_SAMPLES.map(function (x) {
    return '<button type="button" role="tab" aria-selected="' + (cur === x[0]) + '" class="tip-smpbtn' + (cur === x[0] ? ' on' : '') + (x[0] === 'trial' ? ' trial' : '') + '" ' + attr + '="' + x[0] + '">' + x[1] + '</button>';
  }).join('') + '</div>';
}
function tipSampleMatrix(L, money) {
  var cnt = function (a) {
    var w = 0, l = 0, wait = 0, pl = 0;
    a.forEach(function (e) { if (e.res === 1) { w++; pl += e.win || 0; } else if (e.res === 0) { l++; pl -= e.risk || 0; } else if (e.res == null) wait++; });
    return { w: w, l: l, n: w + l, wait: wait, pl: pl, all: a.length };
  };
  var cell = function (a) {
    var c = cnt(a);
    if (!c.all) return '<td class="tip-smx-empty">—</td>';
    return '<td><b><span class="positive">' + c.w + '</span><i>–</i><span class="negative">' + c.l + '</span></b><small>' + (c.n ? Math.round(c.w / c.n * 100) + '%' : '—') + (c.wait ? ' · ' + c.wait + ' ◷' : '') + '</small></td>';
  };
  var cols = [L.filter(function (e) { return !e.trial; }), L.filter(function (e) { return e.trial; }), L];
  var tiers = [['OTTIME', 'excellent', 'positive'], ['DA VALUTARE', 'try', 'tip-amber-text']];
  var row = function (label, cls, fn) { return '<tr><th class="' + cls + '">' + label + '</th>' + cols.map(function (a) { return cell(a.filter(fn)); }).join('') + '</tr>'; };
  var body = tiers.map(function (t) { return row(t[0], t[2], function (e) { return (e.tier || 'excellent') === t[1]; }); }).join('') +
    '<tr class="tip-smx-tot">' + '<th>Totale</th>' + cols.map(function (a) { return cell(a); }).join('') + '</tr>';
  if (money) body += '<tr class="tip-smx-eur"><th>€ teorico</th>' + cols.map(function (a) { var c = cnt(a); return c.n ? '<td class="' + (c.pl >= 0 ? 'positive' : 'negative') + '">' + (c.pl >= 0 ? '+' : '') + Math.round(c.pl) + '€</td>' : '<td class="tip-smx-empty">—</td>'; }).join('') + '</tr>';
  return '<div class="tip-tscroll"><table class="tip-smx"><thead><tr><th></th><th>◆ Stabili</th><th class="trial">🧪 In prova</th><th>Totale</th></tr></thead><tbody>' + body + '</tbody></table></div>';
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('[data-split-sample],[data-st-sample]');
  if (!b) return;
  if (b.hasAttribute('data-split-sample')) tipUI.splitSample = b.getAttribute('data-split-sample');
  else { tipUI.stF = Object.assign({}, tipUI.stF || {}); tipUI.stF.sample = b.getAttribute('data-st-sample'); }
  render();
});
/* 3.80.0 — FILTRI COMUNI dei consigli live: uguali nelle Statistiche e in Live › Consigli di oggi.
   Si combinano con il selettore Totale / Stabili / In prova e con il filtro etichette (profilo, ritmo). */
var TIP_F_LABEL = { tier: { excellent: 'Ottime', try: 'Da valutare' }, half: { 1: '1° tempo', 2: '2° tempo' }, res: { win: 'Vinte', loss: 'Perse', wait: 'In attesa' },
  q: { in: 'Passano filtro qualità', out: 'Esclusi dal filtro qualità' }, g: { 0: '0 gol segnati', 1: '1 gol segnato', 2: '2+ gol segnati' } };
function tipEFilter(F, e) {
  F = F || {};
  if (F.tier && (e.tier || 'excellent') !== F.tier) return false;
  if (F.k && e.k !== F.k) return false;
  if (F.lg && (e.lg || tipLeagueTier(e)) !== F.lg) return false;
  if (F.half && String(e.half || 1) !== String(F.half)) return false;
  if (F.res && (e.res === 1 ? 'win' : e.res === 0 ? 'loss' : 'wait') !== F.res) return false;
  if (F.q && (F.q === 'in') !== tipQualityPass(e)) return false;
  if (F.g !== undefined && F.g !== '') { var G = (e.gh || 0) + (e.ga || 0); if (String(F.g) === '2' ? G < 2 : String(G) !== String(F.g)) return false; }
  return true;
}
/* sezioni del pannello: chip(kind, valore, testo) arriva da chi apre il pannello */
function tipEFilterSections(chip, sec, sample, hide) {
  /* niente ingressi condizionati (aspetta unico / aspetta 1T): non diventano mai consigli contati */
  var act = function (trial) { return Object.keys(TIP_PLAY_SHORT).filter(function (k) { return tipKindActive(k) && !!TIP_TRIAL[k] === trial && k !== 't1w' && k !== 't2w' && !(hide && hide[k]); }); };
  var kinds = (sample !== 'trial' ? '<p class="tip-lfsub">◆ Stabili</p>' + act(false).map(function (k) { return chip('k', k, TIP_PLAY_SHORT[k]); }).join('') : '') +
    (sample !== 'stable' ? '<p class="tip-lfsub">🧪 In prova</p>' + act(true).map(function (k) { return chip('k', k, TIP_PLAY_SHORT[k]); }).join('') : '');
  return sec('Livello', chip('tier', '', 'Tutti') + chip('tier', 'excellent', 'Ottime') + chip('tier', 'try', 'Da valutare')) +
    sec('Tipo', chip('k', '', 'Tutti') + kinds) +
    sec('Tempo', chip('half', '', 'Tutti') + chip('half', '1', '1° tempo') + chip('half', '2', '2° tempo')) +
    sec('Esito', chip('res', '', 'Tutti') + chip('res', 'win', 'Vinte') + chip('res', 'loss', 'Perse') + chip('res', 'wait', 'In attesa')) +
    sec('Gol segnati', chip('g', '', 'Tutti') + chip('g', '0', '0') + chip('g', '1', '1') + chip('g', '2', '2 o più')) +
    sec('Qualità', chip('q', '', 'Tutti') + chip('q', 'in', 'Passano') + chip('q', 'out', 'Esclusi')) +
    sec('Campionato', chip('lg', '', 'Tutti') + Object.keys(TIP_LG_NAME).map(function (k) { return chip('lg', k, TIP_LG_NAME[k]); }).join('')) +
    sec('Profilo', chip('p', '', 'Tutti') + chip('p', 'gol', 'Da gol') + chip('p', 'medio', 'Media') + chip('p', 'pochi', 'Pochi gol') + chip('p', 'nq', 'Senza quote')) +
    sec('Ritmo', chip('r', '', 'Tutti') + chip('r', 'alto', 'Alto') + chip('r', 'norm', 'Normale') + chip('r', 'basso', 'Basso'));
}
function tipEFilterChips(F, lf, clearAttr) {
  var out = [], x = function (key, label) { out.push('<button type="button" class="tip-lchip on" ' + clearAttr + '="' + key + '">' + U.esc(label) + ' ✕</button>'); };
  F = F || {}; lf = lf || {};
  if (F.tier) x('tier', TIP_F_LABEL.tier[F.tier]);
  if (F.k) x('k', tipKindLabel(F.k));
  if (F.half) x('half', TIP_F_LABEL.half[F.half]);
  if (F.res) x('res', TIP_F_LABEL.res[F.res]);
  if (F.g !== undefined && F.g !== '') x('g', TIP_F_LABEL.g[F.g]);
  if (F.q) x('q', TIP_F_LABEL.q[F.q]);
  if (F.lg) x('lg', TIP_LG_NAME[F.lg] || F.lg);
  if (lf.p) x('p', TIP_PROF[lf.p]);
  if (lf.r) x('r', TIP_RIT[lf.r]);
  return out;
}
/* 3.81.0 — pannello filtri compatto: una griglia di pulsanti (sezione + valore scelto); tocchi e si aprono le alternative */
function tipFilterTabs(list) {
  return '<div class="tip-ftabs">' + list.map(function (x, i) {
    return '<button type="button" class="tip-ftab" data-ftab="' + i + '"><b>' + U.esc(x.t) + '</b><small>—</small></button>';
  }).join('') + '</div><p class="muted tip-hint tip-fhint">Tocca una voce per vedere le alternative.</p>' +
    list.map(function (x, i) { return '<div class="tip-fpane" data-fpane="' + i + '" hidden><div class="tip-lfgrid">' + x.body + '</div></div>'; }).join('');
}
/* 3.88.0 — sezione del pannello per ogni filtro (per aprirla direttamente) */
var TIP_F_SEC = { period: 'Periodo', sample: 'Campione', tier: 'Livello', k: 'Tipo', half: 'Tempo', res: 'Esito', g: 'Gol segnati', q: 'Qualità', lg: 'Campionato', p: 'Profilo', r: 'Ritmo', m: 'Tipo', top: 'Top' };
/* Azzera e ✓ in alto accanto alla X (colorata); i pulsanti in fondo non ci sono più */
function tipSheetTopActions(d, onReset, onOk) {
  var box = d.querySelector('.sheet-actions');
  if (!box) return;
  var mk = function (cls, label, html, fn) { var b = document.createElement('button'); b.type = 'button'; b.className = 'sheet-btn ' + cls; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = html; b.onclick = function (ev) { ev.stopPropagation(); fn(); }; return b; };
  box.insertBefore(mk('tip-sheet-ok sheet-save', 'Fatto', '✓', onOk), box.firstChild);
  box.insertBefore(mk('tip-sheet-reset', 'Azzera i filtri', 'Azzera', onReset), box.firstChild);
  var x = box.querySelector('.sheet-close'); if (x) x.classList.add('tip-sheet-x');
}
function tipFilterTabsBind(d, list, open) {
  var tabs = d.querySelectorAll('[data-ftab]'), panes = d.querySelectorAll('[data-fpane]');
  var label = function () {
    list.forEach(function (x, i) {
      var t = tabs[i], p = panes[i], on = p && p.querySelector('.tip-lchip.on'), set, txt;
      if (x.label) { txt = x.label(); set = x.isSet ? x.isSet() : true; }
      else { txt = on ? on.textContent.replace(/^\s+|\s+$/g, '') : 'Tutti'; var a = on && (on.getAttribute('data-stf') || on.getAttribute('data-arcf') || ''); set = !!(a && a.split(':')[1]); }
      t.querySelector('small').textContent = txt; t.classList.toggle('set', !!set);
    });
  };
  tabs.forEach(function (t) {
    t.onclick = function (ev) {
      ev.stopPropagation();
      var i = t.getAttribute('data-ftab'), open = !t.classList.contains('open');
      tabs.forEach(function (x) { x.classList.toggle('open', open && x === t); });
      panes.forEach(function (p) { p.hidden = !(open && p.getAttribute('data-fpane') === i); });
      var h = d.querySelector('.tip-fhint'); if (h) h.hidden = open;
    };
  });
  d.addEventListener('click', function () { setTimeout(label, 0); }, true);
  label();
  if (open) { var i = list.findIndex(function (x) { return x.t === open; }); if (i >= 0) tabs[i].click(); }
}
/* 3.88.0 — tocco su un filtro attivo = lo cancella; pressione lunga (mezzo secondo) = apre il pannello su quel filtro */
var TIP_LP_MS = 500;
function tipLongPressed(b) { var t = b && b._lpAt; if (t && Date.now() - t < 1500) { b._lpAt = 0; return true; } return false; }
(function () {
  var timer = null;
  var start = function (ev) {
    var b = ev.target.closest && ev.target.closest('[data-stclear],[data-arcclear]');
    if (!b) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      /* si segna soltanto: il pannello si apre al rilascio (nel click), così il tocco non chiude subito il pannello */
      b._lpAt = Date.now(); b.classList.add('tip-lp');
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) { /* ok */ }
    }, TIP_LP_MS);
  };
  var stop = function () { clearTimeout(timer); timer = null; };
  document.addEventListener('pointerdown', start);
  ['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach(function (n) { document.addEventListener(n, stop, true); });
  document.addEventListener('contextmenu', function (ev) { if (ev.target.closest && ev.target.closest('[data-stclear],[data-arcclear]')) ev.preventDefault(); });
})();
/* filtri di Live › Consigli di oggi */
function tipArcFilterBar() {
  var act = tipEFilterChips(tipUI.arcF, tipUI.lblF, 'data-arcclear');
  return '<div class="tip-lblf"><button type="button" class="tip-lchip tip-lfbtn" data-arcfilters>⚲ Filtri' + (act.length ? ' (' + act.length + ')' : '') + '</button>' + act.join('') + '</div>';
}
function tipArcFilterSheet(openKey) {
  var F = tipUI.arcF = Object.assign({}, tipUI.arcF || {});
  var chip = function (kind, v, t) {
    var cur = kind === 'p' || kind === 'r' ? ((tipUI.lblF || {})[kind] || '') : (F[kind] == null ? '' : String(F[kind]));
    return '<button type="button" class="tip-lchip' + (cur === String(v) ? ' on' : '') + '" data-arcf="' + kind + ':' + v + '">' + t + '</button>';
  };
  var list = [], sec = function (t, body) { list.push({ t: t, body: body }); return ''; };
  tipEFilterSections(chip, sec, tipUI.splitSample || '', TIP_LIVE_HIDE);
  var d = sheetModal(sheetHead('Filtri · Consigli di oggi', { sub: 'Valgono per riepilogo, tabelle ed elenco' }) + '<div class="tip-sheet">' + tipFilterTabs(list) +
    '</div>');
  d.classList.add('tip-dlg');
  d.querySelectorAll('[data-arcf]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      var kv = b.getAttribute('data-arcf').split(':'), k = kv[0], v = kv[1] || '';
      if (k === 'p' || k === 'r') { tipUI.lblF = Object.assign({}, tipUI.lblF || {}); tipUI.lblF[k] = v; } else tipUI.arcF[k] = v;
      d.querySelectorAll('[data-arcf^="' + k + ':"]').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });
  tipFilterTabsBind(d, list, openKey ? TIP_F_SEC[openKey] : '');
  tipSheetTopActions(d, function () { tipUI.arcF = {}; tipUI.lblF = {}; d.close(); }, function () { d.close(); });
  d.addEventListener('close', function () { render(); });
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('[data-arcfilters],[data-arcclear]');
  if (!b) return;
  if (b.hasAttribute('data-arcfilters')) return tipArcFilterSheet();
  if (tipLongPressed(b)) return tipArcFilterSheet(b.getAttribute('data-arcclear'));
  var k = b.getAttribute('data-arcclear');
  if (k === 'p' || k === 'r') { tipUI.lblF = Object.assign({}, tipUI.lblF || {}); tipUI.lblF[k] = ''; } else { tipUI.arcF = Object.assign({}, tipUI.arcF || {}); tipUI.arcF[k] = ''; }
  render();
});
function tipArchiveSplit(L) {
  if (!L.length) return '';
  var cell = function (arr) {
    var w = arr.filter(function (e) { return e.res === 1; }).length, p = arr.filter(function (e) { return e.res === 0; }).length, a = arr.filter(function (e) { return e.res == null; }).length;
    return arr.length ? '<td><b class="positive">' + w + '</b>/<b class="negative">' + p + '</b>' + (a ? '<small> +' + a + '</small>' : '') + '</td>' : '<td class="muted">—</td>';
  };
  var ks = Object.keys(TIP_PLAY_SHORT).filter(function (k) { return L.some(function (e) { return e.k === k; }); });
  var t1 = '<table class="tip-caltab tip-bytype"><tr><th>Tipo di segnale</th><th>OTTIME</th><th>DA VALUTARE</th></tr>' + ks.map(function (k) {
    var arr = L.filter(function (e) { return e.k === k; });
    return '<tr><th>' + U.esc(tipKindLabel(k)) + '</th>' + cell(arr.filter(function (e) { return (e.tier || 'excellent') === 'excellent'; })) + cell(arr.filter(function (e) { return e.tier === 'try'; })) + '</tr>';
  }).join('') + '</table>';
  var ps = ['gol', 'medio', 'pochi', 'nq'].filter(function (q) { return L.some(function (e) { return (e.prof || 'nq') === q; }); }), rs = ['alto', 'norm', 'basso'];
  var t2 = '<table class="tip-caltab tip-bytype"><tr><th>Profilo / ritmo</th><th>Alto</th><th>Normale</th><th>Basso</th><th>Tot.</th></tr>' + ps.map(function (q) {
    var arr = L.filter(function (e) { return (e.prof || 'nq') === q; });
    return '<tr><th>' + TIP_PROF[q] + '</th>' + rs.map(function (r) { return cell(arr.filter(function (e) { return (e.rit || 'norm') === r; })); }).join('') + cell(arr) + '</tr>';
  }).join('') + '</table>';
  var op = tipUI.splitOpen ? ' open' : '';
  return '<details class="tip-split"' + op + ' ontoggle="tipUI.splitOpen=this.open"><summary>Per tipo di segnale</summary>' + t1 + '</details>' +
    '<details class="tip-split"' + (tipUI.splitOpen2 ? ' open' : '') + ' ontoggle="tipUI.splitOpen2=this.open"><summary>Profilo × ritmo</summary>' + t2 + '<p class="muted tip-hint">vinte/perse · +in attesa</p></details>';
}
/* 3.74.0 — scheda consiglio: in alto livello ed etichette, poi la partita, poi i dettagli in campi separati;
   l'esito è un'icona in basso a sinistra */
function tipMemRow(e) {
  var t = e.tier || 'excellent', sc = (e.gh || 0) + '-' + (e.ga || 0), goal = (e.gh || 0) + (e.ga || 0) + 1;
  var state = e.res === 1 ? 'win' : e.res === 0 ? 'loss' : e.res === 'skip' ? 'skip' : 'wait';
  var icon = { win: '✓', loss: '✕', skip: '–', wait: '◷' }[state], said = { win: 'Vinta', loss: 'Persa', skip: 'Solo monitoraggio', wait: 'In attesa' }[state];
  var corner = /^t[ch][12]$/.test(e.k), firstHalf = (e.half || 0) === 1 || e.k.charAt(1) === 'h' || e.k === 'tq1' || e.k === 'tp1' || e.k === 'tg1' || e.k.indexOf('t1') === 0;
  var lbl = function (cls, txt) { return '<i class="tip-lbl ' + cls + '">' + U.esc(txt) + '</i>'; };
  var chips = (e.prof ? lbl('tip-lbl-' + e.prof, TIP_PROF[e.prof] || e.prof) : '') + (e.rit ? lbl('tip-lbl-r' + e.rit, TIP_RIT[e.rit] || e.rit) : '') +
    (e.lg && e.lg !== 'major' ? lbl('', TIP_LG_NAME[e.lg] || e.lg) : '') +
    (e.played ? lbl('tip-lbl-gol', 'giocata da te') : '');
  /* 3.82.0 — giorno e ORA in cui il segnale è stato dato */
  var day = (e.date ? tipCap(tipDayLabel(e.date)) : '') + (e.t ? ' ' + new Date(e.t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '');
  var target = corner ? 'angoli ' + (e.cn != null ? e.cn : '?') + ' → +' + (e.need || 1) : sc + ' → ' + goal + '° gol';
  var f = function (txt, cls) { return txt ? '<span' + (cls ? ' class="' + cls + '"' : '') + '>' + txt + '</span>' : ''; };
  var meta = f(U.esc(TIP_PLAY_SHORT[e.k] || e.k), 'tip-mem-kind') + f(U.esc(day)) + f((e.min || 0) + '’' + (firstHalf ? ' 1T' : '')) +
    f(corner ? U.esc(sc) + ' · ' + U.esc(target) : U.esc(target)) + f(e.book ? '@' + Number(e.book).toFixed(2) : '') +
    f(Array.isArray(e.ft) ? 'finale ' + e.ft[0] + '-' + e.ft[1] : '') +
    f(e.played ? 'tua @' + e.played.q.toFixed(2) + ' · ' + e.played.s + '€' : '');
  /* 3.75.0 — stabile o in prova: sempre nello stesso punto, in alto a destra */
  var kind = tipSampleIcon(e.trial, 'tip-mem-sample');
  return '<div class="tip-memory-row tip-mem2 tip-memory-' + state + (e.trial ? ' tip-mem-istrial' : '') + '">' + kind +
    '<div class="tip-mem-top"><span class="tip-history-tier tip-history-' + t + '">' + (t === 'try' ? 'DA VALUTARE' : 'OTTIMA') + '</span>' + chips + '</div>' +
    '<b class="tip-mem-name">' + U.esc(e.home || '') + ' – ' + U.esc(e.away || '') + '</b>' +
    '<div class="tip-mem-meta"><span class="tip-mem-res tip-mem-res-' + state + '" role="img" aria-label="' + said + '" title="' + said + '">' + icon + '</span>' + meta + '</div></div>';
}
function tipExcellentArchive() {
  /* 3.55.0 — solo i consigli di oggi (00:00-23:59) e niente monitoraggi; tutto resta salvato per statistiche e retraining.
     3.84.0 — stesso schema dello Storico (tipDayHead / tipDayBody); qui selettore e filtri propri, niente +1 angolo 1T */
  var today0 = U.local().slice(0, 10), smp = tipUI.splitSample || '';
  var all = tipPlayDedup((db.predModel || {}).playLog || []).filter(function (e) { return tipKindActive(e.k) && !TIP_LIVE_HIDE[e.k] && (e.tier === 'excellent' || e.tier === 'try' || !e.tier) && !e.conditional && !e.costly && e.res !== 'skip' && new Date(e.t || 0).toLocaleDateString('sv-SE') === today0 && tipLblPass(e.prof || 'nq', e.rit || 'norm') && tipEFilter(tipUI.arcF, e); })
    .slice().sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
  var mine = all.filter(function (e) { return e.played; }).length;
  return '<section class="card tip-top tip-live-section tip-archive"><div class="tip-top-head tip-archive-head"><b>★ Consigli di oggi</b><span class="tip-archive-sum">' + (all.length ? tipDayHead(all) : '0 salvati') + (mine ? ' · ' + mine + ' giocati da te' : '') + '</span></div>' +
    tipDayBody(all, smp, tipSampleSeg(smp, 'data-split-sample') + tipArcFilterBar()) +
    '<p class="muted tip-hint">Vinte–perse, % sulle chiuse, ◷ in attesa. Una voce per partita e punteggio; ingressi futuri e step costosi non contano.</p></section>';
}

/* ---------- 3.48.0 — Scansione automatica, segnali nuovi e avvisi sul telefono ---------- */
var TIP_AUTO_MS = 120e3; /* con la pagina Live aperta si riscansiona ogni 2 minuti */
var TIP_ALERT_FN = '/functions/v1/pronostici-avvisi';
function tipFreshIds() {
  var now = Date.now(), out = {};
  (((db.predModel || {}).playLog) || []).forEach(function (e) { if (e.t > now - 10 * 60e3 && e.res == null) out[e.id] = 1; });
  return out;
}
/* avviso dentro l'app per le nuove OTTIME arrivate con l'ultima scansione */
function tipFreshNotify() {
  var last = tipUI._freshAt || 0, now = Date.now();
  tipUI._freshAt = now;
  if (!last) return;
  var nw = (((db.predModel || {}).playLog) || []).filter(function (e) { return e.t > last && e.tier === 'excellent' && e.res == null && tipAlertWants(Object.assign({}, tipAlertPrefs(), { on: true }), e); }); /* 3.73.0 — stessi filtri degli avvisi */
  if (!nw.length) return;
  var e = nw[nw.length - 1];
  U.toast((e.trial ? '🧪 IN PROVA · ' : '') + '🟢 ' + (nw.length > 1 ? nw.length + ' nuove OTTIME · ' : 'Nuova OTTIMA · ') + e.home + ' – ' + e.away + ' ' + e.min + '’ · ' + (TIP_PLAY_SHORT[e.k] || e.k) + ' ' + Math.round(e.p * 100) + '%');
  try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (x) { /* ok */ }
}
async function tipAutoScan(force) {
  if (tipUI._autoBusy || !tipCanSync() || typeof tab === 'undefined' || tab !== 'tips' || (tipUI.panel !== 'live' && tipUI.panel !== 'home') || document.visibilityState !== 'visible') return;
  if (!force && tipUI.scan && Date.now() - tipUI.scan.at < TIP_AUTO_MS - 5e3) return;
  if (document.querySelector('dialog[open]')) return; /* non disturbare una partita aperta */
  tipUI._autoBusy = true;
  try {
    await tipScanFetch();
    await tipSignalsPull(true);
    render();
    setTimeout(function () { tipFreshNotify(); if (tab === 'tips' && tipUI.panel === 'live' && !document.querySelector('dialog[open]')) render(); }, 120);
  } catch (e) { /* riprova al giro dopo */ }
  finally { tipUI._autoBusy = false; }
}
function tipAutoStart() {
  if (tipUI._autoT) return;
  tipUI._autoT = setInterval(function () { tipAutoScan(false); }, 30e3);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(function () { tipAutoScan(false); }, 400); });
}
/* segnali trovati dal server mentre l'app era chiusa (funzione pronostici-avvisi): entrano nella traccia */
async function tipSignalsPull(quiet) {
  if (!tipCanSync()) return;
  if (tipUI._sigOff && Date.now() - tipUI._sigOff < 3600e3) return;
  if (tipUI._sigAt && Date.now() - tipUI._sigAt < 60e3) return;
  tipUI._sigAt = Date.now();
  try {
    var since = ((db.predModel || {}).sigSince) || Date.now() - 2 * 86400e3;
    var r = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'signals', since: since } });
    if (r && r.bzRemaining != null) tipUI.bzRem = r.bzRemaining;
    tipUI.serverVer = (r && r.ver) || 'vecchia';
    var L = (r && r.signals) || [];
    if (!L.length) return;
    var mx = since;
    L.forEach(function (e) { if (e && e.key && e.id) { tipPlayQueue({ e: e }); mx = Math.max(mx, e.t || 0); } });
    mutate(function (d) { d.predModel = d.predModel || {}; d.predModel.sigSince = mx; });
  } catch (e) {
    if (/404|not found|NOT_FOUND/i.test(String(e && e.message))) tipUI._sigOff = Date.now();
    if (!quiet) U.toast(tipFnErr(e).replace('pronostici-dati', 'pronostici-avvisi').replace('GUIDA_DATI_AUTOMATICI', 'GUIDA_AVVISI'));
  }
}
/* 3.73.0 — filtri degli avvisi: stabili / in prova, ottime / da valutare, tipo (gol o angoli, 1° e 2° tempo)
   e singolo segnale. Le scelte valgono per le notifiche sul telefono (server) e per l'avviso dentro l'app. */
var TIP_ALERT_GROUPS = [['gol1', 'Gol 1° tempo'], ['gol2', 'Gol 2° tempo'], ['cor1', 'Angoli 1° tempo'], ['cor2', 'Angoli 2° tempo']];
function tipAlertGroup(k) {
  k = String(k || '');
  if (/^th/.test(k)) return 'cor1';
  if (/^tc/.test(k)) return 'cor2';
  return k === 'tp1' || k === 'tq1' || k === 'tg1' || k.indexOf('t1') === 0 ? 'gol1' : 'gol2';
}
/* 3.78.0 — FILTRO QUALITÀ (analisi del 20/10 su 84 consigli chiusi, quasi tutti del 19/10):
   probabilità promessa ≥ 62% e campionato forte (maggiori, minori di Paesi forti, giovanili di Paesi forti) →
   21 vinte su 28 (75%) contro 44 su 84 (52%). Campione piccolo e di un solo giorno: il filtro decide solo
   le notifiche; tutti i segnali restano registrati e le statistiche confrontano chi passa e chi no. */
/* 3.79.0 — +1 angolo 1T: registrato e nelle Statistiche, ma niente notifiche e niente sezione Live */
var TIP_NO_PUSH = { th1: 1 }, TIP_LIVE_HIDE = { th1: 1 };
/* 3.89.0 — analisi del 21/10 (423 consigli chiusi): stabili con p ≥ 65% e campionato forte 23/27 (85%), tutto il resto ~50%.
   Soglia portata da 62% a 65%. */
var TIP_QUALITY_MINP = 0.65, TIP_QUALITY_LG = { major: 1, 'minor+': 1, 'youth+': 1 };
function tipQualityPass(e) {
  if (!e) return false;
  var lg = e.lg || tipLeagueTier({ league: e.league, home: e.home, away: e.away });
  if (!TIP_QUALITY_LG[lg]) return false;
  return /^t[ch][12]$/.test(String(e.k || '')) || (e.p || 0) >= TIP_QUALITY_MINP;
}
/* 3.82.0 — motivo per cui un segnale NON viene notificato ('' = si notifica). Lo usa anche il server e lo salva nel segnale. */
function tipAlertWhy(A, e) {
  if (!e) return 'segnale vuoto';
  if (!A || !A.on) return 'avvisi spenti';
  if (TIP_NO_PUSH[e.k]) return 'tipo senza notifiche';
  if (!tipKindActive(e.k)) return 'tipo sospeso';
  if (e.trial ? A.trial === false : A.stable === false) return e.trial ? 'segnali in prova spenti' : 'segnali stabili spenti';
  if (e.tier === 'excellent' ? A.excellent === false : !A.amber) return e.tier === 'excellent' ? 'OTTIME spente' : 'DA VALUTARE spente';
  if (A[tipAlertGroup(e.k)] === false) return 'tipo ' + ((TIP_ALERT_GROUPS.find(function (g) { return g[0] === tipAlertGroup(e.k); }) || [0, ''])[1]).toLowerCase() + ' spento';
  if (A.quality !== false && !tipQualityPass(e)) return 'escluso da Solo qualità';
  if (A.off && A.off[e.k]) return 'segnale spento negli avvisi';
  return '';
}
function tipAlertWants(A, e) { return !tipAlertWhy(A, e); }
function tipAlertPrefs() { return Object.assign({ on: false, amber: false, stars: false }, ((db.predModel || {}).alerts) || {}); }
function tipAlertCard() {
  var A = tipAlertPrefs(), sub = typeof pushState !== 'undefined' && pushState.sub && pushState.row && pushState.row.enabled !== false;
  if (typeof pushState !== 'undefined' && !pushState.loaded && typeof refreshPushState === 'function' && !tipUI._pushAsked) { tipUI._pushAsked = 1; setTimeout(refreshPushState, 50); }
  var st = !tipCanSync() ? 'Fai l’accesso in Altro › Sincronizzazione.' :
    !sub ? 'Prima attiva le notifiche del telefono in Altro › Notifiche (stesso permesso del promemoria serale), poi torna qui.' :
    A.on ? 'Attivi: il server controlla le partite ogni 2 minuti e ti avvisa anche ad app chiusa. ' + tipAlertSummary(A) :
    'Spenti: tocca per ricevere un avviso quando compare una giocata, anche ad app chiusa.';
  var btn = function (k, on, label) { return '<button type="button" class="tip-chipbtn' + (on ? ' on' : '') + '" data-alert="' + k + '">' + label + '</button>'; };
  return '<section class="card tip-top tip-alerts"><div class="tip-top-head"><b>🔔 Avvisi sul telefono</b><span>' + (A.on && sub ? 'attivi' : 'spenti') + '</span></div><p class="muted tip-hint">' + U.esc(st) + (tipUI.bzRem != null ? ' Richieste rimaste: ' + U.esc(tipUI.bzRem) + '.' : '') + '</p>' +
    (tipCanSync() && sub ? tipAlertDiag() + '<div class="tip-chips">' + btn('on', A.on, A.on ? 'Avvisi attivi' : 'Attiva avvisi') + btn('stars', A.stars, 'Solo preferite') + '<button type="button" class="tip-chipbtn" data-alert="test">Invia una prova</button></div>' + tipAlertFilters(A, btn) : '') +
    '</section>';
}
function tipAlertOn(A, k) { return ['stable', 'trial', 'excellent', 'gol1', 'gol2', 'cor1', 'cor2', 'quality'].indexOf(k) >= 0 ? A[k] !== false : !!A[k]; }
function tipAlertSummary(A) {
  var on = function (k) { return tipAlertOn(A, k); };
  var lv = [on('excellent') && 'OTTIME', on('amber') && 'DA VALUTARE'].filter(Boolean), sg = [on('stable') && 'stabili', on('trial') && 'in prova'].filter(Boolean);
  var gr = TIP_ALERT_GROUPS.filter(function (g) { return on(g[0]); }).map(function (g) { return g[1].toLowerCase(); });
  var off = Object.keys(A.off || {}).filter(function (k) { return A.off[k]; }).length;
  if (!lv.length || !sg.length || !gr.length) return 'Con questi filtri non arriva nessun avviso.';
  return lv.join(' e ') + (on('quality') ? ' di qualità' : '') + ' · segnali ' + sg.join(' e ') + ' · ' + gr.join(', ') + (off ? ' · ' + off + ' segnali spenti' : '') + (A.stars ? ' · solo preferite' : '') + '.';
}
function tipAlertFilters(A, btn) {
  var on = function (k) { return tipAlertOn(A, k); }, sec = function (t) { return '<p class="muted tip-hint"><b>' + t + '</b></p>'; };
  var kinds = Object.keys(TIP_PLAY_SHORT).filter(function (k) { return tipKindActive(k) && !TIP_NO_PUSH[k]; });
  var groups = TIP_ALERT_GROUPS.filter(function (g) { return kinds.some(function (k) { return tipAlertGroup(k) === g[0]; }); });
  var single = groups.map(function (g) {
    var ks = kinds.filter(function (k) { return tipAlertGroup(k) === g[0]; });
    if (!ks.length) return '';
    return '<p class="muted tip-hint">' + g[1] + (on(g[0]) ? '' : ' (tipo spento)') + '</p><div class="tip-chips">' + ks.map(function (k) {
      var isOn = !(A.off && A.off[k]);
      return '<button type="button" class="tip-chipbtn' + (isOn ? ' on' : '') + '" data-alert-k="' + k + '">' + U.esc(TIP_PLAY_SHORT[k]) + (TIP_TRIAL[k] ? ' 🧪' : '') + '</button>';
    }).join('') + '</div>';
  }).join('');
  return sec('Segnali') + '<div class="tip-chips">' + btn('stable', on('stable'), 'Stabili') + btn('trial', on('trial'), 'In prova 🧪') + '</div>' +
    sec('Livello') + '<div class="tip-chips">' + btn('excellent', on('excellent'), 'OTTIME') + btn('amber', on('amber'), 'DA VALUTARE') + btn('quality', on('quality'), 'Solo qualità') + '</div>' +
    '<p class="muted tip-hint">Solo qualità: probabilità almeno 65% e campionati forti (maggiori, minori e giovanili di Paesi forti). Meno avvisi; i segnali esclusi restano nelle statistiche.</p>' +
    sec('Tipo') + '<div class="tip-chips">' + groups.map(function (g) { return btn(g[0], on(g[0]), g[1]); }).join('') + '</div>' +
    '<details class="tip-split"' + (tipUI.alertOpen ? ' open' : '') + ' ontoggle="tipUI.alertOpen=this.open"><summary>Singoli segnali</summary>' + single + '</details>';
}
/* 3.82.0 — controllo: versione della funzione sul server e ultimi segnali con l'esito della notifica */
function tipAlertDiag() {
  var v = tipUI.serverVer, need = '3.90.0', old = v && (v === 'vecchia' || v < need);
  var L = (((db.predModel || {}).playLog) || []).filter(function (e) { return e.src === 'server' && e.t > Date.now() - 24 * 3600e3; })
    .sort(function (a, b) { return (b.t || 0) - (a.t || 0); }).slice(0, 12);
  var rows = L.map(function (e) {
    var p = e.push, ok = p && p.sent, why = p ? p.why : 'il server non ha registrato l’esito (funzione da aggiornare)';
    return '<li class="tip-diag-row"><span class="tip-diag-ico ' + (ok ? 'ok' : 'ko') + '">' + (ok ? '📲' : '–') + '</span><span><b>' + U.esc(new Date(e.t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })) + ' · ' + U.esc(e.home || '') + ' – ' + U.esc(e.away || '') + '</b><small>' + U.esc(tipKindLabel(e.k)) + ' · ' + (e.tier === 'try' ? 'DA VALUTARE' : 'OTTIMA') + ' · ' + Math.round((e.p || 0) * 100) + '% · ' + (ok ? 'notificato' : 'non notificato: ' + U.esc(why || '')) + '</small></span></li>';
  }).join('');
  return '<details class="tip-split tip-diag"' + (old ? ' open' : '') + '><summary>Controllo notifiche' + (old ? ' · ⚠ server da aggiornare' : '') + '</summary>' +
    '<p class="muted tip-hint">Funzione avvisi sul server: <b>' + U.esc(v ? (v === 'vecchia' ? 'versione vecchia' : v) : 'non ancora letta') + '</b>' + (old ? ' — ripubblica pronostici-avvisi: senza l’aggiornamento i segnali in prova non vengono notificati.' : '') + '</p>' +
    (rows ? '<ul class="tip-diag-list">' + rows + '</ul>' : '<p class="muted tip-hint">Nessun segnale dal server nelle ultime 24 ore.</p>') + '</details>';
}
async function tipAlertTest() {
  try {
    var r = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'test' } });
    U.toast(r && r.sent ? 'Prova inviata: deve arrivare la notifica.' : (r && r.error) || 'Nessun telefono iscritto.');
  } catch (e) { U.toast(tipFnErr(e).replace('pronostici-dati', 'pronostici-avvisi').replace('GUIDA_DATI_AUTOMATICI', 'GUIDA_AVVISI')); }
}
function tipLivePanel(list) {
  tipUI.freshIds = tipFreshIds();
  var scanHtml = tipScanPanel(); /* prima: collega le partite dei pronostici ai dati live della scansione */
  var evals = {};
  var live = list.filter(tipIsLiveNow).map(function (m) { evals[m.id] = tipLiveEval(m); return m; }).sort(function (a, b) {
    var pa = evals[a.id] && evals[a.id].act.k !== 'no' ? 0 : 1, pb = evals[b.id] && evals[b.id].act.k !== 'no' ? 0 : 1;
    return pa - pb || tipKickoff(a) - tipKickoff(b);
  }),
    soon = list.filter(function (m) {
      var ko = tipKickoff(m).getTime(), now = Date.now();
      return !m.cancelled && !tipNum(m.ft) && ko > now + 5 * 60e3 && ko < now + 3 * 3600e3;
    }).sort(function (a, b) { return tipKickoff(a) - tipKickoff(b); });
  var row = function (m) {
    var d = (tipUI.liveData || {})[m.id],
      sc = d && d.goals && d.goals[0] != null ? d.goals[0] + '-' + d.goals[1] : 'vs',
      mn = d && d.elapsed != null ? d.elapsed + '\'' : U.esc(m.time);
    var ev = Object.prototype.hasOwnProperty.call(evals, m.id) ? evals[m.id] : (function () {
      var rec = tipPreValue(m, tipTopIds()[m.id])[0];
      return rec ? { act: { k: 'pre', t: 'SOLO PREMATCH', c: 'muted', p: rec.p, w: rec.k === 'ht05' ? '1T' : 'fine', s: 'da prematch: ' + rec.label + ' da ' + rec.need.toFixed(2) } } : null;
    })(), go = ev && ev.act.k !== 'no';
    return '<button type="button" class="tip-trow' + (go ? ' tip-hot' : '') + '" data-tip-live="' + U.esc(m.id) + '"><span class="tip-tn tip-ln">' + mn + '</span><span class="tip-tmain"><b>' + U.esc(m.home) + ' – ' + U.esc(m.away) + '</b><small>' + (go ? '<b class="positive">' + (ev.act.w === '1T' ? 'gol 1° tempo' : 'gol 2° tempo / fine') + '</b> · ' + ev.act.s : U.esc(m.league) + (d && d.at ? ' · ' + new Date(d.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '')) + '</small>' + (d && d.goals ? '<small class="tip-next-goal">⚽ Next gol: ' + (d.goals[0] + d.goals[1] + 1) + '° · risultato ' + sc + '</small>' : '<small class="tip-next-goal">In attesa di dati live aggiornati</small>') + '</span><span class="tip-tpick"><b>' + sc + (go ? ' <span class="' + ev.act.c + '">' + ev.act.t + '</span>' : '') + '</b><small>' + (go ? Math.round(ev.act.p * 100) + '% ›' : ev ? 'niente ›' : 'valuta ›') + '</small></span></button>';
  };
  /* 3.33.0 — giocate migliori adesso, per tipo: partite dei pronostici e dello scanner, in ordine di riuscita */
  var pool = {};
  live.forEach(function (m) { var e = evals[m.id]; if (e && e.r) pool[m.id] = { m: m, r: e.r, min: e.min, half: e.half || (e.min > 46 ? 2 : 1), sc: ((tipUI.liveData || {})[m.id] || {}).goals, open: 'data-tip-live="' + U.esc(m.id) + '"' }; });
  (tipUI.scanRows || []).forEach(function (y) { if (!pool[y.m.id]) pool[y.m.id] = { m: y.m, r: y.r, min: y.min, half: y.half, sc: y.x.goals, open: 'data-scan-open="' + U.esc(y.x.afId) + '"' }; });
  /* 3.48.0 — ogni partita UNA volta: nella sezione della sua giocata migliore (OTTIMA prima, poi DA VALUTARE).
     Se con lo stesso punteggio era già stata segnalata con un altro tipo, si dice quale. */
  var byType = {}, fresh = tipUI.freshIds || {};
  Object.keys(pool).forEach(function (id) {
    var P2 = pool[id], best = tipPlayBest(tipPlays(P2.r, P2.min, P2.half));
    if (!best) return;
    if (!tipLblPass(best.prof, best.rit)) return;
    var ctx = { half: P2.half, gh: P2.sc ? P2.sc[0] : 0, ga: P2.sc ? P2.sc[1] : 0 }, prev = tipPlayFind(P2.m.id, ctx);
    (byType[best.k] = byType[best.k] || []).push({ P: P2, pl: best, prev: prev && prev.k !== best.k ? prev : null, isNew: !!fresh[P2.m.id] });
  });
  (tipUI.scanRows || []).forEach(function (y) {
    (y.trials || []).forEach(function (tp) {
      if (TIP_LIVE_HIDE[tp.k] || !tipKindActive(tp.k) || !tipLblPass(tp.prof, tp.rit)) return;
      (byType[tp.k] = byType[tp.k] || []).push({ P: { m: y.m, r: y.r, min: y.min, half: y.half, sc: y.x.goals, open: 'data-scan-open="' + U.esc(y.x.afId) + '"' }, pl: tp, prev: null, isNew: false });
    });
  });
  var playsHtml = tipLblFilterBar() + Object.keys(TIP_PLAY_NAME).filter(function (k) { return byType[k] && byType[k].length; }).map(function (k) {
    var found = byType[k].filter(function (x) { return x.pl.green; }).length, possible = byType[k].length - found;
    var L = byType[k].sort(function (a, b) { return (b.pl.green ? 1 : 0) - (a.pl.green ? 1 : 0) || b.pl.p - a.pl.p; }).slice(0, 10);
    return '<section class="card tip-top tip-grade-section' + (TIP_TRIAL[k] ? ' tip-grade-trial' : '') + '">' + tipTypeHead(k, byType[k].length, found, possible) + '<div class="tip-tlist">' +
      L.map(function (x) {
        var P2 = x.P;
        var pc = Math.round((x.pl.evalP == null ? x.pl.p : x.pl.evalP) * 100);
        /* 3.61.0 — riquadro: nome partita per intero in alto, poi minuto · risultato · % · tipo, etichette e campionato */
        return '<button type="button" class="tip-prow' + (x.pl.green ? ' tip-hot' : ' tip-warm') + (x.isNew ? ' tip-new' : '') + '" ' + P2.open + '>' +
          '<b class="tip-prow-name">' + (x.isNew ? '<i class="tip-newtag">NUOVA</i> ' : '') + U.esc(P2.m.home) + ' – ' + U.esc(P2.m.away) + '</b>' +
          '<span class="tip-prow-line"><span>' + P2.min + '’ · <b>' + (P2.sc ? P2.sc[0] + '-' + P2.sc[1] : '?-?') + '</b></span><span class="' + (x.pl.green ? 'positive' : 'tip-amber-text') + '"><b>' + pc + '%</b> ' + (x.pl.green ? 'OTTIMA' : 'DA VALUTARE') + ' ›</span></span>' +
          tipLabelChips(x.pl.prof, x.pl.rit) + (x.pl.trial ? '<span class="tip-lbls"><i class="tip-lbl tip-lbl-trial">IN PROVA</i>' + (x.pl.cn != null ? '<i class="tip-lbl">angoli ora ' + x.pl.cn + '</i>' : '') + (x.pl.book ? '<i class="tip-lbl' + (x.pl.lowBook ? ' tip-amber-text' : '') + '">quota ' + x.pl.book.toFixed(2) + (x.pl.lowBook ? ' sotto la giusta ' + x.pl.minQ.toFixed(2) : '') + '</i>' : '') + '</span>' : '') +
          '<small class="muted">' + U.esc(P2.m.league || '') + (function () { var A = tipLgAvgOf(P2.m.league); return A ? ' · media ' + A.avg.toFixed(1).replace('.', ',') + ' gol (' + A.n + ' partite)' : ''; })() + '</small>' +
          (x.prev ? '<small class="tip-amber-text">già segnalata al ' + x.prev.min + '’: ' + U.esc(TIP_PLAY_SHORT[x.prev.k] || x.prev.k) + '</small>' : '') + '</button>';
      }).join('') + '</div></section>';
  }).join('');
  return (
    '<div class="tip-actrow"><button type="button" class="tip-live-get" data-scan>🔎 ' + (tipUI.scan ? 'Riscansiona ora' : 'Scansiona ora') + '</button></div>' +
    (playsHtml.replace(tipLblFilterBar(), '') ? playsHtml : tipLblFilterBar() + '<section class="card tip-top"><p class="muted tip-tnone">Nessuna giocata consigliata in questo momento. Il controllo è automatico ogni 2 minuti.</p></section>') +
    tipExcellentArchive() +
    /* 3.64.0 — le liste complete stanno in fondo, chiuse: servono solo per curiosare */
    '<details class="tip-split tip-alllive"' + (tipUI.allLiveOpen ? ' open' : '') + ' ontoggle="tipUI.allLiveOpen=this.open"><summary>Tutte le partite live</summary>' +
    '<p class="muted tip-hint">Scanner: tutte le partite in corso nel mondo, ordinate per spinta. Sotto, le partite dei tuoi pronostici prepartita.</p>' +
    scanHtml + tipStarPanel(list) +
    '<section class="card tip-top tip-live-section"><div class="tip-top-head"><b>I tuoi pronostici in corso</b><span>' + live.length + ' partite · ' + live.filter(function (m) { return evals[m.id] && evals[m.id].act.k !== 'no'; }).length + ' da giocare</span></div>' +
    (live.length ? '<div class="tip-tlist">' + live.map(row).join('') + '</div>' : '<p class="muted tip-tnone">Nessuna partita dei pronostici in corso adesso.</p>') +
    '</section>' +
    (soon.length ? '<section class="card tip-top"><div class="tip-top-head"><b>Tra poco</b><span>prossime 3 ore</span></div><div class="tip-tlist">' + soon.map(row).join('') + '</div></section>' : '') +
    '</details>'
  );
}
/* storico delle sincronizzazioni (per il "momento" degli ultimi minuti) */
function tipCtxBadge(m) {
  var n = m.ctx ? (m.ctx.h || []).length + (m.ctx.a || []).length : 0;
  return n ? ' · ' + n + (n === 1 ? ' fattore' : ' fattori') : '';
}
function tipCtxSheet(id, back) {
  var m = (db.predictions || []).find(function (x) { return x.id === id; });
  if (!m) return;
  var cx = JSON.parse(JSON.stringify(m.ctx || { h: [], a: [], late: false }));
  cx.h = cx.h || []; cx.a = cx.a || [];
  var col = function (side, name) {
    return '<div class="tip-ctx-col"><b>' + U.esc(name) + '</b>' + TIP_CTX.map(function (d) {
      return '<label class="toggle-line"><input type="checkbox" data-cx="' + side + '" value="' + d.k + '"' + (cx[side].indexOf(d.k) >= 0 ? ' checked' : '') + '> ' + U.esc(d.label) + '</label>';
    }).join('') + '</div>';
  };
  var html = sheetHead('Contesto squadre', { sub: U.esc(m.home) + ' – ' + U.esc(m.away) }) +
    '<div class="tip-form">' +
    '<p class="muted tip-hint">Cambia i gol attesi di questa partita.</p>' +
    col('h', m.home) + col('a', m.away) +
    '<label class="toggle-line"><input type="checkbox" data-cx-late' + (cx.late ? ' checked' : '') + '> Notizie uscite dopo le quote (il book non le ha ancora prezzate)</label>' +
    '<div id="tip-ctx-out" class="tip-probs"></div>' +
    '<button type="button" class="tip-live-get" data-cx-save>Salva</button>' +
    '</div>';
  var dlg = sheetModal(html);
  dlg.classList.add('tip-dlg');
  var before = tipCalc(Object.assign({}, m, { ctx: null }));
  var draw = function () {
    cx.h = []; cx.a = [];
    dlg.querySelectorAll('[data-cx]').forEach(function (el) { if (el.checked) cx[el.dataset.cx].push(el.value); });
    cx.late = dlg.querySelector('[data-cx-late]').checked;
    var c = tipCalc(Object.assign({}, m, { ctx: cx })),
      box = function (label, a, b) { return '<div class="tip-prob"><small>' + label + '</small><b>' + b + '%</b><i>' + (b === a ? 'invariato' : 'prima ' + a + '%') + '</i></div>'; };
    dlg.querySelector('#tip-ctx-out').innerHTML = box('Over 0.5 1T', before.ht05, c.ht05) + box('Over 1.5', before.o15, c.o15) + box('Over 2.5', before.o25, c.o25) +
      '<div class="tip-prob"><small>Gol attesi</small><b>' + c.lh.toFixed(2) + '–' + c.la.toFixed(2) + '</b><i>prima ' + before.lh.toFixed(2) + '–' + before.la.toFixed(2) + '</i></div>';
  };
  dlg.querySelectorAll('input').forEach(function (el) { el.addEventListener('change', draw); });
  dlg.querySelector('[data-cx-save]').onclick = function () {
    draw();
    mutate(function (n) {
      var x = n.predictions.find(function (y) { return y.id === m.id; });
      if (!x) return;
      if (cx.h.length || cx.a.length) x.ctx = { h: cx.h, a: cx.a, late: !!cx.late };
      else delete x.ctx;
      if (!tipNum(x.ft) && !tipNum(x.ht) && tipKickoff(x).getTime() > Date.now()) {
        var keep = db; db = n;
        try { var P = tipParams(), pk = tipPicksFor(x, P); if (pk.length && !x.preIssue) x.picks = pk; } finally { db = keep; }
      }
    });
    dlg.close();
    U.toast('Contesto salvato per le stime live. I consigli già emessi restano nello storico.');
    if (back === 'live') tipLiveSheet(m.id);
  };
  draw();
}
function tipLiveLogSave(m, v, r, adv, q) {
  var half = v.half || 1, key = m.id + '|' + half + '|' + v.min;
  var P = {};
  r.lines.forEach(function (x) { if (/^(h1|n1|n2|gg|w\d+)$/.test(x.k)) P[x.k] = Math.round(x.p * 1000) / 1000; });
  var rec = {
    key: key, id: m.id, afId: m.afId || null, scan: !!m.scan, home: m.home, away: m.away, league: m.league,
    date: m.date, time: m.time, at: Date.now(), min: v.min, half: half, gh: v.gh || 0, ga: v.ga || 0,
    lh: Math.round(r.lam * 100) / 100, model: r.model, F: Math.round(r.F * 100) / 100, P: P, adv: adv,
    q: Object.keys(q || {}).length ? Object.assign({}, q) : undefined, side: v.side,
  };
  var sig = JSON.stringify([rec.P, rec.adv, rec.q]);
  if (tipUI._logSig && tipUI._logSig[key] === sig) return;
  tipUI._logSig = tipUI._logSig || {};
  tipUI._logSig[key] = sig;
  mutate(function (d) {
    d.predModel = d.predModel || {};
    var L = d.predModel.liveLog = d.predModel.liveLog || [];
    var i = L.findIndex(function (x) { return x.key === key; });
    if (i >= 0) { rec.res = L[i].res; L[i] = rec; } else L.push(rec);
    if (L.length > 600) L.splice(0, L.length - 600);
  });
}
/* esito di una valutazione live dato il risultato finale (e, se ci sono, i minuti dei gol) */
function tipLiveLogResolve(rec, x) {
  var G = rec.gh + rec.ga, ft = x.ft, ht = x.ht, mins = Array.isArray(x.goals) && Array.isArray(x.ft) && x.goals.length === x.ft[0] + x.ft[1] ? x.goals.map(function (g) { return g.min; }) : null;
  if (!Array.isArray(ft)) return null;
  var FT = ft[0] + ft[1], res = { ft: ft, ht: ht || null, at: Date.now() };
  var after = function (t) { return mins ? mins.filter(function (mm) { return mm > rec.min && mm <= t; }).length : null; };
  res.y = {};
  res.y.n1 = FT > G ? 1 : 0;
  res.y.n2 = FT >= G + 2 ? 1 : 0;
  if (rec.half === 1 && Array.isArray(ht)) res.y.h1 = ht[0] + ht[1] > G ? 1 : 0;
  Object.keys(rec.P || {}).forEach(function (k) {
    if (!/^w\d+$/.test(k)) return;
    var t = Number(k.slice(1));
    if (FT === G) res.y[k] = 0;
    else { var a = after(t); if (a != null) res.y[k] = a > 0 ? 1 : 0; }
  });
  res.adv = (rec.adv || []).map(function (a) {
    if (a.t === 'now') return res.y[a.k] != null ? res.y[a.k] : null;
    if (a.t === 'play' && (a.k === 't2w' || a.k === 't1w')) {
      var endT = a.k === 't1w' ? 45 : 200, tot = a.k === 't1w' ? (Array.isArray(ht) ? ht[0] + ht[1] : null) : FT;
      if (tot == null) return null;
      if (tot === G) return 0;
      if (!mins) return null;
      return mins.some(function (mm) { return mm > rec.min && mm <= a.at; }) ? 'skip' : (mins.some(function (mm) { return mm > a.at && mm <= endT; }) ? 1 : 0);
    }
    if (a.t === 'play') return a.k.indexOf('t1') === 0 ? (res.y.h1 != null ? res.y.h1 : null) : res.y.n1;
    if (a.t === '2h' || a.t === 'step2h') {
      if (!Array.isArray(ht)) return null;
      var HT = ht[0] + ht[1];
      if (HT > G) return 'skip'; /* il punteggio è cambiato prima dell'intervallo: il piano 2° tempo non si gioca */
      if (FT === HT) return 0;
      if (a.t === '2h') return 1;
      var e2 = mins ? mins.filter(function (mm) { return mm > 45 && mm <= a.t1; }).length : null;
      return e2 == null ? 1 : e2 > 0 ? 1 : 2;
    }
    if (FT === G) return a.t === 'wait' ? 0 : 0;
    var early = after(a.t1);
    if (early == null) return a.t === 'step' ? 1 : null; /* step: almeno un gol = uno dei due step vinto */
    if (a.t === 'step') return early > 0 ? 1 : 2; /* 1 = vinto allo step 1, 2 = vinto allo step 2 */
    return early > 0 ? 'skip' : 1; /* aspetta: se il gol arriva prima, non si gioca */
  });
  return res;
}
function tipLiveLogPanel() {
  var fromL = tipStatsFrom(), L = (((db.predModel || {}).liveLog) || []).filter(function (x) { return (x.at || 0) >= fromL; });
  if (!L.length) return '';
  var done = L.filter(function (x) { return x.res; });
  var row = function (label, arr) {
    var n = arr.length;
    if (!n) return '<tr><th>' + label + '</th><td>0</td><td>—</td><td>—</td></tr>';
    var pp = arr.reduce(function (s2, a) { return s2 + a.p; }, 0) / n, w = arr.filter(function (a) { return a.y; }).length;
    return '<tr><th>' + label + '</th><td>' + n + '</td><td>' + Math.round(pp * 100) + '%</td><td class="' + (w / n >= pp - 0.03 ? 'positive' : 'negative') + '">' + Math.round(w / n * 100) + '%</td></tr>';
  };
  var pick = function (fn) {
    var out = [];
    done.forEach(function (x) { (x.adv || []).forEach(function (a, i) { var y = x.res.adv && x.res.adv[i]; if (fn(a) && y != null && y !== 'skip') out.push({ p: a.p, y: y ? 1 : 0 }); }); });
    return out;
  };
  var mk = function (k) { var out = []; done.forEach(function (x) { if (x.P && x.P[k] != null && x.res.y && x.res.y[k] != null) out.push({ p: x.P[k], y: x.res.y[k] }); }); return out; };
  return '<section class="card diary-card tip-markets"><h2>Live: consigli e risultati</h2><p class="muted">' + L.length + ' valutazioni · ' + done.length + ' con esito</p>' +
    '<table class="tip-caltab"><tr><th></th><th>n</th><th>Previsto</th><th>Reale</th></tr>' +
    Object.keys(TIP_PLAY_NAME).filter(tipKindActive).map(function (k) { return row(TIP_PLAY_SHORT[k] + ' (ottime)', pick(function (a) { return a.t === 'play' && a.k === k; })); }).join('') +
    row('Consiglio: gioca ora', pick(function (a) { return a.t === 'now'; })) +
    row('Consiglio: a step', pick(function (a) { return a.t === 'step'; })) +
    row('Consiglio: aspetta', pick(function (a) { return a.t === 'wait'; })) +
    row('Piano 2° tempo', pick(function (a) { return a.t === '2h' || a.t === 'step2h'; })) +
    row('Gol 1° tempo (tutte)', mk('h1')) + row('Altro gol finale (tutte)', mk('n1')) + row('Gol entro il 70’', mk('w70')) +
    '</table><div class="actions"><button type="button" data-live-export>Esporta traccia live</button></div></section>';
}
function tipLiveMinQ() {
  var v = NaN;
  try { v = Number(localStorage.getItem('tipMinQ')); } catch (e) { /* ok */ }
  return Math.max(TIP_MIN_ODDS, isFinite(v) && v > 1 ? v : TIP_MIN_ODDS);
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
/* 3.48.0 — ogni scansione salva le statistiche di tutte le partite: dopo 5 minuti c'è l'andamento recente
   (modello completo) anche senza aprire la partita. Una sola scrittura per scansione. */
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
function tipLiveSheet(id, obj) {
  var m = obj || (db.predictions || []).find(function (x) { return x.id === id; });
  if (!m) return;
  var d0 = (tipUI.liveData || {})[m.id] || {},
    st0 = d0.stats || {},
    sd0 = st0.side || [{}, {}];
  var cell = function (k, i, v, step) {
    return '<input type="number" min="0" ' + (step ? 'step="' + step + '" inputmode="decimal"' : 'inputmode="numeric"') + ' data-ips="' + k + '" data-side="' + i + '" value="' + (v != null ? v : '') + '" aria-label="' + k + '">';
  };
  var row = function (k, label, step) {
    return '<span>' + label + '</span>' + cell(k, 0, sd0[0] && sd0[0][k], step) + cell(k, 1, sd0[1] && sd0[1][k], step);
  };
  var half0 = d0.status === '2H' || d0.status === 'HT' || (d0.elapsed || 0) > 46 ? 2 : 1;
  var html =
    sheetHead(m.home + ' – ' + m.away, { sub: U.esc(m.league) + ' · ' + U.esc(tipDayLabel(m.date)) + ' ' + U.esc(m.time) }) +
    '<div class="tip-form">' +
    '<div class="tip-ltop"><button type="button" class="tip-live-get" data-ip-sync>📡 Sincronizza</button>' +
    '<button type="button" class="tip-starbtn' + (tipIsStar(m) ? ' on' : '') + '" data-sheet-star aria-label="Preferita">' + (tipIsStar(m) ? '★' : '☆') + '</button></div>' +
    '<div id="tip-ip-out" class="tip-live-out"></div>' +
    (m.scan ? '' : '<button type="button" class="tip-ctx-btn" data-ctx-open>🧭 Contesto squadre' + tipCtxBadge(m) + ' ›</button>') +
    '<details class="tip-ipdata"' + (d0.at ? '' : ' open') + '><summary>Dati live (correggili se serve)</summary>' +
    '<div class="tip-live">' +
    '<label>Minuto<input type="number" min="0" inputmode="numeric" data-ip="min" value="' + (d0.elapsed != null ? d0.elapsed : '') + '"></label>' +
    '<label>Tempo<select data-ip="half"><option value="1"' + (half0 === 1 ? ' selected' : '') + '>1°</option><option value="2"' + (half0 === 2 ? ' selected' : '') + '>2°</option></select></label>' +
    '<label>Gol ' + U.esc(m.home) + '<input type="number" min="0" inputmode="numeric" data-ip="gh" value="' + (d0.goals ? d0.goals[0] : '') + '"></label>' +
    '<label>Gol ' + U.esc(m.away) + '<input type="number" min="0" inputmode="numeric" data-ip="ga" value="' + (d0.goals ? d0.goals[1] : '') + '"></label>' +
    '<label>Ultimo gol al minuto<input type="number" min="0" inputmode="numeric" data-ip="lg" value="' + (d0.lastGoal != null ? d0.lastGoal : '') + '"></label>' +
    '</div>' +
    '<div class="tip-ipgrid"><span></span><b>' + U.esc(m.home) + '</b><b>' + U.esc(m.away) + '</b>' +
    row('s', 'Tiri') + row('t', 'In porta') + row('b', 'In area') + row('c', 'Angoli') + row('xg', 'xG', '0.01') + row('poss', 'Possesso %') + row('red', 'Espulsi') +
    '</div></details>' +
    '</div>';
  var dlg = sheetModal(html);
  dlg.classList.add('tip-dlg');
  var q = {};
  var read = function () {
    var v = { side: [{}, {}] };
    dlg.querySelectorAll('[data-ip]').forEach(function (el) {
      if (el.value === '') return;
      var n = Number(String(el.value).replace(',', '.'));
      if (isFinite(n)) v[el.dataset.ip] = n;
    });
    dlg.querySelectorAll('[data-ips]').forEach(function (el) {
      if (el.value === '') return;
      var n = Number(String(el.value).replace(',', '.'));
      if (isFinite(n)) v.side[+el.dataset.side][el.dataset.ips] = n;
    });
    if (U.finite(v.lg) && U.finite(v.min) && v.min - v.lg >= 0 && v.min - v.lg <= 5) v.rg = true;
    if (U.finite(v.min)) {
      var pv = tipLivePrev(m.id, v.min, v.half || 1);
      if (pv) v.prev = pv;
    }
    return v;
  };
  var pct = function (x) { return Math.round(x * 100) + '%'; };
  var draw = function () {
    var v = read(),
      out = dlg.querySelector('#tip-ip-out');
    if (!U.finite(v.min)) {
      out.innerHTML = '<p class="muted">Tocca Sincronizza o scrivi minuto e punteggio in “Dati live”.</p>';
      return;
    }
    var r = tipInplay(m, v);
    var main = r.lines.find(function (x) { return x.k === (r.rem.ht > 0 ? 'h1' : 'n1'); }) || r.lines[0],
      qm = q[main.k], vText;
    var lik = main.p >= 0.75 ? ['PROBABILE', 'positive'] : main.p >= TIP_LIVE_MINP ? ['ABBASTANZA PROBABILE', 'positive'] : main.p >= 0.45 ? ['INCERTO', ''] : ['IMPROBABILE', 'negative'];
    var likHtml = '<div class="tip-iplik"><b class="' + lik[1] + '">' + lik[0] + '</b></div>';
    var gateM = tipLiveGate(m, r, v.min, v.half || (v.min > 46 ? 2 : 1), main.k);
    if (main.p < TIP_LIVE_MINP) {
      vText = '<b class="negative">NON GIOCARE</b><small>serve almeno il ' + Math.round(TIP_LIVE_MINP * 100) + '%</small>';
    } else if (gateM) {
      vText = '<b class="negative">NON GIOCARE</b><small>' + gateM + '</small>';
    } else if (U.finite(qm) && qm > 1) {
      var evm = (qm * main.p - 1) * 100;
      vText = qm >= tipNeedQ(main.fair)
        ? '<b class="positive">GIOCA a ' + qm.toFixed(2) + '</b><small>atteso ' + (evm >= 0 ? '+' : '') + evm.toFixed(1) + '% · quota minima ' + tipNeedQ(main.fair).toFixed(2) + '</small>'
        : '<b class="negative">NON GIOCARE a ' + qm.toFixed(2) + '</b><small>serve almeno ' + tipNeedQ(main.fair).toFixed(2) + '</small>';
    } else if (main.fair && main.fair < tipLiveMinQ()) vText = '<b>Quota giusta ' + main.fair.toFixed(2) + ': sotto la tua soglia ' + tipLiveMinQ().toFixed(2) + '</b><small>guarda “Cosa fare”</small>';
    else vText = '<b>Gioca da quota ' + (main.fair ? main.fair.toFixed(2) : '—') + ' in su</b>';
    var mainHtml =
      '<div class="tip-ipmain"><div class="tip-ipmain-h"><span>Prossimo gol ' + (r.rem.ht > 0 ? 'nel 1° tempo' : 'entro la fine') + '</span><small>' + U.esc(main.label) + '</small></div>' +
      '<div class="tip-ipmain-b"><strong>' + pct(main.p) + '</strong><input type="number" min="1" step="0.01" inputmode="decimal" placeholder="quota" data-iq="' + main.k + '" value="' + (U.finite(qm) ? qm : '') + '"></div>' +
      likHtml + '<div class="tip-ipmain-v">' + vText + '</div></div>';
    /* C'è ancora valore? confronto con come la prezza il book (quote prepartita + punteggio + espulsioni) */
    var rb = tipInplay(m, v, true),
      c0 = tipCalc(m, tipParams()),
      cand = r.lines.filter(function (x) { return ['n1', 'n2', 'h1', 'gg'].indexOf(x.k) >= 0 && x.p >= TIP_LIVE_MINP && x.p <= 0.97; }).map(function (x) {
        var b = rb.lines.find(function (y) { return y.k === x.k; }),
          real = U.finite(q[x.k]) && q[x.k] > 1,
          odd = real ? q[x.k] : (b && b.p > 0 ? Math.max(1.01, 1 / Math.min(0.99, b.p * TIP_LIVE_MARGIN)) : null);
        return { x: x, odd: odd, real: real, ev: odd && odd >= tipNeedQ(0) ? x.p * odd - 1 : -1 }; /* sotto la quota minima (1.50) non si gioca */
      }).sort(function (a, b) { return (b.ev - (b.x.k === 'gg' ? 0.04 : 0)) - (a.ev - (a.x.k === 'gg' ? 0.04 : 0)); }),
      best = cand[0],
      pace = r.F >= 1.08 ? 'più viva' : r.F <= 0.92 ? 'più bloccata' : 'come previsto',
      vc, vh, vb;
    var likW = function (p) { return p >= 0.75 ? 'PROBABILE' : p >= TIP_LIVE_MINP ? 'abbastanza probabile' : p >= 0.45 ? 'incerto' : 'IMPROBABILE'; },
      nameOf = { h1: 'Gol prima dell’intervallo', n1: 'Un altro gol entro la fine', n2: 'Altri due gol entro la fine', gg: 'Segnano entrambe' },
      summary = '<ul class="tip-ipsum">' + ['h1', 'n1', 'n2'].map(function (k) { return r.lines.find(function (x) { return x.k === k; }); }).filter(Boolean).map(function (x) {
        return '<li><span>' + nameOf[x.k] + '</span><b class="' + (x.p >= TIP_LIVE_MINP ? 'positive' : x.p < 0.45 ? 'negative' : '') + '">' + likW(x.p) + ' · ' + pct(x.p) + '</b></li>';
      }).join('') + '</ul>',
      top = r.lines.filter(function (x) { return ['h1', 'n1'].indexOf(x.k) >= 0; }).sort(function (a, b) { return b.p - a.p; })[0] || r.lines[0];
    if (!best) {
      vc = 'no';
      vh = top.p < 0.45 ? 'NO: è improbabile che segnino' : 'NO: troppo incerto';
      vb = '';
    } else if (!r.used && !best.real) { vc = 'mid'; vh = 'Probabile gol, ma senza statistiche'; vb = 'Tocca Sincronizza per le statistiche.'; }
    else if (best.ev >= 0.05 && !best.real) { vc = 'mid'; vh = 'Segneranno probabilmente: controlla la quota'; vb = '<b>' + U.esc(nameOf[best.x.k] || best.x.label) + '</b> (' + U.esc(best.x.label) + '): gioca da quota <b>' + best.x.fair.toFixed(2) + '</b> in su.'; }
    else if (best.ev >= 0.05) { vc = 'yes'; vh = 'SÌ, gioca'; vb = '<b>' + U.esc(nameOf[best.x.k] || best.x.label) + '</b> (' + U.esc(best.x.label) + ') a ' + best.odd.toFixed(2) + ' (minima ' + best.x.fair.toFixed(2) + ').'; }
    else if (best.ev >= 0) { vc = 'mid'; vh = 'Probabile, ma quota al limite'; vb = '<b>' + U.esc(nameOf[best.x.k] || best.x.label) + '</b>: ' + pct(best.x.p) + '. Ha senso solo da quota ' + (best.x.fair * 1.05).toFixed(2) + ' in su.'; }
    else {
      vc = 'no'; vh = 'Probabile gol, ma quota troppo bassa';
      vb = '<b>' + U.esc(nameOf[best.x.k] || best.x.label) + '</b>: serve almeno quota ' + tipNeedQ(best.x.fair).toFixed(2) + '.';
    }
    var h1l = r.lines.find(function (x) { return x.k === 'h1'; });
    var plan = (v.gh || 0) + (v.ga || 0) === 0 && v.min >= 25 && v.min <= 38 && h1l
      ? (vc === 'no' ? ' 2° step del piano: saltalo.' : ' 2° step del piano: da quota ' + h1l.fair.toFixed(2) + '.')
      : '';
    var preTxt = 'Prepartita 1T ' + Math.round(c0.ht05) + '% · O1.5 ' + Math.round(c0.o15) + '% · ritmo ' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%.';
    var valHtml = '<div class="tip-ipval tip-ipval-' + vc + '"><div class="tip-ipval-h"><small>Conviene giocare ancora su questa partita?</small><b>' + vh + '</b></div>' + summary + (vb ? '<p>' + vb + '</p>' : '') + '<small>' + preTxt + plan + '</small></div>';
    /* perché: i fattori che spostano di più, per squadra */
    var why = r.teams.map(function (t, i) {
      var nm = i === 0 ? m.home : m.away,
        ps = t.parts.filter(function (x) { return x.k !== 'fav' && Math.abs(x.v) >= 0.02; }).sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); }).slice(0, 4),
        rest = Math.log(t.mult) - ps.reduce(function (s, x) { return s + x.v; }, 0);
      if (Math.abs(rest) >= 0.02) ps.push({ k: 'altro', v: rest });
      return '<div class="tip-ipwhy-t"><b>' + U.esc(nm) + ' ' + (t.mult >= 1 ? '+' : '') + Math.round((t.mult - 1) * 100) + '%</b>' +
        (ps.length ? ps.map(function (x) { return '<span class="' + (x.v > 0 ? 'positive' : 'negative') + '">' + U.esc(TIP_LM_LABEL[x.k] || x.k) + ' ' + (x.v > 0 ? '+' : '') + Math.round((Math.exp(x.v) - 1) * 100) + '%</span>'; }).join('') : '<span class="muted">niente di rilevante</span>') + '</div>';
    }).join('');
    var mdl = { full: 'statistiche + xG + momento', norec: 'statistiche + xG', noxg: 'statistiche + momento (senza xG)', basic: 'statistiche (senza xG)', book: 'solo minuto e punteggio' }[r.model];
    /* 3.21.0 — giocata a step: step 1 ora, step 2 solo se non hanno ancora segnato */
    var sc = tipUI.step = tipUI.step || { s1: 10, s2: 20 },
      stepOpts = r.lines.filter(function (x) { return x.win || x.k === 'h1' || x.k === 'n1'; }),
      tOf = function (x) { return x.k === 'h1' ? 45 : x.k === 'n1' ? 95 : x.t2; };
    stepOpts.sort(function (a2, b2) { return tOf(a2) - tOf(b2); });
    var stepHtml = '';
    if (stepOpts.length >= 2) {
      var A = stepOpts.find(function (x) { return x.k === sc.a; }) || stepOpts.find(function (x) { return x.k === 'w70'; }) || stepOpts[0];
      var laterOpts = stepOpts.filter(function (x) { return tOf(x) > tOf(A); });
      var B = laterOpts.find(function (x) { return x.k === sc.b; }) || laterOpts[laterOpts.length - 1];
      var p2 = 1 - (1 - B.p) / Math.max(1e-6, 1 - A.p), f2 = p2 > 0.001 ? 1 / p2 : null,
        any = 1 - (1 - A.p) * (1 - p2), q1 = sc.q1, q2 = sc.q2;
      var opt = function (list, sel, key) { return '<select data-st="' + key + '">' + list.map(function (x) { return '<option value="' + x.k + '"' + (x.k === sel.k ? ' selected' : '') + '>' + (x.k === 'h1' ? 'entro l’intervallo' : x.k === 'n1' ? 'entro la fine' : 'entro il ' + x.t2 + '’') + '</option>'; }).join('') + '</select>'; };
      var ok = function (q, f) { return U.finite(q) && q > 1 ? (q >= tipNeedQ(f) ? '<em class="positive">ok</em>' : '<em class="negative">quota bassa</em>') : (f && f < TIP_MIN_ODDS ? '<em class="negative">sotto 1.50</em>' : ''); };
      var money = '';
      if (U.finite(q1) && q1 > 1 && U.finite(q2) && q2 > 1) {
        var ev = A.p * sc.s1 * (q1 - 1) + (1 - A.p) * (-sc.s1 + p2 * sc.s2 * (q2 - 1) - (1 - p2) * sc.s2);
        money = '<p class="tip-stepm">Vinci al 1° step <b class="positive">+' + (sc.s1 * (q1 - 1)).toFixed(2) + '€</b> · al 2° <b class="positive">+' + (sc.s2 * (q2 - 1) - sc.s1).toFixed(2) + '€</b> · persi entrambi <b class="negative">−' + (sc.s1 + sc.s2).toFixed(2) + '€</b> · atteso <b class="' + (ev >= 0 ? 'positive' : 'negative') + '">' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '€</b></p>';
      }
      stepHtml = '<details class="tip-step"' + (sc.open ? ' open' : '') + '><summary>Gioca a step · almeno uno ' + pct(any) + '</summary>' +
        '<div class="tip-steprow"><span>1 · gol ' + opt(stepOpts.slice(0, -1).length ? stepOpts.slice(0, -1) : stepOpts, A, 'a') + '<small>' + pct(A.p) + ' · min ' + A.fair.toFixed(2) + ' ' + ok(q1, A.fair) + '</small></span><input type="number" inputmode="decimal" min="0" step="1" data-st="s1" value="' + sc.s1 + '" aria-label="Euro step 1"><input type="number" inputmode="decimal" min="1" step="0.01" placeholder="quota" data-st="q1" value="' + (U.finite(q1) ? q1 : '') + '"></div>' +
        '<div class="tip-steprow"><span>2 · se ancora 0 gol, gol ' + opt(laterOpts, B, 'b') + '<small>' + pct(p2) + ' · min ' + (f2 ? f2.toFixed(2) : '—') + ' (quota da controllare in quel momento) ' + ok(q2, f2) + '</small></span><input type="number" inputmode="decimal" min="0" step="1" data-st="s2" value="' + sc.s2 + '" aria-label="Euro step 2"><input type="number" inputmode="decimal" min="1" step="0.01" placeholder="quota" data-st="q2" value="' + (U.finite(q2) ? q2 : '') + '"></div>' +
        money + '</details>';
    }
    /* 3.24.0 — "Cosa fare": per il 1° tempo (se si è ancora presto) e per la fine partita.
       Niente quote da scrivere: l'app dice se la quota giusta è già ≥ 1.50 (gioca ora)
       oppure come arrivarci (a step o aspettando), o se lasciar stare. */
    var MINQ = tipLiveMinQ(), adv = [];
    /* 3.27.0 — quota del book per "altro gol entro la fine" (Over punteggio+0.5), se la funzione la trova */
    var ldat = (tipUI.liveData || {})[m.id] || {}, Gn = (v.gh || 0) + (v.ga || 0), bookN1 = null, bookSure = false;
    if (ldat.ou && Number(ldat.elapsed) === v.min) {
      var ln = (Gn + 0.5).toFixed(1), prevL = Gn > 0 ? ldat.ou[(Gn - 0.5).toFixed(1)] : null;
      var stale = prevL && prevL.o > 1.01; /* una linea già vinta ancora quotata = quote prepartita, non live */
      if (!stale && ldat.ou[ln] && ldat.ou[ln].o > 1) { bookN1 = ldat.ou[ln].o; bookSure = Gn > 0; }
    }
    var planFor = function (x, endName, tmax, kind) {
      var lik = x.p >= 0.75 ? 'PROBABILE' : x.p >= TIP_LIVE_MINP ? 'abbastanza probabile' : x.p >= 0.45 ? 'incerto' : 'IMPROBABILE';
      var head = '<div class="tip-do-h"><b>' + endName + '</b><span class="' + (x.p >= TIP_LIVE_MINP ? 'positive' : x.p < 0.45 ? 'negative' : '') + '">' + lik + ' · ' + pct(x.p) + '</span></div>';
      if (x.p < TIP_LIVE_MINP) return head + '<p class="tip-do-v negative">NO · ' + (x.p < 0.45 ? 'è più facile che non segnino' : 'troppo incerto') + '</p>';
      var gate = tipLiveGate(m, r, v.min, v.half || (v.min > 46 ? 2 : 1), kind);
      if (gate) return head + '<p class="tip-do-v negative">NO · ' + gate + '</p>';
      var bk = kind === 'n1' ? bookN1 : null, bkTxt = bk ? ' · book ' + bk.toFixed(2) + (bookSure ? '' : ' (verifica che sia live)') : '';
      if (bk) {
        /* confronto: cosa pensa il book (quota, tolto l'aggio) e cosa dicono statistiche + prepartita */
        var pb = Math.min(0.99, 1 / (bk * 1.05)), dlt = x.p - pb;
        head += '<p class="tip-do-cmp">Book ' + pct(pb) + ' · modello ' + pct(x.p) + ' · ' +
          (dlt >= 0.05 ? '<b class="positive">le statistiche vedono più gol del book: valore</b>' : dlt <= -0.05 ? '<b class="negative">il book vede più gol delle statistiche: niente valore</b>' : 'd’accordo') + '</p>';
      }
      var cond = function (t1) { return 1 - (1 - x.p) / Math.max(1e-6, 1 - r.pWin(t1)); };
      /* 3.31.0 — "gioca ora" solo se è solido: margine sulla soglia del 60% e sulla quota, e se fra 5 minuti
         senza gol resterebbe ancora sopra il 60% (così non diventa "aspetta" tre minuti dopo) */
      var pNext = v.min + 5 < tmax ? cond(v.min + 5) : 0;
      var solid = x.p >= TIP_LIVE_MINP + 0.04 && pNext >= TIP_LIVE_MINP && (bk ? bk >= Math.max(MINQ, x.fair * 1.03) : x.fair >= MINQ * 1.05);
      if (solid) {
        adv.push({ t: 'now', k: x.k, p: x.p, q: x.fair, book: bk || undefined });
        return head + '<p class="tip-do-v positive">GIOCA ORA · quota già buona (giusta ' + x.fair.toFixed(2) + ')' + (bk ? ' · book ' + bk.toFixed(2) + ' ✓' : '') + '</p>';
      }
      if (x.fair >= MINQ && bk && bk < Math.max(MINQ, x.fair * 1.03)) head += '<p class="tip-do-v negative">Ora no: book ' + bk.toFixed(2) + ' sotto la minima ' + Math.max(MINQ, x.fair * 1.03).toFixed(2) + '</p>';
      else if (x.fair >= MINQ) head += '<p class="tip-do-v">Ci sta, ma ora è al limite (giusta ' + x.fair.toFixed(2) + (pNext < TIP_LIVE_MINP ? ', fra 5 minuti senza gol scende al ' + pct(pNext) : '') + '): meglio prenderlo a quota più alta</p>';
      var lines = [], stepLi = null, waitLi = null;
      var st1 = null, bestMin = 0;
      for (var t1 = Math.ceil((v.min + 5) / 5) * 5; t1 <= tmax - 5; t1 += 5) {
        var pw = r.pWin(t1), pc2 = cond(t1);
        if (pw < 0.45 || pc2 < 0.45) continue; /* ogni step deve avere almeno il 45% */
        var lo = Math.min(1 / pw, 1 / pc2);
        if (lo >= MINQ && lo > bestMin) { bestMin = lo; st1 = { t: t1, p: pw, p2: pc2 }; }
      }
      if (st1) {
        adv.push({ t: 'step', k: x.k, t1: st1.t, p1: st1.p, p2: st1.p2, q1: 1 / st1.p, q2: 1 / st1.p2, p: x.p });
        stepLi = ('<li><b>A step</b>: gol entro il ' + st1.t + '’ (' + pct(st1.p) + ', quota ≥ ' + Math.max(MINQ, 1 / st1.p).toFixed(2) + '), se no ' + (kind === 'h1' ? 'gol entro l’intervallo' : 'gol entro la fine') + ' (' + pct(st1.p2) + ', quota ≥ ' + Math.max(MINQ, 1 / st1.p2).toFixed(2) + ')</li>');
        lines.push(stepLi);
      }
      var wt = null;
      /* aspetta fino a quando il "gioca" sarà solido (stesso criterio di "gioca ora"), non solo fino a quota 1.50 */
      for (var t2 = Math.ceil(v.min) + 2; t2 <= tmax - 8; t2++) {
        var pc = cond(t2), pn2 = cond(t2 + 5);
        if (pc > 0 && 1 / pc >= MINQ * 1.05) { if (pc >= TIP_LIVE_MINP + 0.04 && pn2 >= TIP_LIVE_MINP) wt = { t: t2, p: pc }; break; }
      }
      if (wt && wt.p >= TIP_LIVE_MINP) {
        adv.push({ t: 'wait', k: x.k, t1: wt.t, p: wt.p, q: 1 / wt.p });
        waitLi = '<li><b>Aspetta il ' + wt.t + '’</b>: se ancora nessun gol, ' + pct(wt.p) + ' a quota ≥ ' + Math.max(MINQ, 1 / wt.p).toFixed(2) + ' · poi risincronizza</li>';
        lines.push(waitLi);
      }
      if (!lines.length) return head + (x.fair >= MINQ ? '<p class="tip-do-v">Se vuoi giocarlo ora: solo da quota ' + Math.max(MINQ, x.fair * 1.08).toFixed(2) + ' in su</p>' : '<p class="tip-do-v negative">NO · quota giusta solo ' + x.fair.toFixed(2) + ' e non si arriva a ' + MINQ.toFixed(2) + ' né a step né aspettando</p>');
      /* 3.28.0 — quale conviene per QUESTA partita: se spinge lo step (il gol può arrivare presto),
         altrimenti aspettare (se non segnano la quota sale e rivaluti con dati nuovi) */
      if (stepLi && waitLi) {
        var push = r.used && r.F >= 1.08;
        lines = push ? [stepLi.replace('<li>', '<li class="tip-rec">★ '), waitLi] : [waitLi.replace('<li>', '<li class="tip-rec">★ '), stepLi];
        lines.push('<li class="muted">' + (push ? 'Consigliato lo step: la partita spinge (ritmo +' + Math.round((r.F - 1) * 100) + '%), il gol può arrivare presto.' : 'Consigliato aspettare: ritmo ' + (r.used ? (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%' : 'non misurato') + ', se non segnano la quota sale e rivaluti con dati nuovi.') + '</li>');
      } else if (lines.length === 1) lines[0] = lines[0].replace('<li>', '<li class="tip-rec">★ ');
      /* 3.32.0 — una sola indicazione chiara: la consigliata; le altre in una riga piccola */
      var plain = function (h) { return h.replace(/<li[^>]*>/, '').replace('</li>', '').replace('★ ', ''); };
      var main1 = lines.filter(function (l) { return l.indexOf('class="muted"') < 0; });
      var why1 = lines.filter(function (l) { return l.indexOf('class="muted"') >= 0; }).map(plain).join(' ');
      if (main1.length) return head + (x.fair < MINQ ? '<p class="tip-do-q">Ora la quota è troppo bassa (giusta ' + x.fair.toFixed(2) + bkTxt + ').</p>' : '') +
        '<p class="tip-do-v tip-do-go">→ ' + plain(main1[0]) + '</p>' +
        (main1[1] ? '<p class="tip-do-alt">oppure: ' + plain(main1[1]) + '</p>' : '') + (why1 ? '<p class="tip-do-alt">' + why1 + '</p>' : '');
      return head + (x.fair >= MINQ ? '<p class="tip-do-v">Meglio:</p>' : '<p class="tip-do-v">Ora quota troppo bassa (giusta ' + x.fair.toFixed(2) + bkTxt + '). Puoi:</p>') + '<ul>' + lines.join('') + '</ul>';
    };
    var blocks = [];
    var hOne = r.lines.find(function (x) { return x.k === 'h1'; }), nOne = r.lines.find(function (x) { return x.k === 'n1'; });
    if (hOne && v.min <= 40) blocks.push(planFor(hOne, 'Gol entro l’intervallo', 45, 'h1'));
    if (nOne && v.min < 88) blocks.push(planFor(nOne, 'Altro gol entro la fine', 88, 'n1'));
    /* 3.26.0 — dal 25' del 1° tempo: piccola prova sul gol prima dell'intervallo se la partita è viva,
       poi piano a step nel 2° tempo se all'intervallo il punteggio non è cambiato */
    var halfNow = v.half || (v.min > 46 ? 2 : 1);
    if (halfNow === 1 && v.min >= 25 && v.min <= 44 && hOne && nOne) {
      var ph = hOne.p, live = r.used && r.F >= 1.08, gateN = tipLiveGate(m, r, v.min, 1, 'n1');
      var h2Any = 1 - (1 - nOne.p) / Math.max(1e-6, 1 - ph); /* almeno un gol nel 2° tempo se all'intervallo nulla è cambiato */
      var pIn = function (t) { return 1 - (1 - r.pWin(t)) / Math.max(1e-6, 1 - ph); }; /* gol tra 46' e t, se 0 gol fino all'intervallo */
      var best2 = null, bm = 0;
      for (var tt = 55; tt <= 80; tt += 5) {
        var a1 = pIn(tt), b1 = 1 - (1 - h2Any) / Math.max(1e-6, 1 - a1);
        if (a1 < 0.05 || b1 < 0.05) continue;
        var lo2 = Math.min(1 / a1, 1 / b1);
        if (lo2 >= MINQ && lo2 > bm) { bm = lo2; best2 = { t: tt, a: a1, b: b1 }; }
      }
      var li = [];
      if (live && ph >= 0.4 && 1 / ph >= MINQ) adv.push({ t: 'now', k: 'h1', p: ph, q: 1 / ph, small: true });
      if (live && ph >= 0.4 && 1 / ph >= MINQ) li.push('<li><b>Prova piccola</b> (pochi euro) sul gol prima dell’intervallo: ' + pct(ph) + ' · quota ≥ ' + Math.max(MINQ, 1 / ph).toFixed(2) + ' · la partita spinge' + (ph < 0.5 ? ', ma è meno di 1 su 2' : '') + '</li>');
      else if (ph >= 0.4 && 1 / ph >= MINQ) li.push('<li class="muted">Gol prima dell’intervallo ' + pct(ph) + ': la partita non spinge abbastanza per provarci</li>');
      if (!gateN && h2Any >= TIP_LIVE_MINP && 1 / h2Any >= MINQ) adv.push({ t: '2h', p: h2Any, q: 1 / h2Any });
      else if (!gateN && h2Any >= TIP_LIVE_MINP && best2) adv.push({ t: 'step2h', t1: best2.t, p1: best2.a, p2: best2.b, p: h2Any });
      if (gateN) li.push('<li class="muted">2° tempo: ' + gateN + '</li>');
      else if (h2Any < TIP_LIVE_MINP) li.push('<li class="muted">2° tempo: gol solo al ' + pct(h2Any) + ', non abbastanza</li>');
      else if (1 / h2Any >= MINQ) li.push('<li><b>2° tempo</b>, se all’intervallo il punteggio non cambia: gol nel 2° tempo ' + pct(h2Any) + ' · quota ≥ ' + Math.max(MINQ, 1 / h2Any).toFixed(2) + ' · rivaluta al 46’</li>');
      else if (best2) li.push('<li><b>2° tempo a step</b>, se all’intervallo il punteggio non cambia: dal 46’ gol entro il ' + best2.t + '’ (' + pct(best2.a) + ', quota ≥ ' + Math.max(MINQ, 1 / best2.a).toFixed(2) + '), se no entro la fine (' + pct(best2.b) + ', quota ≥ ' + Math.max(MINQ, 1 / best2.b).toFixed(2) + ') · almeno uno ' + pct(h2Any) + ' · rivaluta al 46’</li>');
      else li.push('<li class="muted">2° tempo: gol ' + pct(h2Any) + ' ma a ' + MINQ.toFixed(2) + ' non si arriva neanche a step</li>');
      blocks.push('<div class="tip-do-h"><b>Piano 1° tempo + 2° tempo</b></div><ul>' + li.join('') + '</ul>');
    }
    var preTxt2 = 'Prepartita 1T ' + Math.round(c0.ht05) + '% · O1.5 ' + Math.round(c0.o15) + '% · ritmo ' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%';
    var doHtml = '<div class="tip-do"><div class="tip-strat-h"><b>Cosa fare</b><label>quota da <input type="number" inputmode="decimal" step="0.05" min="1.5" data-minq value="' + MINQ.toFixed(2) + '"></label></div>' +
      blocks.map(function (h) { return '<div class="tip-do-b">' + h + '</div>'; }).join('') +
      '<small>Quote minime: se il book paga meno, non giocare.</small></div>';
    /* 3.23.0 — traccia delle valutazioni live (per controllo e retraining): solo con dati sincronizzati */
    var dl = (tipUI.liveData || {})[m.id];
    /* 3.33.0 — "Giocate": i tipi di giocata disponibili adesso, con la probabilità di riuscita,
       in verde quelli ottimi per questo minuto, in ordine */
    var halfV = v.half || (v.min > 46 ? 2 : 1), ctxV = { min: v.min, half: halfV, gh: v.gh || 0, ga: v.ga || 0 };
    var plays = tipPlays(r, v.min, halfV, bookN1 && bookSure ? { n1: bookN1 } : null);
    if (dl && dl.elapsed != null && Number(dl.elapsed) === v.min) tipPlayLogAdd(m, ctxV, plays);
    var logged = tipPlayFind(m.id, ctxV), baseSt = (tipUI.step && tipUI.step.s1) || 10;
    adv = plays.filter(function (x) { return x.green; }).map(function (x) { return { t: 'play', k: x.k, p: x.p, at: x.at, legs: x.legs.map(function (l) { return Math.round(l.p * 1000) / 1000; }) }; });
    /* 3.58.0 — Valuta una quota: scrivi la quota del book, la stima unisce statistiche e prezzo del book */
    var qv = tipUI.qv = tipUI.qv || { k: 'n1', q: '' };
    var qLines = r.lines.filter(function (x) { return x.k === 'n1' || x.k === 'h1' || x.k === 'n2' || x.k === 'gg'; });
    if (!qLines.some(function (x) { return x.k === qv.k; })) qv.k = qLines[0] ? qLines[0].k : 'n1';
    var qL = qLines.find(function (x) { return x.k === qv.k; }), qq = Number(String(qv.q).replace(',', '.')), qvHtml = '';
    if (qL) {
      var lg = function (p) { p = Math.min(0.99, Math.max(0.01, p)); return Math.log(p / (1 - p)); }, il = function (z) { return 1 / (1 + Math.exp(-z)); };
      var res = '';
      if (qq > 1) {
        var pb = Math.min(0.97, 1 / (qq * 1.05)), pc = il(0.5 * lg(qL.p) + 0.5 * lg(pb)), ev = pc * qq - 1;
        var verdict = ev >= 0.03 && qq >= TIP_MIN_ODDS ? ['positive', 'CONVIENE · valore ' + (ev * 100).toFixed(0) + '%'] : ev >= -0.02 ? ['tip-amber-text', 'AL LIMITE · valore ' + (ev * 100).toFixed(0) + '%'] : ['negative', 'NON CONVIENE · valore ' + (ev * 100).toFixed(0) + '%'];
        res = '<div class="tip-qvres"><span><small>Statistiche</small><b>' + pct(qL.p) + '</b></span><span><small>Book</small><b>' + pct(pb) + '</b></span><span><small>Stima</small><b>' + pct(pc) + '</b></span></div>' +
          '<p class="' + verdict[0] + ' tip-qvv">' + verdict[1] + '</p><small class="muted">Stima = metà statistiche live, metà quota del book (tolto il margine). Quota minima ' + Math.max(TIP_MIN_ODDS, 1 / pc).toFixed(2) + '.</small>';
      } else res = '<small class="muted">Statistiche ' + pct(qL.p) + ' · quota minima ' + Math.max(TIP_MIN_ODDS, 1 / qL.p).toFixed(2) + '. Scrivi la quota del book per la stima completa.</small>';
      qvHtml = '<div class="tip-qv"><div class="tip-do-h"><b>Valuta una quota</b></div><div class="tip-qvrow"><select data-qv-k>' + qLines.map(function (x) { return '<option value="' + x.k + '"' + (x.k === qv.k ? ' selected' : '') + '>' + U.esc(x.label) + '</option>'; }).join('') + '</select>' +
        '<input type="number" inputmode="decimal" step="0.01" min="1.01" placeholder="quota" data-qv-q value="' + U.esc(qv.q) + '"></div>' + res + '</div>';
    }
    doHtml = qvHtml + '<div class="tip-do"><div class="tip-do-h"><b>Giocate adesso</b><span class="muted">probabilità di riuscita</span></div>' +
      (logged && logged.k && !plays.some(function (x) { return x.k === logged.k && (x.green || x.warm); }) ? '<p class="tip-amber-text tip-prevplay">Con questo punteggio era già stata segnalata al ' + logged.min + '’: ' + U.esc(TIP_PLAY_SHORT[logged.k] || logged.k) + '. È la stessa scommessa: non raddoppiare.</p>' : '') +
      (plays.length ? plays.map(function (x, i) {
        return '<div class="tip-play' + (x.green ? ' tip-hot' : x.warm ? ' tip-warm' : '') + '"><div class="tip-play-h"><b>' + U.esc(x.name) + '</b><strong class="' + (x.green ? 'positive' : x.warm ? 'tip-amber-text' : '') + '">' + pct(x.p) + '</strong></div>' +
          '<small>' + x.legs.map(function (l) { return U.esc(l.l) + ' (' + pct(l.p) + ', quota ≥ ' + Math.max(TIP_MIN_ODDS, 1 / l.p).toFixed(2) + ')'; }).join(' → ') + '</small>' +
          '<small>' + (x.legs.length > 1 ? 'Puntate ' + x.cost.stakes.map(function (v2) { return Math.round(v2) + '€'; }).join(' → ') + ': rischi fino a ' + Math.round(x.cost.risk) + '€ per vincere ' + x.cost.win.toFixed(0) + '€' : 'Rischi ' + Math.round(x.cost.risk) + '€ per vincere ' + x.cost.win.toFixed(0) + '€') + (x.note ? ' · ' + U.esc(x.note) : '') + '</small>' +
          (x.alt ? '<small class="negative">' + U.esc(x.alt) + '</small>' : '') +
          '<small class="' + (x.green ? 'positive' : x.warm ? 'tip-amber-text' : 'muted') + '">' + U.esc(tipPlayDecision(r, v.min, halfV, x)) + '</small>' +
          (logged && logged.played && logged.played.k === x.k
            ? '<small class="tip-marked">✓ Giocata a ' + logged.played.q.toFixed(2) + ' · ' + logged.played.s + '€' + (logged.played.res === 1 ? ' · vinta' : logged.played.res === 0 ? ' · persa' : '') + '</small>'
            : (x.green || x.warm ? '<div class="tip-markrow" data-markrow="' + i + '"><button type="button" class="tip-mark" data-mark="' + i + '">L’ho giocata</button></div>' : '')) +
          '</div>';
      }).join('') : '<p class="muted">Nessun tipo di giocata disponibile adesso (troppo presto o troppo tardi, o quota sotto 1.50).</p>') +
      '<small>Quote minime: se il book paga meno, non giocare.</small></div>';
    if (dl && dl.elapsed != null && Number(dl.elapsed) === v.min && dl.goals && dl.goals[0] === (v.gh || 0) && dl.goals[1] === (v.ga || 0)) tipLiveLogSave(m, v, r, adv, q);
    tipUI.liveMore = tipUI.liveMore || false;
    out.innerHTML = doHtml + '<details class="tip-more2"' + (tipUI.liveMore ? ' open' : '') + '><summary>Dettagli e altri mercati</summary>' + mainHtml + stepHtml +
      '<div class="tip-probs"><div class="tip-prob"><small>Gol attesi da qui</small><b>' + r.L.toFixed(2) + '</b><i>' + U.esc(m.home.split(' ')[0]) + ' ' + r.rh.toFixed(2) + ' · ' + U.esc(m.away.split(' ')[0]) + ' ' + r.ra.toFixed(2) + '</i></div>' +
      '<div class="tip-prob"><small>Effetto live</small><b>' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%</b><i>' + mdl + '</i></div>' +
      '<div class="tip-prob"><small>Tempo rimasto</small><b>' + Math.round(r.rem.all * 100) + '%</b><i>dei gol della partita</i></div></div>' +
      '<details class="tip-ipwhy"><summary>Perché</summary>' + why + '</details>' +
      '<div class="tip-iplines">' +
      r.lines.filter(function (x) { return x.k !== main.k; }).map(function (x) {
        var qq = q[x.k], verdict = '';
        if (U.finite(qq) && qq > 1) {
          var ev = (qq * x.p - 1) * 100, good = ev > 0 && qq >= TIP_MIN_ODDS && x.p >= TIP_LIVE_MINP;
          verdict = '<em class="' + (good ? 'positive' : 'negative') + '">' + (good ? 'Conviene ' : qq < TIP_MIN_ODDS ? 'Sotto 1.50 ' : x.p < TIP_LIVE_MINP ? 'Troppo incerto ' : 'Non conviene ') + (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%</em>';
        }
        return '<div class="tip-ipline"><span><b>' + U.esc(x.label) + '</b><small>' + (x.sub ? U.esc(x.sub) + ' · ' : '') + 'quota minima ' + (x.fair ? x.fair.toFixed(2) : '—') + '</small>' + verdict + '</span><strong>' + pct(x.p) + '</strong>' +
          '<input type="number" min="1" step="0.01" inputmode="decimal" placeholder="quota" data-iq="' + x.k + '" value="' + (U.finite(qq) ? qq : '') + '"></div>';
      }).join('') +
      '</div><p class="muted tip-hint">' + preTxt2 + '</p></details>';
    var qk = out.querySelector('[data-qv-k]'), qi = out.querySelector('[data-qv-q]');
    if (qk) qk.onchange = function () { tipUI.qv.k = qk.value; draw(); };
    if (qi) qi.onchange = function () { tipUI.qv.q = qi.value; draw(); };
    out.querySelectorAll('[data-mark]').forEach(function (bt) {
      bt.onclick = function () {
        var x = plays[Number(bt.dataset.mark)], row = out.querySelector('[data-markrow="' + bt.dataset.mark + '"]');
        if (!x || !row) return;
        row.innerHTML = '<label>Quota<input type="number" inputmode="decimal" step="0.01" min="1.01" data-mq value="' + (x.book || x.minQ || 1.5).toFixed(2) + '"></label>' +
          '<label>' + (x.legs.length > 1 ? 'Euro 1° step' : 'Euro') + '<input type="number" inputmode="decimal" step="1" min="1" data-ms value="' + baseSt + '"></label><button type="button" class="tip-mark" data-msave>Salva</button>';
        row.querySelector('[data-msave]').onclick = function () {
          var qv = Number(String(row.querySelector('[data-mq]').value).replace(',', '.')), sv = Number(String(row.querySelector('[data-ms]').value).replace(',', '.'));
          if (!(qv > 1) || !(sv > 0)) { U.toast('Scrivi quota e puntata.'); return; }
          tipPlayMark(m, ctxV, x, Math.round(qv * 100) / 100, Math.round(sv * 100) / 100);
          U.toast('Segnata: ' + (TIP_PLAY_SHORT[x.k] || x.k) + ' a ' + qv.toFixed(2) + ' · ' + sv + '€');
          setTimeout(draw, 60);
        };
      };
    });
    var mdD = out.querySelector('.tip-more2');
    if (mdD) mdD.addEventListener('toggle', function () { tipUI.liveMore = mdD.open; });
    var mq = out.querySelector('[data-minq]');
    if (mq) mq.onchange = function () { var n3 = Number(String(mq.value).replace(',', '.')); if (isFinite(n3) && n3 > 1) { try { localStorage.setItem('tipMinQ', String(n3)); } catch (e) { /* ok */ } } draw(); };
    out.querySelectorAll('[data-st]').forEach(function (el) {
      el.onchange = function () {
        var k = el.dataset.st, v2 = el.value;
        if (k === 'a' || k === 'b') tipUI.step[k] = v2;
        else { var n2 = Number(String(v2).replace(',', '.')); if (isFinite(n2) && n2 > 0) tipUI.step[k] = n2; else delete tipUI.step[k]; }
        tipUI.step.open = true;
        draw();
      };
    });
    var stD = out.querySelector('.tip-step');
    if (stD) stD.addEventListener('toggle', function () { tipUI.step.open = stD.open; });
    out.querySelectorAll('[data-iq]').forEach(function (el) {
      el.onchange = function () {
        var n = Number(String(el.value).replace(',', '.'));
        if (isFinite(n) && n > 1) q[el.dataset.iq] = n;
        else delete q[el.dataset.iq];
        draw();
      };
    });
  };
  dlg.querySelectorAll('[data-ip],[data-ips]').forEach(function (el) { el.addEventListener('input', draw); el.addEventListener('change', draw); });
  var shs = dlg.querySelector('[data-sheet-star]');
  if (shs) shs.onclick = function () {
    if (m.scan) tipToggleLiveStar(m.afId, m); else tipToggleStar(m.id);
    var on = tipIsStar(m);
    shs.textContent = on ? '★' : '☆';
    shs.classList.toggle('on', !!on);
    render();
  };
  var cxo = dlg.querySelector('[data-ctx-open]');
  if (cxo) cxo.onclick = function () { dlg.close(); tipCtxSheet(m.id, 'live'); };
  var btn = dlg.querySelector('[data-ip-sync]');
  btn.onclick = async function () {
    btn.disabled = true;
    btn.textContent = 'Sincronizzo…';
    try {
      var r = await tipLiveFetch(m),
        st = r.stats || {},
        side = st.side || [{}, {}],
        half = r.status === '2H' || r.status === 'HT' || r.status === 'ET' || (r.elapsed || 0) > 46 ? 2 : 1,
        set = function (sel, val) { var el = dlg.querySelector(sel); if (el && val != null) el.value = val; };
      tipUI.liveData = tipUI.liveData || {};
      tipUI.liveData[m.id] = Object.assign({}, r, { at: Date.now() });
      set('[data-ip="min"]', r.elapsed); set('[data-ip="half"]', half);
      set('[data-ip="gh"]', r.goals && r.goals[0]); set('[data-ip="ga"]', r.goals && r.goals[1]); set('[data-ip="lg"]', r.lastGoal);
      [0, 1].forEach(function (i) {
        ['s', 't', 'b', 'c', 'xg', 'poss', 'red'].forEach(function (k) { set('[data-ips="' + k + '"][data-side="' + i + '"]', side[i] && side[i][k]); });
      });
      draw(); /* prima di salvare questa: il momento si misura rispetto a una sincronizzazione precedente */
      if (r.elapsed != null) tipLiveHist(m.id, { min: r.elapsed, half: half, side: side, at: Date.now() });
      btn.textContent = '📡 ' + (r.elapsed != null ? r.elapsed + '\' · ' : '') + (r.status || '') + ' · sincronizza di nuovo';
      var dd = dlg.querySelector('.tip-ipdata'); if (dd) dd.open = false;
    } catch (e) {
      btn.textContent = '📡 Sincronizza';
      U.toast(tipFnErr(e));
    } finally {
      btn.disabled = false;
    }
  };
  draw();
  if (tipCanSync() && (m.scan || tipIsLiveNow(m)) && !(d0.at && Date.now() - d0.at < 60e3)) btn.click();
}
/* ---------- Statistiche e calibrazione ---------- */
function tipClosed() {
  var rows = [];
  (db.predictions || []).forEach(function (m) {
    (m.picks || []).forEach(function (p) {
      var o = tipOutcome(m, p);
      if (o.s === 'V' || o.s === 'P') rows.push({ m: m, p: p, won: o.s === 'V' });
    });
  });
  return rows;
}
function tipSummary(rows) {
  var n = rows.length,
    w = rows.filter(function (r) {
      return r.won;
    }).length,
    exp = n
      ? rows.reduce(function (s, r) {
          return s + r.p.p / 100;
        }, 0) / n
      : 0,
    brier = n
      ? rows.reduce(function (s, r) {
          return s + Math.pow(r.p.p / 100 - (r.won ? 1 : 0), 2);
        }, 0) / n
      : null;
  return { n: n, w: w, rate: n ? (w / n) * 100 : null, exp: exp * 100, brier: brier };
}
/* Correzioni imparate dai risultati, con un peso prudente verso i valori di partenza. */
function tipLearn() {
  var P = Object.assign({}, TIP_DEFAULTS, (db.predModel || {}).base || {});
  var done = (db.predictions || []).filter(function (m) {
    return !m.cancelled && tipNum(m.ft);
  });
  var A = 0,
    E = 0,
    lg = {},
    htG = 0,
    htFt = 0,
    D = 0,
    sPx = 0;
  done.forEach(function (m) {
    var c = tipCalc(m, P),
      e = c.lh + c.la,
      a = m.ft[0] + m.ft[1];
    A += a;
    E += e;
    (lg[m.league] = lg[m.league] || { a: 0, e: 0, n: 0 }).a += a;
    lg[m.league].e += e;
    lg[m.league].n++;
    if (tipNum(m.ht)) {
      htG += m.ht[0] + m.ht[1];
      htFt += a;
    }
    if (m.ft[0] === m.ft[1]) D++;
    sPx += c.px / 100;
  });
  var n = done.length;
  if (!n) return { n: 0 };
  /* 3.10.0 — gol nel 1° tempo per campionato e quota di gol entro il 30' */
  var htL = {}, eObs = 0, eExp = 0, eN = 0;
  done.forEach(function (m) {
    if (!tipNum(m.ht)) return;
    var c = tipCalc(m, P),
      lht = (U.finite(m.hts) ? m.hts : P.htShare) * (c.lh + c.la),
      x = (htL[m.league] = htL[m.league] || { a: 0, e: 0, n: 0 });
    x.a += m.ht[0] + m.ht[1];
    x.e += lht;
    x.n++;
    if (m.ht[0] + m.ht[1] > 0 && Number.isInteger(m.fg)) {
      var f0 = (P.plan && P.plan.early) || 0.62;
      eExp += (1 - Math.exp(-f0 * lht)) / (1 - Math.exp(-lht));
      eObs += m.fg <= 30 ? 1 : 0;
      eN++;
    }
  });
  var htLeague = {};
  Object.keys(htL).forEach(function (k) {
    var x = htL[k];
    if (x.n < 5) return;
    var f = (x.a + 8 * (x.e / x.n)) / (x.e + 8 * (x.e / x.n));
    if (Math.abs(f - 1) >= 0.03) htLeague[k] = Math.round(f * 1000) / 1000;
  });
  var early = null;
  if (eN >= 10) {
    var f0b = (P.plan && P.plan.early) || 0.62,
      mean = eExp / eN;
    early = Math.round(Math.max(0.45, Math.min(0.8, f0b * (eObs + 15 * mean) / (eExp + 15 * mean))) * 1000) / 1000;
  }
  var W = 20 * (E / n); // come 20 partite "normali"
  var goalFactor = (A + W) / (E + W);
  var leagueGoal = {};
  Object.keys(lg).forEach(function (k) {
    var x = lg[k];
    if (x.n < 5) return;
    var w = 10 * (x.e / x.n),
      f = (x.a + w) / (x.e * goalFactor + w);
    if (Math.abs(f - 1) >= 0.03) leagueGoal[k] = Math.round(f * 1000) / 1000;
  });
  var wHt = 20 * 2.7,
    htShare = htFt ? (htG + P.htShare * wHt) / (htFt + wHt) : null;
  var pxBar = sPx / n,
    drawBoost = (D + 20 * pxBar) / (sPx + 20 * pxBar);
  return {
    n: n,
    goals: { actual: A, expected: E },
    goalFactor: Math.round(goalFactor * 1000) / 1000,
    leagueGoal: leagueGoal,
    leagueRaw: lg,
    htShare: htShare != null ? Math.round(htShare * 1000) / 1000 : null,
    htN: htFt,
    draws: { actual: D, expected: sPx },
    drawBoost: Math.round(drawBoost * 1000) / 1000,
    htLeague: htLeague,
    htLeagueRaw: htL,
    early: early,
    earlyN: eN,
  };
}


/* ---------- Pagina (3.4.0: lista in primo piano, statistiche e file su pulsanti dedicati) ---------- */
var TIP_IC = {
  stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
  home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5L12 4l8 7.5"/><path d="M6.5 9.5V20h11V9.5"/></svg>',
  live: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.6"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/></svg>',
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};
function tipDayLabel(iso, long) {
  var d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('it-IT', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric' });
}
function tipPct(v) {
  return v == null ? '—' : Math.round(v) + '%';
}
function tipReviewLabel(m) {
  return {
    blend: 'Claude + Poisson',
    claude_only: 'Solo Claude',
    poisson_only: 'Solo Poisson',
    not_revised: 'Non rivista',
    model_v2: 'Modello v2',
    model_v3: 'Statistiche + quote',
  }[m.review] || 'Analisi precedente';
}
var TIP_ST = { V: 'won', P: 'lost', N: 'void', '': 'wait' };
function tipChip(m, p) {
  var o = tipOutcome(m, p),
    st = TIP_ST[o.s],
    mark = { V: '✓', P: '✕', N: '–' }[o.s] || '';
  return (
    '<span class="tip-pick mk-' + p.m + ' ' + st + '">' + (mark ? '<em aria-hidden="true">' + mark + '</em>' : '') + '<b>' + U.esc(p.sel) + '</b><i>' + p.p + '%</i>' + (tipOdd(m, p) ? '<i class="tip-odd">@' + tipOdd(m, p).toFixed(2) + '</i>' : '') +
    (o.s ? '<span class="sr-only">' + { V: 'vinto', P: 'perso', N: 'annullato' }[o.s] + '</span>' : '') + '</span>'
  );
}
/* 3.8.0 — Gli altri mercati della partita (sotto soglia), in grigio. */
function tipOthers(m) {
  var have = {}, ch;
  (m.picks || []).forEach(function (p) { have[p.m] = 1; });
  try { ch = tipChoices(tipCalc(m, tipParams())); } catch (e) { return ''; }
  var out = TIP_MARKETS.filter(function (k) { return !have[k[0]] && ch[k[0]]; }).map(function (k) {
    var x = ch[k[0]], s = m.cancelled ? '' : tipAutoOutcome(m, { m: k[0], sel: x.sel, p: x.p }),
      mark = { V: '✓', P: '✕' }[s] || '';
    return '<span class="tip-other' + (s === 'V' ? ' ok' : s === 'P' ? ' ko' : '') + '">' + U.esc(x.sel) + ' <i>' + Math.round(x.p) + '%</i>' + (mark ? ' <em aria-hidden="true">' + mark + '</em>' : '') + '</span>';
  });
  return out.length ? '<span class="tip-others">' + out.join('') + '</span>' : '';
}
/* Colore della partita: tutto vinto, tutto perso, misto, in corso, da verificare, in programma. */
function tipTone(m) {
  if (m.cancelled) return 'void';
  var st = tipState(m);
  if (st === 'live') return 'live';
  var won = 0,
    lost = 0;
  (m.picks || []).forEach(function (p) {
    var s = tipOutcome(m, p).s;
    if (s === 'V') won++;
    if (s === 'P') lost++;
  });
  if (won && !lost) return 'won';
  if (lost && !won) return 'lost';
  if (won && lost) return 'mixed';
  return st === 'check' ? 'check' : 'open';
}
function tipCard(m, sortKey) {
  var tone = tipTone(m),
    won = 0,
    closed = 0;
  (m.picks || []).forEach(function (p) {
    var s = tipOutcome(m, p).s;
    if (s === 'V' || s === 'P') closed++;
    if (s === 'V') won++;
  });
  var badge = {
    void: '<span class="tip-status void">Annullata</span>',
    live: '<span class="tip-status live"><i class="tip-dot"></i>In corso</span>',
    check: '<span class="tip-status check">Da verificare</span>',
    won: '<span class="tip-status won">' + won + '/' + closed + ' vinti</span>',
    lost: '<span class="tip-status lost">' + won + '/' + closed + ' vinti</span>',
    mixed: '<span class="tip-status mixed">' + won + '/' + closed + ' vinti</span>',
    open: '',
  }[tone];
  var mid = tipNum(m.ft)
    ? '<span class="tip-score has"><b>' + m.ft[0] + '</b><span>–</span><b>' + m.ft[1] + '</b>' + (tipNum(m.ht) ? '<small>1T ' + m.ht[0] + '-' + m.ht[1] + '</small>' : '') + '</span>'
    : '<span class="tip-score"><small>vs</small></span>';
  return (
    '<button type="button" class="tip-card t-' + tone + '" data-tip-open="' + U.esc(m.id) + '">' +
    (sortKey
      ? '<span class="tip-rank"><span><small>' + U.esc(tipDayLabel(m.date)) + '</small>' + U.esc(tipSortLabel(m, sortKey)) + '</span><b>' + (tipSortValue(m, sortKey) < 0 ? '—' : Math.round(tipSortValue(m, sortKey)) + '%') + '</b></span>'
      : '') +
    '<span class="tip-meta"><span class="tip-time">' + U.esc(m.time) + '</span><span class="tip-league">' + U.esc(m.league) + '</span>' + badge + '<span class="tip-star' + (tipIsStar(m) ? ' on' : '') + '" data-tip-star="' + U.esc(m.id) + '" role="button" aria-label="Preferita">' + (tipIsStar(m) ? '★' : '☆') + '</span></span>' +
    '<span class="tip-teams"><span class="tip-home">' + U.esc(m.home) + '</span>' + mid + '<span class="tip-away">' + U.esc(m.away) + '</span></span>' +
    '<span class="tip-picks">' + (m.picks || []).map(function (p) { return tipChip(m, p); }).join('') + '</span>' +
    (m.warn ? '<span class="tip-warn">⚠ ' + U.esc(m.warn) + '</span>' : '') +
    (tipIsLiveNow(m) ? (function () { var e = tipLiveEval(m), go = e && e.act.k !== 'no'; return '<span class="tip-livechip' + (go ? ' tip-hot' : '') + '" data-tip-live="' + U.esc(m.id) + '" role="button">📡 Live' + (go ? ' · ' + e.act.t + ' ' + (e.act.w === '1T' ? 'gol 1T' : 'gol fine') : ' · sintonizza') + ' ›</span>'; })() : '') +
    tipOthers(m) +
    '<span class="tip-foot"><span class="tip-rel r' + m.rel + '">Dati ' + m.rel + '</span><span class="tip-origin' + (m.review === 'not_revised' ? ' stale' : '') + '">' + U.esc(tipReviewLabel(m)) + '</span>' + (m.fav ? '<span class="tip-origin">Favorita ' + m.fav + '%</span>' : '') + '</span>' +
    '</button>'
  );
}
/* 3.50.0 — barra di navigazione dei Pronostici: Home · Top · Partite · Live · Statistiche, avvisi e file */
function tipNav(list) {
  var P = tipUI.panel, nLive = list.filter(tipIsLiveNow).length, A = tipAlertPrefs(), now = Date.now(), nOtt = 0, cur = tipLiveNowPlays();
  if (cur) nOtt = cur.filter(function (x) { return x.tier === 'excellent'; }).length;
  else (((db.predModel || {}).playLog) || []).forEach(function (e) { if (e.tier === 'excellent' && e.res == null && e.t > now - 20 * 60e3 && !e.conditional && !e.costly && !e.trial) nOtt++; });
  var it = function (k, ic, label, badge) {
    return '<button type="button" class="tip-navb' + (P === k ? ' on' : '') + '" data-tip-panel="' + k + '" aria-label="' + label + '"' + (P === k ? ' aria-current="page"' : '') + '>' + ic + '<span>' + label + '</span>' + (badge ? '<b class="tip-badge">' + badge + '</b>' : '') + '</button>';
  };
  var tool = function (k, ic, label, badge, attr, cls) {
    return '<button type="button" class="tip-hbtn' + (P === k ? ' on' : '') + (cls || '') + '" ' + (attr || 'data-tip-panel="' + k + '"') + ' aria-label="' + label + '">' + ic + (badge ? '<b class="tip-badge">' + badge + '</b>' : '') + '</button>';
  };
  /* 3.52.0 — accanto al titolo Pronostici: Live, Stats, Avvisi, Aggiorna. Nella barra solo Home, Top, Partite. */
  setTimeout(function () {
    var hd = document.querySelector('header');
    if (!hd || typeof tab === 'undefined' || tab !== 'tips') return;
    var box = hd.querySelector('.tip-htools');
    if (!box) { box = document.createElement('div'); box.className = 'tip-htools'; hd.appendChild(box); }
    box.innerHTML = tool('stats', TIP_IC.stats, 'Statistiche') +
      tool('alerts', TIP_IC.bell, 'Avvisi', '', 'data-tip-alerts', A.on ? ' armed' : '') +
      tool('file', TIP_IC.file, 'Aggiorna', '', 'data-tip-sheet', tipUI.loading || tipUI.preBusy ? ' busy' : '');
    box.querySelectorAll('[data-tip-panel]').forEach(function (b) { b.onclick = function () { tipUI.panel = b.dataset.tipPanel; render(); window.scrollTo(0, 0); }; });
    box.querySelectorAll('[data-tip-alerts]').forEach(function (b) { b.onclick = tipAlertSheet; });
    box.querySelectorAll('[data-tip-sheet]').forEach(function (b) { b.onclick = tipFileSheet; });
  }, 0);
  /* 3.54.0 — Home fissa a sinistra, poi lo switch Partite · Top · Live */
  return '<div class="tip-nav" role="navigation" aria-label="Sezioni dei pronostici">' +
    '<button type="button" class="tip-navhome' + (P === 'home' ? ' on' : '') + '" data-tip-panel="home" aria-label="Home dei pronostici">' + TIP_IC.home + '</button>' +
    '<div class="tip-navseg">' + it('list', TIP_IC.list, 'Partite') + it('top', TIP_IC.star, 'Top') + it('live', TIP_IC.live, 'Live', nOtt) +
    '</div></div><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>';
}
/* giorni a scelta rapida, uguali in Top e Partite: Oggi · Domani · Dopodomani · Tutti (con il numero di partite) */
function tipDayChips(list, allLabel) {
  var today = U.local().slice(0, 10), add = function (n) { var d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
  var wd = function (iso) { return tipCap(new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long' })); };
  var opts = [[today, 'Oggi'], [add(1), 'Domani'], [add(2), wd(add(2))], ['all', allLabel || 'Tutti']];
  var cnt = function (d) { return list.filter(function (m) { return !m.cancelled && (d === 'all' ? m.date >= today : m.date === d); }).length; };
  return '<div class="tip-days" role="tablist">' + opts.map(function (o) {
    var on = tipUI.day === o[0], n = cnt(o[0]);
    return '<button type="button" role="tab" class="tip-dayb' + (on ? ' on' : '') + (n ? '' : ' empty') + '" data-tip-day="' + o[0] + '" aria-selected="' + on + '"><b>' + U.esc(o[1]) + '</b><small>' + (o[0] === 'all' ? n + ' partite' : new Date(o[0] + 'T12:00:00').getDate() + ' · ' + n + (n === 1 ? ' partita' : ' partite')) + '</small></button>';
  }).join('') + '</div>';
}
/* titolo uniforme delle sezioni */
function tipHead(title, sub) {
  return '<div class="tip-pagehead"><b>' + title + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
}
/* Home dei Pronostici: Top, Live, Partite e Resoconto, ognuna si apre con un tocco */
function tipHubPanel(list) {
  var today = U.local().slice(0, 10), P = tipParams(), T = tipTopFor(today, list, P), now = Date.now();
  var live = list.filter(tipIsLiveNow), L = ((db.predModel || {}).playLog) || [];
  var hot = tipLiveNowPlays() || tipPlayDedup(L.filter(function (e) { return tipKindActive(e.k) && !TIP_LIVE_HIDE[e.k] && e.res == null && e.t > now - 30 * 60e3 && (e.tier === 'excellent' || e.tier === 'try') && !e.conditional && !e.costly; }))
    .sort(function (a, b) { return (a.tier === 'try' ? 1 : 0) - (b.tier === 'try' ? 1 : 0) || b.t - a.t; });
  var nOtt = hot.filter(function (e) { return e.tier === 'excellent'; }).length;
  var row = function (a, b, c, cls) { return '<span class="tip-hubrow"><span>' + a + '</span><b class="' + (cls || '') + '">' + b + '</b>' + (c ? '<small>' + c + '</small>' : '') + '</span>'; };
  var card = function (k, ic, title, meta, body, accent) {
    return '<button type="button" class="card tip-hub' + (accent ? ' ' + accent : '') + '" data-tip-panel="' + k + '"><span class="tip-hubhead"><span class="tip-hubic">' + ic + '</span><b>' + title + '</b><span class="tip-hubmeta">' + meta + '</span>' + TIP_IC.chev + '</span>' + (body ? '<span class="tip-hubbody">' + body + '</span>' : '') + '</button>';
  };
  var topBody = T.all.slice(0, 4).map(function (c) { return row(U.esc(c.m.time) + ' · ' + U.esc(c.m.home) + ' – ' + U.esc(c.m.away), U.esc(c.p.sel) + ' ' + c.p.p + '%', '', 'positive'); }).join('') ||
    '<span class="tip-hubempty">Nessuna partita in Top oggi' + (list.some(function (m) { return m.date > today; }) ? ': guarda domani in Top.' : '.') + '</span>';
  var liveBody = hot.slice(0, 4).map(function (e) { return row(e.min + '’ · ' + U.esc(e.home) + ' – ' + U.esc(e.away), (e.tier === 'excellent' ? 'OTTIMA ' : 'DA VALUTARE ') + Math.round(e.p * 100) + '%', U.esc(TIP_PLAY_SHORT[e.k] || e.k), e.tier === 'excellent' ? 'positive' : 'tip-amber-text'); }).join('') ||
    '<span class="tip-hubempty">' + (tipUI.scan ? 'Nessuna giocata adesso: il Live controlla da solo ogni 2 minuti.' : 'Tocca per cercare le giocate nelle partite in corso.') + '</span>';
  var days = [0, 1, 2].map(function (n) { var d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() + n); var iso = d.toLocaleDateString('sv-SE'); return [n === 0 ? 'Oggi' : n === 1 ? 'Domani' : tipCap(tipDayLabel(iso)), list.filter(function (m) { return m.date === iso && !m.cancelled; }).length]; });
  var listBody = '<span class="tip-hubdays">' + days.map(function (d) { return '<span><b>' + d[1] + '</b><small>' + U.esc(d[0]) + '</small></span>'; }).join('') + '</span>';
  var R = (db.predModel || {}).reports || {}, rk = Object.keys(R).sort().pop(), rep = rk ? R[rk] : null;
  var statBody = rep ? row(U.esc(tipCap(tipDayLabel(rk))), '◆ ' + rep.tot.w + '/' + rep.tot.n + ' · ' + (rep.tot.pl >= 0 ? '+' : '') + rep.tot.pl.toFixed(2) + '€' + (rep.trial && rep.trial.n ? ' · 🧪 ' + rep.trial.w + '/' + rep.trial.n : ''), rep.mine && rep.mine.n ? 'tue ' + (rep.mine.pl >= 0 ? '+' : '') + rep.mine.pl.toFixed(2) + '€' : 'a quota minima', rep.tot.pl >= 0 ? 'positive' : 'negative') : '<span class="tip-hubempty">Il primo resoconto arriva a fine giornata.</span>';
  return card('top', TIP_IC.star, 'Top di oggi', T.all.length + (T.all.length === 1 ? ' partita' : ' partite'), topBody, 'tip-hub-top') +
    card('live', TIP_IC.live, 'Live adesso', (nOtt ? '<i class="tip-hubpill">' + nOtt + ' OTTIM' + (nOtt === 1 ? 'A' : 'E') + '</i> ' : '') + (tipUI.scan ? tipScanEval().length : live.length) + ' in corso', liveBody, nOtt ? 'tip-hub-hot' : 'tip-hub-live') +
    card('list', TIP_IC.list, 'Partite', list.filter(function (m) { return m.date >= today && !m.cancelled; }).length + ' in programma', listBody) +
    card('stats', TIP_IC.stats, 'Resoconto', rep ? 'ultimo giorno' : '', statBody);
}
/* avvisi: dalla campanella della barra */
function tipAlertSheet() {
  var inner = function () { return tipAlertCard().replace(/<div class="tip-top-head">.*?<\/div>/, ''); };
  var html = sheetHead('Avvisi sul telefono') + '<div class="tip-sheet tip-alertsheet">' + inner() + '</div>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
  var bindA = function () {
    d.querySelectorAll('[data-alert]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.alert;
        if (k === 'test') { tipAlertTest(); return; }
        mutate(function (n) { n.predModel = n.predModel || {}; var A = n.predModel.alerts = Object.assign({ on: false, amber: false, stars: false }, n.predModel.alerts || {}); A[k] = !tipAlertOn(A, k); if (k === 'stars' && A[k]) A.on = true; A.at = Date.now(); });
        var box = d.querySelector('.tip-alertsheet');
        if (box) { box.innerHTML = inner(); bindA(); }
      };
    });
    d.querySelectorAll('[data-alert-k]').forEach(function (b) {
      b.onclick = function () {
        var k = b.dataset.alertK;
        mutate(function (n) { n.predModel = n.predModel || {}; var A = n.predModel.alerts = Object.assign({ on: false, amber: false, stars: false }, n.predModel.alerts || {}); A.off = Object.assign({}, A.off || {}); if (A.off[k]) delete A.off[k]; else A.off[k] = 1; A.at = Date.now(); });
        var box = d.querySelector('.tip-alertsheet');
        if (box) { box.innerHTML = inner(); bindA(); }
      };
    });
  };
  bindA();
}
function tipsPage() {
  tipEnsurePrematch();
  tipStatsResetOnce();
  tipIdCheckOnce();
  tipUI._cal = null; /* calibrazione ricalcolata a ogni disegno della pagina */
  var list = (db.predictions || []).slice();
  if (!list.length) {
    return (
      '<section class="card tip-empty"><b>Nessuna partita</b><p class="muted">I pronostici arrivano dal file che prepara Claude. Chiedigli “prevedi le prossime partite”, poi pubblica l’app oppure importa il file qui.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-fetch>↻ Cerca aggiornamenti</button><button type="button" data-tip-import>Importa file</button></div></section><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>'
    );
  }
  var pn = tipUI.panel;
  if (['home', 'top', 'list', 'live', 'stats'].indexOf(pn) < 0) pn = tipUI.panel = 'home';
  var body = pn === 'stats' ? tipHead('Statistiche', 'Come stanno andando i consigli') + tipStatsPanel(list)
    : pn === 'top' ? tipHead('Top', 'Le partite più sicure del giorno') + tipDayChips(list, 'Da oggi') + tipTopPanel(list)
    : pn === 'live' ? tipHead('Live', tipUI.scan ? 'Aggiornato alle ' + new Date(tipUI.scan.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + ' · da solo ogni 2 minuti' : 'Scansione automatica ogni 2 minuti') + tipLivePanel(list)
    : pn === 'list' ? tipHead('Partite', 'Tutti i pronostici, con filtri') + tipDayChips(list, 'Tutti') + tipListPanel(list)
    : tipHubPanel(list);
  return tipNav(list) + '<div class="tip-body tip-body-' + pn + '">' + body + '</div>';
}
function tipListPanel(list) {
  var days = [],
    leagues = [],
    counts = { open: 0, live: 0, check: 0, done: 0 };
  list.forEach(function (m) {
    if (days.indexOf(m.date) < 0) days.push(m.date);
    if (leagues.indexOf(m.league) < 0) leagues.push(m.league);
    counts[tipState(m)]++;
  });
  days.sort();
  leagues.sort(function (a, b) {
    return a.localeCompare(b, 'it');
  });
  var q = tipUI.q.trim().toLowerCase();
  var shown = list
    .filter(function (m) {
      return (
        (tipUI.view === 'all' || tipState(m) === tipUI.view) &&
        (tipUI.day === 'all' || m.date === tipUI.day) &&
        (!tipUI.league || m.league === tipUI.league) &&
        (!q || (m.home + ' ' + m.away + ' ' + m.league).toLowerCase().indexOf(q) >= 0) &&
        (!tipUI.starOnly || tipIsStar(m))
      );
    })
    .sort(function (a, b) {
      return tipKickoff(a) - tipKickoff(b) || a.league.localeCompare(b.league);
    });
  if (tipUI.view === 'done') shown.reverse();
  var byProb = tipUI.sort !== 'time';
  if (byProb) {
    shown.forEach(function (m) {
      m._sv = tipSortValue(m, tipUI.sort);
    });
    shown.sort(function (a, b) {
      return b._sv - a._sv || tipKickoff(a) - tipKickoff(b);
    });
  }

  var sortName = (TIP_SORTS.find(function (o) { return o[0] === tipUI.sort; }) || TIP_SORTS[0])[1];
  var stateName = { open: 'Prossime', live: 'In corso', check: 'Da verificare', done: 'Concluse', all: 'Tutte' }[tipUI.view];
  var dayName = tipUI.day === 'all' ? 'Tutti i giorni' : tipCap(tipDayLabel(tipUI.day));
  var fbtn = function (key, label, value, on, alert) {
    return (
      '<button type="button" class="tip-fbtn' + (on ? ' on' : '') + '" data-tip-filter="' + key + '"><small>' + label + (alert ? '<i class="tip-alert">' + alert + '</i>' : '') + '</small><b>' + U.esc(value) + '</b>' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>'
    );
  };
  var active = tipUI.view !== 'open' || tipUI.day !== 'all' || tipUI.league || tipUI.q || byProb;
  var filters =
    '<section class="tip-filters" aria-label="Filtri">' +
    '<div class="tip-fgrid">' +
    fbtn('view', 'Stato', stateName, tipUI.view !== 'open', counts.check ? counts.check : '') +
    fbtn('league', 'Campionato', tipUI.league || 'Tutti', !!tipUI.league) +
    fbtn('sort', 'Ordina per', sortName, byProb) +
    '</div>' +
    '<div class="tip-srow"><span class="tip-search">' + TIP_IC.search + '<input id="tip-q" type="search" placeholder="Cerca squadra" value="' + U.esc(tipUI.q) + '" aria-label="Cerca squadra"></span>' +
    '<button type="button" class="tip-starf' + (tipUI.starOnly ? ' on' : '') + '" data-tip-staronly>' + (tipUI.starOnly ? '★' : '☆') + ' Preferite · ' + list.filter(function (m) { return m.star; }).length + '</button>' +
    (active ? '<button type="button" class="tip-reset" data-tip-reset>Azzera</button>' : '') + '</div>' +
    '</section>';
  tipUI._opts = { days: days, leagues: leagues, counts: counts, total: list.length };

  var body = '',
    lastDay = '';
  if (byProb && shown.length)
    body += '<h2 class="tip-day no-cap"><span>' + U.esc(TIP_SORTS.find(function (o) { return o[0] === tipUI.sort; })[1]) + '</span><small>dal più probabile · ' + shown.length + ' partite</small></h2>';
  shown.forEach(function (m) {
    if (byProb) {
      body += tipCard(m, tipUI.sort);
      return;
    }
    if (m.date !== lastDay) {
      var n = shown.filter(function (x) { return x.date === m.date; }).length;
      body += '<h2 class="tip-day"><span>' + tipDayLabel(m.date, true) + '</span><small>' + n + (n === 1 ? ' partita' : ' partite') + '</small></h2>';
      lastDay = m.date;
    }
    body += tipCard(m);
  });
  if (!shown.length)
    body = '<div class="card empty">' + (tipUI.view === 'check' ? 'Nessuna partita da verificare.' : tipUI.view === 'live' ? 'Nessuna partita in corso.' : 'Nessuna partita con questi filtri.') + '</div>';
  return filters + '<div class="tip-list">' + body + '</div>';
}
/* 3.65.0 — STATISTICHE: Live e Prepartita separate, ognuna con Riepilogo e Storico.
   Periodo scelto da calendario (uno o più giorni), filtri in un pannello. */
var TIP_LG_NAME = { major: 'Maggiori', 'minor+': 'Minori (Paesi forti)', minor: 'Minori', 'youth+': 'Giovanili (Paesi forti)', youth: 'Giovanili', women: 'Femminili' };
function tipISO(d) { return d.toLocaleDateString('sv-SE'); }
function tipAddDays(iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return tipISO(d); }
function tipStRange() {
  var today = tipISO(new Date());
  if (tipUI.stFrom === undefined) { tipUI.stFrom = tipAddDays(today, -29); tipUI.stTo = today; }
  return { from: tipUI.stFrom || '0000-00-00', to: tipUI.stTo || '9999-99-99' };
}
function tipStRangeLabel() {
  var R = tipStRange(), f = function (d) { return new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }); };
  if (!tipUI.stFrom) return 'Tutto';
  return R.from === R.to ? f(R.from) : f(R.from) + ' – ' + f(R.to);
}
function tipLiveDay(e) { return new Date(e.t || 0).toLocaleDateString('sv-SE'); }
/* consigli live chiudibili (niente ingressi futuri, step costosi, monitoraggi) */
function tipLiveAll(trial) {
  return tipPlayDedup((db.predModel || {}).playLog || []).filter(function (e) {
    return !!e.trial === !!trial && tipStatsOk(e) && (e.tier === 'excellent' || e.tier === 'try' || !e.tier) && !e.conditional && !e.costly && e.res !== 'skip';
  });
}
function tipStatLog(anySample) {
  var R = tipStRange(), F = tipUI.stF || {}, lf = tipUI.lblF || {};
  /* 3.78.0 — di base stabili E in prova insieme; i totali restano separati */
  var base = anySample ? tipLiveAll(false).concat(tipLiveAll(true)) : F.sample === 'trial' ? tipLiveAll(true) : F.sample === 'stable' ? tipLiveAll(false) : tipLiveAll(false).concat(tipLiveAll(true));
  return base.filter(function (e) {
    var d = tipLiveDay(e);
    return d >= R.from && d <= R.to && tipEFilter(F, e) &&
      (!lf.p || (e.prof || 'nq') === lf.p) && (!lf.r || (e.rit || 'norm') === lf.r);
  }).sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
}
function tipStatCount(arr) {
  var w = 0, l = 0, a = 0, p = 0, n = 0, pl = 0;
  arr.forEach(function (e) { if (e.res === 1) w++; else if (e.res === 0) l++; else a++; if (e.res === 1 || e.res === 0) { p += e.p || 0; n++; pl += e.res ? (e.win || 0) : -(e.risk || 0); } });
  return { w: w, l: l, a: a, n: n, pl: pl, rate: n ? w / n * 100 : null, exp: n ? p / n * 100 : null };
}
/* ---- prepartita: un record per pronostico chiuso ---- */
function tipPreTopSet(list) {
  var set = {};
  list.forEach(function (m) {
    Object.keys((m.preIssue || {}).top || {}).forEach(function (k) { set[m.id + '|' + k] = 1; });
  });
  return set;
}
function tipPreRows(list) {
  var R = tipStRange(), F = tipUI.stPF || {}, top = tipPreTopSet(list), out = [];
  list.forEach(function (m) {
    if (m.cancelled || m.date < R.from || m.date > R.to || tipKickoff(m).getTime() < tipStatsFrom()) return;
    var lg = tipLeagueTier(m);
    if (F.lg && lg !== F.lg) return;
    (m.picks || []).forEach(function (p) {
      if (F.m && p.m !== F.m) return;
      var isTop = !!top[m.id + '|' + p.m];
      var topKnown = !!(m.preIssue && m.preIssue.top != null);
      if (F.top === 'top' && !isTop) return;
      if (F.top === 'no' && (!topKnown || isTop)) return;
      if (F.top === 'unknown' && topKnown) return;
      var o = tipOutcome(m, p).s;
      out.push({ m: m, p: p, top: isTop, topKnown: topKnown, lg: lg, res: o === 'V' ? 1 : o === 'P' ? 0 : null, prob: (p.p || 0) / 100, src: (m.preIssue && m.preIssue.inputs.src) || m.src || 'unknown' });
    });
  });
  return out;
}
function tipPreCount(arr) {
  var w = 0, l = 0, a = 0, p = 0, n = 0;
  arr.forEach(function (r) { if (r.res === 1) w++; else if (r.res === 0) l++; else a++; if (r.res != null) { p += r.prob; n++; } });
  return { w: w, l: l, a: a, n: n, rate: n ? w / n * 100 : null, exp: n ? p / n * 100 : null };
}
/* ---- pezzi grafici ---- */
function tipWL(x) { return x.n || x.a ? '<b class="positive">' + x.w + '</b>/<b class="negative">' + x.l + '</b>' + (x.a ? '<small> +' + x.a + '</small>' : '') : '<span class="muted">—</span>'; }
function tipPctCell(x) { return x.n ? '<b class="' + (x.rate >= x.exp - 2 ? 'positive' : 'negative') + '">' + Math.round(x.rate) + '%</b><small> prev. ' + Math.round(x.exp) + '%</small>' : '<span class="muted">—</span>'; }
function tipKpi(label, val, sub, cls) { return '<div class="card diary-kpi"><small>' + label + '</small><b class="' + (cls || '') + '">' + val + '</b><span>' + sub + '</span></div>'; }
function tipBarsByDay(byDay, days) {
  var mx = Math.max.apply(null, days.map(function (d) { var x = byDay[d] || { w: 0, l: 0 }; return x.w + x.l; }).concat([1]));
  return '<section class="card diary-card"><h2>Giorno per giorno</h2><div class="tip-days14" style="grid-template-columns:repeat(' + days.length + ',1fr)">' + days.map(function (d) {
    var x = byDay[d] || { w: 0, l: 0 };
    return '<div class="tip-d14" title="' + d + '"><div class="tip-d14bar"><i class="w" style="height:' + (x.w / mx * 100) + '%"></i><i class="l" style="height:' + (x.l / mx * 100) + '%"></i></div><small>' + (days.length <= 16 ? d.slice(8) : '') + '</small></div>';
  }).join('') + '</div><p class="muted tip-hint"><b class="positive">verde</b> vinte · <b class="negative">rosso</b> perse</p></section>';
}
function tipRangeDays() {
  var R = tipStRange(), out = [], from = R.from, to = R.to;
  if (!tipUI.stFrom) { from = tipAddDays(tipISO(new Date()), -29); to = tipISO(new Date()); }
  for (var d = from, i = 0; d <= to && i < 62; d = tipAddDays(d, 1), i++) out.push(d);
  return out;
}
/* tabella "per gruppo" con colonne Ottime / Da valutare / Totale / € */
function tipLiveTable(title, groups) {
  var rows = groups.filter(function (g) { return g[1].length; });
  if (!rows.length) return '';
  return '<section class="card diary-card"><h2>' + title + '</h2><div class="tip-tscroll"><table class="tip-caltab tip-sttab"><tr><th></th><th>Ottime</th><th>Da valutare</th><th>Totale</th><th>€</th></tr>' + rows.map(function (g) {
    var c = tipStatCount(g[1]), ex = tipStatCount(g[1].filter(function (e) { return (e.tier || 'excellent') === 'excellent'; })), tr = tipStatCount(g[1].filter(function (e) { return e.tier === 'try'; }));
    return '<tr><th>' + g[0] + '</th><td>' + tipWL(ex) + '</td><td>' + tipWL(tr) + '</td><td>' + tipPctCell(c) + '</td><td class="' + (c.pl >= 0 ? 'positive' : 'negative') + '">' + (c.n ? (c.pl >= 0 ? '+' : '') + Math.round(c.pl) : '—') + '</td></tr>';
  }).join('') + '</table></div></section>';
}
function tipPreTable(title, groups) {
  var rows = groups.filter(function (g) { return g[1].length; });
  if (!rows.length) return '';
  return '<section class="card diary-card"><h2>' + title + '</h2><div class="tip-tscroll"><table class="tip-caltab tip-sttab"><tr><th></th><th>Top</th><th>Altri</th><th>Non documentati</th><th>Totale</th></tr>' + rows.map(function (g) {
    var c = tipPreCount(g[1]), t = tipPreCount(g[1].filter(function (r) { return r.top; })), o = tipPreCount(g[1].filter(function (r) { return r.topKnown && !r.top; })), u = tipPreCount(g[1].filter(function (r) { return !r.topKnown; }));
    return '<tr><th>' + g[0] + '</th><td>' + tipWL(t) + '</td><td>' + tipWL(o) + '</td><td>' + tipWL(u) + '</td><td>' + tipPctCell(c) + '</td></tr>';
  }).join('') + '</table></div></section>';
}
var TIP_PROB_BANDS = [[0, 55], [55, 60], [60, 65], [65, 70], [70, 101]];
function tipBandName(b) { return b[0] ? (b[1] > 100 ? 'oltre ' + b[0] + '%' : b[0] + '-' + b[1] + '%') : 'sotto 55%'; }
/* ---- LIVE ---- */
function tipStatsLiveSummary() {
  /* 3.79.0 — in alto la matrice OTTIME / DA VALUTARE × Stabili / In prova / Totale (sempre tutti), poi il selettore:
     le tabelle sotto mostrano il campione scelto */
  var smp = (tipUI.stF || {}).sample || '', ALL = tipStatLog(true), L = tipStatLog();
  var mine = L.filter(function (e) { return e.played; }), mpl = mine.reduce(function (s2, e) { return s2 + tipPlayedPL(e); }, 0), mw = mine.filter(function (e) { return e.played.res === 1; }).length;
  var html = '<section class="card diary-card"><h2>Riepilogo</h2>' + (ALL.length ? tipSampleMatrix(ALL, true) : '<p class="muted tip-tnone">Nessun consiglio nel periodo e con i filtri scelti.</p>') +
    (mine.length ? '<p class="tip-mine">Giocate da te: <b>' + mw + '/' + mine.length + '</b> · <b class="' + (mpl >= 0 ? 'positive' : 'negative') + '">' + (mpl >= 0 ? '+' : '') + mpl.toFixed(2) + '€ veri</b></p>' : '') +
    '</section>' + tipSampleSeg(smp, 'data-st-sample');
  if (!L.length) return html + '<section class="card"><p class="muted tip-tnone">Nessun consiglio nel periodo e con i filtri scelti.</p></section>';
  var byDay = {};
  L.forEach(function (e) { var d = tipLiveDay(e), x = byDay[d] = byDay[d] || { w: 0, l: 0 }; if (e.res === 1) x.w++; else if (e.res === 0) x.l++; });
  html += tipLiveTable('Per tipo di giocata', Object.keys(TIP_PLAY_SHORT).map(function (k) { return [U.esc(tipKindLabel(k)), L.filter(function (e) { return e.k === k; })]; }).concat([['<b>' + (smp === 'trial' ? '🧪 Totale in prova' : smp === 'stable' ? '◆ Totale stabili' : 'Totale') + '</b>', L]]));
  html += tipLiveTable('Filtro qualità (avvisi)', [['Passano', L.filter(tipQualityPass)], ['Esclusi', L.filter(function (e) { return !tipQualityPass(e); })]]);
  html += tipBarsByDay(byDay, tipRangeDays());
  html += tipLiveTable('Per campionato', Object.keys(TIP_LG_NAME).map(function (g) { return [TIP_LG_NAME[g], L.filter(function (e) { return e.lg === g; })]; }).concat([['Non indicato', L.filter(function (e) { return !e.lg; })]]));
  html += tipLiveTable('Per profilo (quote pre-partita)', ['gol', 'medio', 'pochi', 'nq'].map(function (q) { return [TIP_PROF[q], L.filter(function (e) { return (e.prof || 'nq') === q; })]; }));
  html += tipLiveTable('Per ritmo live', ['alto', 'norm', 'basso'].map(function (r) { return [TIP_RIT[r], L.filter(function (e) { return (e.rit || 'norm') === r; })]; }));
  html += tipLiveTable('Per probabilità promessa', TIP_PROB_BANDS.map(function (b) { return [tipBandName(b), L.filter(function (e) { var q = (e.p || 0) * 100; return q >= b[0] && q < b[1]; })]; }));
  html += tipLiveTable('Per gol già segnati', [0, 1, 2, 3].map(function (g) { return [g === 3 ? '3 o più' : String(g), L.filter(function (e) { var G = (e.gh || 0) + (e.ga || 0); return g === 3 ? G >= 3 : G === g; })]; }));
  return html + '<p class="muted tip-hint">Vinte/perse (+in attesa). ◆ stabili e 🧪 in prova sono contati separatamente. € alla quota minima (o alla quota vera del book, se registrata) con la puntata base.</p>';
}
function tipDayMiniLive(arr) {
  var ks = Object.keys(TIP_PLAY_SHORT).filter(function (k) { return arr.some(function (e) { return e.k === k; }); });
  return '<table class="tip-caltab tip-sttab tip-daymini"><tr><th>Tipo</th><th>Ottime</th><th>Da val.</th><th>%</th></tr>' + ks.map(function (k) {
    var a = arr.filter(function (e) { return e.k === k; }), c = tipStatCount(a);
    return '<tr><th>' + U.esc(tipKindLabel(k)) + '</th><td>' + tipWL(tipStatCount(a.filter(function (e) { return (e.tier || 'excellent') === 'excellent'; }))) + '</td><td>' + tipWL(tipStatCount(a.filter(function (e) { return e.tier === 'try'; }))) + '</td><td>' + (c.n ? Math.round(c.rate) + '%' : '—') + '</td></tr>';
  }).join('') + '</table>';
}
/* 3.83.0 — Storico giorno per giorno con lo stesso schema di Live › Consigli di oggi: riepilogo Stabili / In prova / Totale,
   selettore del campione, tabelle per tipo e profilo × ritmo, elenco con l'ora del segnale. Valgono periodo e filtri. */
/* 3.84.0 — UN SOLO schema per i consigli di un giorno: lo usano Statistiche › Storico e Live › Consigli di oggi.
   riga: ◆ stabili e 🧪 in prova vinte–perse, saldo teorico, in attesa · corpo: riepilogo con € teorico, (barra extra),
   tabelle per tipo e profilo × ritmo, elenco con l'ora del segnale. 'all' = tutti i campioni, smp = campione scelto. */
function tipDayHead(all) {
  var wl = function (a) {
    var w = a.filter(function (e) { return e.res === 1; }).length, l = a.filter(function (e) { return e.res === 0; }).length;
    return '<b class="positive">' + w + '</b>–<b class="negative">' + l + '</b>';
  };
  var c = tipStatCount(all), st = all.filter(function (e) { return !e.trial; }), tr = all.filter(function (e) { return e.trial; });
  return (st.length ? '◆ ' + wl(st) : '') + (st.length && tr.length ? ' · ' : '') + (tr.length ? '🧪 ' + wl(tr) : '') +
    (c.n ? ' · <span class="' + (c.pl >= 0 ? 'positive' : 'negative') + '">' + (c.pl >= 0 ? '+' : '') + Math.round(c.pl) + '€</span>' : '') + (c.a ? ' · ' + c.a + ' ◷' : '');
}
function tipDayBody(all, smp, extra) {
  var arr = tipSampleOf(all, smp);
  return (all.length ? tipSampleMatrix(all, true) : '') + (extra || '') +
    (arr.length ? tipArchiveSplit(arr) + '<div class="tip-tlist">' + arr.slice(0, 80).map(tipMemRow).join('') + '</div>'
      : '<p class="muted tip-tnone">Nessun consiglio' + (smp === 'trial' ? ' in prova' : smp === 'stable' ? ' stabile' : '') + ' con questa selezione.</p>');
}
function tipStatsLiveHistory() {
  var smp = (tipUI.stF || {}).sample || '', ALL = tipStatLog(true), byDay = {};
  ALL.forEach(function (e) { (byDay[tipLiveDay(e)] = byDay[tipLiveDay(e)] || []).push(e); });
  return tipSampleSeg(smp, 'data-st-sample') + tipDaysList(Object.keys(byDay).sort().reverse(), function (d, i) {
    var all = byDay[d].sort(function (a, b) { return (b.t || 0) - (a.t || 0); });
    return '<details class="card tip-histday"' + (i === 0 ? ' open' : '') + '><summary><b>' + U.esc(tipCap(tipDayLabel(d))) + '</b><span>' + tipDayHead(all) + '</span></summary>' + tipDayBody(all, smp) + '</details>';
  });
}
function tipDaysList(ds, fn) {
  if (!ds.length) return '<section class="card"><p class="muted tip-tnone">Nessun dato nel periodo e con i filtri scelti.</p></section>';
  var shown = tipUI.histN || 10;
  return ds.slice(0, shown).map(fn).join('') + (ds.length > shown ? '<div class="actions"><button type="button" data-hist-more>Mostra altri giorni (' + (ds.length - shown) + ')</button></div>' : '');
}
/* ---- PREPARTITA ---- */
function tipStatsPreSummary(list) {
  var R = tipPreRows(list), c = tipPreCount(R), t = tipPreCount(R.filter(function (r) { return r.top; }));
  var pc = function (x) { return x.rate == null ? '—' : Math.round(x.rate) + '%'; }, cl = function (x) { return x.rate == null ? '' : x.rate >= x.exp - 2 ? 'positive' : 'negative'; };
  var html = '<div class="diary-kpis">' +
    tipKpi('Pronostici vinti', pc(c), c.n ? c.w + ' su ' + c.n + ' · previsto ' + Math.round(c.exp) + '%' : 'nessun esito', cl(c)) +
    tipKpi('Liste Top', pc(t), t.n ? t.w + ' su ' + t.n + ' · prev. ' + Math.round(t.exp) + '%' : '—', cl(t)) +
    tipKpi('Partite', String(new Set(R.map(function (r) { return r.m.id; })).size), c.a ? c.a + ' pronostici in attesa' : 'nel periodo') +
    tipKpi('Da verificare', String(R.filter(function (r) { return r.res == null && tipKickoff(r.m).getTime() + 130 * 60e3 < Date.now(); }).length), 'finite senza esito') +
    '</div>';
  if (!R.length) return html + '<section class="card"><p class="muted tip-tnone">Nessun pronostico nel periodo e con i filtri scelti.</p></section>';
  var byDay = {};
  R.forEach(function (r) { var x = byDay[r.m.date] = byDay[r.m.date] || { w: 0, l: 0 }; if (r.res === 1) x.w++; else if (r.res === 0) x.l++; });
  html += tipPreTable('Per tipo di pronostico', TIP_MARKETS.map(function (k) { return [k[1], R.filter(function (r) { return r.p.m === k[0]; })]; }).concat([['<b>Totale</b>', R]]));
  html += tipBarsByDay(byDay, tipRangeDays());
  html += tipPreTable('Per campionato', Object.keys(TIP_LG_NAME).map(function (g) { return [TIP_LG_NAME[g], R.filter(function (r) { return r.lg === g; })]; }));
  html += tipPreTable('Per probabilità', [[0, 75], [75, 80], [80, 85], [85, 90], [90, 101]].map(function (b) { return [b[0] ? (b[1] > 100 ? 'oltre ' + b[0] + '%' : b[0] + '-' + b[1] + '%') : 'sotto 75%', R.filter(function (r) { var q = r.prob * 100; return q >= b[0] && q < b[1]; })]; }));
  html += tipPreTable('Per fonte dei dati', [['Quote TotalCorner', 'quote'], ['Quote + modello', 'quote+modello'], ['1X2 + modello', '1X2+modello'], ['Solo modello', 'modello'], ['Fonte non documentata', 'unknown']].map(function (s2) { return [s2[0], R.filter(function (r) { return r.src === s2[1]; })]; }));
  return html + '<p class="muted tip-hint">Vinte/perse (+in attesa). Top = selezione al calcio d’inizio della partita. Nei vecchi dati la Top non è documentata; le percentuali originali sono conservate.</p>';
}
function tipStatsPreHistory(list) {
  var R = tipPreRows(list), byDay = {};
  R.forEach(function (r) { (byDay[r.m.date] = byDay[r.m.date] || []).push(r); });
  return tipDaysList(Object.keys(byDay).sort().reverse(), function (d, i) {
    var arr = byDay[d], c = tipPreCount(arr), byM = {};
    arr.forEach(function (r) { (byM[r.m.id] = byM[r.m.id] || { m: r.m, rs: [] }).rs.push(r); });
    var mini = '<table class="tip-caltab tip-sttab tip-daymini"><tr><th>Pronostico</th><th>Top</th><th>Altri</th><th>Non documentati</th><th>%</th></tr>' + TIP_MARKETS.filter(function (k) { return arr.some(function (r) { return r.p.m === k[0]; }); }).map(function (k) {
      var a = arr.filter(function (r) { return r.p.m === k[0]; }), x = tipPreCount(a);
      return '<tr><th>' + k[1] + '</th><td>' + tipWL(tipPreCount(a.filter(function (r) { return r.top; }))) + '</td><td>' + tipWL(tipPreCount(a.filter(function (r) { return r.topKnown && !r.top; }))) + '</td><td>' + tipWL(tipPreCount(a.filter(function (r) { return !r.topKnown; }))) + '</td><td>' + (x.n ? Math.round(x.rate) + '%' : '—') + '</td></tr>';
    }).join('') + '</table>';
    var rows = Object.keys(byM).map(function (id) {
      var g = byM[id], m = g.m, sc = tipNum(m.ft) ? m.ft[0] + '-' + m.ft[1] + (tipNum(m.ht) ? ' (1T ' + m.ht[0] + '-' + m.ht[1] + ')' : '') : 'in attesa';
      return '<div class="tip-memory-row"><div class="tip-memory-info"><b>' + U.esc(m.home + ' – ' + m.away) + '</b><small>' + U.esc((m.time || '') + ' · ' + (m.league || '') + ' · ' + sc) + '</small><span class="tip-lbls">' + g.rs.map(function (r) {
        return '<i class="tip-lbl ' + (r.res === 1 ? 'tip-lbl-gol' : r.res === 0 ? 'tip-lbl-bad' : '') + '">' + (r.top ? '★ ' : '') + U.esc(TIP_SHORT[r.p.m] || r.p.m) + ' ' + Math.round(r.p.p) + '% ' + (r.res === 1 ? '✓' : r.res === 0 ? '✕' : '◷') + '</i>';
      }).join('') + '</span></div></div>';
    }).join('');
    return '<details class="card tip-histday"' + (i === 0 ? ' open' : '') + '><summary><b>' + U.esc(tipCap(tipDayLabel(d))) + '</b><span><b class="positive">' + c.w + '</b>/<b class="negative">' + c.l + '</b>' + (c.a ? ' · ' + c.a + ' in attesa' : '') + (c.rate != null ? ' · <b>' + Math.round(c.rate) + '%</b>' : '') + '</span></summary>' + mini + '<div class="tip-tlist">' + rows + '</div></details>';
  });
}
/* ---- filtri e calendario ---- */
function tipStatChips() {
  var live = (tipUI.stArea || 'live') === 'live', F = live ? (tipUI.stF || {}) : (tipUI.stPF || {}), lf = tipUI.lblF || {}, act = [];
  var x = function (key, label) { act.push('<button type="button" class="tip-lchip on" data-stclear="' + key + '">' + U.esc(label) + ' ✕</button>'); };
  if (live) {
    if (F.sample === 'trial') x('sample', 'Solo in prova 🧪');
    if (F.sample === 'stable') x('sample', 'Solo stabili');
    act = act.concat(tipEFilterChips(F, lf, 'data-stclear'));
  } else {
    if (F.m) x('m', (TIP_MARKETS.find(function (k) { return k[0] === F.m; }) || [0, F.m])[1]);
    if (F.lg) x('lg', TIP_LG_NAME[F.lg] || F.lg);
    if (F.top) x('top', F.top === 'top' ? 'Solo Top' : F.top === 'unknown' ? 'Top non documentata' : 'Fuori Top');
  }
  return '<div class="tip-lblf"><button type="button" class="tip-lchip tip-lfbtn" data-stfilters>⚲ Filtri' + (act.length ? ' (' + act.length + ')' : '') + '</button><button type="button" class="tip-lchip on" data-stfopen="period">📅 ' + U.esc(tipStRangeLabel()) + '</button>' + act.join('') + tipArchiveChip() + '</div>';
}
function tipCalHtml() {
  var R = tipStRange(), today = tipISO(new Date()), base = tipUI.stCal || today.slice(0, 7);
  var y = Number(base.slice(0, 4)), mo = Number(base.slice(5, 7)) - 1, first = new Date(y, mo, 1), start = (first.getDay() + 6) % 7, n = new Date(y, mo + 1, 0).getDate();
  var has = {};
  tipLiveAll().forEach(function (e) { has[tipLiveDay(e)] = 1; });
  (db.predictions || []).forEach(function (m) { if (tipNum(m.ft)) has[m.date] = 1; });
  var cells = '';
  for (var i = 0; i < start; i++) cells += '<span></span>';
  for (var dd = 1; dd <= n; dd++) {
    var iso = y + '-' + String(mo + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0'), inR = tipUI.stFrom && iso >= R.from && iso <= R.to;
    cells += '<button type="button" class="tip-calday' + (inR ? ' in' : '') + (iso === R.from || iso === R.to ? ' end' : '') + (has[iso] ? ' has' : '') + (iso === today ? ' today' : '') + '" data-calday="' + iso + '"' + (iso > today ? ' disabled' : '') + '>' + dd + '</button>';
  }
  var title = first.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  return '<div class="tip-cal"><div class="tip-calhead"><button type="button" data-calmo="-1">‹</button><b>' + tipCap(title) + '</b><button type="button" data-calmo="1">›</button></div><div class="tip-calgrid"><i>L</i><i>M</i><i>M</i><i>G</i><i>V</i><i>S</i><i>D</i>' + cells + '</div><p class="muted tip-hint">Tocca un giorno, poi un altro per scegliere più giorni. I giorni con dati hanno il puntino.</p></div>';
}
function tipStatFilterSheet(openKey) {
  var live = (tipUI.stArea || 'live') === 'live';
  var chip = function (kind, v, t) {
    var cur = kind === 'p' || kind === 'r' ? ((tipUI.lblF || {})[kind] || '') : ((live ? tipUI.stF : tipUI.stPF) || {})[kind] || '';
    return '<button type="button" class="tip-lchip' + (cur === String(v) ? ' on' : '') + '" data-stf="' + kind + ':' + v + '">' + t + '</button>';
  };
  var list = [], sec = function (t, body, lab, isSet) { list.push({ t: t, body: body, label: lab, isSet: isSet }); return ''; };
  var quick = '<div class="tip-lfgrid">' + [['Oggi', 0, 0], ['Ieri', 1, 1], ['7 giorni', 6, 0], ['30 giorni', 29, 0], ['Tutto', -1, 0]].map(function (q) { return '<button type="button" class="tip-lchip" data-calq="' + q[1] + ':' + q[2] + '">' + q[0] + '</button>'; }).join('') + '</div>';
  sec('Periodo', quick.replace(/^<div class="tip-lfgrid">|<\/div>$/g, '') + '<div data-calbox class="tip-fcal">' + tipCalHtml() + '</div>', tipStRangeLabel, function () { return !!tipUI.stFrom; });
  if (live) { sec('Campione', chip('sample', '', 'Totale') + chip('sample', 'stable', '◆ Stabili') + chip('sample', 'trial', '🧪 In prova')); tipEFilterSections(chip, sec, (tipUI.stF || {}).sample || ''); }
  else sec('Tipo', chip('m', '', 'Tutti') + TIP_MARKETS.map(function (k) { return chip('m', k[0], k[1]); }).join('')) +
    sec('Top', chip('top', '', 'Tutti') + chip('top', 'top', 'Solo Top') + chip('top', 'no', 'Fuori Top') + chip('top', 'unknown', 'Top non documentata')) +
    sec('Campionato', chip('lg', '', 'Tutti') + Object.keys(TIP_LG_NAME).map(function (k) { return chip('lg', k, TIP_LG_NAME[k]); }).join(''));
  var d = sheetModal(sheetHead(live ? 'Filtri · Live' : 'Filtri · Prepartita', { sub: 'Periodo e tipo di consiglio' }) + '<div class="tip-sheet">' + tipFilterTabs(list) +
    '</div>');
  d.classList.add('tip-dlg');
  var bindCal = function () {
    d.querySelectorAll('[data-calday]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var iso = b.dataset.calday;
        if (!tipUI.stFrom || tipUI._calPick !== 1) { tipUI.stFrom = iso; tipUI.stTo = iso; tipUI._calPick = 1; }
        else { if (iso < tipUI.stFrom) { tipUI.stTo = tipUI.stFrom; tipUI.stFrom = iso; } else tipUI.stTo = iso; tipUI._calPick = 0; }
        d.querySelector('[data-calbox]').innerHTML = tipCalHtml(); bindCal();
        var h = d.querySelector('.tip-lfsec'); if (h) h.textContent = 'Periodo · ' + tipStRangeLabel();
      };
    });
    d.querySelectorAll('[data-calmo]').forEach(function (b) {
      b.onclick = function (ev) {
        ev.stopPropagation();
        var base = tipUI.stCal || tipISO(new Date()).slice(0, 7), y = Number(base.slice(0, 4)), m = Number(base.slice(5, 7)) - 1 + Number(b.dataset.calmo);
        var nd = new Date(y, m, 1); tipUI.stCal = nd.getFullYear() + '-' + String(nd.getMonth() + 1).padStart(2, '0');
        d.querySelector('[data-calbox]').innerHTML = tipCalHtml(); bindCal();
      };
    });
  };
  bindCal();
  d.querySelectorAll('[data-calq]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      var q = b.dataset.calq.split(':'), today = tipISO(new Date());
      if (q[0] === '-1') { tipUI.stFrom = ''; tipUI.stTo = ''; } else { tipUI.stFrom = tipAddDays(today, -Number(q[0])); tipUI.stTo = tipAddDays(today, -Number(q[1])); }
      tipUI._calPick = 0; tipUI.stCal = (tipUI.stTo || today).slice(0, 7);
      d.querySelector('[data-calbox]').innerHTML = tipCalHtml(); bindCal();
      var h = d.querySelector('.tip-lfsec'); if (h) h.textContent = 'Periodo · ' + tipStRangeLabel();
    };
  });
  d.querySelectorAll('[data-stf]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      var kv = b.getAttribute('data-stf').split(':'), k = kv[0], v = kv[1] || '';
      if (k === 'p' || k === 'r') { tipUI.lblF = tipUI.lblF || {}; tipUI.lblF[k] = v; }
      else if (live) { tipUI.stF = tipUI.stF || {}; tipUI.stF[k] = v; }
      else { tipUI.stPF = tipUI.stPF || {}; tipUI.stPF[k] = v; }
      d.querySelectorAll('[data-stf^="' + k + ':"]').forEach(function (x) { x.classList.toggle('on', x === b); });
    };
  });
  tipFilterTabsBind(d, list, openKey ? TIP_F_SEC[openKey] : '');
  tipSheetTopActions(d, function () { if (live) { tipUI.stF = {}; tipUI.lblF = {}; } else tipUI.stPF = {}; tipUI.stFrom = undefined; d.close(); }, function () { d.close(); });
  d.addEventListener('close', function () { tipUI.histN = 10; render(); });
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest && ev.target.closest('[data-stfilters],[data-stclear],[data-sttab],[data-starea],[data-hist-more],[data-stfopen]');
  if (b && b.hasAttribute('data-stfopen')) return tipStatFilterSheet(b.getAttribute('data-stfopen'));
  if (!b) return;
  if (b.hasAttribute('data-stfilters')) return tipStatFilterSheet();
  if (b.hasAttribute('data-stclear') && tipLongPressed(b)) return tipStatFilterSheet(b.getAttribute('data-stclear'));
  if (b.dataset.sttab) tipUI.stTab = b.dataset.sttab;
  else if (b.dataset.starea) { tipUI.stArea = b.dataset.starea; tipUI.histN = 10; }
  else if (b.hasAttribute('data-hist-more')) tipUI.histN = (tipUI.histN || 10) + 10;
  else {
    var k = b.dataset.stclear;
    if (k === 'p' || k === 'r') { tipUI.lblF = tipUI.lblF || {}; tipUI.lblF[k] = ''; }
    else if ((tipUI.stArea || 'live') === 'live') { tipUI.stF = tipUI.stF || {}; tipUI.stF[k] = ''; }
    else { tipUI.stPF = tipUI.stPF || {}; tipUI.stPF[k] = ''; }
  }
  render();
});
/* esportazione per il retraining */
async function tipRetrainExport() {
  if (tipUI.exportBusy) return;
  tipUI.exportBusy = true;
  try {
  var pm = db.predModel || {};
  var data = { app: 'bet_tracker', kind: 'retraining-live', schemaVersion: 2, version: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '', exported: new Date().toISOString(),
    note: 'playLog = consigli live (un record per partita e punteggio): p probabilità, res 1/0/null, k tipo di giocata, snap = stato del modello, stats = statistiche live al momento, goalsAt = minuti dei gol',
    thresholds: { greenMin: TIP_GREEN_MINP, greenMin1T: TIP_GREEN_MINP_1T, leagueExtra: TIP_LG_EXTRA, typeExtra: TIP_K_EXTRA },
    playLog: pm.playLog || [], liveLog: pm.liveLog || [], lgAvg: tipUI.lgAvg || {}, reports: pm.reports || {},
    prematch: db.predictions || [] };
  data = JSON.parse(JSON.stringify(data));
  data.completeness = { signals: data.playLog.length, withStats: data.playLog.filter(function (e) { return !!e.stats; }).length,
    withModel: data.playLog.filter(function (e) { return !!e.snap; }).length, withBook: data.playLog.filter(function (e) { return !!e.book; }).length };
  data.trace = []; data.finals = [];
  var until = new Date().toISOString(), from = new Date(Date.now() - 7 * 86400e3).toISOString();
  data.serverRegistry = { from: from, until: until, complete: false, note: 'Registri server degli ultimi 7 giorni; solo finali confermati.' };
  try {
    if (!tipCanSync()) throw Error('Sincronizzazione non collegata: esportati solo i dati locali.');
    U.toast('Esportazione dei consigli e dei registri server degli ultimi 7 giorni…');
    for (var kind of ['trace', 'finals']) {
      var offset = 0;
      do {
        var page = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'training', kind: kind, from: from, until: until, offset: offset } });
        if (!page || !Array.isArray(page.rows) || page.error) throw Error((page && page.error) || 'Registro server non disponibile');
        data[kind] = data[kind].concat(page.rows);
        if (page.nextOffset != null && (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)) throw Error('Paginazione del registro non valida');
        offset = page.nextOffset;
      } while (offset != null);
    }
    data.serverRegistry.complete = true;
  } catch (e) { data.serverRegistry.error = e.message || String(e); }
  try { data.diag = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'diag' } }); } catch (e) { data.diag = { error: e.message || String(e) }; }
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = 'retraining-live-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  U.toast('Export: ' + data.playLog.length + ' consigli · ' + data.trace.length + ' osservazioni · ' + data.finals.length + ' finali verificati' +
    (data.serverRegistry.complete ? '' : '. Registri incompleti: ' + data.serverRegistry.error));
  } finally { tipUI.exportBusy = false; }
}
document.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('[data-retrain]')) tipRetrainExport(); });
document.addEventListener('click', function (ev) { if (ev.target.closest && ev.target.closest('[data-st-archive]')) { tipUI.stArchive = !tipUI.stArchive; render(); } });
function tipStatsResetNote() { return ''; }
/* 3.88.0 — Archivio: un chip tra i filtri (acceso = si vedono anche i dati prima dell'azzeramento e i tipi sospesi) */
function tipArchiveChip() {
  if (!((db.predModel || {}).statsFrom)) return '';
  return '<button type="button" class="tip-lchip' + (tipUI.stArchive ? ' on' : '') + '" data-st-archive title="Dati prima dell’azzeramento e tipi sospesi">🗄 Archivio' + (tipUI.stArchive ? ' ✕' : '') + '</button>';
}
function tipStatsPanel(list) {
  var A = tipUI.stArea || 'live', T = tipUI.stTab || 'riep';
  var seg = function (attr, k, t, cur) { return '<button type="button" class="tip-navb' + (cur === k ? ' on' : '') + '" ' + attr + '="' + k + '"><span>' + t + '</span></button>'; };
  var head = '<div class="tip-nav tip-subnav"><div class="tip-navseg">' + seg('data-starea', 'live', 'Live', A) + seg('data-starea', 'pre', 'Prepartita', A) + seg('data-starea', 'more', 'Altro', A) + '</div></div>';
  if (A === 'more') return head + (tipArchiveChip() ? '<div class="tip-lblf">' + tipArchiveChip() + '</div>' : '') + tipStatsPre(list);
  head += '<div class="tip-smpseg tip-mainseg" role="tablist">' + [['riep', 'Riepilogo'], ['storico', 'Storico']].map(function (x) { return '<button type="button" role="tab" aria-selected="' + (T === x[0]) + '" class="tip-smpbtn' + (T === x[0] ? ' on' : '') + '" data-sttab="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' + tipStatChips();
  var body = A === 'pre' ? (T === 'storico' ? tipStatsPreHistory(list) : tipStatsPreSummary(list)) : (T === 'storico' ? tipStatsLiveHistory() : tipStatsLiveSummary());
  return head + body + '<div class="actions"><button type="button" class="primary" data-retrain>⬇︎ Esporta per il retraining</button></div>';
}
function tipStatsPre(list) {
  var P = tipParams(),
    sum = tipSummary(tipClosedStats()),
    counts = { open: 0, live: 0, check: 0, done: 0 };
  list.forEach(function (m) {
    counts[tipState(m)]++;
  });
  var kpi = function (label, val, sub, cls) {
    return '<div class="card diary-kpi"><small>' + label + '</small><b class="' + (cls || '') + '">' + val + '</b><span>' + sub + '</span></div>';
  };
  var kpis =
    '<div class="diary-kpis">' +
    kpi('Vinti', tipPct(sum.rate), sum.n ? sum.w + ' su ' + sum.n + ' pronostici' : 'nessun esito ancora', sum.rate == null ? '' : sum.rate >= sum.exp ? 'positive' : 'negative') +
    kpi('Atteso dal modello', sum.n ? tipPct(sum.exp) : '—', 'media delle probabilità') +
    kpi('Da giocare', String(counts.open), counts.check ? counts.check + ' da verificare' : 'partite in programma') +
    kpi('Precisione', sum.brier == null ? '—' : sum.brier.toFixed(3), 'Brier: più basso è meglio') +
    '</div>';
  var rows = tipClosedStats();
  var mk =
    '<section class="card diary-card tip-markets"><h2>Andamento per mercato</h2>' +
    TIP_MARKETS.map(function (k) {
      var s = tipSummary(rows.filter(function (r) { return r.p.m === k[0]; }));
      var w = s.rate == null ? 0 : Math.max(2, s.rate);
      return (
        '<div class="tip-mrow"><div class="tip-mhead"><b>' + k[1] + '</b><span>' + (s.n ? s.w + '/' + s.n + ' · ' + tipPct(s.rate) + ' (atteso ' + tipPct(s.exp) + ')' : 'nessun esito') + '</span></div>' +
        '<div class="tip-bar"><i class="' + (s.rate != null && s.rate < s.exp - 5 ? 'low' : '') + '" style="width:' + w + '%"></i>' + (s.n ? '<em style="left:' + s.exp + '%"></em>' : '') + '</div></div>'
      );
    }).join('') +
    '</section>';
  /* 3.9.0 — Andamento delle liste Top (ricalcolate giorno per giorno) */
  var topRows = {}, days = [];
  list.forEach(function (m) { if (days.indexOf(m.date) < 0) days.push(m.date); });
  days.forEach(function (day) {
    var T = tipTopFor(day, list, P);
    TIP_TOP_MK.forEach(function (mk) {
      T[mk[0]].items.forEach(function (c) {
        var o = tipOutcome(c.m, c.p);
        if (o.s === 'V' || o.s === 'P') (topRows[mk[0]] = topRows[mk[0]] || []).push({ p: c.p, won: o.s === 'V' });
      });
    });
  });
  mk +=
    '<section class="card diary-card tip-markets"><h2>Andamento liste Top</h2>' +
    TIP_TOP_MK.map(function (k) {
      var s = tipSummary(topRows[k[0]] || []);
      var w = s.rate == null ? 0 : Math.max(2, s.rate);
      return (
        '<div class="tip-mrow"><div class="tip-mhead"><b>' + k[1] + '</b><span>' + (s.n ? s.w + '/' + s.n + ' · ' + tipPct(s.rate) + ' (atteso ' + tipPct(s.exp) + ')' : 'nessun esito') + '</span></div>' +
        '<div class="tip-bar"><i class="' + (s.rate != null && s.rate < s.exp - 5 ? 'low' : '') + '" style="width:' + w + '%"></i>' + (s.n ? '<em style="left:' + s.exp + '%"></em>' : '') + '</div></div>'
      );
    }).join('') +
    '</section>';
  /* 3.10.0 — Calibrazione: promesso vs reale per fasce */
  var bands = [[75, 79], [80, 84], [85, 89], [90, 100]];
  mk += '<section class="card diary-card tip-markets"><h2>Promesso e reale</h2><table class="tip-caltab"><tr><th></th>' + bands.map(function (b) { return '<th>' + b[0] + (b[1] < 100 ? '-' + b[1] : '+') + '%</th>'; }).join('') + '</tr>' +
    ['ht05', 'o15'].map(function (k) {
      var rr = (tipCalRows()[k] || []);
      return '<tr><th>' + (k === 'ht05' ? 'Over 0.5 1T' : 'Over 1.5') + '</th>' + bands.map(function (b) {
        var x = rr.filter(function (r) { return r[0] >= b[0] && r[0] <= b[1]; });
        if (!x.length) return '<td>—</td>';
        var real = x.reduce(function (s2, r) { return s2 + r[1]; }, 0) / x.length * 100;
        var exp = x.reduce(function (s2, r) { return s2 + r[0]; }, 0) / x.length;
        return '<td class="' + (real < exp - 5 ? 'neg' : real > exp + 2 ? 'pos' : '') + '"><b>' + Math.round(real) + '%</b><small>atteso ' + Math.round(exp) + ' · ' + x.length + '</small></td>';
      }).join('') + '</tr>';
    }).join('') + '</table></section>';
  /* 3.10.0 — Statistiche, quote o mix: chi sbaglia meno (Brier, più basso è meglio) */
  var src = { s: { o15: [0, 0], ht05: [0, 0] }, q: { o15: [0, 0], ht05: [0, 0] }, b: { o15: [0, 0], ht05: [0, 0] } };
  list.forEach(function (m) {
    if (m.cancelled || !U.finite(m.lhS) || !U.finite(m.lhM)) return;
    var add = function (key, mm) {
      var c = tipCalc(mm, P);
      if (tipNum(m.ft)) { var y = m.ft[0] + m.ft[1] >= 2 ? 1 : 0; src[key].o15[0] += Math.pow(c.o15 / 100 - y, 2); src[key].o15[1]++; }
      if (tipNum(m.ht)) { var z = m.ht[0] + m.ht[1] >= 1 ? 1 : 0; src[key].ht05[0] += Math.pow(c.ht05 / 100 - z, 2); src[key].ht05[1]++; }
    };
    add('s', Object.assign({}, m, { lh: m.lhS, la: m.laS }));
    add('q', Object.assign({}, m, { lh: m.lhM, la: m.laM }));
    add('b', m);
  });
  var br = function (x) { return x[1] ? (x[0] / x[1]).toFixed(3) : '—'; };
  mk += '<section class="card diary-card tip-markets"><h2>Statistiche, quote o mix?</h2><p class="muted">Errore medio: più basso è meglio.</p><table class="tip-caltab"><tr><th></th><th>Solo statistiche</th><th>Solo quote</th><th>Mix usato</th></tr>' +
    [['o15', 'Over 1.5'], ['ht05', 'Over 0.5 1T']].map(function (k) {
      return '<tr><th>' + k[1] + ' <small>(' + src.b[k[0]][1] + ')</small></th><td>' + br(src.s[k[0]]) + '</td><td>' + br(src.q[k[0]]) + '</td><td>' + br(src.b[k[0]]) + '</td></tr>';
    }).join('') + '</table></section>';
  /* 3.10.0 — Piano 1° tempo sulle Top: risultato reale */
  var pr = { n: 0, pl: 0, unk: 0, z: 0 };
  days.forEach(function (day) {
    tipTopFor(day, list, P).ht05.items.forEach(function (c) {
      var m = c.m;
      if (!tipNum(m.ht) || m.cancelled) return;
      var x = tipPlan(c.p.p), q = x.pl;
      pr.n++;
      if (m.ht[0] + m.ht[1] === 0) { pr.pl -= q.s1 + q.s2; pr.z++; }
      else if (Number.isInteger(m.fg)) pr.pl += m.fg <= 30 ? q.s1 * (q.q1 - 1) : q.s2 * (q.q2 - 1) - q.s1;
      else pr.unk++;
    });
  });
  mk += '<section class="card diary-card tip-markets"><h2>Piano 1° tempo sulle Top</h2><p class="muted">' + (pr.n ? pr.n + ' partite giocate, ' + pr.z + ' finite 0-0 al 45\'. Risultato con quote del piano: <b class="' + (pr.pl >= 0 ? 'positive' : 'negative') + '">' + (pr.pl >= 0 ? '+' : '') + pr.pl.toFixed(2) + '€</b>' + (pr.unk ? ' (' + pr.unk + ' senza minuto del primo gol: segnalo nel dettaglio partita)' : '') + '.' : 'Nessuna partita delle Top 1° tempo con il risultato del 1° tempo segnato.') + '</p></section>';
  var L = tipLearn(),
    learned = (db.predModel || {}).learned;
  var cal = '<section class="card diary-card money-card tip-cal"><h2>Il modello impara</h2>';
  if (L.n < 10) {
    cal += '<p class="muted">Servono almeno 10 partite con il risultato per stimare le correzioni (ora ' + L.n + ').</p>';
  } else {
    var lgRows = Object.keys(L.leagueRaw)
      .filter(function (k) { return L.leagueRaw[k].n >= 5; })
      .sort(function (a, b) { return L.leagueRaw[b].n - L.leagueRaw[a].n; })
      .slice(0, 8)
      .map(function (k) {
        var x = L.leagueRaw[k];
        return '<li><span>' + U.esc(k) + ' <small>(' + x.n + ')</small></span><b>' + (x.a / x.n).toFixed(2) + ' gol</b><i>attesi ' + (x.e / x.n).toFixed(2) + '</i></li>';
      })
      .join('');
    cal +=
      '<div class="money-grid tip-cal-grid">' +
      '<div><small>Gol per partita</small><b>' + (L.goals.actual / L.n).toFixed(2) + '</b><span>attesi ' + (L.goals.expected / L.n).toFixed(2) + ' · correzione ×' + L.goalFactor.toFixed(2) + '</span></div>' +
      '<div><small>Pareggi</small><b>' + Math.round((L.draws.actual / L.n) * 100) + '%</b><span>attesi ' + Math.round((L.draws.expected / L.n) * 100) + '% · ×' + L.drawBoost.toFixed(2) + '</span></div>' +
      '<div><small>Gol nel 1° tempo</small><b>' + (L.htShare == null ? '—' : Math.round(L.htShare * 100) + '%') + '</b><span>' + (L.htN ? 'su ' + L.htN + ' gol con 1° tempo segnato' : 'segna i risultati del 1° tempo') + '</span></div>' +
      '<div><small>Partite usate</small><b>' + L.n + '</b><span>' + (learned ? 'correzioni attive dal ' + U.esc(dLabel(learned.at.slice(0, 10))) : 'correzioni non applicate') + '</span></div>' +
      '</div>' +
      (lgRows ? '<ul class="tip-leagues">' + lgRows + '</ul>' : '') +
      '<p class="muted tip-hint">Gol nel 1° tempo corretti per ' + Object.keys(L.htLeague || {}).length + ' campionati' + (L.early ? ' · gol entro il 30\': ' + Math.round(L.early * 100) + '% dei gol del 1° tempo (da ' + L.earlyN + ' partite)' : ' · per la quota di gol entro il 30\' servono 10 partite con il minuto del primo gol (ora ' + (L.earlyN || 0) + ')') + '.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-learn>Applica correzioni</button>' + (learned ? '<button type="button" data-tip-unlearn>Torna al modello di base</button>' : '') + '</div>';
  }
  cal += '</section>';
  return kpis + tipReportPanel() + tipLiveLogPanel() + mk + cal;
}
/* ---------- 3.10.0 — Calibrazione con lo storico ----------
   Per ogni mercato: tra i pronostici già chiusi con probabilità vicina (±4 punti) si conta
   quanti hanno vinto davvero. La stima viene spostata verso quel valore, con prudenza:
   pesa come 25 pronostici "teorici", quindi con pochi risultati cambia poco. */
function tipCalRows() {
  if (tipUI._cal) return tipUI._cal;
  var by = {};
  /* 3.14.0 — solo i pronostici del modello attuale (con quote): quelli dei modelli
     precedenti erano più ottimisti e falserebbero la correzione */
  var cur = ((db.predModel || {}).base || {}).version;
  tipClosed().forEach(function (r) {
    if (/^(Under|No goal)/.test(r.p.sel)) return;
    if (cur === '3' && !r.m.src) return;
    (by[r.p.m] = by[r.p.m] || []).push([r.p.raw == null ? r.p.p : r.p.raw, r.won ? 1 : 0]);
  });
  tipUI._cal = by;
  return by;
}
function tipCal(k, p) {
  var rows = (tipCalRows()[k] || []).filter(function (r) { return Math.abs(r[0] - p) <= 4; });
  if (!rows.length) return p;
  var K = 15, /* 3.89.0 — Over 1.5 77% contro 84% previsto: la correzione con lo storico pesa di più (era 25) */
    w = rows.reduce(function (s, r) { return s + r[1]; }, 0),
    e = rows.reduce(function (s, r) { return s + r[0] / 100; }, 0);
  /* correzione = (vinti reali − attesi) diluita */
  /* 3.14.0 — prudenza: verso il basso si corregge del tutto, verso l'alto al massimo +1 punto */
  var d = ((w - e) / (rows.length + K)) * 100;
  return Math.round(Math.max(1, Math.min(99, p + Math.min(d, 1))));
}
/* ---------- 3.9.0 — Liste Top ----------
   Per ogni giorno e per ogni mercato: si parte dalla partita più solida e si aggiungono
   le altre finché la MEDIA delle probabilità resta sopra l'obiettivo del mercato
   (1T 80%, Over 1.5 85%...). Il numero di partite quindi cambia ogni giorno.
   Ordine: probabilità + piccolo bonus se c'è una favorita netta (dalle quote),
   piccola penalità per le partite equilibrate. Entrano solo partite con le quote Over
   del book (topSkip nel file = esclusa, con il motivo). 3.70.0: ordine per probabilità, la quota non esclude. */
var TIP_TIER_LABEL = { 'minor+': 'campionato minore', minor: 'campionato minore', 'youth+': 'giovanili', youth: 'giovanili', women: 'femminile' };
var TIP_TOP_MK = [
  ['ht05', 'Over 0.5 1° tempo'],
  ['o15', 'Over 1.5'],
  ['o25', 'Over 2.5'],
  ['gg', 'Goal'],
];
function tipFavBonus(m, k) {
  if (k === '1x2' || !m.fav) return 0;
  var f = m.fav;
  if (f >= 50) return Math.min(1, (f - 50) / 25) * 3;
  return f < 42 ? -1.5 : 0;
}
function tipTopCandidates(day, list, P) {
  P = P || tipParams();
  var res = {};
  TIP_TOP_MK.forEach(function (mk) {
    var k = mk[0],
      target = tipTarget(P, k),
      cand = [], skip = {};
    list.forEach(function (m) {
      var out = function (why) { if (m.date === day && (m.picks || []).some(function (x) { return x.m === k && !/^(Under|No goal)/.test(x.sel); })) skip[m.id] = why; };
      if (m.date === day && !m.cancelled && (m.warn || !m.odds || !(m.odds.o15 || m.odds.o25 || m.odds.gl) || (m.topSkip && !m.odds.o25 && !m.odds.gl)))
        return out(m.warn ? 'avviso sulla partita' : 'quote Over del book non disponibili');
      /* 3.50.0 — bastano le quote Over del book (1.5 o 2.5): le partite automatiche spesso non hanno l'Over 1.5 */
      if (m.date !== day || m.cancelled || m.warn || !m.odds || !(m.odds.o15 || m.odds.o25 || m.odds.gl)) return;
      if (m.topSkip && !m.odds.o25 && !m.odds.gl) return;
      var pk = (m.picks || []).find(function (x) { return x.m === k; });
      if (!pk) return;
      /* niente Under / No goal nelle Top: solo i lati "Over / Goal / segno" */
      if (/^(Under|No goal)/.test(pk.sel)) return;
            /* 3.10.0 — probabilità corretta con lo storico (calibrazione) */
      var pc = tipCal(k, pk.p),
        pp = Object.assign({}, pk, { p: pc, raw: pk.p });
      /* 3.70.0 — la quota non esclude più: la Top sceglie le partite che segnano.
         Sotto 1.50 si gioca a step o live, come da regola (vedi "quota di pareggio" nella riga). */
      cand.push({ m: m, p: pp, score: pc + tipFavBonus(m, k) });
    });
    /* 3.70.0 — prima la probabilità; la favorita netta conta solo a parità */
    cand.sort(function (a, b) { return b.p.p - a.p.p || b.score - a.score; });
    /* 3.59.0 — con le quote vere (bet365) poche partite arrivano alla media dell'85%: la Top prende le migliori
       del giorno sopra una soglia minima (obiettivo − 8 punti), al massimo 10 per mercato */
    var pickd = [], sum = 0, floor = target - 8;
    cand.forEach(function (c) {
      var tier = tipLeagueTier(c.m), need = floor + (TIP_PRE_LG_EXTRA[tier] || 0);
      if (c.p.p < need) { skip[c.m.id] = 'serve almeno ' + need + '%' + (TIP_PRE_LG_EXTRA[tier] ? ' (' + TIP_TIER_LABEL[tier] + ')' : ''); return; }
      if (tipFavBonus(c.m, k) < 0 && c.p.p < target - 4) { skip[c.m.id] = 'partita equilibrata: serve almeno ' + (target - 4) + '%'; return; }
      if (pickd.length >= 10) { skip[c.m.id] = 'già 10 partite più probabili in Top'; return; }
      pickd.push(c); sum += c.p.p;
    });
    /* 3.14.0 — Top allargata: fino a 3 punti sotto l'obiettivo, fuori dalla Top sicura.
       Si giocano solo se la quota del book supera la quota minima indicata. */
    var inTop = {};
    pickd.forEach(function (c) { inTop[c.m.id] = 1; });
    var ext = cand.filter(function (c) { return false && !inTop[c.m.id]; })
      .sort(function (a, b) { return b.p.p - a.p.p || b.score - a.score; })
      .slice(0, 10);
    res[k] = { items: pickd, skip: skip, ext: ext, avg: pickd.length ? sum / pickd.length : null, target: target, cand: cand.length, near: pickd.length || ext.length ? [] : cand.slice(0, 3) };
  });
  /* Top assoluti: tutte le liste insieme, una riga per partita (il pronostico con più margine sull'obiettivo). */
  var best = {};
  TIP_TOP_MK.forEach(function (mk) {
    res[mk[0]].items.forEach(function (c) {
      var margin = c.p.p - res[mk[0]].target + tipFavBonus(c.m, mk[0]);
      if (!best[c.m.id] || margin > best[c.m.id].margin) best[c.m.id] = { m: c.m, p: c.p, margin: margin };
    });
  });
  res.all = Object.keys(best).map(function (id) { return best[id]; }).sort(function (a, b) { return b.margin - a.margin; });
  return res;
}
/* Le Top pubblicate sono lette dallo stesso record usato dalle statistiche. */
function tipTopFor(day, list, P) {
  P = P || tipParams();
  var res = {}, best = {};
  TIP_TOP_MK.forEach(function (mk) {
    var k = mk[0], target = tipTarget(P, k), items = [];
    list.forEach(function (m) {
      var issue = m.preIssue;
      if (m.date !== day || m.cancelled || !issue || !issue.top || !issue.top[k]) return;
      var p = issue.picks.find(function (p) { return p.m === k; });
      if (!p) return;
      var original = Object.assign({}, m, issue.inputs);
      items.push({ m: original, p: p, rank: issue.top[k], score: p.p });
    });
    items.sort(function (a, b) { return a.rank - b.rank || a.m.id.localeCompare(b.m.id); });
    res[k] = { items: items, ext: [], avg: items.length ? items.reduce(function (s, c) { return s + c.p.p; }, 0) / items.length : null, target: target, cand: items.length, near: [] };
    items.forEach(function (c) {
      var margin = c.p.p - target;
      if (!best[c.m.id] || margin > best[c.m.id].margin) best[c.m.id] = { m: c.m, p: c.p, margin: margin };
    });
  });
  res.all = Object.keys(best).map(function (k) { return best[k]; }).sort(function (a, b) { return b.margin - a.margin; });
  return res;
}
/* 3.9.2 — Piano a due passi sul 1° tempo: 1) gol entro il 30'; 2) se 0-0 al 30', Over 0.5 1T live.
   Si suppone che il 62% dei gol del 1° tempo arrivi entro il 30' (model.plan.early).
   Quote giuste: sotto queste quote la puntata perde valore. */
function tipPlan(p) {
  var P = tipParams(),
    pl = Object.assign({ s1: 10, s2: 20, q1: 1.8, q2: 2.5, early: 0.62 }, P.plan || {});
  if (P.early) pl.early = P.early;
  var l = -Math.log(1 - Math.min(p, 99) / 100),
    p1 = 1 - Math.exp(-pl.early * l),
    c = 1 - Math.exp(-(1 - pl.early) * l),
    p2 = (1 - p1) * c,
    p0 = 1 - p1 - p2;
  return {
    p1: p1, c: c, p2: p2, p0: p0, pl: pl,
    fair1: 1 / p1,
    fair2: 1 / c,
    ev: pl.s1 * (pl.q1 - 1) * p1 + (pl.s2 * (pl.q2 - 1) - pl.s1) * p2 - (pl.s1 + pl.s2) * p0,
  };
}
/* 3.11.0 — Controllo live al 30' sullo 0-0.
   Si confrontano tiri, tiri in porta, angoli (e xG se c'è) con quanto ci si aspettava
   dopo 30' per quella partita. La spinta osservata corregge il ritmo di gol per gli
   ultimi 15' + recupero, con prudenza (pesa metà, limiti 0,5-1,7). */
function tipLive(pHt, lhtot, inp) {
  var x = tipPlan(pHt),
    lht = -Math.log(1 - Math.min(pHt, 99) / 100),
    scale = Math.sqrt((lhtot || 2.7) / 2.7),
    exp = { s: 8 * scale, t: 2.8 * scale, c: 3.3 * scale, xg: lht * x.pl.early },
    w = (inp.s || 0) + 2 * (inp.t || 0) + 0.5 * (inp.c || 0),
    ew = exp.s + 2 * exp.t + 0.5 * exp.c,
    f = (w + ew) / (2 * ew);
  if (U.finite(inp.xg)) f = 0.5 * f + 0.5 * ((inp.xg + exp.xg) / (2 * exp.xg));
  if (inp.red) f *= 1.15;
  f = Math.max(0.5, Math.min(1.7, f));
  var rest = (1 - x.pl.early) * lht * f,
    p = 1 - Math.exp(-rest);
  return { f: f, p: p, fair: 1 / p, base: x.c, exp: exp };
}
/* 3.71.0 — Over 1.5 pagato poco: a 0-0 la quota sale con i minuti. Minuto in cui il book arriva circa a 1.50
   (dalla sua quota pre-partita) e probabilità del modello in quel momento. Se segnano prima, l'Over 1.5 diventa
   "altro gol" e lo segue il Live. */
function tipO15Wait(p, odd) {
  if (!U.finite(odd) || odd >= 1.5 || odd <= 1 || !U.finite(p)) return null;
  var solve = function (pp) { var lo = 0.05, hi = 9; for (var i = 0; i < 40; i++) { var md = (lo + hi) / 2; if (tipPoisAtLeast(2, md) < pp) lo = md; else hi = md; } return (lo + hi) / 2; };
  var lb = solve(Math.min(0.99, 1 / odd)), lm = solve(Math.min(0.99, p / 100));
  for (var t = 5; t <= 80; t++) {
    var f = (94 - t) / 94;
    if (tipPoisAtLeast(2, lb * f) <= 1 / 1.5) return { min: t, p: tipPoisAtLeast(2, lm * f) };
  }
  return null;
}
function tipTopRow(c, i) {
  var m = c.m,
    o = tipOutcome(m, c.p),
    odd = tipOdd(m, c.p),
    st = TIP_ST[o.s];
  return (
    '<button type="button" class="tip-trow ' + st + '" data-tip-open="' + U.esc(m.id) + '">' +
    '<span class="tip-tn">' + (i + 1) + '</span>' +
    '<span class="tip-tmain"><b>' + U.esc(m.home) + ' – ' + U.esc(m.away) + '</b><small>' + U.esc(m.time) + ' · ' + U.esc(m.league) + (m.fav ? ' · favorita ' + m.fav + '%' : '') + '</small></span>' +
    '<span class="tip-tpick"><b>' + U.esc(c.p.sel) + '</b><small>' + c.p.p + '%' + (c.p.raw != null && c.p.raw !== c.p.p ? ' (stima ' + c.p.raw + '%)' : '') + (odd ? ' · @' + odd.toFixed(2) : '') + '</small>' +
    '<small class="tip-plan">quota di pareggio ' + (100 / c.p.p).toFixed(2) + (odd ? ' · quota alla pubblicazione' : ' · quota book non disponibile') + '</small>' +
    (function () {
      if (c.p.m !== 'o15' || c.p.sel !== 'Over 1.5') return '';
      /* senza la quota Over 1.5 del book: stimata dai gol attesi delle quote (con il margine del book, circa 5%) */
      var q = odd, est = false;
      if (!q && U.finite(m.lhM) && U.finite(m.laM)) { var pm = tipPoisAtLeast(2, m.lhM + m.laM); if (pm > 0.05) { q = 0.95 / pm; est = true; } }
      var w = tipO15Wait(c.p.p, q);
      return w ? '<small class="tip-plan">' + (est ? 'quota stimata ~' + q.toFixed(2) : 'quota bassa') + ': a 0-0 sale a 1.50 verso il ' + w.min + '’ · lì il modello dà ' + Math.round(w.p * 100) + '%' + (w.p * 1.5 >= 1 ? ' (c’è valore)' : ' (senza valore)') + '</small>' : '';
    })() +
    '</span>' +
    (o.s ? '<em class="tip-tmark" aria-label="' + { V: 'vinto', P: 'perso', N: 'annullato' }[o.s] + '">' + { V: '✓', P: '✕', N: '–' }[o.s] + '</em>' : '') +
    '</button>'
  );
}
/* ---------- 3.27.0 — Prepartita: "Da giocare" solo dove c'è valore ----------
   Stesse regole del live: partita da gol (soglie Top), segnano almeno al 60%, quota ≥ 1.50;
   se c'è la quota del book deve essere almeno la quota giusta (valore). Il gol nel 1° tempo
   (quote basse) si gioca a step: gol entro il 30' prepartita, poi il Live al 30' se ancora 0-0. */
function tipPreValue(m, top) {
  var MINQ = Math.max(TIP_MIN_ODDS, tipLiveMinQ()), issue = m.preIssue, source = issue ? Object.assign({}, m, issue.inputs) : m;
  return (m.picks || []).filter(function (p) { return !/^(Under|No goal)/.test(p.sel); }).map(function (p) {
    var probability = p.p / 100, book = tipOdd(source, p), need = Math.max(MINQ, 1 / Math.max(0.01, probability));
    return { k: p.m, label: p.sel, p: probability, book: book, need: need, ev: book ? probability * book - 1 : 0, ok: !!(book && book >= need) };
  }).filter(function (r) { return r.p >= TIP_LIVE_MINP && (r.ok || (top && top[r.k])); })
    .sort(function (a, b) { return (b.ok - a.ok) || b.ev - a.ev || b.p - a.p; });
}

/* partite nelle Top (1° tempo e Over 1.5), per giorno; calcolo tenuto per un minuto */
function tipTopIds(list) {
  list = list || db.predictions || [];
  var key = list.length + '|' + Math.floor(Date.now() / 60e3);
  var P = tipParams(), inTop = {}, days = [];
  list.forEach(function (m) { if (days.indexOf(m.date) < 0) days.push(m.date); });
  days.forEach(function (d) {
    var T = tipTopFor(d, list, P);
    TIP_TOP_MK.map(function (mk) { return mk[0]; }).forEach(function (k) {
      if (!T[k]) return;
      (T[k].items || []).concat(T[k].ext || []).forEach(function (c) { (inTop[c.m.id] = inTop[c.m.id] || {})[k] = true; });
    });
  });
  tipUI._topIds = { key: key, map: inTop };
  return inTop;
}
function tipPrePlayPanel(list) {
  var now = Date.now(), inTop = tipTopIds(list);
  var items = list.filter(function (m) {
    var ko = tipKickoff(m).getTime();
    if (m.cancelled || tipNum(m.ft) || ko < now - 5 * 60e3 || ko > now + 36 * 3600e3) return false;
    return tipUI.day === 'all' || !tipUI.day || m.date === tipUI.day;
  }).map(function (m) { return { m: m, rec: tipPreValue(m, inTop[m.id]) }; }).filter(function (x) { return x.rec.length; });
  items.sort(function (a, b) { return (b.rec[0].ok - a.rec[0].ok) || (b.rec[0].ev - a.rec[0].ev) || (tipKickoff(a.m) - tipKickoff(b.m)); });
  var withVal = items.filter(function (x) { return x.rec[0].ok; }).length;
  var row = function (x) {
    var m = x.m;
    return '<button type="button" class="tip-trow tip-prerow" data-tip-open="' + U.esc(m.id) + '"><span class="tip-tn tip-ln">' + U.esc(m.time) + '</span><span class="tip-tmain"><b>' + U.esc(m.home) + ' – ' + U.esc(m.away) + '</b><small>' +
      x.rec.slice(0, 2).map(function (r) {
        return '<span class="' + (r.ok ? 'positive' : '') + '">' + U.esc(r.label) + ' ' + Math.round(r.p * 100) + '% · ' + (r.ok ? 'book ' + r.book.toFixed(2) + ' ✓' : 'da ' + r.need.toFixed(2)) + '</span>' + (r.extra ? '<i> · ' + U.esc(r.extra) + '</i>' : '');
      }).join('<br>') + '</small></span><span class="tip-tpick"><small>' + U.esc(m.league) + '</small></span></button>';
  };
  return '<section class="card tip-top"><div class="tip-top-head"><b>Da giocare (prepartita)</b><span>' + items.length + ' partite · ' + withVal + ' con valore sul book</span></div>' +
    (items.length ? '<div class="tip-tlist">' + items.slice(0, 25).map(row).join('') + '</div>' : '<p class="muted tip-tnone">Niente da giocare prepartita: nessuna partita da gol con quota 1.50 raggiungibile.</p>') +
    '<p class="muted tip-hint">✓ = la quota del book è sopra la minima. “da X” = gioca solo se trovi almeno X.</p></section>';
}
function tipTopPanel(list) {
  var P = tipParams(),
    today = U.local().slice(0, 10),
    days = [];
  list.forEach(function (m) { if (days.indexOf(m.date) < 0) days.push(m.date); });
  days.sort();
  var hasOdds = function (d) { return list.some(function (m) { return m.date === d && m.odds && (m.odds.o15 || m.odds.o25 || m.odds.gl); }); };
  var shown = tipUI.day !== 'all' ? [tipUI.day] : days.filter(function (d) { return d >= today && hasOdds(d); });
  if (!shown.length) shown = days.slice(-1);
  var chips = '<div class="tip-chips tip-topdays">' + ['all'].concat(days).map(function (d) {
    var on = tipUI.day === d;
    return '<button type="button" class="tip-chip' + (on ? ' on' : '') + '" data-tip-day="' + d + '">' + (d === 'all' ? 'Da oggi' : U.esc(tipCap(tipDayLabel(d)))) + '</button>';
  }).join('') + '</div>';
  var html = '<p class="muted tip-hint">Top aggiornate fino al calcio d’inizio di ogni partita, poi bloccate. Fino a 10 per mercato, in ordine di probabilità.</p>';
  void chips;
  shown.forEach(function (day) {
    var T = tipTopFor(day, list, P);
    html += '<h2 class="tip-day"><span>' + tipDayLabel(day, true) + '</span><small>' + T.all.length + (T.all.length === 1 ? ' partita in Top' : ' partite in Top') + '</small></h2>';
    var sec = function (title, items, avg, target, extra) {
      return (
        '<section class="card tip-top">' +
        '<div class="tip-top-head"><b>' + title + '</b><span>' + (items.length ? 'media ' + Math.round(avg) + '%' + (target ? ' · obiettivo ' + target + '%' : '') : 'nessuna partita') + '</span></div>' +
        (items.length ? '<div class="tip-tlist">' + items.map(tipTopRow).join('') + '</div>' : '<p class="muted tip-tnone">' + (extra || 'Oggi nessuna partita tiene la media richiesta.') + '</p>') +
        '</section>'
      );
    };
    var allAvg = T.all.length ? T.all.reduce(function (s, c) { return s + c.p.p; }, 0) / T.all.length : null;
    html += sec('★ Top di tutti i mercati', T.all, allAvg, null, 'Nessuna Top registrata per questo giorno.');
    TIP_TOP_MK.forEach(function (mk) {
      var r = T[mk[0]];
      var near = r.near.length ? ' Le più vicine: ' + r.near.map(function (c) { return U.esc(c.m.home) + ' – ' + U.esc(c.m.away) + ' ' + c.p.p + '%'; }).join(', ') + '.' : '';
      html += sec('Top ' + mk[1], r.items, r.avg, r.target, r.cand ? 'Nessuna partita arriva al ' + r.target + '% di media.' + near : 'Nessuna candidata con quote complete.');
      if ((mk[0] === 'ht05' || mk[0] === 'o15') && r.ext.length) {
        html +=
          '<section class="card tip-top tip-top-ext"><div class="tip-top-head"><b>Top allargata · ' + mk[1] + '</b><span>' + (r.target - 3) + '-' + (r.target - 1) + '%</span></div>' +
          '<p class="muted tip-tnone">' + (mk[0] === 'ht05'
            ? 'Da giocare solo se il book paga più delle quote minime: gol entro il 30\' sopra la prima, live al 30\' sullo 0-0 sopra la seconda. Altrimenti si salta.'
            : 'Da giocare solo se la quota Over 1.5 del tuo book è sopra la quota minima. Altrimenti si salta.') + '</p>' +
          '<div class="tip-tlist">' + r.ext.map(tipTopRow).join('') + '</div></section>';
      }
    });
  });
  return html;
}
/* Riquadro quote nel dettaglio partita */
function tipOddsBlock(m) {
  var o = m.odds || {},
    k = m.mkt || {};
  if (!Object.keys(o).length) return '<p class="muted tip-hint">Quote non disponibili: probabilità solo dal modello statistico.</p>';
  var op = m.oddsOpen || {},
    keyOf = { '1': '1', X: 'X', '2': '2', 'Over 1.5': 'o15', 'Over 2.5': 'o25', Goal: 'gg' };
  var cell = function (label, odd, impl) {
    var o0 = op[keyOf[label]],
      mv = o0 && odd && Math.abs(o0 - odd) >= 0.01 ? '<i class="tip-mv ' + (odd < o0 ? 'dn' : 'up') + '">' + (odd < o0 ? '▼' : '▲') + ' da ' + o0.toFixed(2) + '</i>' : '';
    return '<div class="tip-prob"><small>' + label + '</small><b>' + (odd ? odd.toFixed(2) : '—') + '</b>' + (impl != null ? '<i>' + Math.round(impl) + '%</i>' : '') + mv + '</div>';
  };
  return (
    '<h3 class="tip-sub">Quote del book <small>media dei bookmaker, % senza margine</small></h3>' +
    '<div class="tip-probs tip-odds">' + cell('1', o['1'], k.p1) + cell('X', o.X, k.px) + cell('2', o['2'], k.p2) + cell('Over 1.5', o.o15, k.o15) + cell('Over 2.5', o.o25, k.o25) + cell('Goal', o.gg) + '</div>' +
    (U.finite(m.lhS) && U.finite(m.lhM)
      ? '<p class="muted tip-hint">Gol attesi: statistiche ' + m.lhS.toFixed(2) + '–' + m.laS.toFixed(2) + ' · quote ' + m.lhM.toFixed(2) + '–' + m.laM.toFixed(2) + ' · usati ' + m.lh.toFixed(2) + '–' + m.la.toFixed(2) + ' (peso quote ' + Math.round((m.wMkt || 0) * 100) + '%).' + (U.finite(m.hts) ? ' Gol nel 1° tempo: ' + Math.round(m.hts * 100) + '% del totale.' : '') + '</p>'
      : '') +
    (m.topSkip ? '<p class="muted tip-hint">Esclusa dalle Top: ' + U.esc(m.topSkip) + '.</p>' : '') + tipTopWhyHtml(m)
  );
}
/* 3.4.1 — Ordinamento: ora oppure probabilità (pronostico migliore o un mercato). */
try {
  var _ts = localStorage.getItem('bet_tip_sort');
  if (_ts && ['time', 'best', 'o15', 'o25', 'ht05', 'gg'].indexOf(_ts) >= 0) tipUI.sort = _ts;
} catch (e) {}
var TIP_SORTS = [
  ['time', 'Ora di inizio'],
  ['best', 'Pronostico più probabile'],
  ['o15', 'Over 1.5'],
  ['o25', 'Over 2.5'],
  ['ht05', 'Over 0.5 1° tempo'],
  ['gg', 'Goal'],
];
function tipSortValue(m, key) {
  if (key === 'best')
    return (m.picks || []).reduce(function (mx, p) {
      return Math.max(mx, p.p);
    }, 0);
  var p = (m.picks || []).find(function (p) { return p.m === key; });
  return p ? p.p : -1;
}
function tipSortLabel(m, key) {
  if (key === 'best') {
    var b = (m.picks || []).slice().sort(function (a, z) {
      return z.p - a.p;
    })[0];
    return b ? b.sel : '';
  }
  if (key === '1x2') {
    var c = tipCalc(m);
    return 'Segno ' + (c.p1 >= c.px && c.p1 >= c.p2 ? '1' : c.p2 >= c.px ? '2' : 'X');
  }
  var p = (m.picks || []).find(function (p) { return p.m === key; });
  return p ? p.sel : 'Nessun consiglio emesso';
}
function tipCap(t) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}
/* 3.5.0 — Un pulsante per tipo di filtro: apre un pannello con le scelte. */
function tipFilterSheet(key) {
  var o = tipUI._opts || { days: [], leagues: [], counts: {}, total: 0 },
    items = [],
    title = '',
    cur = '';
  if (key === 'view') {
    title = 'Stato';
    cur = tipUI.view;
    items = [
      ['open', 'Prossime', o.counts.open],
      ['live', 'In corso', o.counts.live],
      ['check', 'Da verificare', o.counts.check],
      ['done', 'Concluse', o.counts.done],
      ['all', 'Tutte', o.total],
    ];
  } else if (key === 'day') {
    title = 'Giorno';
    cur = tipUI.day;
    items = [['all', 'Tutti i giorni', null]].concat(o.days.map(function (d) { return [d, tipCap(tipDayLabel(d, true)), null]; }));
  } else if (key === 'league') {
    title = 'Campionato';
    cur = tipUI.league;
    items = [['', 'Tutti i campionati', null]].concat(o.leagues.map(function (l) { return [l, l, null]; }));
  } else {
    title = 'Ordina per';
    cur = tipUI.sort;
    items = TIP_SORTS.map(function (x) { return [x[0], x[1], null]; });
  }
  var html =
    sheetHead(title) +
    '<div class="tip-opts">' +
    items
      .map(function (it, i) {
        return '<button type="button" class="tip-opt' + (it[0] === cur ? ' on' : '') + '" data-i="' + i + '"><span>' + U.esc(it[1]) + '</span>' + (it[2] != null ? '<i>' + it[2] + '</i>' : '') + (it[0] === cur ? '<b aria-hidden="true">✓</b>' : '') + '</button>';
      })
      .join('') +
    '</div>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
  d.querySelectorAll('.tip-opt').forEach(function (b) {
    b.onclick = function () {
      var v = items[Number(b.dataset.i)][0];
      if (key === 'view') tipUI.view = v;
      else if (key === 'day') tipUI.day = v;
      else if (key === 'league') tipUI.league = v;
      else {
        tipUI.sort = v;
        try { localStorage.setItem('bet_tip_sort', v); } catch (e) {}
      }
      d.close();
      render();
      window.scrollTo(0, 0);
    };
  });
}
/* Pannello File: aggiorna dal sito, importa JSON/CSV, esporta lo storico. */
/* 3.62.0 — azzeramento: si riparte da zero con le nuove regole di predizione.
   Si cancellano partite e pronostici, consigli (oggi e storico), resoconti, tracce e preferite live.
   Restano: saldo e scommesse, impostazioni degli avvisi, correzioni del modello.
   sigSince = adesso: i segnali già salvati sul server non vengono reimportati. */
function tipResetAll() {
  var pm = db.predModel || {}, n = (db.predictions || []).length, c = (pm.playLog || []).length;
  U.confirm({
    title: 'Azzerare tutti i pronostici?',
    text: 'Si cancellano ' + n + ' partite e ' + c + ' consigli salvati, con resoconti e storico. Saldo e scommesse non cambiano. Se vuoi tenerne una copia, prima usa Esporta storico.',
    detail: 'Hai qualche secondo per annullare.',
  }).then(function (ok) {
    if (!ok) return;
    var before = { predictions: U.clone(db.predictions || []), predModel: U.clone(pm) };
    tipUI._plQ = []; tipUI.freshIds = {}; tipUI.liveData = {}; tipUI.scanRows = []; tipUI.scan = null; tipUI.lblF = {};
    mutate(function (d) {
      d.predictions = [];
      d.predModel = d.predModel || {};
      ['playLog', 'reports', 'reportsV', 'liveLog', 'liveStars', 'lastBatch', 'lastAutoBatch', 'lastLabel'].forEach(function (k) { delete d.predModel[k]; });
      d.predModel.sigSince = Date.now();
      d.predModel.resetAt = Date.now();
    });
    render();
    U.toast('Pronostici azzerati', function () { mutate(function (d) { d.predictions = before.predictions; d.predModel = before.predModel; }); render(); });
  });
}
function tipFileSheet() {
  var P = tipParams(),
    pm = db.predModel || {},
    list = db.predictions || [],
    days = list.map(function (m) { return m.date; }).sort();
  var html =
    sheetHead('Pronostici', { sub: list.length ? 'Dal ' + U.esc(tipDayLabel(days[0])) + ' al ' + U.esc(tipDayLabel(days[days.length - 1])) : 'Nessuna partita' }) +
    '<div class="tip-sheet">' +
    '<div class="tip-sheet-info"><div><small>Modello</small><b>v' + U.esc(P.version) + (pm.learned ? ' + correzioni' : '') + '</b></div><div><small>Soglie</small><b>1T ' + tipThr(P, 'ht05') + '% · O1.5 ' + tipThr(P, 'o15') + '%</b></div><div class="wide"><small>Ultimo file</small><b>' + U.esc(pm.lastLabel || pm.lastBatch || '—') + '</b></div><div class="wide"><small>Ultimo controllo</small><b>' + (pm.lastCheck ? U.esc(U.date(pm.lastCheck)) : 'mai') + '</b></div></div>' +
    '<button type="button" class="tip-sheet-btn primary" data-s="auto"><b>↻ Pronostici automatici</b><small>' + (pm.lastAutoAt ? 'Ultimi del ' + U.esc(U.date(pm.lastAutoAt)) + ' · ' : '') + 'prossimi 3 giorni dalle quote bet365 (TotalCorner)' + (tipUI.bzRem != null ? ' · richieste rimaste ' + U.esc(tipUI.bzRem) : '') + '</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="fetch"><b>↻ Aggiorna dal sito</b><small>Scarica il pronostici.json pubblicato con l’app</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="import"><b>Importa file</b><small>pronostici.json o pronostici.csv preparati da Claude</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="results"><b>↻ Risultati automatici</b><small>' + (pm.lastResults ? 'Ultimo controllo ' + U.esc(U.date(pm.lastResults)) + (pm.afRemaining != null ? ' · richieste rimaste oggi ' + U.esc(pm.afRemaining) : '') : 'Finale, 1° tempo e minuto del primo gol da API-Football') + '</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-retrain><b>⬇︎ Esporta per il retraining</b><small>Tutti i consigli live con esiti, statistiche e stato del modello</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="check"><b>🔍 Consigli in attesa</b><small>Cerca i risultati e mostra perché un consiglio non si chiude</small></button>' +
    '<button type="button" class="tip-sheet-btn tip-sheet-danger" data-s="reset"><b>⟲ Azzera pronostici</b><small>Cancella partite, consigli di oggi e storico, resoconti e tracce live. Saldo e scommesse restano.</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="export"><b>Esporta storico</b><small>Risultati ed esiti in JSON, da dare a Claude o GPT per ricalibrare</small></button>' +
    '</div>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
  d.querySelector('[data-s="auto"]').onclick = function () {
    d.close();
    tipAutoPrematch({ manual: true });
  };
  d.querySelector('[data-s="fetch"]').onclick = function () {
    d.close();
    tipFetch({ manual: true });
    render();
  };
  d.querySelector('[data-s="import"]').onclick = function () {
    d.close();
    var f = document.getElementById('tip-file');
    if (f) f.click();
  };
  d.querySelector('[data-s="results"]').onclick = function () {
    d.close();
    tipAutoResults({ manual: true });
  };
  d.querySelector('[data-retrain]').onclick = function () { d.close(); tipRetrainExport(); };
  d.querySelector('[data-s="check"]').onclick = function () { d.close(); U.toast('Cerco i risultati…'); tipAutoResults({ manual: true }); };
  d.querySelector('[data-s="reset"]').onclick = function () { d.close(); tipResetAll(); };
  d.querySelector('[data-s="export"]').onclick = function () {
    d.close();
    tipExport();
  };
}
function tipExport() {
  var P = tipParams();
  U.download('pronostici-storico-' + U.local().slice(0, 10) + '.json', {
    app: 'bet_tracker',
    kind: 'pronostici-storico',
    exportedAt: new Date().toISOString(),
    compatibleWith: ['Claude', 'GPT'],
    schemaVersion: '2',
    model: (db.predModel || {}).base || TIP_DEFAULTS,
    learned: (db.predModel || {}).learned || null,
    matches: (db.predictions || []).map(function (m) {
      var c = tipCalc(m, P);
      return Object.assign({}, m, {
        currentEstimateOnly: true,
        prob: { p1: c.p1, px: c.px, p2: c.p2, o05: c.o05, o15: c.o15, o25: c.o25, ht05: c.ht05, gg: c.gg },
        outcomes: (m.picks || []).map(function (p) {
          return { m: p.m, sel: p.sel, p: p.p, esito: tipOutcome(m, p).s || null };
        }),
      });
    }),
  });
}

/* 3.70.0 — perché un mercato della partita non è in Top */
function tipTopWhyHtml(m) {
  var i = m.preIssue;
  if (!i || !i.why) return '';
  var rows = TIP_TOP_MK.filter(function (mk) { return i.why[mk[0]] && !(i.top && i.top[mk[0]]); }).map(function (mk) {
    return '<li><b>' + U.esc(mk[1]) + '</b> fuori Top: ' + U.esc(i.why[mk[0]]) + '</li>';
  });
  return rows.length ? '<ul class="muted tip-hint">' + rows.join('') + '</ul>' + (i.provisional ? '<p class="muted tip-hint">Top provvisoria: si blocca al calcio d\'inizio.</p>' : '') : '';
}
/* ---------- Dettaglio partita ---------- */
function tipDetail(id) {
  var m = (db.predictions || []).find(function (x) {
    return x.id === id;
  });
  if (!m) return;
  var issue = m.preIssue;
  var c = tipCalc(issue ? Object.assign({}, m, issue.inputs) : m, issue && issue.parameters ? issue.parameters : tipParams()),
    sc = function (pref, v) {
      return (
        '<div class="tip-score-in"><input type="number" min="0" max="20" inputmode="numeric" id="' + pref + '-h" value="' + (tipNum(v) ? v[0] : '') + '" aria-label="Gol ' + U.esc(m.home) + '"><span>–</span><input type="number" min="0" max="20" inputmode="numeric" id="' + pref + '-a" value="' + (tipNum(v) ? v[1] : '') + '" aria-label="Gol ' + U.esc(m.away) + '"></div>'
      );
    };
  var PP = tipParams();
  (m.picks || []).forEach(function (p) { c[p.m] = /^(Under|No goal)/.test(p.sel) ? 100 - p.p : p.p; });
  var prob = function (label, v, both, k) {
    if (typeof v === 'string') return '<div class="tip-prob"><small>' + label + '</small><b>' + v + '</b></div>';
    var T = k ? tipThr(PP, k) : 101;
    return '<div class="tip-prob' + (v >= T || (both && 100 - v >= T) ? ' hot' : '') + '"><small>' + label + '</small><b>' + v + '%</b></div>';
  };
  var picks = (m.picks || [])
    .map(function (p) {
      var o = tipOutcome(m, p);
      return (
        '<button type="button" class="tip-pick-row ' + ({ V: 'won', P: 'lost', N: 'void', '': 'wait' }[o.s]) + '" style="--mk:var(--mk-' + p.m + ')" data-tip-ov="' + p.m + '"><span><b>' + U.esc(p.sel) + '</b><small>' + TIP_SHORT[p.m] + ' · ' + p.p + '%' + (o.man ? ' · segnato a mano' : '') + '</small></span><strong>' + ({ V: 'Vinto', P: 'Perso', N: 'Annullato', '': 'In attesa' }[o.s]) + '</strong></button>'
      );
    })
    .join('');
  var html =
    sheetHead(m.home + ' – ' + m.away, { form: 'tip-form', sub: U.esc(m.league) + ' · ' + U.esc(tipDayLabel(m.date)) + ' ' + U.esc(m.time) }) +
    '<form id="tip-form" class="tip-form">' +
    '<div class="tip-res"><label>Risultato finale' + sc('tip-ft', m.ft) + '</label><label>1° tempo' + sc('tip-ht', m.ht) + '</label></div>' +
    '<label class="tip-fg">Minuto del primo gol <small>serve per il piano 30\' (lascia vuoto se 0-0)</small><input type="number" min="1" max="130" inputmode="numeric" id="tip-fg" value="' + (Number.isInteger(m.fg) ? m.fg : '') + '"></label>' +
    '<label class="toggle-line"><input type="checkbox" id="tip-cancel"' + (m.cancelled ? ' checked' : '') + '> Partita annullata o rinviata</label>' +
    '<h3 class="tip-sub">Pronostici <small>tocca per cambiare l’esito a mano</small></h3>' +
    '<div class="tip-pick-list">' + (picks || '<p class="muted">Nessun pronostico.</p>') + '</div>' +
    '<button type="button" class="tip-ctx-btn" data-star-btn>' + (tipIsStar(m) ? '★ Tra le preferite (tocca per togliere)' : '☆ Aggiungi alle preferite') + '</button>' +
    '<button type="button" class="tip-ctx-btn" data-ctx-open>🧭 Contesto squadre' + tipCtxBadge(m) + ' ›</button>' +
    '<h3 class="tip-sub">Probabilità <small>i mercati consigliati usano la percentuale salvata</small></h3>' +
    '<div class="tip-probs">' + prob('1', c.p1) + prob('X', c.px) + prob('2', c.p2) + prob('Over 1.5', c.o15, 1, 'o15') + prob('Over 2.5', c.o25, 1, 'o25') + prob('Over 0.5 1T', c.ht05, 1, 'ht05') + prob('Goal', c.gg, 1, 'gg') + prob('Gol attesi', c.lh.toFixed(1) + '–' + c.la.toFixed(1)) + '</div>' +
    tipOddsBlock(m) +
    (function () {
      var pk = (m.picks || []).find(function (x) { return x.m === 'ht05' && x.sel.indexOf('Over') === 0; });
      if (!pk) return '';
      var x = tipPlan(c.ht05);
      return '<h3 class="tip-sub">Simulazione 1° tempo <small>non inclusa nei consigli registrati · ' + x.pl.s1 + '€ entro il 30\' + ' + x.pl.s2 + '€ live</small></h3>' +
        '<div class="tip-probs">' +
        '<div class="tip-prob"><small>Gol entro 30\'</small><b>' + Math.round(x.p1 * 100) + '%</b><i>quota min ' + x.fair1.toFixed(2) + '</i></div>' +
        '<div class="tip-prob"><small>Gol 30\'-45\'</small><b>' + Math.round(x.p2 * 100) + '%</b><i>live min ' + x.fair2.toFixed(2) + '</i></div>' +
        '<div class="tip-prob"><small>0-0 al 45\'</small><b>' + Math.round(x.p0 * 100) + '%</b><i>−' + (x.pl.s1 + x.pl.s2) + '€</i></div>' +
        '<div class="tip-prob' + (x.ev > 0 ? ' hot' : '') + '"><small>Atteso a ' + x.pl.q1 + '/' + x.pl.q2 + '</small><b>' + (x.ev >= 0 ? '+' : '') + x.ev.toFixed(2) + '€</b></div>' +
        '</div>' +
        '<button type="button" class="tip-live-get" data-live-open>📡 Live · sintonizza ›</button>';
    })() +
    '<details class="tip-more"><summary>Dettagli dell’analisi</summary>' +
    '<p class="muted tip-hint">Risultati più probabili ' + c.cs.map(function (x) { return x.s + ' (' + x.p + '%)'; }).join(', ') + '</p>' +
    '<p class="muted tip-hint">' + U.esc(tipReviewLabel(m)) + ' · affidabilità dati ' + m.rel + ' · ' + U.esc(m.batch || 'batch non identificato') + '</p>' +
    (m.review === 'not_revised' ? '<p class="muted tip-hint">Partita già iniziata o fuori dalla revisione: resta il pronostico originale.</p>' : '') +
    (m.note ? '<p class="muted tip-hint">' + U.esc(m.note) + '</p>' : '') +
    '</details>' +
    '</form>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
  var ovState = Object.assign({}, m.ov || {});
  var stBtn = d.querySelector('[data-star-btn]');
  if (stBtn) stBtn.onclick = function () {
    tipToggleStar(m.id);
    var now = (db.predictions || []).find(function (x) { return x.id === m.id; });
    stBtn.textContent = tipIsStar(now) ? '★ Tra le preferite (tocca per togliere)' : '☆ Aggiungi alle preferite';
    render();
  };
  var cxBtn = d.querySelector('[data-ctx-open]');
  if (cxBtn) cxBtn.onclick = function () { d.close(); tipCtxSheet(m.id); };
  var loBtn = d.querySelector('[data-live-open]');
  if (loBtn) loBtn.onclick = function () { d.close(); tipLiveSheet(m.id); };
  var liveIn = d.querySelectorAll('[data-live]');
  if (liveIn.length) {
    var liveCalc = function () {
      var v = {}, any = false;
      liveIn.forEach(function (el) {
        var k = el.dataset.live;
        if (k === 'red') { v.red = el.checked; if (el.checked) any = true; return; }
        if (el.value === '') return;
        var n = Number(String(el.value).replace(',', '.'));
        if (isFinite(n)) { v[k] = n; if (k !== 'q') any = true; }
      });
      var out = d.querySelector('#tip-live-out');
      if (!any) return;
      var r = tipLive(c.ht05, c.lh + c.la, v),
        pl = tipPlan(c.ht05).pl,
        verdict = '';
      if (U.finite(v.q)) {
        var ev = pl.s2 * (v.q * r.p - 1);
        verdict = v.q >= r.fair
          ? '<b class="positive">Conviene: ' + v.q.toFixed(2) + ' è sopra la quota minima. Atteso ' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '€ su ' + pl.s2 + '€.</b>'
          : '<b class="negative">Non conviene: ' + v.q.toFixed(2) + ' è sotto la quota minima. Atteso ' + ev.toFixed(2) + '€ su ' + pl.s2 + '€: meglio saltare.</b>';
      }
      out.innerHTML =
        '<div class="tip-probs"><div class="tip-prob"><small>Spinta</small><b>' + (r.f >= 1 ? '+' : '') + Math.round((r.f - 1) * 100) + '%</b><i>attesi ~' + Math.round(r.exp.s) + ' tiri, ' + Math.round(r.exp.t) + ' in porta</i></div>' +
        '<div class="tip-prob hot"><small>Gol 30\'-45\'</small><b>' + Math.round(r.p * 100) + '%</b><i>prima ' + Math.round(r.base * 100) + '%</i></div>' +
        '<div class="tip-prob"><small>Quota minima</small><b>' + r.fair.toFixed(2) + '</b></div></div>' +
        (verdict ? '<p class="tip-live-verdict">' + verdict + '</p>' : '<p class="muted">Inserisci la quota live per sapere se conviene.</p>');
    };
    liveIn.forEach(function (el) { el.addEventListener('input', liveCalc); el.addEventListener('change', liveCalc); });

    var lg = d.querySelector('[data-live-get]');
    if (lg)
      lg.onclick = async function () {
        lg.disabled = true;
        lg.textContent = 'Scarico…';
        try {
          var r = await tipLiveFetch(m),
            st = r.stats || {},
            set = function (k, v) { var el = d.querySelector('[data-live="' + k + '"]'); if (el && v != null) { if (k === 'red') el.checked = v > 0; else el.value = v; } };
          set('s', st.s); set('t', st.t); set('c', st.c); set('xg', st.xg); set('red', st.red);
          liveCalc();
          var g = r.goals || [], live = /^(1H|HT|2H|ET|BT|P|LIVE|INT)$/.test(r.status || '');
          lg.textContent = (live ? '📡 ' + (r.elapsed || '') + '\' · ' : '📡 ' + (r.status || '') + ' · ') + (g[0] != null ? g[0] + '-' + g[1] : '') + ' · aggiorna';
          if (g[0] + g[1] > 0) U.toast('Il punteggio non è più 0-0: il piano live non serve.');
        } catch (e) {
          lg.textContent = '📡 Scarica statistiche live';
          U.toast(tipFnErr(e));
        } finally {
          lg.disabled = false;
        }
      };
  }
  d.querySelectorAll('[data-tip-ov]').forEach(function (b) {
    b.onclick = function () {
      var k = b.dataset.tipOv,
        next = { undefined: 'V', V: 'P', P: 'N', N: undefined }[ovState[k]];
      if (next) ovState[k] = next;
      else delete ovState[k];
      var p = m.picks.find(function (x) { return x.m === k; }),
        tmp = Object.assign({}, m, { ov: ovState }),
        o = tipOutcome(tmp, p);
      b.className = 'tip-pick-row ' + { V: 'won', P: 'lost', N: 'void', '': 'wait' }[o.s];
      b.querySelector('strong').textContent = { V: 'Vinto', P: 'Perso', N: 'Annullato', '': 'In attesa' }[o.s];
      b.querySelector('small').textContent = TIP_SHORT[p.m] + ' · ' + p.p + '%' + (o.man ? ' · segnato a mano' : '');
    };
  });
  d.querySelector('#tip-form').onsubmit = function (e) {
    e.preventDefault();
    var read = function (pref) {
      var h = d.querySelector('#' + pref + '-h').value,
        a = d.querySelector('#' + pref + '-a').value;
      if (h === '' && a === '') return null;
      var hv = Number(h),
        av = Number(a);
      if (!Number.isInteger(hv) || !Number.isInteger(av) || hv < 0 || av < 0 || hv > 20 || av > 20) return false;
      return [hv, av];
    };
    var ft = read('tip-ft'),
      ht = read('tip-ht');
    if (ft === false || ht === false) {
      U.toast('Inserisci entrambi i gol, numeri da 0 a 20.');
      return;
    }
    if (ft && ht && (ht[0] > ft[0] || ht[1] > ft[1])) {
      U.toast('Il 1° tempo non può avere più gol del finale.');
      return;
    }
    var cancelled = d.querySelector('#tip-cancel').checked;
    var fgv = d.querySelector('#tip-fg').value,
      fg = fgv === '' ? null : Number(fgv);
    if (fg != null && (!Number.isInteger(fg) || fg < 1 || fg > 130)) {
      U.toast('Minuto del primo gol non valido.');
      return;
    }
    if (
      mutate(function (n) {
        var x = n.predictions.find(function (y) { return y.id === m.id; });
        if (!x) return;
        x.ft = ft;
        x.ht = ht;
        if (Number.isInteger(fg)) x.fg = fg;
        else delete x.fg;
        x.ov = ovState;
        if (cancelled) x.cancelled = true;
        else delete x.cancelled;
      })
    ) {
      d.close();
      U.toast('Partita aggiornata');
    }
  };
}

/* ---------- Collegamenti della pagina ---------- */
/* 3.5.0 — Over 0.5 nella partita tolto dai pronostici (quasi sempre sicuro, non informa).
   Le partite che erano entrate solo per quello escono, a meno che abbiano dati segnati a mano. */
/* 3.9.1 — stesso trattamento per i pronostici 1X2. */
function tipDropO05() {
  var drop = { o05: 1, '1x2': 1 };
  var has = (db.predictions || []).some(function (m) {
    return (m.picks || []).some(function (p) { return drop[p.m]; });
  });
  if (!has) return;
  mutate(function (n) {
    n.predictions = n.predictions.filter(function (m) {
      m.picks = (m.picks || []).filter(function (p) { return !drop[p.m]; });
      if (m.ov) { delete m.ov.o05; delete m.ov['1x2']; }
      return m.picks.length || (m.ov && Object.keys(m.ov).length);
    });
  });
}
function bindTips() {
  if (!tipUI.dropped) {
    tipUI.dropped = true;
    tipDropO05();
  }
  main.querySelectorAll('[data-tip-fetch]').forEach(function (b) {
    b.onclick = function () {
      tipFetch({ manual: true });
      render();
    };
  });
  var file = document.getElementById('tip-file');
  main.querySelectorAll('[data-tip-import]').forEach(function (b) {
    b.onclick = function () {
      file && file.click();
    };
  });
  if (file)
    file.onchange = async function (e) {
      try {
        var f = e.target.files[0];
        if (f) {
          var txt = await f.text();
          var isCsv = /\.csv$/i.test(f.name) || !/^\s*[{[]/.test(txt);
          var parsed = isCsv ? tipParseCsv(txt) : JSON.parse(txt);
          if (!parsed) throw Error('vuoto');
          tipMerge(parsed, { manual: true });
        }
      } catch (err) {
        U.toast('File non leggibile. Nessun dato modificato.');
      } finally {
        e.target.value = '';
      }
    };
  main.querySelectorAll('[data-tip-view]').forEach(function (b) {
    b.onclick = function () {
      tipUI.view = b.dataset.tipView;
      render();
    };
  });
  main.querySelectorAll('[data-tip-day]').forEach(function (b) {
    b.onclick = function () {
      tipUI.day = b.dataset.tipDay;
      render();
    };
  });
  main.querySelectorAll('[data-tip-filter]').forEach(function (b) {
    b.onclick = function () {
      tipFilterSheet(b.dataset.tipFilter);
    };
  });
  var so = document.getElementById('tip-sort');
  if (so)
    so.onchange = function () {
      tipUI.sort = so.value;
      try { localStorage.setItem('bet_tip_sort', so.value); } catch (e) {}
      render();
      window.scrollTo(0, 0);
    };
  var lg = document.getElementById('tip-league');
  if (lg)
    lg.onchange = function () {
      tipUI.league = lg.value;
      render();
    };
  var q = document.getElementById('tip-q');
  if (q)
    q.oninput = function () {
      tipUI.q = q.value;
      clearTimeout(q._t);
      q._t = setTimeout(function () {
        render();
        var again = document.getElementById('tip-q');
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      }, 250);
    };
  main.querySelectorAll('[data-tip-live]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      tipLiveSheet(b.dataset.tipLive);
    };
  });
  if (tipUI.panel === 'live' || tipUI.panel === 'home') { tipAutoStart(); setTimeout(function () { tipAutoScan(false); tipSignalsPull(true); }, 300); }
  main.querySelectorAll('[data-alert]').forEach(function (b) {
    b.onclick = function () {
      var k = b.dataset.alert;
      if (k === 'test') { tipAlertTest(); return; }
      mutate(function (d) { d.predModel = d.predModel || {}; var A = d.predModel.alerts = Object.assign({ on: false, amber: false, stars: false }, d.predModel.alerts || {}); A[k] = !A[k]; if (k !== 'on' && A[k]) A.on = true; A.at = Date.now(); });
    };
  });
  var scb = main.querySelector('[data-scan]');
  if (scb) scb.onclick = async function () {
    scb.disabled = true;
    scb.textContent = 'Scansiono…';
    try { await tipScanFetch(); tipSignalsPull(true); render(); setTimeout(tipFreshNotify, 120); }
    catch (e) { U.toast(tipFnErr(e)); scb.disabled = false; scb.textContent = '🔎 Riprova scansione'; }
  };
  main.querySelectorAll('[data-tip-star]').forEach(function (b) {
    b.onclick = function (e) { e.stopPropagation(); e.preventDefault(); tipToggleStar(b.dataset.tipStar); render(); };
  });
  main.querySelectorAll('[data-live-star]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var id = b.dataset.liveStar, mm = (tipUI.scanMap || {})[id] || tipLiveStars().find(function (z) { return z.afId === id; }) || {};
      if (mm.id && !mm.scan && (db.predictions || []).some(function (x) { return x.id === mm.id; })) tipToggleStar(mm.id); /* partita dei pronostici: una sola stella */
      else tipToggleLiveStar(id, { home: mm.home, away: mm.away, league: mm.league });
      render();
    };
  });
  /* 3.30.0 — sezioni a tendina: tocca il titolo per chiudere/aprire (si ricorda) */
  var closed = {};
  try { closed = JSON.parse(localStorage.getItem('tipClosed') || '{}') || {}; } catch (e) { closed = {}; }
  main.querySelectorAll('.tip-top > .tip-top-head, .tip-markets > h2').forEach(function (h) {
    var sec = h.parentElement, key = (h.querySelector('b') || h).textContent.trim().slice(0, 40);
    sec.classList.add('tip-fold');
    if (closed[key]) sec.classList.add('folded');
    h.setAttribute('role', 'button');
    h.onclick = function (e) {
      if (e.target.closest('input,select,button:not(.tip-top-head)')) return;
      var f = sec.classList.toggle('folded');
      if (f) closed[key] = 1; else delete closed[key];
      try { localStorage.setItem('tipClosed', JSON.stringify(closed)); } catch (e2) { /* ok */ }
    };
  });
  if (!tipUI._repChecked) { tipUI._repChecked = 1; setTimeout(tipDailyReports, 1200); }
  main.querySelectorAll('[data-live-export]').forEach(function (lex) { lex.onclick = function () {
    var data = JSON.stringify({ app: 'bet_tracker', kind: 'liveLog', exported: new Date().toISOString(), liveLog: ((db.predModel || {}).liveLog) || [], playLog: ((db.predModel || {}).playLog) || [], reports: ((db.predModel || {}).reports) || {} }, null, 1);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    a.download = 'traccia-live-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }; });

  var sto = main.querySelector('[data-tip-staronly]');
  if (sto) sto.onclick = function () { tipUI.starOnly = !tipUI.starOnly; render(); };
  var sca = main.querySelector('[data-scan-all]');
  if (sca) sca.onclick = function () { tipUI.scanAll = !tipUI.scanAll; render(); };
  main.querySelectorAll('[data-scan-open]').forEach(function (b) {
    b.onclick = function () {
      var mm = (tipUI.scanMap || {})[b.dataset.scanOpen];
      if (mm) tipLiveSheet(mm.id, mm);
    };
  });
  main.querySelectorAll('[data-tip-open]').forEach(function (b) {
    b.onclick = function () {
      tipDetail(b.dataset.tipOpen);
    };
  });
  main.querySelectorAll('[data-tip-learn]').forEach(function (b) {
    b.onclick = function () {
      var L = tipLearn();
      if (L.n < 10) return;
      mutate(function (n) {
        n.predModel = n.predModel || {};
        n.predModel.learned = {
          at: new Date().toISOString(),
          n: L.n,
          goalFactor: L.goalFactor,
          leagueGoal: L.leagueGoal,
          htShare: L.htShare,
          drawBoost: L.drawBoost,
          htLeague: L.htLeague,
          early: L.early,
        };
      });
      U.toast('Correzioni applicate al modello');
    };
  });
  main.querySelectorAll('[data-tip-unlearn]').forEach(function (b) {
    b.onclick = function () {
      mutate(function (n) {
        n.predModel.learned = null;
      });
      U.toast('Modello di base ripristinato');
    };
  });
  main.querySelectorAll('[data-tip-export]').forEach(function (b) {
    b.onclick = tipExport;
  });
  main.querySelectorAll('[data-tip-panel]').forEach(function (b) {
    b.onclick = function () {
      tipUI.panel = b.dataset.tipPanel;
      render();
      window.scrollTo(0, 0);
    };
  });
  main.querySelectorAll('[data-tip-sheet]').forEach(function (b) {
    b.onclick = tipFileSheet;
  });
  main.querySelectorAll('[data-tip-alerts]').forEach(function (b) {
    b.onclick = tipAlertSheet;
  });
  main.querySelectorAll('[data-tip-reset]').forEach(function (b) {
    b.onclick = function () {
      tipUI.view = 'open';
      tipUI.day = 'all';
      tipUI.league = '';
      tipUI.q = '';
      tipUI.sort = 'time';
      try { localStorage.removeItem('bet_tip_sort'); } catch (e) {}
      render();
    };
  });
  /* Controllo automatico del file all'apertura della scheda, al massimo ogni 30 minuti. */
  var last = (db.predModel || {}).lastCheck;
  if (!tipUI.loading && (!tipUI.checkedAt || Date.now() - tipUI.checkedAt > 30 * 60e3) && navigator.onLine !== false) {
    tipUI.checkedAt = Date.now();
    if (!last || Date.now() - Date.parse(last) > 30 * 60e3 || !(db.predictions || []).length) tipFetch();
    setTimeout(function () { tipAutoPrematch(); }, 900);
  }
  /* 3.12.0 — risultati automatici all'apertura, al massimo ogni 20 minuti */
  if (!tipUI.resBusy && (!tipUI.resAt || Date.now() - tipUI.resAt > 10 * 60e3) && navigator.onLine !== false && tipCanSync()) {
    tipUI.resAt = Date.now();
    setTimeout(function () { tipAutoResults(); }, 1500);
  }
}

/* 3.48.0 — tocco sull'avviso: apre Pronostici › Live e la partita (?live=bz:123 o messaggio dal service worker) */
async function tipOpenFromPush(afId) {
  try {
    if (typeof setTab === 'function') setTab('tips'); else tab = 'tips';
    tipUI.panel = 'live';
    render();
    if (!afId) return;
    if (!tipUI.scan || Date.now() - tipUI.scan.at > 60e3) { try { await tipScanFetch(); } catch (e) { /* ok */ } render(); }
    var mm = (tipUI.scanMap || {})[afId];
    if (mm) tipLiveSheet(mm.id, mm);
    else U.toast('La partita non è più tra quelle in corso.');
  } catch (e) { /* ok */ }
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'open-live') tipOpenFromPush(e.data.live);
  });
setTimeout(function () {
  try {
    var lv = new URLSearchParams(location.search).get('live');
    if (lv) { history.replaceState(null, '', location.pathname); tipOpenFromPush(lv === '1' ? null : lv); }
  } catch (e) { /* ok */ }
}, 700);
/* 3.50.0 — Pronostici è la prima scheda dell'app: appena caricato questo file si disegna */
try { if (typeof tab !== 'undefined' && tab === 'tips') render(); } catch (e) { /* ok */ }
