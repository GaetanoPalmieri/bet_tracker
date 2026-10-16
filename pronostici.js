/* =====================================================================
   3.3.1 — PRONOSTICI
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
var TIP_DEFAULTS = { version: '1', threshold: 70, htShare: 0.45, drawBoost: 1, goalFactor: 1, leagueGoal: {} };
var TIP_MARKETS = [
  ['1x2', '1X2'],
  ['o05', 'Over/Under 0.5'],
  ['o15', 'Over/Under 1.5'],
  ['o25', 'Over/Under 2.5'],
  ['ht05', 'O/U 0.5 1° tempo'],
  ['gg', 'Goal / No goal'],
];
var TIP_SHORT = { '1x2': '1X2', o05: 'O/U 0.5', o15: 'O/U 1.5', o25: 'O/U 2.5', ht05: '1° tempo', gg: 'GG/NG' };
var tipUI = { view: 'open', day: 'all', league: '', q: '', loading: false, fileInfo: '' };

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
  });
}
function tipPois(k, l) {
  var p = Math.exp(-l);
  for (var i = 1; i <= k; i++) p *= l / i;
  return p;
}
function tipCalc(m, P) {
  P = P || tipParams();
  var f = (P.goalFactor || 1) * ((P.leagueGoal || {})[m.league] || 1),
    lh = m.lh * f,
    la = m.la * f,
    N = 11,
    g = [],
    s = 0,
    i,
    j;
  for (i = 0; i < N; i++) {
    g.push([]);
    for (j = 0; j < N; j++) {
      var v = tipPois(i, lh) * tipPois(j, la);
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
    ht05: pc(1 - Math.exp(-(P.htShare || 0.45) * (lh + la))),
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
    if (x.p > P.threshold) out.push({ m: k[0], sel: x.sel, p: x.p });
  });
  return out;
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
        if (Array.isArray(fm.p1x2) && fm.p1x2.length === 3) m.p1x2 = fm.p1x2.map(Number);
        if (fm.cancelled) m.cancelled = true;
        m.picks = tipPicksFor(m, P);
        if (!m.picks.length) return;
        n.predictions.push(m);
        byId[id] = m;
        res.added++;
      } else {
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
          cur.batch = String(file.batch || fm.date);
          cur.picks = tipPicksFor(cur, P);
          if (JSON.stringify([cur.lh, cur.la, cur.p1x2, cur.picks, cur.rel, cur.note, cur.time, cur.league, cur.review]) !== oldSnapshot) res.updated++;
        } else if (fm.time && cur.time !== String(fm.time) && noScores && future) {
          cur.time = String(fm.time);
          res.updated++;
        }
        if (!tipNum(cur.ft) && tipNum(fm.ft)) { cur.ft = fm.ft; res.results++; }
        if (!tipNum(cur.ht) && tipNum(fm.ht)) cur.ht = fm.ht;
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
  };
}

/* ---------- Pagina ---------- */
function tipDayLabel(iso, long) {
  var d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('it-IT', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric' });
}
function tipPct(v) {
  return v == null ? '—' : Math.round(v) + '%';
}
function tipChip(m, p) {
  var o = tipOutcome(m, p),
    st = { V: 'won', P: 'lost', N: 'void', '': 'wait' }[o.s];
  return (
    '<span class="tip-pick ' + st + '"><b>' + U.esc(p.sel) + '</b><i>' + p.p + '%</i>' + (o.s ? '<em>' + { V: '✓', P: '✕', N: '–' }[o.s] + '</em>' : '') + '</span>'
  );
}
function tipReviewLabel(m) {
  return {
    blend: 'Claude + Poisson',
    claude_only: 'Solo Claude',
    poisson_only: 'Solo Poisson',
    not_revised: 'Non rivista',
  }[m.review] || 'Analisi precedente';
}
function tipCard(m) {
  var st = tipState(m),
    score = tipNum(m.ft) ? m.ft[0] + ' – ' + m.ft[1] : '',
    wins = (m.picks || []).filter(function (p) {
      return tipOutcome(m, p).s === 'V';
    }).length,
    closed = (m.picks || []).filter(function (p) {
      var s = tipOutcome(m, p).s;
      return s === 'V' || s === 'P';
    }).length;
  var badge = m.cancelled
    ? '<span class="tip-status void">Annullata</span>'
    : st === 'live'
      ? '<span class="tip-status live">In corso</span>'
      : st === 'check'
      ? '<span class="tip-status todo">Da verificare</span>'
      : st === 'done'
        ? '<span class="tip-status ' + (wins === closed ? 'ok' : wins ? 'mix' : 'ko') + '">' + wins + '/' + closed + ' vinti</span>'
        : '';
  return (
    '<button type="button" class="card tip-card' + (m.cancelled ? ' cancelled' : '') + '" data-tip-open="' + U.esc(m.id) + '">' +
    '<span class="tip-meta"><span class="tip-time">' + U.esc(m.time) + '</span><span class="tip-league">' + U.esc(m.league) + '</span><span class="tip-rel r' + m.rel + '" title="Affidabilità dei dati">' + m.rel + '</span>' + badge + '</span>' +
    '<span class="tip-teams"><span>' + U.esc(m.home) + '</span><span class="tip-score">' + (score || 'vs') + '</span><span>' + U.esc(m.away) + '</span></span>' +
    '<span class="tip-origin' + (m.review === 'not_revised' ? ' stale' : '') + '">' + U.esc(tipReviewLabel(m)) + '</span>' +
    '<span class="tip-picks">' + (m.picks || []).map(function (p) { return tipChip(m, p); }).join('') + '</span></button>'
  );
}
function tipsPage() {
  var list = (db.predictions || []).slice(),
    P = tipParams();
  if (!list.length) {
    return (
      '<section class="card hero tip-hero"><small>PRONOSTICI</small><div class="big">Nessuna partita</div><p class="muted">I pronostici arrivano dal file che prepara Claude. Chiedigli “prevedi le prossime partite”, poi pubblica l’app oppure importa il file qui.</p>' +
      '<div class="hero-flow-btns"><button type="button" class="flow-btn in" data-tip-fetch>↻ Cerca aggiornamenti</button><button type="button" class="flow-btn" data-tip-import>Importa file</button></div><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden></section>'
    );
  }
  var days = [];
  list.forEach(function (m) {
    if (days.indexOf(m.date) < 0) days.push(m.date);
  });
  days.sort();
  var leagues = [];
  list.forEach(function (m) {
    if (leagues.indexOf(m.league) < 0) leagues.push(m.league);
  });
  leagues.sort(function (a, b) {
    return a.localeCompare(b, 'it');
  });
  var counts = { open: 0, live: 0, check: 0, done: 0 };
  list.forEach(function (m) {
    counts[tipState(m)]++;
  });
  var q = tipUI.q.trim().toLowerCase();
  var shown = list
    .filter(function (m) {
      return (
        (tipUI.view === 'all' || tipState(m) === tipUI.view) &&
        (tipUI.day === 'all' || m.date === tipUI.day) &&
        (!tipUI.league || m.league === tipUI.league) &&
        (!q || (m.home + ' ' + m.away + ' ' + m.league).toLowerCase().indexOf(q) >= 0)
      );
    })
    .sort(function (a, b) {
      return tipKickoff(a) - tipKickoff(b) || a.league.localeCompare(b.league);
    });
  if (tipUI.view === 'done')
    shown.reverse();
  var sum = tipSummary(tipClosed()),
    first = days[0],
    lastD = days[days.length - 1];

  var batchLabel = (db.predModel || {}).lastLabel || (db.predModel || {}).lastBatch || '—';
  var hero =
    '<section class="card hero tip-hero"><div class="row"><small>PRONOSTICI</small><span class="diary-chip ' + (counts.check ? 'todo' : 'ok') + '">' + (counts.check ? counts.check + ' da verificare' : '✓ Tutto in ordine') + '</span></div>' +
    '<div class="big">' + list.length + ' partite</div>' +
    '<div class="diary-hero-sub"><span>Dal <b>' + tipDayLabel(first) + '</b> al <b>' + tipDayLabel(lastD) + '</b> · soglia oltre il ' + P.threshold + '%</span><span>Modello v' + U.esc(P.version) + ((db.predModel || {}).learned ? ' + correzioni imparate' : '') + ' · ' + U.esc(batchLabel) + '</span></div>' +
    '<div class="hero-flow-btns"><button type="button" class="flow-btn in" data-tip-fetch>' + (tipUI.loading ? 'Controllo…' : '↻ Aggiorna') + '</button><button type="button" class="flow-btn" data-tip-import>Importa file</button></div><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden></section>';

  var kpi = function (label, val, sub, cls) {
    return '<div class="card diary-kpi"><small>' + label + '</small><b class="' + (cls || '') + '">' + val + '</b><span>' + sub + '</span></div>';
  };
  var kpis =
    '<div class="diary-kpis">' +
    kpi('Vinti', tipPct(sum.rate), sum.n ? sum.w + ' su ' + sum.n + ' pronostici' : 'nessun esito ancora', sum.rate == null ? '' : sum.rate >= sum.exp ? 'positive' : 'negative') +
    kpi('Atteso dal modello', sum.n ? tipPct(sum.exp) : '—', 'media delle probabilità') +
    kpi('Da giocare', String(counts.open), 'partite in programma') +
    kpi('Precisione', sum.brier == null ? '—' : sum.brier.toFixed(3), 'Brier: più basso è meglio') +
    '</div>';

  var seg = function (items, cur, attr) {
    return (
      '<div class="diary-seg tip-seg" style="grid-template-columns:repeat(' + items.length + ',minmax(0,1fr))" role="group">' +
      items
        .map(function (it) {
          return '<button type="button" ' + attr + '="' + it[0] + '" class="' + (cur === it[0] ? 'active' : '') + '" aria-pressed="' + (cur === it[0]) + '">' + it[1] + '</button>';
        })
        .join('') +
      '</div>'
    );
  };
  var filters =
    '<section class="card tip-filters">' +
    seg([['open', 'Prossime<small>' + counts.open + '</small>'], ['live', 'Live<small>' + counts.live + '</small>'], ['check', 'Verifica<small>' + counts.check + '</small>'], ['done', 'Concluse<small>' + counts.done + '</small>'], ['all', 'Tutte<small>' + list.length + '</small>']], tipUI.view, 'data-tip-view') +
    (days.length > 1 ? seg([['all', 'Tutti']].concat(days.slice(-4).map(function (d) { return [d, tipDayLabel(d)]; })), tipUI.day, 'data-tip-day') : '') +
    '<div class="tip-filter-row"><select id="tip-league" aria-label="Campionato"><option value="">Tutti i campionati</option>' +
    leagues.map(function (l) { return '<option value="' + U.esc(l) + '"' + (tipUI.league === l ? ' selected' : '') + '>' + U.esc(l) + '</option>'; }).join('') +
    '</select><input id="tip-q" type="search" placeholder="Cerca squadra" value="' + U.esc(tipUI.q) + '" aria-label="Cerca squadra"></div></section>';

  var body = '',
    lastDay = '';
  shown.forEach(function (m) {
    if (m.date !== lastDay) {
      body += '<h2 class="section tip-day">' + tipDayLabel(m.date, true) + '</h2>';
      lastDay = m.date;
    }
    body += tipCard(m);
  });
  if (!shown.length)
    body = '<div class="card empty">' + (tipUI.view === 'check' ? 'Nessuna partita da verificare.' : 'Nessuna partita con questi filtri.') + '</div>';

  /* Andamento per mercato */
  var rows = tipClosed();
  var mk =
    '<section class="card diary-card tip-markets"><h2>Andamento per mercato</h2><p class="muted">Solo i pronostici oltre il ' + P.threshold + '%. “Atteso” è la media delle probabilità date dal modello: se i vinti restano sotto, il modello è troppo ottimista su quel mercato.</p>' +
    TIP_MARKETS.map(function (k) {
      var s = tipSummary(rows.filter(function (r) { return r.p.m === k[0]; }));
      var w = s.rate == null ? 0 : Math.max(2, s.rate);
      return (
        '<div class="tip-mrow"><div class="tip-mhead"><b>' + k[1] + '</b><span>' + (s.n ? s.w + '/' + s.n + ' · ' + tipPct(s.rate) + ' (atteso ' + tipPct(s.exp) + ')' : 'nessun esito') + '</span></div>' +
        '<div class="tip-bar"><i class="' + (s.rate != null && s.rate < s.exp - 5 ? 'low' : '') + '" style="width:' + w + '%"></i>' + (s.n ? '<em style="left:' + s.exp + '%"></em>' : '') + '</div></div>'
      );
    }).join('') +
    '</section>';

  /* Calibrazione: cosa ha imparato il modello */
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
      '<p class="muted">Applicando le correzioni cambiano le probabilità mostrate; i pronostici già fissati e il loro esito restano com’erano.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-learn>Applica correzioni</button>' + (learned ? '<button type="button" data-tip-unlearn>Torna al modello di base</button>' : '') + '</div>';
  }
  cal += '</section>';

  var exp =
    '<section class="card diary-card"><h2>Per Claude e GPT</h2><p class="muted">Lo stesso JSON storico funziona con entrambi: include partite, gol attesi, probabilità, pronostici, risultati ed esiti. Allegalo a Claude o GPT per analisi e ricalibrazione. Non addestra automaticamente il modello.</p><div class="actions"><button type="button" data-tip-export>Esporta storico (Claude / GPT)</button></div></section>';

  return hero + kpis + filters + body + mk + cal + exp;
}

