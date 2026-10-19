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
        if (typeof fm.afId === 'string') m.afId = fm.afId;
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
    if (!f || !Array.isArray(f.matches)) { if (manual) U.toast((f && f.error) || 'Pronostici automatici non disponibili.'); return; }
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
  /* 3.23.0 — partite valutate nel live ancora senza esito */
  var logTodo = {};
  (((db.predModel || {}).liveLog) || []).forEach(function (x) {
    if (x.res || (x.miss || 0) >= 10) return;
    var ko = tipKickoff({ date: x.date, time: x.time }).getTime();
    if (!(ko + 125 * 60e3 < now) || ko < now - 7 * 86400e3) return;
    if (!logTodo[x.id]) logTodo[x.id] = { id: 'log:' + x.id, date: x.date, time: x.time, home: x.home, away: x.away, league: x.league, afId: x.afId || null, needFg: true, needGoals: true };
  });
  (((db.predModel || {}).playLog) || []).forEach(function (x) {
    if ((x.res != null && !(x.played && x.played.res == null)) || (x.miss || 0) >= 10 || logTodo[x.id]) return;
    var ko = tipKickoff({ date: x.date, time: x.time }).getTime();
    if (!(ko + 125 * 60e3 < now) || ko < now - 7 * 86400e3) return;
    logTodo[x.id] = { id: 'log:' + x.id, date: x.date, time: x.time, home: x.home, away: x.away, league: x.league, afId: x.afId || null, needFg: true, needGoals: true };
  });
  var logList = Object.keys(logTodo).map(function (k) { return logTodo[k]; });
  if (!todo.length && !logList.length) {
    if (opts.manual) U.toast('Nessun risultato da cercare.');
    return;
  }
  tipUI.resBusy = true;
  try {
    var r = await SuiteSync.api(TIP_FN, {
      method: 'POST',
      json: { action: 'results', matches: todo.slice(0, 80).map(function (m) { return { id: m.id, date: m.date, time: m.time, home: m.home, away: m.away, league: m.league, afId: m.afId || null, needFg: hasHt(m) && !Number.isInteger(m.fg) }; }).concat(logList.slice(0, 40)) },
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
      (d.predModel.liveLog || []).forEach(function (rec) {
        if (rec.res || !logTodo[rec.id]) return;
        var x = byId['log:' + rec.id];
        if (!x || !Array.isArray(x.ft)) { rec.miss = (rec.miss || 0) + 1; return; }
        var res = tipLiveLogResolve(rec, x);
        if (res) rec.res = res;
      });
      (d.predModel.playLog || []).forEach(function (e) {
        var needP = e.played && e.played.res == null;
        if ((e.res != null && !needP) || !logTodo[e.id]) return;
        var x = byId['log:' + e.id];
        if (!x || !Array.isArray(x.ft)) { e.miss = (e.miss || 0) + 1; return; }
        if (e.res == null) {
          var o = tipPlayOutcome(e, x);
          if (o != null) { e.res = o; e.ft = x.ft; e.ht = x.ht || null; }
          else e.miss = (e.miss || 0) + 1;
        }
        if (needP) { var op = tipPlayedOutcome(e, x); if (op != null) e.played.res = op; }
      });
      d.predModel.lastResults = new Date().toISOString();
      if (r.remaining != null) d.predModel.afRemaining = r.remaining;
    });
    setTimeout(tipDailyReports, 300);
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
  return { pWin: pWin, F: L / Math.max(0.001, base), used: hasStats, model: name, recent: !!pv, xg: hasXg, rem: R, L: L, rh: rh, ra: ra, lines: lines, lam: lam[0] + lam[1], teams: out };
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
function tipScanPanel() {
  var S = tipUI.scan;
  var head = '<section class="card tip-top tip-live-section"><div class="tip-top-head"><b>Da giocare adesso</b><span>' + (S ? 'Aggiornate alle ' + new Date(S.at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : 'In attesa della scansione') + '</span></div>';
  if (!S) return head + '<p class="muted tip-tnone">Partite live nel mondo, dalla più probabile per un gol.</p></section>';
  var all = S.list.map(tipScanMatch).filter(Boolean),
    showAll = !!tipUI.scanAll;
  tipUI.scanRows = all;
  tipUI.scanMap = {};
  all.forEach(function (y) {
    tipUI.scanMap[y.x.afId] = y.m;
    y.tempo = y.r.L / Math.max(0.03, y.r.rem.all); /* gol attesi su 90' al ritmo di adesso */
    y.ritmo = y.x.stats ? y.r.F : 1;
    y.grp = !y.x.stats ? 1 : y.ritmo >= 1.08 ? 0 : y.ritmo <= 0.92 ? 2 : 1;
    y.act = tipQuickAction(y);
    if (y.x.stats) tipPlayLogAdd(y.m, { min: y.min, half: y.half, gh: y.x.goals[0], ga: y.x.goals[1] }, y.plays);
  });
  if (tipUI._histAt !== S.at) {
    tipUI._histAt = S.at;
    tipLiveHistMany(all.filter(function (y) { return y.x.stats && y.x.stats.side && y.min != null; }).map(function (y) { return { id: y.m.id, snap: { min: y.min, half: y.half, side: y.x.stats.side, at: S.at } }; }));
  }
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
var TIP_PLAY_SHORT = { t2w: 'aspetta unico', t1w: 'aspetta 1T', t1st: 'step 1T', t1s15: '1T ≥1.50', t1s18: '1T ≥1.80', t2st3: 'step 60-80-fine', t2st2: 'step 80-fine', t2u15: 'unico ≥1.50', t2u18: 'unico ≥1.80' };
/* ---------- 3.35.0 — Traccia delle giocate consigliate (ottime) e resoconto giornaliero ----------
   3.48.0 — UNA giocata per partita e per punteggio: la migliore del momento. Se la stessa partita
   poi propone un altro tipo (step 60-80-fine → step 80-fine → unico) con lo stesso punteggio, è la
   stessa scommessa: resta quella già segnalata. Una DA VALUTARE che diventa OTTIMA viene aggiornata.
   Dopo un gol (punteggio diverso) è una giocata nuova. */
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
  if (cur.tier === 'try' && o.e.tier === 'excellent') {
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
  var G = e.gh + e.ga, FT = x.ft[0] + x.ft[1], HT = Array.isArray(x.ht) ? x.ht[0] + x.ht[1] : null,
    mins = Array.isArray(x.goals) ? x.goals.map(function (g) { return g.min; }) : null;
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
  var all = tipPlayDedup((((db.predModel || {}).playLog) || []).filter(function (e) { return e.date === date; }));
  var L = all.filter(function (e) { return e.res != null && (!e.tier || e.tier === 'excellent'); });
  var by = {}, tot = { n: 0, w: 0, p: 0, pl: 0, risk: 0 }, mine = { n: 0, w: 0, pl: 0, st: 0 };
  L.forEach(function (e) {
    if (e.res === 'skip') return;
    var b = by[e.k] = by[e.k] || { n: 0, w: 0, p: 0, pl: 0 };
    var pl = e.res ? e.win : -e.risk;
    b.n++; b.w += e.res ? 1 : 0; b.p += e.p; b.pl += pl;
    tot.n++; tot.w += e.res ? 1 : 0; tot.p += e.p; tot.pl += pl; tot.risk += e.risk;
  });
  /* 3.48.0 — le giocate che hai segnato davvero, con quota e puntata vere */
  (((db.predModel || {}).playLog) || []).forEach(function (e) {
    if (e.date !== date || !e.played || (e.played.res !== 0 && e.played.res !== 1)) return;
    mine.n++; mine.w += e.played.res; mine.pl += tipPlayedPL(e); mine.st += e.played.n > 1 ? e.played.risk : e.played.s;
  });
  return { date: date, by: by, tot: tot, mine: mine };
}
/* a fine giornata: quando tutte le giocate del giorno hanno l'esito (o dopo 2 giorni) il resoconto si salva da solo */
function tipDailyReports() {
  var M = db.predModel || {}, L = M.playLog || [], today = U.local().slice(0, 10), done = M.reports || {}, fresh = [];
  /* 3.48.0 — i resoconti salvati prima contavano più tipi della stessa partita: si ricalcolano una volta */
  if (!M.reportsV) done = {};
  var days = [];
  L.forEach(function (e) { if (e.date < today && days.indexOf(e.date) < 0) days.push(e.date); });
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
    fresh.forEach(function (r) { n.predModel.reports[r.date] = { tot: r.tot, by: r.by, mine: r.mine, at: Date.now() }; });
    n.predModel.reportsV = 2;
  });
  var last = fresh[fresh.length - 1];
  if (last.tot.n) U.toast('Resoconto ' + tipDayLabel(last.date) + ': ' + last.tot.w + '/' + last.tot.n + ' giocate ottime vinte · ' + (last.tot.pl >= 0 ? '+' : '') + last.tot.pl.toFixed(2) + '€ (a quota minima)' + (last.mine && last.mine.n ? ' · tue ' + last.mine.w + '/' + last.mine.n + ' ' + (last.mine.pl >= 0 ? '+' : '') + last.mine.pl.toFixed(2) + '€' : ''));
}
function tipReportPanel() {
  var R = (db.predModel || {}).reports || {}, keys = Object.keys(R).sort().reverse().slice(0, 10);
  var today = U.local().slice(0, 10), live = tipReportFor(today);
  if (!keys.length && !live.tot.n && !(((db.predModel || {}).playLog) || []).length) return '';
  var rowT = function (label, t) {
    return '<tr><th>' + label + '</th><td>' + t.n + '</td><td>' + (t.n ? Math.round(t.p / t.n * 100) + '%' : '—') + '</td><td class="' + (t.n && t.w / t.n >= t.p / t.n - 0.03 ? 'positive' : 'negative') + '">' + (t.n ? Math.round(t.w / t.n * 100) + '%' : '—') + '</td><td class="' + (t.pl >= 0 ? 'positive' : 'negative') + '">' + (t.pl >= 0 ? '+' : '') + t.pl.toFixed(1) + '€</td></tr>';
  };
  var mineTxt = function (mn) {
    if (!mn || !mn.n) return '';
    return '<p class="tip-mine">Giocate da te: <b>' + mn.w + '/' + mn.n + '</b> vinte · puntati ' + Math.round(mn.st) + '€ · <b class="' + (mn.pl >= 0 ? 'positive' : 'negative') + '">' + (mn.pl >= 0 ? '+' : '') + mn.pl.toFixed(2) + '€ veri</b></p>';
  };
  var dayBlock = function (d, rep, partial) {
    var types = Object.keys(rep.by);
    return '<details class="tip-repday"><summary><b>' + U.esc(tipCap(tipDayLabel(d))) + (partial ? ' (in corso)' : '') + '</b> · ' + rep.tot.w + '/' + rep.tot.n + ' vinte · <span class="' + (rep.tot.pl >= 0 ? 'positive' : 'negative') + '">' + (rep.tot.pl >= 0 ? '+' : '') + rep.tot.pl.toFixed(2) + '€</span>' + (rep.mine && rep.mine.n ? ' · tue <span class="' + (rep.mine.pl >= 0 ? 'positive' : 'negative') + '">' + (rep.mine.pl >= 0 ? '+' : '') + rep.mine.pl.toFixed(2) + '€</span>' : '') + '</summary>' +
      '<table class="tip-caltab"><tr><th></th><th>n</th><th>Previsto</th><th>Vinte</th><th>€</th></tr>' + types.map(function (k) { return rowT(TIP_PLAY_SHORT[k] || k, rep.by[k]); }).join('') + rowT('Totale', rep.tot) + '</table>' + mineTxt(rep.mine) + '</details>';
  };
  /* totale per tipo su tutti i giorni chiusi */
  var all = {}, allT = { n: 0, w: 0, p: 0, pl: 0 }, allM = { n: 0, w: 0, pl: 0, st: 0 };
  keys.forEach(function (d) { var r = R[d]; Object.keys(r.by).forEach(function (k) { var a = all[k] = all[k] || { n: 0, w: 0, p: 0, pl: 0 }, b = r.by[k]; a.n += b.n; a.w += b.w; a.p += b.p; a.pl += b.pl; }); allT.n += r.tot.n; allT.w += r.tot.w; allT.p += r.tot.p; allT.pl += r.tot.pl; if (r.mine) { allM.n += r.mine.n; allM.w += r.mine.w; allM.pl += r.mine.pl; allM.st += r.mine.st; } });
  return '<section class="card diary-card tip-markets"><h2>Resoconto giocate ottime</h2><p class="muted">Una giocata verde per partita, chiusa con il risultato. € a quota minima con puntata base ' + ((tipUI.step && tipUI.step.s1) || 10) + '€; “tue” = quelle che hai segnato con “L’ho giocata”, a quota vera.</p>' +
    (live.tot.n ? dayBlock(today, live, true) : '') + keys.map(function (d) { return dayBlock(d, R[d], false); }).join('') +
    (keys.length ? '<details class="tip-repday" open><summary><b>Ultimi ' + keys.length + ' giorni per tipo</b></summary><table class="tip-caltab"><tr><th></th><th>n</th><th>Previsto</th><th>Vinte</th><th>€</th></tr>' + Object.keys(all).map(function (k) { return rowT(TIP_PLAY_SHORT[k] || k, all[k]); }).join('') + rowT('Totale', allT) + '</table>' + mineTxt(allM) + '</details>' : '') +
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
function tipGreenFloor(x) {
  return Math.max(tipMinP(x), x.thr);
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
function tipAmberFloor(x) { return Math.max(TIP_GREEN_MINP, x.thr - 0.04); }
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
function tipCountSummary(total, excellent, maybe) {
  return '<div class="tip-count-summary" aria-label="' + excellent + ' ottime, ' + maybe + ' da valutare, ' + total + ' partite analizzate">' +
    '<div class="tip-count-strong tip-count-green"><b>' + excellent + '</b><small>OTTIME</small></div>' +
    '<div class="tip-count-strong tip-count-amber"><b>' + maybe + '</b><small>DA VALUTARE</small></div>' +
    '<div class="tip-count-total">su ' + total + '</div></div>';
}
/* book (facoltativo): { n1: quota live del book per "altro gol entro la fine" } */
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
    s: g.short + (prev && prev.k !== g.k ? ' · già segnalata al ' + prev.min + '’ (' + (TIP_PLAY_SHORT[prev.k] || prev.k) + ')' : '') };
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
    return { r: null, min: d && d.elapsed != null ? Number(d.elapsed) : 0, act: { k: 'pre', t: 'SOLO PREMATCH', c: 'muted', p: rec.p, w: rec.k === 'g30' ? '1T' : 'fine', s: 'da prematch: ' + rec.label + ' da ' + rec.need.toFixed(2) } };
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
function tipExcellentArchive() {
  /* I vecchi record senza tier provengono dal precedente registro delle Ottime. */
  var L = tipPlayDedup((db.predModel || {}).playLog || []).filter(function(e){return e.tier === 'excellent' || e.tier === 'try' || !e.tier;})
    .slice().sort(function (a,b) {return (b.t||0)-(a.t||0);});
  var groups = [{tier:'excellent',label:'OTTIME',cls:'excellent'}, {tier:'try',label:'DA VALUTARE',cls:'try'}];
  var summary = groups.map(function(g){
    var arr=L.filter(function(e){return (e.tier||'excellent')===g.tier;});
    var wins=arr.filter(function(e){return e.res===1;}).length;
    var losses=arr.filter(function(e){return e.res===0;}).length;
    var waiting=arr.filter(function(e){return e.res==null;}).length;
    var skipped=arr.filter(function(e){return e.res==='skip';}).length;
    return '<div class="tip-archive-group tip-archive-'+g.cls+'"><strong>'+g.label+'</strong><span>'+arr.length+' salvate</span>'+
      '<div class="tip-archive-stats"><b class="positive">'+wins+' vinte</b><b class="negative">'+losses+' perse</b><small>'+waiting+' in attesa · '+skipped+' non giocate</small></div></div>';
  }).join('');
  var rows=L.slice(0,60).map(function(e){
    var t=e.tier||'excellent', sc=(e.gh||0)+'-'+(e.ga||0), goal=(e.gh||0)+(e.ga||0)+1;
    var state=e.res===1?'win':e.res===0?'loss':e.res==='skip'?'skip':'wait';
    var status=state==='win'?'✓ VINTA':state==='loss'?'✕ PERSA':state==='skip'?'— SOLO MONITORAGGIO':'◷ IN ATTESA';
    var result=(Array.isArray(e.ft)?' · finale '+e.ft[0]+'-'+e.ft[1]:'')+(e.played?' · giocata da te a '+e.played.q.toFixed(2)+' ('+e.played.s+'€)'+(e.played.res===1?' ✓':e.played.res===0?' ✕':''):'');
    return '<div class="tip-memory-row tip-memory-'+state+'"><div class="tip-memory-info"><div class="tip-history-tier tip-history-'+t+'">'+(t==='try'?'DA VALUTARE':'OTTIMA')+'</div><b>'+U.esc(e.home||'')+' – '+U.esc(e.away||'')+'</b><small>'+U.esc(TIP_PLAY_SHORT[e.k]||e.k)+' · '+U.esc(e.date||'')+' · '+(e.min||0)+'’ · dal '+sc+' → gol n. '+goal+result+'</small></div><span class="tip-memory-state tip-memory-state-'+state+'">'+status+'</span></div>';
  }).join('');
  return '<section class="card tip-top tip-live-section tip-archive"><div class="tip-top-head"><b>★ Storico consigli</b><small class="tip-archive-total">'+L.length+' salvati</small></div>'+
    '<div class="tip-archive-groups">'+summary+'</div>'+
    '<p class="muted tip-hint">Una voce per partita e punteggio. Esiti dai risultati automatici; ingressi futuri e step costosi non contano come vinte/perse.</p>'+
    (L.length?'<div class="tip-tlist">'+rows+'</div>':'<p class="muted tip-tnone">Nessun consiglio qualificato salvato.</p>')+'</section>';
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
  var nw = (((db.predModel || {}).playLog) || []).filter(function (e) { return e.t > last && e.tier === 'excellent' && e.res == null; });
  if (!nw.length) return;
  var e = nw[nw.length - 1];
  U.toast('🟢 ' + (nw.length > 1 ? nw.length + ' nuove OTTIME · ' : 'Nuova OTTIMA · ') + e.home + ' – ' + e.away + ' ' + e.min + '’ · ' + (TIP_PLAY_SHORT[e.k] || e.k) + ' ' + Math.round(e.p * 100) + '%');
  try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (x) { /* ok */ }
}
async function tipAutoScan(force) {
  if (tipUI._autoBusy || !tipCanSync() || typeof tab === 'undefined' || tab !== 'tips' || tipUI.panel !== 'live' || document.visibilityState !== 'visible') return;
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
function tipAlertPrefs() { return Object.assign({ on: false, amber: false, stars: false }, ((db.predModel || {}).alerts) || {}); }
function tipAlertCard() {
  var A = tipAlertPrefs(), sub = typeof pushState !== 'undefined' && pushState.sub && pushState.row && pushState.row.enabled !== false;
  if (typeof pushState !== 'undefined' && !pushState.loaded && typeof refreshPushState === 'function' && !tipUI._pushAsked) { tipUI._pushAsked = 1; setTimeout(refreshPushState, 50); }
  var st = !tipCanSync() ? 'Fai l’accesso in Altro › Sincronizzazione.' :
    !sub ? 'Prima attiva le notifiche del telefono in Altro › Notifiche (stesso permesso del promemoria serale), poi torna qui.' :
    A.on ? 'Attivi: il server controlla le partite ogni 2 minuti e ti avvisa quando trova ' + (A.amber ? 'OTTIME e DA VALUTARE' : 'una OTTIMA') + (A.stars ? ' tra le preferite' : '') + ', anche ad app chiusa.' :
    'Spenti: tocca per ricevere un avviso quando compare una giocata, anche ad app chiusa.';
  var btn = function (k, on, label) { return '<button type="button" class="tip-chipbtn' + (on ? ' on' : '') + '" data-alert="' + k + '">' + label + '</button>'; };
  return '<section class="card tip-top tip-alerts"><div class="tip-top-head"><b>🔔 Avvisi sul telefono</b><span>' + (A.on && sub ? 'attivi' : 'spenti') + '</span></div><p class="muted tip-hint">' + U.esc(st) + (tipUI.bzRem != null ? ' Richieste Bzzoiro rimaste oggi: ' + U.esc(tipUI.bzRem) + '.' : '') + '</p>' +
    (tipCanSync() && sub ? '<div class="tip-chips">' + btn('on', A.on, A.on ? 'Avvisi attivi' : 'Attiva avvisi') + btn('amber', A.amber, 'Anche DA VALUTARE') + btn('stars', A.stars, 'Solo preferite') + '<button type="button" class="tip-chipbtn" data-alert="test">Invia una prova</button></div>' : '') +
    '</section>';
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
      return rec ? { act: { k: 'pre', t: 'SOLO PREMATCH', c: 'muted', p: rec.p, w: rec.k === 'g30' ? '1T' : 'fine', s: 'da prematch: ' + rec.label + ' da ' + rec.need.toFixed(2) } } : null;
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
    var ctx = { half: P2.half, gh: P2.sc ? P2.sc[0] : 0, ga: P2.sc ? P2.sc[1] : 0 }, prev = tipPlayFind(P2.m.id, ctx);
    (byType[best.k] = byType[best.k] || []).push({ P: P2, pl: best, prev: prev && prev.k !== best.k ? prev : null, isNew: !!fresh[P2.m.id] });
  });
  var playsHtml = Object.keys(TIP_PLAY_NAME).filter(function (k) { return byType[k] && byType[k].length; }).map(function (k) {
    var found = byType[k].filter(function (x) { return x.pl.green; }).length, possible = byType[k].length - found;
    var L = byType[k].sort(function (a, b) { return (b.pl.green ? 1 : 0) - (a.pl.green ? 1 : 0) || b.pl.p - a.pl.p; }).slice(0, 10);
    return '<section class="card tip-top tip-grade-section"><div class="tip-top-head"><b>' + U.esc(TIP_PLAY_NAME[k]) + '</b>' + tipCountSummary(byType[k].length, found, possible) + '</div><div class="tip-tlist">' +
      L.map(function (x) {
        var P2 = x.P;
        return '<button type="button" class="tip-trow' + (x.pl.green ? ' tip-hot' : ' tip-warm') + (x.isNew ? ' tip-new' : '') + '" ' + P2.open + '><span class="tip-tn tip-ln">' + P2.min + '\'</span><span class="tip-tmain"><b>' + (x.isNew ? '<i class="tip-newtag">NUOVA</i> ' : '') + U.esc(P2.m.home) + ' – ' + U.esc(P2.m.away) + '</b><small>' +
          x.pl.legs.map(function (l) { return 'q≥' + Math.max(TIP_MIN_ODDS, 1 / l.p).toFixed(2); }).join(' → ') + (x.pl.book ? ' · book ' + x.pl.book.toFixed(2) : '') + '</small>' +
          (x.prev ? '<small class="tip-amber-text">già segnalata al ' + x.prev.min + '’: ' + U.esc(TIP_PLAY_SHORT[x.prev.k] || x.prev.k) + ' (stessa scommessa)</small>' : '') +
          '<small class="tip-next-goal">⚽ Next gol: ' + (P2.sc ? P2.sc[0] + P2.sc[1] + 1 : 'da verificare') + '° · base ' + (P2.sc ? P2.sc[0] + '-' + P2.sc[1] : 'non disponibile') + '</small></span><span class="tip-tpick"><b>' + (P2.sc ? P2.sc[0] + '-' + P2.sc[1] + ' · ' : '') + '<span class="' + (x.pl.green ? 'positive' : 'tip-amber-text') + '">' + Math.round((x.pl.evalP == null ? x.pl.p : x.pl.evalP) * 100) + '%</span></b><small>' + (x.pl.green ? 'OTTIMA ›' : 'DA VALUTARE ›') + '</small><small class="tip-decision-reason">' + U.esc(tipPlayDecision(P2.r, P2.min, P2.half, x.pl)) + '</small></span></button>';
      }).join('') + '</div></section>';
  }).join('');
  return (
    '<div class="tip-actrow"><button type="button" class="tip-live-get" data-scan>🔎 ' + (tipUI.scan ? 'Riscansiona ora' : 'Scansiona ora') + '</button></div>' +
    scanHtml + tipStarPanel(list) + playsHtml + tipExcellentArchive() +
    '<section class="card tip-top tip-live-section"><div class="tip-top-head"><b>In corso</b><span>' + live.length + ' partite · ' + live.filter(function (m) { return evals[m.id] && evals[m.id].act.k !== 'no'; }).length + ' da giocare</span></div>' +
    (live.length ? '<div class="tip-tlist">' + live.map(row).join('') + '</div>' : '<p class="muted tip-tnone">Nessuna partita dei pronostici in corso adesso.</p>') +
    '</section>' +
    (soon.length ? '<section class="card tip-top"><div class="tip-top-head"><b>Tra poco</b><span>prossime 3 ore</span></div><div class="tip-tlist">' + soon.map(row).join('') + '</div></section>' : '') +
    ''
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
        try { var P = tipParams(), pk = tipPicksFor(x, P); if (pk.length) x.picks = pk; } finally { db = keep; }
      }
    });
    dlg.close();
    U.toast('Contesto salvato: pronostici aggiornati.');
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
  var G = rec.gh + rec.ga, ft = x.ft, ht = x.ht, mins = Array.isArray(x.goals) ? x.goals.map(function (g) { return g.min; }) : null;
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
  var L = ((db.predModel || {}).liveLog) || [];
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
    Object.keys(TIP_PLAY_NAME).map(function (k) { return row(TIP_PLAY_SHORT[k] + ' (ottime)', pick(function (a) { return a.t === 'play' && a.k === k; })); }).join('') +
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
    doHtml = '<div class="tip-do"><div class="tip-do-h"><b>Giocate adesso</b><span class="muted">probabilità di riuscita</span></div>' +
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
      ? '<span class="tip-rank"><span><small>' + U.esc(tipDayLabel(m.date)) + '</small>' + U.esc(tipSortLabel(m, sortKey)) + '</span><b>' + Math.round(m._sv != null ? m._sv : tipSortValue(m, sortKey)) + '%</b></span>'
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
  var P = tipUI.panel, nLive = list.filter(tipIsLiveNow).length, A = tipAlertPrefs(), now = Date.now(), nOtt = 0;
  (((db.predModel || {}).playLog) || []).forEach(function (e) { if (e.tier === 'excellent' && e.res == null && e.t > now - 20 * 60e3) nOtt++; });
  var it = function (k, ic, label, badge) {
    return '<button type="button" class="tip-navb' + (P === k ? ' on' : '') + '" data-tip-panel="' + k + '" aria-label="' + label + '"' + (P === k ? ' aria-current="page"' : '') + '>' + ic + '<span>' + label + '</span>' + (badge ? '<b class="tip-badge">' + badge + '</b>' : '') + '</button>';
  };
  return '<div class="tip-nav" role="navigation" aria-label="Sezioni dei pronostici"><div class="tip-navseg">' +
    it('home', TIP_IC.home, 'Home') + it('top', TIP_IC.star, 'Top') + it('list', TIP_IC.list, 'Partite') +
    it('live', TIP_IC.live, 'Live', nOtt || (nLive ? '' : '')) + it('stats', TIP_IC.stats, 'Stats') +
    '</div><div class="tip-navtools">' +
    '<button type="button" class="tip-navb tip-navicon' + (A.on ? ' armed' : '') + '" data-tip-alerts aria-label="Avvisi sul telefono">' + TIP_IC.bell + '<span>Avvisi</span>' + (A.on ? '<i class="tip-navdot"></i>' : '') + '</button>' +
    '<button type="button" class="tip-navb tip-navicon" data-tip-sheet aria-label="Aggiorna, importa ed esporta">' + TIP_IC.file + '<span>Aggiorna</span>' + (tipUI.loading || tipUI.preBusy ? '<i class="tip-spin"></i>' : '') + '</button>' +
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
  var hot = tipPlayDedup(L.filter(function (e) { return e.res == null && e.t > now - 30 * 60e3 && (e.tier === 'excellent' || e.tier === 'try'); }))
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
  var statBody = rep ? row(U.esc(tipCap(tipDayLabel(rk))), rep.tot.w + '/' + rep.tot.n + ' vinte · ' + (rep.tot.pl >= 0 ? '+' : '') + rep.tot.pl.toFixed(2) + '€', rep.mine && rep.mine.n ? 'tue ' + (rep.mine.pl >= 0 ? '+' : '') + rep.mine.pl.toFixed(2) + '€' : 'a quota minima', rep.tot.pl >= 0 ? 'positive' : 'negative') : '<span class="tip-hubempty">Il primo resoconto arriva a fine giornata.</span>';
  return card('top', TIP_IC.star, 'Top di oggi', T.all.length + (T.all.length === 1 ? ' partita' : ' partite'), topBody, 'tip-hub-top') +
    card('live', TIP_IC.live, 'Live adesso', (nOtt ? '<i class="tip-hubpill">' + nOtt + ' OTTIM' + (nOtt === 1 ? 'A' : 'E') + '</i> ' : '') + live.length + ' in corso', liveBody, nOtt ? 'tip-hub-hot' : 'tip-hub-live') +
    card('list', TIP_IC.list, 'Partite', list.filter(function (m) { return m.date >= today && !m.cancelled; }).length + ' in programma', listBody) +
    card('stats', TIP_IC.stats, 'Resoconto', rep ? 'ultimo giorno' : '', statBody);
}
/* 3.51.0 — prova delle fonti dati: la funzione interroga Highlightly/TotalCorner, il risultato si copia e si manda a Claude */
async function tipProbeSheet() {
  var dlg = sheetModal(sheetHead('Prova fonti dati') + '<div class="tip-sheet"><p class="muted tip-hint" data-pr-msg>Prova in corso: circa 1 minuto (legge due volte le stesse partite live per vedere ogni quanto si aggiornano). Non chiudere.</p><pre class="tip-probe" data-pr-out></pre><div class="actions"><button type="button" class="primary" data-pr-copy disabled>Copia risultato</button></div></div>');
  dlg.classList.add('tip-dlg');
  var out = dlg.querySelector('[data-pr-out]'), msg = dlg.querySelector('[data-pr-msg]'), cp = dlg.querySelector('[data-pr-copy]'), txt = '';
  try {
    var r = await SuiteSync.api(TIP_ALERT_FN, { method: 'POST', json: { action: 'probe', wait: 60 } });
    txt = JSON.stringify(r, null, 1);
    msg.textContent = 'Fatto. Tocca “Copia risultato” e incollalo nella chat con Claude.';
  } catch (e) {
    txt = String((e && e.message) || e);
    msg.textContent = 'Errore: ' + tipFnErr(e).replace('pronostici-dati', 'pronostici-avvisi');
  }
  out.textContent = txt;
  cp.disabled = false;
  cp.onclick = async function () {
    try { await navigator.clipboard.writeText(txt); U.toast('Copiato'); }
    catch (e) { var rg = document.createRange(); rg.selectNodeContents(out); var sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); U.toast('Selezionato: tieni premuto e copia'); }
  };
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
        mutate(function (n) { n.predModel = n.predModel || {}; var A = n.predModel.alerts = Object.assign({ on: false, amber: false, stars: false }, n.predModel.alerts || {}); A[k] = !A[k]; if (k !== 'on' && A[k]) A.on = true; A.at = Date.now(); });
        var box = d.querySelector('.tip-alertsheet');
        if (box) { box.innerHTML = inner(); bindA(); }
      };
    });
  };
  bindA();
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
  var pn = tipUI.panel;
  if (['home', 'top', 'list', 'live', 'stats'].indexOf(pn) < 0) pn = tipUI.panel = 'home';
  var body = pn === 'stats' ? tipHead('Statistiche', 'Resoconto, calibrazione e correzioni') + tipStatsPanel(list)
    : pn === 'top' ? tipHead('Top', 'Le partite più sicure del giorno') + tipDayChips(list, 'Da oggi') + tipPrePlayPanel(list) + tipTopPanel(list)
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
var TIP_O15_MINQ = 1.25;
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
      /* 3.50.0 — bastano le quote Over del book (1.5 o 2.5): le partite automatiche spesso non hanno l'Over 1.5 */
      if (m.date !== day || m.cancelled || m.warn || !m.odds || !(m.odds.o15 || m.odds.o25)) return;
      if (m.topSkip && !m.odds.o25) return;
      var pk = (m.picks || []).find(function (x) { return x.m === k; });
      if (!pk) return;
      /* niente Under / No goal nelle Top: solo i lati "Over / Goal / segno" */
      if (/^(Under|No goal)/.test(pk.sel)) return;
      /* 3.48.0 — Over 1.5 pagato meno di 1.25: anche vincendone 8 su 10 si perde (storico 16-18/10: −9%) */
      if (k === 'o15' && U.finite(m.odds.o15) && m.odds.o15 < TIP_O15_MINQ) return;
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
/* ---------- 3.27.0 — Prepartita: "Da giocare" solo dove c'è valore ----------
   Stesse regole del live: partita da gol (soglie Top), segnano almeno al 60%, quota ≥ 1.50;
   se c'è la quota del book deve essere almeno la quota giusta (valore). Il gol nel 1° tempo
   (quote basse) si gioca a step: gol entro il 30' prepartita, poi il Live al 30' se ancora 0-0. */
