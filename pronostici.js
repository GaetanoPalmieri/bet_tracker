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
    if (x.p >= tipThr(P, k[0])) out.push({ m: k[0], sel: x.sel, p: x.p });
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
        if (Array.isArray(fm.p1x2) && fm.p1x2.length === 3) m.p1x2 = fm.p1x2.map(Number);
        if (fm.cancelled) m.cancelled = true;
        tipCopyExtra(m, fm);
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
          tipCopyExtra(cur, fm);
          cur.batch = String(file.batch || fm.date);
          cur.picks = tipPicksFor(cur, P);
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
  if (/rateLimit|Too many requests|per minute/i.test(t)) return 'API-Football: troppe richieste in un minuto. Riprova tra un minuto.';
  if (/request limit for the day|"requests"/i.test(t)) return 'Richieste giornaliere di API-Football finite: si azzerano alle 2 di notte.';
  if (/429|limit/i.test(t)) return 'API-Football: limite di richieste raggiunto. Riprova tra qualche minuto.';
  return t.replace(/^Errore \d+:\s*/, '').slice(0, 140) || 'Dati automatici non disponibili.';
}
async function tipAutoResults(opts) {
  opts = opts || {};
  if (tipUI.resBusy) return;
  if (!opts.manual && tipUI.afOff && Date.now() - tipUI.afOff < 6 * 3600e3) return;
  if (!tipCanSync()) {
    if (opts.manual) U.toast('Fai l’accesso in Altro › Sincronizzazione per i risultati automatici.');
    return;
  }
  var now = Date.now();
  var hasHt = function (m) { return (m.picks || []).some(function (p) { return p.m === 'ht05'; }); };
  var todo = (db.predictions || []).filter(function (m) {
    if (m.cancelled || (m.afMiss || 0) >= 3) return false;
    var ko = tipKickoff(m).getTime();
    if (!(ko + 125 * 60e3 < now && ko > now - 5 * 86400e3)) return false;
    if (!tipNum(m.ft)) return true;
    if (m.ov && Object.keys(m.ov).length && !m.afId) return true; /* esiti a mano da sostituire */
    /* 3.14.1 — partite già chiuse ma senza minuto del primo gol (serve al piano 30') */
    return hasHt(m) && !Number.isInteger(m.fg) && tipNum(m.ht) && m.ht[0] + m.ht[1] > 0 && !m.fgTried;
  });
  if (!todo.length) {
    if (opts.manual) U.toast('Nessun risultato da cercare.');
    return;
  }
  tipUI.resBusy = true;
  try {
    var r = await SuiteSync.api(TIP_FN, {
      method: 'POST',
      json: { action: 'results', matches: todo.slice(0, 80).map(function (m) { return { id: m.id, date: m.date, time: m.time, home: m.home, away: m.away, league: m.league, afId: m.afId || null, needFg: hasHt(m) && !Number.isInteger(m.fg) }; }) },
    });
    var byId = {};
    (r.results || []).forEach(function (x) { byId[x.id] = x; });
    var n = 0, voids = 0;
    mutate(function (d) {
      d.predictions.forEach(function (m) {
        if (!todo.some(function (t) { return t.id === m.id; })) return;
        var x = byId[m.id];
        if (!x) { m.afMiss = (m.afMiss || 0) + 1; return; }
        m.afId = x.afId;
        if (x.cancelled && !m.cancelled) { m.cancelled = true; m.ov = {}; voids++; }
        /* 3.14.1 — il risultato automatico prevale su quello segnato a mano:
           si aggiornano punteggi e si tolgono gli esiti manuali */
        if (Array.isArray(x.ft)) {
          if (!tipNum(m.ft) || m.ft[0] !== x.ft[0] || m.ft[1] !== x.ft[1]) n++;
          m.ft = x.ft;
          m.ov = {};
        }
        if (Array.isArray(x.ht)) m.ht = x.ht;
        if (Number.isInteger(x.fg) && !Number.isInteger(m.fg)) m.fg = x.fg;
        if (tipNum(m.ft) && !Number.isInteger(m.fg) && m.ht && m.ht[0] + m.ht[1] > 0) m.fgTried = true;
      });
      d.predModel = d.predModel || {};
      d.predModel.lastResults = new Date().toISOString();
      if (r.remaining != null) d.predModel.afRemaining = r.remaining;
    });
    if (n || voids || opts.manual)
      U.toast(n || voids ? 'Risultati automatici: ' + n + ' partite' + (voids ? ', ' + voids + ' rinviate' : '') : 'Nessun nuovo risultato (' + (r.unmatched || 0) + ' partite non trovate)');
  } catch (e) {
    if (opts.manual) U.toast(tipFnErr(e));
  } finally {
    tipUI.resBusy = false;
    if (tab === 'tips') render();
  }
}
async function tipLiveFetch(m) {
  if (!tipCanSync()) throw Object.assign(new Error('auth'), { auth: true });
  var r = await SuiteSync.api(TIP_FN, {
    method: 'POST',
    json: { action: 'live', match: { id: m.id, date: m.date, time: m.time, home: m.home, away: m.away, league: m.league, afId: m.afId || null } },
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
var TIP_LIVE_MINP = 0.5; /* 3.17.2 — il verdetto considera solo giocate più probabili che no, come il tuo metodo */
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
var TIP_LM_LABEL = {
  xg: 'xG', xgo: 'xG avversari (partita aperta)', sot: 'tiri in porta', box: 'tiri in area', sh: 'tiri', cor: 'angoli',
  soto: 'tiri in porta avversari', gl: 'gol già segnati', rxg: 'xG ultimi minuti', rsot: 'tiri in porta ultimi minuti',
  rsh: 'tiri ultimi minuti', poss: 'possesso', red: 'espulso', redo: 'avversario in 10', lose: 'in svantaggio',
  win1: 'avanti di 1', win2: 'avanti di 2+', lose_l: 'in svantaggio dopo il 60’', win_l: 'in vantaggio dopo il 60’',
  draw_l: 'pari dopo il 60’', fav: 'forza prepartita', rg: 'gol appena segnato', altro: 'altri fattori',
};
/* inp: { min, half, gh, ga, side:[{s,t,b,c,xg,poss,red},{...}], prev:{min, side} } */
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
    var x = mod.b[0], parts = [];
    mod.keys.forEach(function (k, n) {
      var v = (f[k] || 0) * mod.b[n + 1];
      x += v;
      parts.push({ k: k, v: v });
    });
    x = Math.max(-1.2, Math.min(1.2, x));
    return { all: lam[i] * R.all * Math.exp(x), ht: lam[i] * R.ht * Math.exp(x) * mod.c1, mult: Math.exp(x), parts: parts };
  });
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
  lines.push({ k: 'nh', label: 'Prossimo gol ' + m.home, sub: '', p: (1 - p0) * (L ? rh / L : 0.5) });
  lines.push({ k: 'na', label: 'Prossimo gol ' + m.away, sub: '', p: (1 - p0) * (L ? ra / L : 0.5) });
  lines.forEach(function (x) { x.fair = x.p > 0.001 ? 1 / x.p : null; });
  var base = (lam[0] + lam[1]) * R.all;
  return { F: L / Math.max(0.001, base), used: hasStats, model: name, recent: !!pv, xg: hasXg, rem: R, L: L, rh: rh, ra: ra, lines: lines, lam: lam[0] + lam[1], teams: out };
}
function tipIsLiveNow(m) {
  if (m.cancelled || tipNum(m.ft)) return false;
  var ko = tipKickoff(m).getTime(), now = Date.now();
  return now >= ko - 5 * 60e3 && now <= ko + 135 * 60e3;
}
/* ---------- 3.18.0 — Scanner: tutte le partite live del mondo ---------- */
async function tipScanFetch() {
  if (!tipCanSync()) throw Object.assign(new Error('auth'), { auth: true });
  var r = await SuiteSync.api(TIP_FN, { method: 'POST', json: { action: 'scan', odds: true } });
  tipUI.scan = { at: Date.now(), list: r.live || [], oddsNote: r.oddsNote || null, remaining: r.remaining };
  return tipUI.scan;
}
function tipPoisAtLeast(n, L) {
  var p = 0, t = Math.exp(-L);
  for (var k = 0; k < n; k++) { p += t; t *= L / (k + 1); }
  return 1 - p;
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
  if (pre && pre.o25 > 1 && pre.u25 > 1) {
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
    date: U.today ? U.today() : ko.toISOString().slice(0, 10),
    time: ko.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
    lh: lam * sh, la: lam * (1 - sh), rel: 'C',
  };
  var inp = { min: min, half: half, gh: gh, ga: ga };
  if (x.stats && x.stats.side) inp.side = x.stats.side;
  if (x.lastGoal != null && min - x.lastGoal >= 0 && min - x.lastGoal <= 5) inp.rg = true;
  /* i dati live arrivati con la scansione valgono come una sincronizzazione */
  tipUI.liveData = tipUI.liveData || {};
  if (x.stats) tipUI.liveData[m.id] = { afId: x.afId, status: st, elapsed: x.elapsed, goals: x.goals, stats: x.stats, lastGoal: x.lastGoal, at: (tipUI.scan && tipUI.scan.at) || Date.now() };
  var r = tipInplay(m, inp),
    main = r.lines.find(function (y) { return y.k === (r.rem.ht > 0 ? 'h1' : 'n1'); }) || r.lines[0];
  return { m: m, x: x, min: min, half: half, main: main, r: r };
}
function tipScanPanel() {
  var S = tipUI.scan;
  var head = '<section class="card tip-top"><div class="tip-top-head"><b>Scanner · tutte le partite live</b><span>' + (S ? new Date(S.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '1-2 richieste') + '</span></div>' +
    '<button type="button" class="tip-live-get" data-scan>' + (S ? '🔎 Scansiona di nuovo' : '🔎 Scansiona le partite live') + '</button>';
  if (!S) return head + '<p class="muted tip-tnone">Cerca tra tutte le partite in corso nel mondo quelle con più probabilità di un altro gol nel tempo in corso.</p></section>';
  var all = S.list.map(tipScanMatch).filter(Boolean),
    showAll = !!tipUI.scanAll,
    rows = all.filter(function (y) { return showAll || (y.main.p >= TIP_LIVE_MINP && y.min <= 80); })
      .sort(function (a, b) { return b.main.p - a.main.p; }).slice(0, 40);
  tipUI.scanMap = {};
  all.forEach(function (y) { tipUI.scanMap[y.m.afId] = y.m; });
  var withOdds = all.filter(function (y) { return y.m.scanSrc !== 'media'; }).length;
  return head +
    '<p class="muted tip-hint">' + all.length + ' partite in corso · ' + withOdds + ' con quote' + (S.oddsNote ? ' (quote live non disponibili: ' + U.esc(S.oddsNote) + ')' : '') + '. In alto le più probabili per un altro gol nel tempo in corso. Le stime senza quote usano solo la media gol. Prima di giocare apri la partita e sincronizza.</p>' +
    (rows.length ? '<div class="tip-tlist">' + rows.map(function (y) {
      return '<button type="button" class="tip-trow" data-scan-open="' + y.m.afId + '"><span class="tip-tn tip-ln">' + (y.x.status === 'HT' ? 'HT' : y.min + '\'') + '</span><span class="tip-tmain"><b>' + U.esc(y.m.home) + ' – ' + U.esc(y.m.away) + '</b><small>' + U.esc(y.m.league) + (y.m.scanSrc === 'media' ? ' · senza quote' : '') + (y.x.stats ? ' · statistiche' : '') + '</small></span><span class="tip-tpick"><b>' + y.x.goals[0] + '-' + y.x.goals[1] + ' · ' + Math.round(y.main.p * 100) + '%</b><small>' + (y.r.rem.ht > 0 ? 'gol 1T' : 'altro gol') + ' · min ' + y.main.fair.toFixed(2) + ' ›</small></span></button>';
    }).join('') + '</div>' : '<p class="muted tip-tnone">Nessuna partita sopra il 50% adesso.</p>') +
    '<button type="button" class="tip-ctx-btn" data-scan-all>' + (showAll ? 'Mostra solo le migliori' : 'Mostra tutte le partite') + '</button>' +
    '</section>';
}
function tipLivePanel(list) {
  var live = list.filter(tipIsLiveNow).sort(function (a, b) { return tipKickoff(a) - tipKickoff(b); }),
    soon = list.filter(function (m) {
      var ko = tipKickoff(m).getTime(), now = Date.now();
      return !m.cancelled && !tipNum(m.ft) && ko > now + 5 * 60e3 && ko < now + 3 * 3600e3;
    }).sort(function (a, b) { return tipKickoff(a) - tipKickoff(b); });
  var row = function (m) {
    var d = (tipUI.liveData || {})[m.id],
      sc = d && d.goals && d.goals[0] != null ? d.goals[0] + '-' + d.goals[1] : 'vs',
      mn = d && d.elapsed != null ? d.elapsed + '\'' : U.esc(m.time);
    return '<button type="button" class="tip-trow" data-tip-live="' + U.esc(m.id) + '"><span class="tip-tn tip-ln">' + mn + '</span><span class="tip-tmain"><b>' + U.esc(m.home) + ' – ' + U.esc(m.away) + '</b><small>' + U.esc(m.league) + (d && d.at ? ' · aggiornata alle ' + new Date(d.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '') + '</small></span><span class="tip-tpick"><b>' + sc + '</b><small>valuta ›</small></span></button>';
  };
  return (
    '<section class="card tip-top"><div class="tip-top-head"><b>In corso</b><span>' + live.length + ' partite</span></div>' +
    (live.length ? '<div class="tip-tlist">' + live.map(row).join('') + '</div>' : '<p class="muted tip-tnone">Nessuna partita dei pronostici in corso adesso.</p>') +
    '</section>' +
    tipScanPanel() +
    (soon.length ? '<section class="card tip-top"><div class="tip-top-head"><b>Tra poco</b><span>prossime 3 ore</span></div><div class="tip-tlist">' + soon.map(row).join('') + '</div></section>' : '') +
    '<p class="muted tip-hint">Tocca una partita: “Sincronizza” scarica minuto, punteggio e statistiche; poi l’app valuta i mercati sui gol da quel momento (prossimo gol, Over finale e del 1° tempo, Goal). Puoi anche correggere i numeri a mano.</p>'
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
    '<p class="muted tip-hint">Segna quello che sai prima della partita: obbligo di vincere, turnover, assenze. Cambia i gol attesi e quindi tutti i pronostici, le Top e il live di questa partita.</p>' +
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
        try { var P = tipParams(), pk = tipPicksFor(x, P); if (pk.length) x.picks = pk; } finally { db = keep; }
      }
    });
    dlg.close();
    U.toast('Contesto salvato: pronostici aggiornati.');
    if (back === 'live') tipLiveSheet(m.id);
  };
  draw();
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
    '<button type="button" class="tip-live-get" data-ip-sync>📡 Sincronizza</button>' +
    (m.scan ? '<p class="muted tip-hint">Partita dallo scanner: la forza delle squadre viene ' + (m.scanSrc === 'quote' ? 'dalle quote prepartita (Over/Under 2.5 e 1X2).' : m.scanSrc === 'quote live' ? 'dalle quote live (Over/Under) al momento della scansione.' : 'dalla media dei gol, senza quote: stima più grezza.') + '</p>' : '<button type="button" class="tip-ctx-btn" data-ctx-open>🧭 Contesto squadre' + tipCtxBadge(m) + ' ›</button>') +
    '<div id="tip-ip-out" class="tip-live-out"></div>' +
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
    '<p class="muted tip-hint">Scrivi la quota del tuo book accanto al mercato che ti interessa: l’app dice se conviene. Sincronizzando ogni 10-15 minuti il modello vede anche il momento della partita.</p>' +
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
      out.innerHTML = '<p class="muted">Tocca Sincronizza, oppure apri “Dati live” e scrivi almeno minuto e punteggio.</p>';
      return;
    }
    var r = tipInplay(m, v);
    var main = r.lines.find(function (x) { return x.k === (r.rem.ht > 0 ? 'h1' : 'n1'); }) || r.lines[0],
      qm = q[main.k], vText;
    if (U.finite(qm) && qm > 1) {
      var evm = (qm * main.p - 1) * 100;
      vText = qm >= main.fair
        ? '<b class="positive">GIOCA a ' + qm.toFixed(2) + '</b><small>atteso ' + (evm >= 0 ? '+' : '') + evm.toFixed(1) + '% · quota minima ' + main.fair.toFixed(2) + '</small>'
        : '<b class="negative">NON GIOCARE a ' + qm.toFixed(2) + '</b><small>serve almeno ' + main.fair.toFixed(2) + ' · atteso ' + evm.toFixed(1) + '%</small>';
    } else vText = '<b>Gioca solo da quota ' + (main.fair ? main.fair.toFixed(2) : '—') + ' in su</b><small>scrivi la quota del tuo book qui accanto</small>';
    var mainHtml =
      '<div class="tip-ipmain"><div class="tip-ipmain-h"><span>Prossimo gol ' + (r.rem.ht > 0 ? 'nel 1° tempo' : 'entro la fine') + '</span><small>' + U.esc(main.label) + '</small></div>' +
      '<div class="tip-ipmain-b"><strong>' + pct(main.p) + '</strong><input type="number" min="1" step="0.01" inputmode="decimal" placeholder="quota" data-iq="' + main.k + '" value="' + (U.finite(qm) ? qm : '') + '"></div>' +
      '<div class="tip-ipmain-v">' + vText + '</div></div>';
    /* C'è ancora valore? confronto con come la prezza il book (quote prepartita + punteggio + espulsioni) */
    var rb = tipInplay(m, v, true),
      c0 = tipCalc(m, tipParams()),
      cand = r.lines.filter(function (x) { return ['n1', 'n2', 'h1', 'gg'].indexOf(x.k) >= 0 && x.p >= TIP_LIVE_MINP && x.p <= 0.97; }).map(function (x) {
        var b = rb.lines.find(function (y) { return y.k === x.k; }),
          real = U.finite(q[x.k]) && q[x.k] > 1,
          odd = real ? q[x.k] : (b && b.p > 0 ? Math.max(1.01, 1 / Math.min(0.99, b.p * TIP_LIVE_MARGIN)) : null);
        return { x: x, odd: odd, real: real, ev: odd ? x.p * odd - 1 : -1 };
      }).sort(function (a, b) { return (b.ev - (b.x.k === 'gg' ? 0.04 : 0)) - (a.ev - (a.x.k === 'gg' ? 0.04 : 0)); }),
      best = cand[0],
      pace = r.F >= 1.08 ? 'più viva' : r.F <= 0.92 ? 'più bloccata' : 'come previsto',
      vc, vh, vb;
    if (!best) { vc = 'no'; vh = 'NO, niente da giocare'; vb = 'Nessun mercato gol è più probabile che no' + (r.lines[0] && r.lines[0].p < TIP_LIVE_MINP ? ': un altro gol è al ' + pct(r.lines[0].p) + '. Sarebbe una scommessa che perdi quasi sempre, anche se la quota è alta.' : '.'); }
    else if (!r.used && !best.real) { vc = 'mid'; vh = 'Valore non stimabile'; vb = 'Senza statistiche live il modello vede solo minuto e punteggio, come il book: tocca Sincronizza o scrivi i dati.'; }
    else if (best.ev >= 0.05 && !best.real) { vc = 'mid'; vh = 'Forse: controlla la quota'; vb = '<b>' + U.esc(best.x.label) + '</b> al ' + pct(best.x.p) + ': il giusto è ' + best.x.fair.toFixed(2) + '. Scrivi la quota del tuo book qui sotto: SÌ solo se è almeno ' + best.x.fair.toFixed(2) + '.'; }
    else if (best.ev >= 0.05) { vc = 'yes'; vh = 'SÌ, c’è valore'; vb = '<b>' + U.esc(best.x.label) + '</b> al ' + pct(best.x.p) + ': ' + (best.real ? 'la tua quota ' : 'il book dovrebbe pagarla circa ') + best.odd.toFixed(2) + ', il giusto è ' + best.x.fair.toFixed(2) + ' (atteso +' + Math.round(best.ev * 100) + '%). Gioca solo da ' + best.x.fair.toFixed(2) + ' in su.'; }
    else if (best.ev >= 0) { vc = 'mid'; vh = 'Valore minimo'; vb = '<b>' + U.esc(best.x.label) + '</b>: conviene solo da quota ' + (best.x.fair * 1.05).toFixed(2) + ' in su. Sotto, meglio aspettare.'; }
    else { vc = 'no'; vh = 'NO, niente valore'; vb = 'Il book paga ' + (best.real ? '' : 'probabilmente ') + 'meno del giusto su tutti i mercati gol. Lascia stare o risincronizza tra qualche minuto.'; }
    var h1l = r.lines.find(function (x) { return x.k === 'h1'; });
    var plan = (v.gh || 0) + (v.ga || 0) === 0 && v.min >= 25 && v.min <= 38 && h1l
      ? (vc === 'no' ? ' 2° step del tuo piano (0-0 al 30’): qui meglio saltarlo.' : ' 2° step del tuo piano (0-0 al 30’): Over 0.5 1T solo da quota ' + h1l.fair.toFixed(2) + ' in su.')
      : '';
    var preTxt = 'Prepartita: Over 0.5 1T ' + Math.round(c0.ht05) + '% · Over 1.5 ' + Math.round(c0.o15) + '%. Partita ' + pace + ' (' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '% gol attesi rispetto a quanto direbbero solo minuto e prepartita).';
    var valHtml = '<div class="tip-ipval tip-ipval-' + vc + '"><div class="tip-ipval-h"><small>C’è ancora valore su questa partita?</small><b>' + vh + '</b></div><p>' + vb + '</p><small>' + preTxt + plan + (best && !best.real && r.used ? ' Quota del book stimata: scrivi quella vera per la conferma.' : '') + '</small></div>';
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
    out.innerHTML = valHtml + mainHtml +
      '<div class="tip-probs"><div class="tip-prob"><small>Gol attesi da qui</small><b>' + r.L.toFixed(2) + '</b><i>' + U.esc(m.home.split(' ')[0]) + ' ' + r.rh.toFixed(2) + ' · ' + U.esc(m.away.split(' ')[0]) + ' ' + r.ra.toFixed(2) + '</i></div>' +
      '<div class="tip-prob"><small>Effetto live</small><b>' + (r.F >= 1 ? '+' : '') + Math.round((r.F - 1) * 100) + '%</b><i>' + mdl + '</i></div>' +
      '<div class="tip-prob"><small>Tempo rimasto</small><b>' + Math.round(r.rem.all * 100) + '%</b><i>dei gol della partita</i></div></div>' +
      '<div class="tip-ipwhy"><small>Perché (rispetto al prepartita)</small>' + why + (r.recent ? '' : '<p class="muted">Momento degli ultimi minuti: serve una sincronizzazione di 5-30 minuti fa.</p>') + '</div>' +
      '<div class="tip-iplines">' +
      r.lines.filter(function (x) { return x.k !== main.k; }).map(function (x) {
        var qq = q[x.k], verdict = '';
        if (U.finite(qq) && qq > 1) {
          var ev = (qq * x.p - 1) * 100;
          verdict = '<em class="' + (ev > 0 ? 'positive' : 'negative') + '">' + (ev > 0 ? 'Conviene ' : 'Non conviene ') + (ev >= 0 ? '+' : '') + ev.toFixed(1) + '%</em>';
        }
        return '<div class="tip-ipline"><span><b>' + U.esc(x.label) + '</b><small>' + (x.sub ? U.esc(x.sub) + ' · ' : '') + 'quota minima ' + (x.fair ? x.fair.toFixed(2) : '—') + '</small>' + verdict + '</span><strong>' + pct(x.p) + '</strong>' +
          '<input type="number" min="1" step="0.01" inputmode="decimal" placeholder="quota" data-iq="' + x.k + '" value="' + (U.finite(qq) ? qq : '') + '"></div>';
      }).join('') +
      '</div>';
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
      ? '<span class="tip-rank"><span><small>' + U.esc(tipDayLabel(m.date)) + '</small>' + U.esc(tipSortLabel(m, sortKey)) + '</span><b>' + Math.round(m._sv != null ? m._sv : tipSortValue(m, sortKey)) + '%</b></span>'
      : '') +
    '<span class="tip-meta"><span class="tip-time">' + U.esc(m.time) + '</span><span class="tip-league">' + U.esc(m.league) + '</span>' + badge + '</span>' +
    '<span class="tip-teams"><span class="tip-home">' + U.esc(m.home) + '</span>' + mid + '<span class="tip-away">' + U.esc(m.away) + '</span></span>' +
    '<span class="tip-picks">' + (m.picks || []).map(function (p) { return tipChip(m, p); }).join('') + '</span>' +
    (m.warn ? '<span class="tip-warn">⚠ ' + U.esc(m.warn) + '</span>' : '') +
    (tipIsLiveNow(m) ? '<span class="tip-livechip" data-tip-live="' + U.esc(m.id) + '" role="button">📡 Live · sintonizza ›</span>' : '') +
    tipOthers(m) +
    '<span class="tip-foot"><span class="tip-rel r' + m.rel + '">Dati ' + m.rel + '</span><span class="tip-origin' + (m.review === 'not_revised' ? ' stale' : '') + '">' + U.esc(tipReviewLabel(m)) + '</span>' + (m.fav ? '<span class="tip-origin">Favorita ' + m.fav + '%</span>' : '') + '</span>' +
    '</button>'
  );
}
function tipToolbar(list) {
  var stats = tipUI.panel === 'stats',
    top = tipUI.panel === 'top',
    liveP = tipUI.panel === 'live',
    nLive = list.filter(tipIsLiveNow).length,
    P = tipParams();
  var title = stats ? 'Statistiche' : top ? 'Top del giorno' : liveP ? 'Live' : list.length + ' partite',
    sub = stats ? 'Vinti, attese e correzioni' : top ? 'Le più sicure, con media minima garantita' : liveP ? 'Sincronizza e valuta in qualsiasi minuto' : '1T da ' + tipThr(P, 'ht05') + '%, Over 1.5 da ' + tipThr(P, 'o15') + '%';
  return (
    '<div class="tip-toolbar">' +
    '<div class="tip-toolbar-title"><b>' + title + '</b><small>' + sub + '</small></div>' +
    '<button type="button" class="tip-tool' + (top ? ' on' : '') + '" data-tip-panel="' + (top ? 'list' : 'top') + '" aria-label="' + (top ? 'Torna alle partite' : 'Top del giorno') + '">' + (top ? TIP_IC.list : TIP_IC.star) + '<span>' + (top ? 'Partite' : 'Top') + '</span></button>' +
    '<button type="button" class="tip-tool' + (liveP ? ' on' : '') + '" data-tip-panel="' + (liveP ? 'list' : 'live') + '" aria-label="' + (liveP ? 'Torna alle partite' : 'Partite in corso') + '">' + (liveP ? TIP_IC.list : '<i class="tip-livedot' + (nLive ? ' on' : '') + '"></i>') + '<span>' + (liveP ? 'Partite' : 'Live' + (nLive ? ' ' + nLive : '')) + '</span></button>' +
    '<button type="button" class="tip-tool icon-only' + (stats ? ' on' : '') + '" data-tip-panel="' + (stats ? 'list' : 'stats') + '" aria-label="' + (stats ? 'Torna alle partite' : 'Statistiche') + '">' + (stats ? TIP_IC.list : TIP_IC.stats) + '</button>' +
    '<button type="button" class="tip-tool icon-only" data-tip-sheet aria-label="Aggiorna, importa ed esporta">' + TIP_IC.file + (tipUI.loading ? '<i class="tip-spin"></i>' : '') + '</button>' +
    '</div><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>'
  );
}
function tipsPage() {
  tipUI._cal = null; /* calibrazione ricalcolata a ogni disegno della pagina */
  var list = (db.predictions || []).slice();
  if (!list.length) {
    return (
      '<section class="card tip-empty"><b>Nessuna partita</b><p class="muted">I pronostici arrivano dal file che prepara Claude. Chiedigli “prevedi le prossime partite”, poi pubblica l’app oppure importa il file qui.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-fetch>↻ Cerca aggiornamenti</button><button type="button" data-tip-import>Importa file</button></div></section><input type="file" accept=".json,.csv,application/json,text/csv,text/plain" id="tip-file" hidden>'
    );
  }
  return tipToolbar(list) + (tipUI.panel === 'stats' ? tipStatsPanel(list) : tipUI.panel === 'top' ? tipTopPanel(list) : tipUI.panel === 'live' ? tipLivePanel(list) : tipListPanel(list));
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
    '<section class="card diary-card tip-markets"><h2>Andamento per mercato</h2><p class="muted">Solo i pronostici sopra la soglia del mercato (1T da ' + tipThr(P, 'ht05') + '%, Over 1.5 da ' + tipThr(P, 'o15') + '%). La tacca è quanto si aspettava il modello: se la barra resta sotto, il modello è troppo ottimista su quel mercato.</p>' +
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
    '<section class="card diary-card tip-markets"><h2>Andamento liste Top</h2><p class="muted">Solo le partite entrate nelle Top. La tacca è la media promessa dalla lista.</p>' +
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
  mk += '<section class="card diary-card tip-markets"><h2>Promesso e reale</h2><p class="muted">Per fasce di probabilità: quanto prometteva il modello e quanto ha vinto davvero. Con questi dati l\'app corregge le stime delle Top (con prudenza finché i risultati sono pochi).</p><table class="tip-caltab"><tr><th></th>' + bands.map(function (b) { return '<th>' + b[0] + (b[1] < 100 ? '-' + b[1] : '+') + '%</th>'; }).join('') + '</tr>' +
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
  mk += '<section class="card diary-card tip-markets"><h2>Statistiche, quote o mix?</h2><p class="muted">Errore medio (Brier, più basso è meglio) sulle partite con quote e risultato. Serve a decidere quanto devono pesare le quote.</p><table class="tip-caltab"><tr><th></th><th>Solo statistiche</th><th>Solo quote</th><th>Mix usato</th></tr>' +
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
      '<p class="muted">Applicando le correzioni cambiano le probabilità mostrate; i pronostici già fissati e il loro esito restano com’erano.</p>' +
      '<div class="actions"><button type="button" class="primary" data-tip-learn>Applica correzioni</button>' + (learned ? '<button type="button" data-tip-unlearn>Torna al modello di base</button>' : '') + '</div>';
  }
  cal += '</section>';
  return kpis + mk + cal;
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
    (by[r.p.m] = by[r.p.m] || []).push([r.p.p, r.won ? 1 : 0]);
  });
  tipUI._cal = by;
  return by;
}
function tipCal(k, p) {
  var rows = (tipCalRows()[k] || []).filter(function (r) { return Math.abs(r[0] - p) <= 4; });
  if (!rows.length) return p;
  var K = 25,
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
   del book (topSkip nel file = esclusa, con il motivo). */
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
function tipTopFor(day, list, P) {
  P = P || tipParams();
  var res = {};
  TIP_TOP_MK.forEach(function (mk) {
    var k = mk[0],
      target = tipTarget(P, k),
      cand = [];
    list.forEach(function (m) {
      if (m.date !== day || m.cancelled || m.topSkip || m.warn || !m.odds || !m.odds.o15) return;
      var pk = (m.picks || []).find(function (x) { return x.m === k; });
      if (!pk) return;
      /* niente Under / No goal nelle Top: solo i lati "Over / Goal / segno" */
      if (/^(Under|No goal)/.test(pk.sel)) return;
      /* 3.10.0 — probabilità corretta con lo storico (calibrazione) */
      var pc = tipCal(k, pk.p),
        pp = Object.assign({}, pk, { p: pc, raw: pk.p });
      cand.push({ m: m, p: pp, score: pc + tipFavBonus(m, k) });
    });
    cand.sort(function (a, b) { return b.score - a.score || b.p.p - a.p.p; });
    var pickd = [], sum = 0, stop = false;
    cand.forEach(function (c) {
      if (stop) return;
      /* partita equilibrata (favorita sotto il 42%): entra solo se da sola raggiunge l'obiettivo */
      if (tipFavBonus(c.m, k) < 0 && c.p.p < target) return;
      /* 3.9.1 — ogni partita al massimo 1 punto sotto l'obiettivo e media sopra l'obiettivo;
         le partite sotto il minimo restano fuori (le Top restano corte e solide). */
      if (c.p.p >= target - 1 && (sum + c.p.p) / (pickd.length + 1) >= target) {
        pickd.push(c);
        sum += c.p.p;
      }
    });
    /* 3.14.0 — Top allargata: fino a 3 punti sotto l'obiettivo, fuori dalla Top sicura.
       Si giocano solo se la quota del book supera la quota minima indicata. */
    var inTop = {};
    pickd.forEach(function (c) { inTop[c.m.id] = 1; });
    var ext = cand.filter(function (c) { return !inTop[c.m.id] && c.p.p >= target - 3; })
      .sort(function (a, b) { return b.p.p - a.p.p || b.score - a.score; })
      .slice(0, 10);
    res[k] = { items: pickd, ext: ext, avg: pickd.length ? sum / pickd.length : null, target: target, cand: cand.length, near: pickd.length || ext.length ? [] : cand.slice(0, 3) };
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
/* 3.9.2 — Piano a due passi sul 1° tempo: 1) gol entro il 30'; 2) se 0-0 al 30', Over 0.5 1T live.
   Si suppone che il 62% dei gol del 1° tempo arrivi entro il 30' (model.plan.early).
   Quote giuste: sotto queste quote la puntata perde valore. */
function tipPlan(p) {
  var P = tipParams(),
    pl = Object.assign({ s1: 10, s2: 20, q1: 1.8, q2: 1.8, early: 0.62 }, P.plan || {});
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
    (c.p.m === 'ht05' ? (function (x) { return '<small class="tip-plan">30\' ≥' + x.fair1.toFixed(2) + ' · live ≥' + x.fair2.toFixed(2) + '</small>'; })(tipPlan(c.p.p)) : '<small class="tip-plan">quota min ' + (100 / c.p.p).toFixed(2) + (odd ? (odd >= 100 / c.p.p ? ' · conviene' : ' · sotto') : '') + '</small>') +
    '</span>' +
    (o.s ? '<em class="tip-tmark" aria-label="' + { V: 'vinto', P: 'perso', N: 'annullato' }[o.s] + '">' + { V: '✓', P: '✕', N: '–' }[o.s] + '</em>' : '') +
    '</button>'
  );
}
function tipTopPanel(list) {
  var P = tipParams(),
    today = U.local().slice(0, 10),
    days = [];
  list.forEach(function (m) { if (days.indexOf(m.date) < 0) days.push(m.date); });
  days.sort();
  var hasOdds = function (d) { return list.some(function (m) { return m.date === d && m.odds && m.odds.o15; }); };
  var shown = tipUI.day !== 'all' ? [tipUI.day] : days.filter(function (d) { return d >= today && hasOdds(d); });
  if (!shown.length) shown = days.slice(-1);
  var chips = '<div class="tip-chips tip-topdays">' + ['all'].concat(days).map(function (d) {
    var on = tipUI.day === d;
    return '<button type="button" class="tip-chip' + (on ? ' on' : '') + '" data-tip-day="' + d + '">' + (d === 'all' ? 'Da oggi' : U.esc(tipCap(tipDayLabel(d)))) + '</button>';
  }).join('') + '</div>';
  var html = chips;
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
    html += sec('★ Top di tutti i mercati', T.all, allAvg, null, 'Nessun pronostico abbastanza solido per questo giorno.');
    TIP_TOP_MK.forEach(function (mk) {
      var r = T[mk[0]];
      if (mk[0] === 'ht05' && r.items.length) {
        var ev = r.items.reduce(function (sum, c) { return sum + tipPlan(c.p.p).ev; }, 0), pl = tipPlan(80).pl;
        html += '<p class="muted tip-hint tip-planbox">Piano ' + pl.s1 + '€ gol entro il 30\' + ' + pl.s2 + '€ Over 0.5 1T live se 0-0: con quote ' + pl.q1 + ' e ' + pl.q2 + ' su queste ' + r.items.length + ' partite il guadagno atteso è <b>' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '€</b>. Sotto ogni partita: quota minima per il gol entro il 30\' e per la puntata live al 30\' sullo 0-0. Sotto quelle quote la puntata perde valore.</p>';
      }
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
  html += '<p class="muted tip-hint">Entrano solo partite con le quote Over del book. La percentuale è la stima di statistiche + quote; la quota @ è quella media del book.</p>';
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
    (m.topSkip ? '<p class="muted tip-hint">Esclusa dalle Top: ' + U.esc(m.topSkip) + '.</p>' : '')
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
    '<div class="tip-sheet-info"><div><small>Modello</small><b>v' + U.esc(P.version) + (pm.learned ? ' + correzioni' : '') + '</b></div><div><small>Soglie</small><b>1T ' + tipThr(P, 'ht05') + '% · O1.5 ' + tipThr(P, 'o15') + '%</b></div><div class="wide"><small>Ultimo file</small><b>' + U.esc(pm.lastLabel || pm.lastBatch || '—') + '</b></div><div class="wide"><small>Ultimo controllo</small><b>' + (pm.lastCheck ? U.esc(U.date(pm.lastCheck)) : 'mai') + '</b></div></div>' +
    '<button type="button" class="tip-sheet-btn primary" data-s="fetch"><b>↻ Aggiorna dal sito</b><small>Scarica il pronostici.json pubblicato con l’app</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="import"><b>Importa file</b><small>pronostici.json o pronostici.csv preparati da Claude</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="results"><b>↻ Risultati automatici</b><small>' + (pm.lastResults ? 'Ultimo controllo ' + U.esc(U.date(pm.lastResults)) + (pm.afRemaining != null ? ' · richieste rimaste oggi ' + U.esc(pm.afRemaining) : '') : 'Finale, 1° tempo e minuto del primo gol da API-Football') + '</small></button>' +
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
  d.querySelector('[data-s="results"]').onclick = function () {
    d.close();
    tipAutoResults({ manual: true });
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
  var PP = tipParams();
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
    '<button type="button" class="tip-ctx-btn" data-ctx-open>🧭 Contesto squadre' + tipCtxBadge(m) + ' ›</button>' +
    '<h3 class="tip-sub">Probabilità</h3>' +
    '<div class="tip-probs">' + prob('1', c.p1) + prob('X', c.px) + prob('2', c.p2) + prob('Over 1.5', c.o15, 1, 'o15') + prob('Over 2.5', c.o25, 1, 'o25') + prob('Over 0.5 1T', c.ht05, 1, 'ht05') + prob('Goal', c.gg, 1, 'gg') + prob('Gol attesi', c.lh.toFixed(1) + '–' + c.la.toFixed(1)) + '</div>' +
    tipOddsBlock(m) +
    (function () {
      var pk = (m.picks || []).find(function (x) { return x.m === 'ht05' && x.sel.indexOf('Over') === 0; });
      if (!pk) return '';
      var x = tipPlan(c.ht05);
      return '<h3 class="tip-sub">Piano 1° tempo <small>' + x.pl.s1 + '€ entro il 30\' + ' + x.pl.s2 + '€ live</small></h3>' +
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
  var scb = main.querySelector('[data-scan]');
  if (scb) scb.onclick = async function () {
    scb.disabled = true;
    scb.textContent = 'Scansiono…';
    try { await tipScanFetch(); render(); }
    catch (e) { U.toast(tipFnErr(e)); scb.disabled = false; scb.textContent = '🔎 Scansiona le partite live'; }
  };
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
  /* 3.12.0 — risultati automatici all'apertura, al massimo ogni 20 minuti */
  if (!tipUI.resBusy && (!tipUI.resAt || Date.now() - tipUI.resAt > 30 * 60e3) && navigator.onLine !== false && tipCanSync()) {
    tipUI.resAt = Date.now();
    setTimeout(function () { tipAutoResults(); }, 1500);
  }
}
