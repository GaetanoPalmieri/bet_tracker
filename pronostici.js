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
var TIP_DEFAULTS = { version: '1', threshold: 70, htShare: 0.45, drawBoost: 1, goalFactor: 1, leagueGoal: {}, rho: 0 };
var TIP_MARKETS = [
  ['1x2', '1X2'],
  ['o15', 'Over/Under 1.5'],
  ['o25', 'Over/Under 2.5'],
  ['ht05', 'O/U 0.5 1° tempo'],
  ['gg', 'Goal / No goal'],
];
var TIP_SHORT = { '1x2': '1X2', o05: 'O/U 0.5', o15: 'O/U 1.5', o25: 'O/U 2.5', ht05: '1° tempo', gg: 'GG/NG' };
var tipUI = { view: 'open', day: 'all', league: '', q: '', loading: false, fileInfo: '', panel: 'list', sort: 'time' };

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


/* ---------- Pagina (3.4.0: lista in primo piano, statistiche e file su pulsanti dedicati) ---------- */
var TIP_IC = {
  stats: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-6"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
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
  }[m.review] || 'Analisi precedente';
}
var TIP_ST = { V: 'won', P: 'lost', N: 'void', '': 'wait' };
function tipChip(m, p) {
  var o = tipOutcome(m, p),
    st = TIP_ST[o.s],
    mark = { V: '✓', P: '✕', N: '–' }[o.s] || '';
  return (
    '<span class="tip-pick mk-' + p.m + ' ' + st + '">' + (mark ? '<em aria-hidden="true">' + mark + '</em>' : '') + '<b>' + U.esc(p.sel) + '</b><i>' + p.p + '%</i>' +
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
      ? '<span class="tip-rank"><span><small>' + U.esc(tipDayLabel(m.date)) + '</small>' + U.esc(tipSortLabel(m, sortKey)) + '</span><b>' + Math.round(m._sv != null ? m._sv : tipSortValue(m, sortKey)) + '%</b></span>'
      : '') +
    '<span class="tip-meta"><span class="tip-time">' + U.esc(m.time) + '</span><span class="tip-league">' + U.esc(m.league) + '</span>' + badge + '</span>' +
    '<span class="tip-teams"><span class="tip-home">' + U.esc(m.home) + '</span>' + mid + '<span class="tip-away">' + U.esc(m.away) + '</span></span>' +
    '<span class="tip-picks">' + (m.picks || []).map(function (p) { return tipChip(m, p); }).join('') + '</span>' +
    tipOthers(m) +
    '<span class="tip-foot"><span class="tip-rel r' + m.rel + '">Dati ' + m.rel + '</span><span class="tip-origin' + (m.review === 'not_revised' ? ' stale' : '') + '">' + U.esc(tipReviewLabel(m)) + '</span></span>' +
    '</button>'
  );
}
function tipToolbar(list) {
  var stats = tipUI.panel === 'stats';
  return (
    '<div class="tip-toolbar">' +
    '<div class="tip-toolbar-title"><b>' + (stats ? 'Statistiche' : list.length + ' partite') + '</b><small>' + (stats ? 'Vinti, attese e correzioni' : 'Pronostici oltre il ' + tipParams().threshold + '%') + '</small></div>' +
    '<button type="button" class="tip-tool' + (stats ? ' on' : '') + '" data-tip-panel="' + (stats ? 'list' : 'stats') + '" aria-label="' + (stats ? 'Torna alle partite' : 'Statistiche') + '">' + (stats ? TIP_IC.list : TIP_IC.stats) + '<span>' + (stats ? 'Partite' : 'Statistiche') + '</span></button>' +
    '<button type="button" class="tip-tool" data-tip-sheet aria-label="Aggiorna, importa ed esporta">' + TIP_IC.file + '<span>File</span>' + (tipUI.loading ? '<i class="tip-spin"></i>' : '') + '</button>' +
    '</div><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>'
  );
}
function tipsPage() {
  var list = (db.predictions || []).slice();
  if (!list.length) {
    return (
      '<section class="card tip-empty"><b>Nessuna partita</b><p class="muted">I pronostici arrivano dal file che prepara Claude. Chiedigli “prevedi le prossime partite”, poi pubblica l’app oppure importa il file qui.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-fetch>↻ Cerca aggiornamenti</button><button type="button" data-tip-import>Importa file</button></div></section><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>'
    );
  }
  return tipToolbar(list) + (tipUI.panel === 'stats' ? tipStatsPanel(list) : tipListPanel(list));
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
        (!q || (m.home + ' ' + m.away + ' ' + m.league).toLowerCase().indexOf(q) >= 0)
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
    fbtn('view', 'Stato', stateName + ' · ' + (tipUI.view === 'all' ? list.length : counts[tipUI.view]), tipUI.view !== 'open', counts.check ? counts.check : '') +
    fbtn('day', 'Giorno', dayName, tipUI.day !== 'all') +
    fbtn('league', 'Campionato', tipUI.league || 'Tutti', !!tipUI.league) +
    fbtn('sort', 'Ordina per', sortName, byProb) +
    '</div>' +
    '<div class="tip-srow"><span class="tip-search">' + TIP_IC.search + '<input id="tip-q" type="search" placeholder="Cerca squadra" value="' + U.esc(tipUI.q) + '" aria-label="Cerca squadra"></span>' +
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
function tipStatsPanel(list) {
  var P = tipParams(),
    sum = tipSummary(tipClosed()),
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
  var rows = tipClosed();
  var mk =
    '<section class="card diary-card tip-markets"><h2>Andamento per mercato</h2><p class="muted">Solo i pronostici oltre il ' + P.threshold + '%. La tacca è quanto si aspettava il modello: se la barra resta sotto, il modello è troppo ottimista su quel mercato.</p>' +
    TIP_MARKETS.map(function (k) {
      var s = tipSummary(rows.filter(function (r) { return r.p.m === k[0]; }));
      var w = s.rate == null ? 0 : Math.max(2, s.rate);
      return (
        '<div class="tip-mrow"><div class="tip-mhead"><b>' + k[1] + '</b><span>' + (s.n ? s.w + '/' + s.n + ' · ' + tipPct(s.rate) + ' (atteso ' + tipPct(s.exp) + ')' : 'nessun esito') + '</span></div>' +
        '<div class="tip-bar"><i class="' + (s.rate != null && s.rate < s.exp - 5 ? 'low' : '') + '" style="width:' + w + '%"></i>' + (s.n ? '<em style="left:' + s.exp + '%"></em>' : '') + '</div></div>'
      );
    }).join('') +
    '</section>';
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
  return kpis + mk + cal;
}
/* 3.4.1 — Ordinamento: ora oppure probabilità (pronostico migliore o un mercato). */
try {
  var _ts = localStorage.getItem('bet_tip_sort');
  if (_ts && ['time', 'best', 'o15', 'o25', 'ht05', 'gg', '1x2'].indexOf(_ts) >= 0) tipUI.sort = _ts;
} catch (e) {}
var TIP_SORTS = [
  ['time', 'Ora di inizio'],
  ['best', 'Pronostico più probabile'],
  ['o15', 'Over 1.5'],
  ['o25', 'Over 2.5'],
  ['ht05', 'Over 0.5 1° tempo'],
  ['gg', 'Goal'],
  ['1x2', 'Segno 1X2'],
];
function tipSortValue(m, key) {
  if (key === 'best')
    return (m.picks || []).reduce(function (mx, p) {
      return Math.max(mx, p.p);
    }, 0);
  var c = tipCalc(m);
  if (key === '1x2') return Math.max(c.p1, c.px, c.p2);
  return c[key];
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
  return { o05: 'Over 0.5', o15: 'Over 1.5', o25: 'Over 2.5', ht05: 'Over 0.5 1T', gg: 'Goal' }[key];
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
function tipFileSheet() {
  var P = tipParams(),
    pm = db.predModel || {},
    list = db.predictions || [],
    days = list.map(function (m) { return m.date; }).sort();
  var html =
    sheetHead('Pronostici', { sub: list.length ? 'Dal ' + U.esc(tipDayLabel(days[0])) + ' al ' + U.esc(tipDayLabel(days[days.length - 1])) : 'Nessuna partita' }) +
    '<div class="tip-sheet">' +
    '<div class="tip-sheet-info"><div><small>Modello</small><b>v' + U.esc(P.version) + (pm.learned ? ' + correzioni' : '') + '</b></div><div><small>Soglia</small><b>oltre il ' + P.threshold + '%</b></div><div class="wide"><small>Ultimo file</small><b>' + U.esc(pm.lastLabel || pm.lastBatch || '—') + '</b></div><div class="wide"><small>Ultimo controllo</small><b>' + (pm.lastCheck ? U.esc(U.date(pm.lastCheck)) : 'mai') + '</b></div></div>' +
    '<button type="button" class="tip-sheet-btn primary" data-s="fetch"><b>↻ Aggiorna dal sito</b><small>Scarica il pronostici.json pubblicato con l’app</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="import"><b>Importa file</b><small>pronostici.json o pronostici.csv preparati da Claude</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="export"><b>Esporta storico</b><small>Risultati ed esiti in JSON, da dare a Claude o GPT per ricalibrare</small></button>' +
    '</div>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
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
    if (typeof v === 'string') return '<div class="tip-prob"><small>' + label + '</small><b>' + v + '</b></div>';
    return '<div class="tip-prob' + (v > T || (both && 100 - v > T) ? ' hot' : '') + '"><small>' + label + '</small><b>' + v + '%</b></div>';
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
    '<label class="toggle-line"><input type="checkbox" id="tip-cancel"' + (m.cancelled ? ' checked' : '') + '> Partita annullata o rinviata</label>' +
    '<h3 class="tip-sub">Pronostici <small>tocca per cambiare l’esito a mano</small></h3>' +
    '<div class="tip-pick-list">' + (picks || '<p class="muted">Nessun pronostico.</p>') + '</div>' +
    '<h3 class="tip-sub">Probabilità</h3>' +
    '<div class="tip-probs">' + prob('1', c.p1) + prob('X', c.px) + prob('2', c.p2) + prob('Over 1.5', c.o15, 1) + prob('Over 2.5', c.o25, 1) + prob('Over 0.5 1T', c.ht05, 1) + prob('Goal', c.gg, 1) + prob('Gol attesi', c.lh.toFixed(1) + '–' + c.la.toFixed(1)) + '</div>' +
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
/* 3.5.0 — Over 0.5 nella partita tolto dai pronostici (quasi sempre sicuro, non informa).
   Le partite che erano entrate solo per quello escono, a meno che abbiano dati segnati a mano. */
function tipDropO05() {
  var has = (db.predictions || []).some(function (m) {
    return (m.picks || []).some(function (p) { return p.m === 'o05'; });
  });
  if (!has) return;
  mutate(function (n) {
    n.predictions = n.predictions.filter(function (m) {
      m.picks = (m.picks || []).filter(function (p) { return p.m !== 'o05'; });
      if (m.ov) delete m.ov.o05;
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
  }
}