function tipPreValue(m, top) {
  var P = tipParams(), c = tipCalc(m, P), o = m.odds || {}, out = [], MINQ = Math.max(TIP_MIN_ODDS, tipLiveMinQ());
  var add = function (key, label, p, book, extra) {
    if (p < TIP_LIVE_MINP) return;
    var fair = 1 / p, need = Math.max(MINQ, fair);
    if (U.finite(book) && book > 1) {
      if (book >= need) out.push({ k: key, label: label, p: p, book: book, need: need, ev: p * book - 1, ok: true, extra: extra });
    } else if (fair >= MINQ) out.push({ k: key, label: label, p: p, need: need, ev: 0, ok: false, extra: extra });
  };
  if (c.ht05 >= tipThr(P, 'ht05')) {
    var x = tipPlan(c.ht05);
    if (x.fair1 >= MINQ * 0.98) out.push({ k: 'g30', label: 'Gol entro il 30’', p: x.p1, need: Math.max(MINQ, x.fair1), ev: 0, ok: false,
      extra: 'gol 1T ' + Math.round(c.ht05) + '% · se 0-0 al 30’ apri il Live: gol 1T solo da quota ' + Math.max(MINQ, x.fair2).toFixed(2) });
  }
  if (c.o15 >= tipThr(P, 'o15')) {
    add('o25', 'Over 2.5', c.o25 / 100, o.o25);
    add('gg', 'Goal', c.gg / 100, o.gg);
    add('o15', 'Over 1.5', c.o15 / 100, o.o15);
  }
  /* senza quota del book si propone solo se la partita è nelle Top di quel mercato */
  top = top || {};
  out = out.filter(function (r) { return r.ok || (r.k === 'g30' ? top.ht05 : top.o15); });
  out.sort(function (a, b) { return (b.ok - a.ok) || (b.ev - a.ev) || (b.p - a.p); });
  return out;
}
/* partite nelle Top (1° tempo e Over 1.5), per giorno; calcolo tenuto per un minuto */
function tipTopIds(list) {
  list = list || db.predictions || [];
  var key = list.length + '|' + Math.floor(Date.now() / 60e3);
  if (tipUI._topIds && tipUI._topIds.key === key) return tipUI._topIds.map;
  var P = tipParams(), inTop = {}, days = [];
  list.forEach(function (m) { if (days.indexOf(m.date) < 0) days.push(m.date); });
  days.forEach(function (d) {
    var T = tipTopFor(d, list, P);
    ['ht05', 'o15'].forEach(function (k) {
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
    return tipUI.day === 'all' || !tipUI.day || m.date === tipUI.day || true;
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
  var hasOdds = function (d) { return list.some(function (m) { return m.date === d && m.odds && (m.odds.o15 || m.odds.o25); }); };
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
    '<button type="button" class="tip-sheet-btn primary" data-s="auto"><b>↻ Pronostici automatici</b><small>' + (pm.lastAutoAt ? 'Ultimi del ' + U.esc(U.date(pm.lastAutoAt)) + ' · ' : '') + 'prossimi 3 giorni dalle quote dei bookmaker (Bzzoiro)' + (tipUI.bzRem != null ? ' · richieste Bzzoiro rimaste oggi ' + U.esc(tipUI.bzRem) : '') + '</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="probe"><b>🧪 Prova fonti dati</b><small>Controlla Highlightly / TotalCorner: campionati, partite live, statistiche e quote (circa 1 minuto)</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="fetch"><b>↻ Aggiorna dal sito</b><small>Scarica il pronostici.json pubblicato con l’app</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="import"><b>Importa file</b><small>pronostici.json o pronostici.csv preparati da Claude</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="results"><b>↻ Risultati automatici</b><small>' + (pm.lastResults ? 'Ultimo controllo ' + U.esc(U.date(pm.lastResults)) + (pm.afRemaining != null ? ' · richieste rimaste oggi ' + U.esc(pm.afRemaining) : '') : 'Finale, 1° tempo e minuto del primo gol da API-Football') + '</small></button>' +
    '<button type="button" class="tip-sheet-btn" data-s="export"><b>Esporta storico</b><small>Risultati ed esiti in JSON, da dare a Claude o GPT per ricalibrare</small></button>' +
    '</div>';
  var d = sheetModal(html);
  d.classList.add('tip-dlg');
  d.querySelector('[data-s="probe"]').onclick = function () { d.close(); tipProbeSheet(); };
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
    '<button type="button" class="tip-ctx-btn" data-star-btn>' + (tipIsStar(m) ? '★ Tra le preferite (tocca per togliere)' : '☆ Aggiungi alle preferite') + '</button>' +
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
  if (tipUI.panel === 'live') { tipAutoStart(); setTimeout(function () { tipAutoScan(false); tipSignalsPull(true); }, 300); }
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
  if (!tipUI.resBusy && (!tipUI.resAt || Date.now() - tipUI.resAt > 30 * 60e3) && navigator.onLine !== false && tipCanSync()) {
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