/* ---------- Dettaglio partita ---------- */
function tipDetail(id) {
  var m = (db.predictions || []).find(function (x) {
    return x.id === id;
  });
  if (!m) return;
  var c = tipCalc(m),
    sc = function (pref, v) {
      return (
        '<div class="tip-score-in"><input type="number" min="0" max="20" inputmode="numeric" id="' + pref + '-h" value="' + (tipNum(v) ? v[0] : '') + '" aria-label="Gol ' + U.esc(m.home) + '"><span>–</span><input type="number" min="0" max="20" inputmode="numeric" id="' + pref + '-a" value="' + (tipNum(v) ? v[1] : '') + '" aria-label="Gol ' + U.esc(m.away) + '"></div>'
      );
    };
  var T = tipParams().threshold;
  var prob = function (label, v, both) {
    return '<div class="tip-prob' + (v > T || (both && 100 - v > T) ? ' hot' : '') + '"><small>' + label + '</small><b>' + v + '%</b></div>';
  };
  var picks = (m.picks || [])
    .map(function (p) {
      var o = tipOutcome(m, p);
      return (
        '<button type="button" class="tip-pick-row ' + ({ V: 'won', P: 'lost', N: 'void', '': 'wait' }[o.s]) + '" data-tip-ov="' + p.m + '"><span><b>' + U.esc(p.sel) + '</b><small>' + TIP_SHORT[p.m] + ' · ' + p.p + '%' + (o.man ? ' · segnato a mano' : '') + '</small></span><strong>' + ({ V: 'Vinto', P: 'Perso', N: 'Annullato', '': 'In attesa' }[o.s]) + '</strong></button>'
      );
    })
    .join('');
  var html =
    sheetHead(m.home + ' – ' + m.away, { form: 'tip-form', sub: U.esc(m.league) + ' · ' + U.esc(tipDayLabel(m.date)) + ' ' + U.esc(m.time) }) +
    '<form id="tip-form" class="tip-form">' +
    '<div class="tip-res"><label>Risultato finale' + sc('tip-ft', m.ft) + '</label><label>1° tempo' + sc('tip-ht', m.ht) + '</label></div>' +
    '<label class="toggle-line"><input type="checkbox" id="tip-cancel"' + (m.cancelled ? ' checked' : '') + '> Partita annullata o rinviata</label>' +
    '<h3 class="tip-sub">Pronostici oltre la soglia</h3><p class="muted tip-hint">Si segnano da soli dal risultato. Tocca per cambiarli a mano: vinto → perso → annullato → automatico.</p>' +
    '<div class="tip-pick-list">' + (picks || '<p class="muted">Nessun pronostico.</p>') + '</div>' +
    '<h3 class="tip-sub">Probabilità del modello</h3>' +
    '<div class="tip-probs">' + prob('1', c.p1) + prob('X', c.px) + prob('2', c.p2) + prob('Over 0.5', c.o05, 1) + prob('Over 1.5', c.o15, 1) + prob('Over 2.5', c.o25, 1) + prob('Over 0.5 1T', c.ht05, 1) + prob('Goal', c.gg, 1) + '</div>' +
    '<p class="muted tip-hint">Gol attesi ' + c.lh.toFixed(2) + ' – ' + c.la.toFixed(2) + ' · risultati più probabili ' + c.cs.map(function (x) { return x.s + ' (' + x.p + '%)'; }).join(', ') + '</p>' +
    '<p class="muted tip-hint"><b>Origine analisi:</b> ' + U.esc(tipReviewLabel(m)) + ' · Batch ' + U.esc(m.batch || 'non identificato') + '</p>' +
    (m.review === 'not_revised' ? '<p class="muted tip-hint"><b>Non aggiornata:</b> questa partita era già iniziata o non faceva parte della revisione. Il pronostico originale è conservato per confrontarlo con il risultato senza modifiche a posteriori.</p>' : '') +
    '<p class="muted tip-hint">Affidabilità dati ' + m.rel + (m.note ? ' · ' + U.esc(m.note) : '') + '</p>' +
    '</form>';
  var d = sheetModal(html);
  var ovState = Object.assign({}, m.ov || {});
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
    if (
      mutate(function (n) {
        var x = n.predictions.find(function (y) { return y.id === m.id; });
        if (!x) return;
        x.ft = ft;
        x.ht = ht;
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
function bindTips() {
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
    b.onclick = function () {
      var P = tipParams();
      U.download('pronostici-storico-' + U.local().slice(0, 10) + '.json', {
        app: 'bet_tracker',
        kind: 'pronostici-storico',
        exportedAt: new Date().toISOString(),
        compatibleWith: ['Claude', 'GPT'],
        schemaVersion: '1',
        model: (db.predModel || {}).base || TIP_DEFAULTS,
        learned: (db.predModel || {}).learned || null,
        matches: (db.predictions || []).map(function (m) {
          var c = tipCalc(m, P);
          return Object.assign({}, m, {
            prob: { p1: c.p1, px: c.px, p2: c.p2, o05: c.o05, o15: c.o15, o25: c.o25, ht05: c.ht05, gg: c.gg },
            outcomes: (m.picks || []).map(function (p) {
              return { m: p.m, sel: p.sel, p: p.p, esito: tipOutcome(m, p).s || null };
            }),
          });
        }),
      });
    };
  });
  /* Controllo automatico del file all'apertura della scheda, al massimo ogni 30 minuti. */
  var last = (db.predModel || {}).lastCheck;
  if (!tipUI.loading && (!tipUI.checkedAt || Date.now() - tipUI.checkedAt > 30 * 60e3) && navigator.onLine !== false) {
    tipUI.checkedAt = Date.now();
    if (!last || Date.now() - Date.parse(last) > 30 * 60e3 || !(db.predictions || []).length) tipFetch();
  }
}
