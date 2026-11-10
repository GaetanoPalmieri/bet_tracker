const APP_VERSION = '4.26.1';
('use strict');
const KEY = 'bet_tracker_v1',
  main = document.getElementById('main'),
  labels = { pending: 'In corso', won: 'Vinta', lost: 'Persa', void: 'Annullata', cashout: 'Cash out' };
const emptyDB = () => ({
  version: 2,
  accounts: [{ id: 'main', name: 'Saldo', initial: 0 }],
  bets: [],
  transactions: [],
  diary: [],
  predictions: [],
  predModel: {},
  settings: { monthlyLimit: 0, favorites: [], recent: [], lastExport: null },
});
let db = emptyDB(),
  storageError = '',
  tab = 'tips',
  filter = {
    period: 'month',
    day: U.local().slice(0, 10),
    from: '',
    to: '',
    basis: 'placed',
    status: 'all',
    query: '',
    calendar: false,
    month: U.local().slice(0, 7),
  },
  chartPoints = [];
function validDB(d) {
  return validDBCore(d) && validDiary(d) && (d.predictions == null || Array.isArray(d.predictions));
}
function validDiary(d) {
  if (d.diary == null) return true;
  if (!Array.isArray(d.diary)) return false;
  const dates = new Set();
  return d.diary.every(
    (e) =>
      e &&
      typeof e.id === 'string' &&
      /^[\w-]+$/.test(e.id) &&
      typeof e.date === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
      !dates.has(e.date) &&
      dates.add(e.date) &&
      U.finite(e.balance) &&
      (e.note == null || typeof e.note === 'string'),
  );
}
function validDBCore(d) {
  const id = (x) => typeof x === 'string' && /^[\w-]+$/.test(x),
    nonneg = (x) => U.finite(x) && x >= 0;
  if (!d || !Array.isArray(d.accounts) || !Array.isArray(d.bets) || !Array.isArray(d.transactions)) return false;
  const accounts = new Set(d.accounts.map((a) => a?.id));
  return (
    accounts.size === d.accounts.length &&
    d.accounts.every((a) => id(a.id) && typeof a.name === 'string' && nonneg(a.initial)) &&
    new Set(d.bets.map((b) => b?.id)).size === d.bets.length &&
    d.bets.every(
      (b) =>
        id(b.id) &&
        accounts.has(b.account) &&
        nonneg(b.stake) &&
        b.stake > 0 &&
        U.validDate(b.date) &&
        Object.hasOwn(labels, b.status) &&
        Array.isArray(b.legs) &&
        b.legs.length > 0 &&
        b.legs.every(
          (l) =>
            typeof l.event === 'string' &&
            typeof l.pick === 'string' &&
            U.finite(l.odds) &&
            l.odds >= 1 &&
            (!l.status || ['pending', 'won', 'lost', 'void'].includes(l.status)),
        ) &&
        Number.isFinite(b.legs.reduce((n, l) => n * l.odds, b.stake)) &&
        (!b.settledAt || U.validDate(b.settledAt)) &&
        (b.actualPayout == null || nonneg(b.actualPayout)) &&
        (b.status !== 'cashout' || nonneg(b.cashout)),
    ) &&
    new Set(d.transactions.map((t) => t?.id)).size === d.transactions.length &&
    d.transactions.every((t) => id(t.id) && accounts.has(t.account) && U.finite(t.amount) && U.validDate(t.date)) &&
    (!d.settings ||
      (typeof d.settings === 'object' &&
        nonneg(d.settings.monthlyLimit ?? 0) &&
        (!d.settings.favorites ||
          (Array.isArray(d.settings.favorites) && d.settings.favorites.every((v) => typeof v === 'string'))) &&
        (!d.settings.recent ||
          (Array.isArray(d.settings.recent) && d.settings.recent.every((v) => typeof v === 'string')))))
  );
}
function normalize(d) {
  const out = normalizeCore(d);
  out.diary = Array.isArray(d.diary)
    ? d.diary.map((e) => ({
        id: e.id,
        date: e.date,
        balance: U.round(e.balance),
        ...(e.note ? { note: String(e.note) } : {}),
        ...(e.updatedAt ? { updatedAt: e.updatedAt } : {}),
      }))
    : [];
  if (d.updatedAt) out.updatedAt = d.updatedAt;
  /* 3.1.0 — pronostici */
  out.predictions = Array.isArray(d.predictions) ? d.predictions.filter((m) => m && typeof m.id === 'string') : [];
  out.predModel = d.predModel && typeof d.predModel === 'object' ? d.predModel : {};
  return out;
}
function normalizeCore(d) {
  const a = d.accounts[0] || { id: 'main' };
  return {
    version: 2,
    accounts: [{ id: a.id, name: 'Saldo', initial: U.round(d.accounts.reduce((n, a) => n + a.initial, 0)) }],
    bets: d.bets.map((b) => ({
      ...b,
      account: a.id,
      legs: b.legs.map((l) => ({
        event: l.event,
        pick: l.pick,
        odds: l.odds,
        status: l.status || 'pending',
        ...(l.meta && typeof l.meta === 'object' ? { meta: l.meta } : {}),
      })),
    })),
    transactions: d.transactions.map((t) => ({ ...t, account: a.id })),
    settings: { ...emptyDB().settings, ...d.settings },
  };
}
/* 4.24.5 — SALVATAGGIO COMPATTO. L'8/11 il telefono era pieno: ogni pronostico prepartita portava con sé una copia
   intera dei parametri del modello (con la nota lunga) più una copia di quote e pronostici già presenti nella partita:
   1,1 dei 1,9 milioni di caratteri dei pronostici erano doppioni. Superato il limite di Safari ogni salvataggio falliva,
   anche dopo la pulizia forte: i segnali live arrivati dal server (e le notifiche) non entravano più in Live.
   Ora in memoria si scrive una copia sola di ogni insieme di parametri e i doppioni diventano rimandi; alla lettura
   si ricostruisce tutto uguale (niente si perde, i backup e la sincronizzazione restano completi). */
function packSame(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function packDB(d) {
  const preds = Array.isArray(d.predictions) ? d.predictions : [];
  const sets = {},
    ids = new Map();
  const out = preds.map((m) => {
    const pi = m && m.preIssue;
    if (!pi || typeof pi !== 'object' || Array.isArray(pi)) return m;
    const q = { ...pi };
    let ch = false;
    if (pi.parameters && typeof pi.parameters === 'object') {
      const s = JSON.stringify(pi.parameters);
      let id = ids.get(s);
      if (id == null) {
        id = 'p' + ids.size;
        ids.set(s, id);
        sets[id] = pi.parameters;
      }
      q.parameters = { $set: id };
      ch = true;
    }
    if (pi.inputs && typeof pi.inputs === 'object' && !Array.isArray(pi.inputs)) {
      const ks = Object.keys(pi.inputs);
      if (ks.length && ks.every((k) => k !== '$top' && packSame(pi.inputs[k], m[k]))) {
        q.inputs = { $top: ks };
        ch = true;
      }
    }
    if (Array.isArray(pi.picks) && Array.isArray(m.picks) && packSame(pi.picks, m.picks)) {
      q.picks = { $top: 1 };
      ch = true;
    }
    return ch ? { ...m, preIssue: q } : m;
  });
  return JSON.stringify({ ...d, predictions: out, _pack: { v: 1, sets } });
}
function unpackDB(data) {
  /* 4.24.8 — si ripara SEMPRE, anche senza _pack: se una versione vecchia dell'app (rimasta aperta o servita dalla cache)
     ha letto e poi salvato o sincronizzato i dati compatti, i rimandi restavano dentro i pronostici ("issue.picks.find is
     not a function"). Pronostici e quote si ricostruiscono dalla partita; i parametri, se l'insieme è andato perso,
     tornano a quelli attuali del modello. */
  if (!data || typeof data !== 'object') return data;
  const sets = (data._pack && data._pack.sets) || {},
    cl = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  (Array.isArray(data.predictions) ? data.predictions : []).forEach((m) => {
    const pi = m && m.preIssue;
    if (!pi || typeof pi !== 'object') return;
    if (pi.parameters && pi.parameters.$set != null) {
      if (sets[pi.parameters.$set]) pi.parameters = cl(sets[pi.parameters.$set]);
      else delete pi.parameters;
    }
    if (pi.inputs && Array.isArray(pi.inputs.$top)) {
      const o = {};
      pi.inputs.$top.forEach((k) => {
        if (m[k] !== undefined) o[k] = cl(m[k]);
      });
      pi.inputs = o;
    }
    if (pi.picks && !Array.isArray(pi.picks)) pi.picks = Array.isArray(m.picks) ? cl(m.picks) : [];
    if (pi.inputs && (typeof pi.inputs !== 'object' || Array.isArray(pi.inputs))) delete pi.inputs;
  });
  delete data._pack;
  return data;
}
/* salva nel telefono: se la memoria è piena si libera spazio a gradini (cache, poi segnali live più vecchi, che
   restano comunque sul server 60 giorni) e si riprova. Restituisce il gradino usato (0 = nessuna pulizia). */
let storeInfo = { chars: 0, level: 0, warned: false };
function storeLocal(next) {
  let err = null;
  for (let lv = 0; lv <= 4; lv++) {
    if (lv === 1) {
      try {
        localStorage.removeItem('bet_sdb_cache_v1');
        localStorage.removeItem('tipLiveHist');
      } catch {
        /* ok */
      }
    }
    slimForStorage(next, lv);
    const ser = packDB(next);
    try {
      localStorage.setItem(KEY, ser);
      storeInfo.chars = ser.length;
      storeInfo.level = lv;
      storeInfo.err = '';
      return lv;
    } catch (e) {
      err = e;
    }
  }
  storeInfo.err = (err && (err.name || err.message)) || 'errore';
  storeInfo.failAt = Date.now();
  throw err;
}
/* 4.24.6 — MEMORIA DEL TELEFONO in Altro: quanto occupa ogni voce, esito dell'ultimo salvataggio, segnali di oggi
   nell'app, e un pulsante che libera spazio e riprende dal server i segnali degli ultimi 2 giorni. */
function memUsage() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.push([k, (localStorage.getItem(k) || '').length]);
    }
  } catch {
    /* ok */
  }
  return out.sort((a, b) => b[1] - a[1]);
}
function memCardHtml() {
  const u = memUsage(),
    tot = u.reduce((n, x) => n + x[1], 0),
    mb = (n) => (n / 1e6).toLocaleString('it-IT', { maximumFractionDigits: 2 }) + ' M',
    names = { bet_tracker_v1: 'Dati app', tipLiveHist: 'Statistiche live recenti (cache)', bet_sdb_cache_v1: 'Leghe e squadre (cache)' },
    L = ((db.predModel || {}).playLog) || [],
    today = U.local().slice(0, 10),
    nT = L.filter((e) => e && e.date === today).length,
    st = storeInfo.err
      ? '<b class="negative">Ultimo salvataggio NON riuscito (' + U.esc(storeInfo.err) + ')</b>'
      : storeInfo.chars
        ? 'Ultimo salvataggio riuscito' + (storeInfo.level ? ' (pulizia livello ' + storeInfo.level + ')' : '')
        : 'Nessun salvataggio da quando hai aperto l’app';
  return `<div class="card"><h2>Memoria del telefono</h2><p class="muted">${st}<br>Occupati ${mb(tot)} caratteri (Safari ne tiene circa 2,5 M)<br>${u
    .slice(0, 5)
    .map((x) => U.esc(names[x[0]] || x[0]) + ': ' + mb(x[1]))
    .join('<br>')}<br>Segnali live nell’app: ${L.length} · di oggi ${nT} · pronostici ${(db.predictions || []).length}</p><button type="button" id="mem-free">Libera spazio e riprendi i segnali</button></div>`;
}
async function memFree() {
  try {
    localStorage.removeItem('tipLiveHist');
    localStorage.removeItem('bet_sdb_cache_v1');
  } catch {
    /* ok */
  }
  /* segnalibro indietro di 2 giorni: il server rimanda i segnali persi mentre i salvataggi fallivano */
  const ok = mutate((d) => {
    d.predModel = d.predModel || {};
    d.predModel.sigSince = Date.now() - 2 * 86400e3;
    delete d.predModel.sigCursor;
  });
  if (!ok) return;
  if (typeof tipUI !== 'undefined') {
    tipUI._sigAt = 0;
    tipUI._sigOff = 0;
  }
  if (typeof tipSignalsPull === 'function') await tipSignalsPull(false);
  setTimeout(() => {
    render();
    U.toast(storeInfo.err ? 'Memoria ancora piena: manda uno screenshot di questa scheda.' : 'Fatto: ' + memUsage().reduce((n, x) => n + x[1], 0).toLocaleString('it-IT') + ' caratteri occupati, segnali ripresi dal server.');
  }, 600);
}
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const data = unpackDB(JSON.parse(raw));
    if (!validDB(data)) throw Error('Dati non validi');
    db = normalize(data);
  }
} catch (e) {
  storageError = 'Dati non leggibili: usa Altro → Importa backup. I dati originali non saranno sovrascritti.';
}
/* 3.95.0 — MEMORIA DEL TELEFONO. Il 21/10 lo storico dei segnali live (playLog) era arrivato a 2 milioni di caratteri:
   più della metà era "input" (lo stato completo del modello copiato in ogni segnale). Safari tiene circa 5 MB per sito,
   superati i quali OGNI salvataggio falliva. Ora prima di salvare:
   - i segnali già chiusi (o più vecchi di 6 ore) perdono "input" (resta tutto il resto: stime, statistiche, esiti);
   - dopo 4 giorni si tolgono anche le copie delle revisioni;
   - al massimo 1200 segnali, circa 3-4 giorni (i più vecchi escono; il server li conserva).
   Se la memoria è comunque piena: pulizia più forte (700 segnali, niente cache delle leghe) e si riprova una volta. */
function slimForStorage(d, lv) {
  /* 4.24.5 — gradini: 0 normale (1200 segnali), 1 cache tolte (1000), 2 → 800, 3 → 600 e niente snap/stats sui chiusi
     di 2+ giorni, 4 → 400. I segnali tolti dal telefono restano sul server (export e retraining li riprendono da lì). */
  lv = lv === true ? 3 : lv || 0;
  const pm = d && d.predModel;
  if (!pm || !Array.isArray(pm.playLog)) return;
  const now = Date.now(),
    L = pm.playLog,
    cap = [1200, 1000, 800, 600, 400][lv],
    hard = lv >= 3;
  if (L.length > cap) {
    /* via i più VECCHI (per ora del segnale), non i primi dell'elenco: un segnale ripreso dal server può finire in fondo */
    const keep = L.map((e, i) => [(e && e.t) || 0, i])
      .sort((a, b) => b[0] - a[0] || b[1] - a[1])
      .slice(0, cap)
      .map((x) => x[1])
      .sort((a, b) => a - b);
    const kept = keep.map((i) => L[i]);
    L.length = 0;
    kept.forEach((e) => L.push(e));
  }
  const strip = (e) => {
    if (e && typeof e === 'object') delete e.input;
  };
  L.forEach((e) => {
    if (!e || typeof e !== 'object') return;
    const age = now - (e.t || 0);
    if (e.res != null || age > 6 * 3600e3) strip(e);
    strip(e.initial);
    (e.revisions || []).forEach(strip);
    if (lv >= 2 || age > 4 * 86400e3) {
      delete e.revisions;
      if (e.initial) delete e.initial;
    }
    if (hard && e.res != null && age > 2 * 86400e3) {
      delete e.snap;
      delete e.stats;
    }
  });
  const lcap = [600, 600, 400, 300, 200][lv];
  if (Array.isArray(pm.liveLog) && pm.liveLog.length > lcap) pm.liveLog.splice(0, pm.liveLog.length - lcap);
}
function commit(next, { restore = false } = {}) {
  if (storageError && !restore) {
    U.toast('Ripristina un backup valido dalla sezione Altro.');
    return false;
  }
  try {
    next.updatedAt = new Date().toISOString();
    if (!validDB(next)) throw Error('Dati non validi');
    const lv = storeLocal(next);
    if (lv >= 2 && !storeInfo.warned) {
      storeInfo.warned = true;
      setTimeout(() => U.toast('Memoria del telefono quasi piena: tenuti gli ultimi ' + ((next.predModel || {}).playLog || []).length + ' segnali live (gli altri restano sul server).'), 300);
    }
    db = next;
    storageError = '';
    render();
    if (typeof syncBet !== 'undefined' && syncBet) syncBet.changed();
    return true;
  } catch (e) {
    U.toast('Salvataggio non riuscito (' + String((e && (e.name !== 'Error' ? e.name : e.message)) || 'errore').slice(0, 60) + '). Esporta un backup; le modifiche non sono state applicate.');
    return false;
  }
}
function mutate(fn) {
  const n = U.clone(db);
  fn(n);
  return commit(n);
}
function odds(b) {
  return b.legs.reduce((n, l) => n * (l.status === 'void' ? 1 : l.odds), 1);
}
function payout(b) {
  if (b.status === 'pending' || b.status === 'lost') return 0;
  if (b.actualPayout != null) return b.actualPayout;
  return b.status === 'won' ? U.round(b.stake * odds(b)) : b.status === 'void' ? b.stake : b.cashout || 0;
}
function profit(b) {
  return b.status === 'pending' ? 0 : U.round(payout(b) - b.stake);
}
/* 3.0.0 — Il saldo nasce dal diario: saldo iniziale, saldi segnati a fine giornata, depositi e
   prelievi. Saldo attuale = ultimo saldo segnato + depositi − prelievi fatti dopo quel giorno
   (senza nessun saldo segnato: saldo iniziale + depositi − prelievi). Le scommesse non contano più. */
function realFlows(d = db) {
  return (d.transactions || []).filter((t) => t.kind !== 'adjust');
}
function startDate(d = db) {
  return (d.settings && d.settings.initialDate) || null;
}
function hasStart(d = db) {
  // Il saldo iniziale fa da punto di partenza solo con la sua data (Altro › Saldo iniziale):
  // i vecchi dati senza data restano come prima, dal primo giorno segnato.
  return !!startDate(d);
}
function balance(d = db) {
  const list = (d.diary || []).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = list[list.length - 1],
    s = startDate(d),
    flows = realFlows(d);
  if (last)
    return U.round(last.balance + flows.filter((t) => dayKey(t.date) > last.date).reduce((n, t) => n + t.amount, 0));
  return U.round(d.accounts[0].initial + flows.filter((t) => !s || dayKey(t.date) >= s).reduce((n, t) => n + t.amount, 0));
}
function totalDeposited() {
  return U.round(
    db.accounts[0].initial +
      db.transactions.filter((t) => t.amount > 0 && t.kind !== 'adjust').reduce((n, t) => n + t.amount, 0),
  );
}
function totalWithdrawn() {
  return U.round(
    db.transactions.filter((t) => t.amount < 0 && t.kind !== 'adjust').reduce((n, t) => n + Math.abs(t.amount), 0),
  );
}
function totalCapital() {
  return U.round(balance() + totalWithdrawn());
}
function dateFor(b) {
  return filter.basis === 'settled' ? (b.status === 'pending' ? null : b.settledAt) : b.date;
}
function selectedBets(ignorePeriod = false) {
  const bounds = U.bounds(filter.period, filter.day, filter.from, filter.to);
  return db.bets
    .filter(
      (b) =>
        (ignorePeriod || U.inRange(dateFor(b), bounds)) &&
        (filter.basis !== 'settled' || (b.status !== 'pending' && b.settledAt)) &&
        (tab !== 'bets' || filter.status === 'all' || b.status === filter.status) &&
        (!filter.query ||
          b.legs.some((l) => (l.event + ' ' + l.pick).toLocaleLowerCase().includes(filter.query.toLocaleLowerCase()))),
    )
    .sort((a, b) => new Date(dateFor(b)) - new Date(dateFor(a)));
}
function inferLegMeta(l) {
  if (l.meta && typeof l.meta === 'object') return l.meta;
  const parts = String(l.event || '')
      .split(' · ')
      .map((x) => x.trim())
      .filter(Boolean),
    m = {};
  if (parts.length > 1) {
    if (parts[0].includes(' – ')) m.match = parts[0];
    const flagCountry = parts.find((x) => /^[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u.test(x));
    if (flagCountry) {
      const found =
        typeof FOOTBALL_COUNTRIES !== 'undefined'
          ? FOOTBALL_COUNTRIES.find((c) => flagCountry.startsWith(c.flag))
          : null;
      if (found) {
        m.country = found.code;
        m.countryName = found.name;
        m.flag = found.flag;
      }
      const clean = flagCountry.replace(/^[^A-Za-zÀ-ÿ]+/, '').trim();
      m.competition = clean;
    }
    const cat = parts.find((x) => /Maschile|Femminile|Senior|U\d{2}/i.test(x));
    if (cat) m.category = cat;
  }
  return m;
}
function legFields(l) {
  const m = inferLegMeta(l),
    event = String(l.event || ''),
    parts = event
      .split(' · ')
      .map((x) => x.trim())
      .filter(Boolean),
    match = m.match || parts.find((x) => x.includes(' – ')) || '',
    competition =
      m.competition ||
      m.league ||
      (!match && parts[0]
        ? parts[0]
        : parts.find((x) => x !== match && !/Maschile|Femminile|Senior|U\d{2}/i.test(x))) ||
      '',
    country = m.countryName || '',
    category =
      [
        m.gender === 'women' ? 'Femminile' : m.gender === 'men' ? 'Maschile' : '',
        m.level === 'youth' ? m.age || 'Giovanile' : m.level === 'senior' ? 'Senior' : '',
      ]
        .filter(Boolean)
        .join(' · ') ||
      m.category ||
      '';
  return { match, competition, country, category };
}
function legCard(l, index = 0, total = 1) {
  const f = legFields(l),
    division = f.competition || f.country || f.category || 'Evento',
    match = f.match || String(l.event || '').split(' · ')[0] || 'Evento',
    meta = [f.country && f.country !== division ? f.country : '', f.category].filter(Boolean).join(' · '),
    status = l.status && l.status !== 'pending' ? labels[l.status] : 'In corso';
  return `<div class="bet-leg-compact"><div class="bet-leg-main"><div class="bet-leg-topline">${total > 1 ? `<span class="bet-leg-index">${index + 1}</span>` : ''}<span class="bet-leg-division">${U.esc(division)}</span>${meta ? `<span class="bet-leg-meta">${U.esc(meta)}</span>` : ''}</div><b class="bet-leg-match">${U.esc(match)}</b><div class="bet-leg-bottomline"><span class="bet-leg-pick"><small>Esito</small> ${U.esc(l.pick)}</span><span class="bet-leg-odds"><small>Quota</small> ${Number(l.odds).toFixed(2)}</span></div></div><span class="bet-leg-status ${l.status || 'pending'}">${status}</span></div>`;
}
function card(b) {
  const pending = b.status === 'pending',
    kind = b.legs.length > 1 ? 'Multipla · ' + b.legs.length : 'Singola',
    resultValue = pending ? b.stake * odds(b) : payout(b),
    resultLabel = pending ? 'Potenziale' : 'Incasso',
    net = !pending ? profit(b) : null;
  return `<article class="card bet-card compact-bet-card ${pending ? 'is-pending' : 'is-closed'}"><div class="bet-card-head"><div class="bet-card-heading"><div class="bet-card-title"><b>${kind}</b><span class="bet-card-date">${U.date(b.date)}</span></div><span class="badge ${b.status}">${labels[b.status]}</span></div>${pending ? `<div class="quick-outcomes compact-quick-outcomes" aria-label="Esito rapido"><button class="good" type="button" data-quick="won" data-id="${b.id}" aria-label="Segna scommessa come vinta" title="Vinta">✓</button><button class="danger" type="button" data-quick="lost" data-id="${b.id}" aria-label="Segna scommessa come persa" title="Persa">×</button></div>` : ''}</div><div class="bet-legs-list compact-bet-legs">${b.legs.map((l, i) => legCard(l, i, b.legs.length)).join('')}</div><div class="bet-summary-strip"><span><small>Puntata</small><b>${U.money(b.stake)}</b></span><span><small>Quota</small><b>${odds(b).toFixed(2)}</b></span><span><small>${resultLabel}</small><b>${U.money(resultValue)}</b></span>${!pending ? `<span><small>Profitto</small><b class="${net < 0 ? 'negative' : 'positive'}">${U.money(net)}</b></span>` : ''}</div>${b.settledAt ? `<small class="bet-settled-date">Liquidata ${U.date(b.settledAt)}</small>` : ''}<div class="bet-card-actions compact-actions"><button class="blue bet-outcomes-button" data-settle="${b.id}">Esiti</button><button data-edit="${b.id}">Modifica</button><button class="danger" data-delete="${b.id}">Elimina</button></div></article>`;
}
function winRate(bets) {
  const won = bets.filter((b) => b.status === 'won').length,
    played = bets.filter((b) => ['won', 'lost'].includes(b.status)).length;
  return { won, played, percentage: played ? (100 * won) / played : null };
}
function kpis(bets, { interactive = false, context = '' } = {}) {
  const closed = bets.filter((b) => b.status !== 'pending'),
    net = closed.reduce((n, b) => n + profit(b), 0),
    rate = winRate(bets),
    items = [
      ['stake', 'Totale puntato', U.money(bets.reduce((n, b) => n + b.stake, 0)), 'Tutte le giocate'],
      ['profit', 'Profitto netto', U.money(net), 'Scommesse concluse'],
      ['payout', 'Incassi liquidati', U.money(closed.reduce((n, b) => n + payout(b), 0)), 'Esiti registrati'],
      [
        'winrate',
        'Percentuale vinte',
        rate.percentage === null ? '—' : rate.percentage.toLocaleString('it-IT', { maximumFractionDigits: 1 }) + '%',
        rate.played ? rate.won + ' vinte su ' + rate.played + ' concluse' : 'Nessuna vinta o persa',
      ],
    ];
  return `<div class="grid kpi-grid ${context}">${items.map(([key, title, value, detail]) => (interactive ? `<button type="button" class="card kpi-card kpi-action" data-kpi="${key}" aria-label="Apri dettaglio ${title}"><small class="kpi-title">${title}</small><div class="value">${value}</div><small class="kpi-detail">${detail}</small><span class="kpi-open" aria-hidden="true">›</span></button>` : `<div class="card kpi-card"><small class="kpi-title">${title}${key === 'winrate' ? ' <button class="help" data-roi aria-label="Come si calcola la percentuale vinte">ⓘ</button>' : ''}</small><div class="value">${value}</div><small class="kpi-detail">${detail}</small></div>`)).join('')}</div>`;
}
function kpiLabel(b) {
  return b.legs.length > 1 ? `Multipla · ${b.legs.length} eventi` : b.legs[0]?.event || 'Scommessa';
}
/* 2.6.0 — Testata unica dei pannelli, come quella della nuova scommessa:
   titolo a sinistra; a destra cestino (se serve) e spunta ambra per salvare.
   I pannelli che mostrano soltanto dati hanno la X grigia per chiudere. */
const IC = (k, f) => (window.SuiteIcons && SuiteIcons.icons[k]) || f;
function sheetHead(title, { form = '', del = '', sub = '' } = {}) {
  const actions =
    (del ? `<button type="button" class="sheet-btn sheet-del" id="${del}" aria-label="Elimina" title="Elimina">${IC('trash', '🗑')}</button>` : '') +
    (form
      ? `<button type="submit" class="sheet-btn sheet-save" form="${form}" aria-label="Salva" title="Salva">${IC('check', '✓')}</button>`
      : `<button type="button" class="sheet-btn sheet-close" data-close aria-label="Chiudi" title="Chiudi">${IC('close', '✕')}</button>`);
  return `<div class="row editor-head sheet-head"><div class="sheet-title"><h2>${U.esc(title)}</h2>${sub ? `<small>${sub}</small>` : ''}</div><div class="sheet-actions">${actions}</div></div>`;
}
function sheetModal(html) {
  const d = U.modal(html, { backdropClose: true });
  d.classList.add('sheet');
  /* niente contorno sul primo pulsante appena si apre il pannello */
  if (document.activeElement && d.contains(document.activeElement) && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) document.activeElement.blur();
  return d;
}
const sheetRow = ({ icon = '', tone = '', title = '', meta = '', value = '', vtone = '', badge = '' }) =>
  `<div class="sheet-row${tone ? ' ' + tone : ''}"><span class="sheet-row-ic" aria-hidden="true">${icon}</span><div class="sheet-row-main"><b>${title}</b>${meta ? `<small>${meta}</small>` : ''}</div><div class="sheet-row-end"><strong class="${vtone}">${value}</strong>${badge}</div></div>`;
const statusBadge = (st) => `<span class="sheet-badge st-${st}">${labels[st]}</span>`;
function moneyKpiPanel(kind) {
  const txDesc = db.transactions.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  if (kind === 'deposited') {
    const deposits = txDesc.filter((t) => t.amount > 0 && t.kind !== 'adjust'),
      depositTotal = deposits.reduce((n, t) => n + t.amount, 0),
      initial = db.accounts[0].initial;
    return sheetModal(
      sheetHead('Totale versato') +
        `<div class="sheet-hero"><small>Saldo iniziale + depositi</small><b>${U.money(totalDeposited())}</b></div><div class="sheet-tiles"><div><small>Saldo iniziale</small><b>${U.money(initial)}</b></div><div><small>Depositi</small><b>${U.money(depositTotal)}</b></div></div><h3 class="sheet-section">Depositi recenti</h3><div class="sheet-list">${
          deposits.length
            ? deposits
                .slice(0, 8)
                .map((t) => sheetRow({ icon: '↓', tone: 'tone-in', title: 'Deposito', meta: U.date(t.date), value: '+' + U.money(t.amount), vtone: 'positive' }))
                .join('')
            : '<div class="sheet-empty">Nessun deposito registrato.</div>'
        }</div>${deposits.length > 8 ? `<p class="sheet-note">Mostrati gli 8 depositi più recenti su ${deposits.length}.</p>` : ''}`,
    );
  }
  const withdrawals = txDesc.filter((t) => t.amount < 0 && t.kind !== 'adjust'),
    withdrawTotal = withdrawals.reduce((n, t) => n + Math.abs(t.amount), 0),
    available = balance();
  return sheetModal(
    sheetHead('Capitale complessivo') +
      `<div class="sheet-hero"><small>Saldo disponibile + prelievi</small><b>${U.money(totalCapital())}</b></div><div class="sheet-tiles"><div><small>Saldo disponibile</small><b>${U.money(available)}</b></div><div><small>Prelievi</small><b>${U.money(withdrawTotal)}</b></div></div><h3 class="sheet-section">Prelievi recenti</h3><div class="sheet-list">${
        withdrawals.length
          ? withdrawals
              .slice(0, 8)
              .map((t) => sheetRow({ icon: '↑', tone: 'tone-out', title: 'Prelievo', meta: U.date(t.date), value: '−' + U.money(Math.abs(t.amount)) }))
              .join('')
          : '<div class="sheet-empty">Nessun prelievo registrato.</div>'
      }</div>${withdrawals.length > 8 ? `<p class="sheet-note">Mostrati gli 8 prelievi più recenti su ${withdrawals.length}.</p>` : ''}`,
  );
}
function kpiPanel(kind, bets) {
  const closed = bets.filter((b) => b.status !== 'pending'),
    rate = winRate(bets),
    configs = {
      stake: {
        title: 'Totale puntato',
        summary: `${bets.length} scommesse · ${U.money(bets.reduce((n, b) => n + b.stake, 0))}`,
        rows: bets,
        date: (b) => b.date,
        value: (b) => U.money(b.stake),
        tone: () => '',
      },
      profit: {
        title: 'Profitto netto',
        summary: `${closed.length} concluse · ${U.money(closed.reduce((n, b) => n + profit(b), 0))}`,
        rows: closed,
        date: (b) => b.settledAt || b.date,
        value: (b) => U.money(profit(b)),
        tone: (b) => (profit(b) < 0 ? 'negative' : 'positive'),
      },
      payout: {
        title: 'Incassi liquidati',
        summary: `${closed.length} esiti · ${U.money(closed.reduce((n, b) => n + payout(b), 0))}`,
        rows: closed,
        date: (b) => b.settledAt || b.date,
        value: (b) => U.money(payout(b)),
        tone: () => '',
      },
      winrate: {
        title: 'Percentuale vinte',
        summary: rate.played
          ? `${rate.won} vinte su ${rate.played} concluse · ${rate.percentage.toLocaleString('it-IT', { maximumFractionDigits: 1 })}%`
          : 'Nessuna scommessa vinta o persa',
        rows: bets.filter((b) => ['won', 'lost'].includes(b.status)),
        date: (b) => b.settledAt || b.date,
        value: (b) => labels[b.status],
        tone: (b) => (b.status === 'won' ? 'positive' : 'negative'),
      },
    };
  const c = configs[kind] || configs.stake,
    rows = c.rows
      .slice()
      .sort((a, b) => new Date(c.date(b)) - new Date(c.date(a)))
      .slice(0, 8),
    more = Math.max(0, c.rows.length - rows.length);
  return sheetModal(
    sheetHead(c.title) +
      `<div class="sheet-hero"><small>${c.summary}</small></div><h3 class="sheet-section">Più recenti</h3><div class="sheet-list">${rows.length ? rows.map((b) => sheetRow({ icon: b.legs.length > 1 ? '⧉' : '◎', tone: 'tone-bet', title: U.esc(kpiLabel(b)), meta: U.date(c.date(b)), value: c.value(b), vtone: c.tone(b), badge: kind === 'winrate' ? '' : statusBadge(b.status) })).join('') : '<div class="sheet-empty">Nessun dato disponibile.</div>'}</div>${more ? `<p class="sheet-note">Mostrate le 8 più recenti su ${c.rows.length}.</p>` : ''}`,
  );
}
function periodLabel() {
  const now = new Date(),
    month = new Intl.DateTimeFormat('it-IT', { month: 'long', year: 'numeric' }).format(now);
  if (filter.period === 'month') return month.charAt(0).toUpperCase() + month.slice(1);
  if (filter.period === 'week') return 'Questa settimana';
  if (filter.period === 'year') return 'Anno corrente';
  if (filter.period === 'all') return 'Tutto lo storico';
  if (filter.period === 'day') return filter.day ? U.date(filter.day) : 'Giorno';
  if (filter.period === 'custom')
    return filter.from && filter.to ? `${U.date(filter.from)} – ${U.date(filter.to)}` : 'Intervallo personalizzato';
  return 'Periodo';
}
function statsFilters() {
  return `<details class="card stats-filter"><summary><span><small>PERIODO STATISTICHE</small><b>${U.esc(periodLabel())}</b></span><span class="stats-filter-chevron">⌄</span></summary><div class="stats-filter-body"><label>Periodo</label><select id="period" aria-label="Periodo">${[
    ['month', 'Mese corrente'],
    ['week', 'Questa settimana'],
    ['year', 'Anno corrente'],
    ['all', 'Tutto lo storico'],
    ['day', 'Giorno / calendario'],
    ['custom', 'Intervallo personalizzato'],
  ]
    .map(([v, l]) => `<option value="${v}" ${filter.period === v ? 'selected' : ''}>${l}</option>`)
    .join(
      '',
    )}</select><label>Data di riferimento</label><select id="basis"><option value="placed" ${filter.basis === 'placed' ? 'selected' : ''}>Giocate nel periodo</option><option value="settled" ${filter.basis === 'settled' ? 'selected' : ''}>Liquidate nel periodo</option></select>${filter.period === 'day' ? `<label>Giorno</label><input id="day" type="date" value="${filter.day}">` : ''}${filter.period === 'custom' ? `<div class="grid"><div><label>Dal</label><input id="from" type="date" value="${filter.from}"></div><div><label>Al</label><input id="to" type="date" value="${filter.to}"></div></div>` : ''}<label>Cerca</label><input id="query" type="search" value="${U.esc(filter.query)}" placeholder="Campionato, nazione, pronostico…"></div></details>`;
}
function geoStats(rows) {
  const legs = rows.flatMap((b) => b.legs.map((l) => ({ b, l, m: inferLegMeta(l) }))),
    norm = (v, fb) => String(v || fb || 'Non classificato'),
    groups = (key, fb) => {
      const map = new Map();
      for (const x of legs) {
        const k = norm(x.m[key], fb(x));
        const cur = map.get(k) || { name: k, bets: new Set(), stake: 0, profit: 0 };
        cur.bets.add(x.b.id);
        cur.stake += x.b.stake / x.b.legs.length;
        cur.profit += profit(x.b) / x.b.legs.length;
        map.set(k, cur);
      }
      return [...map.values()]
        .map((x) => ({ ...x, count: x.bets.size }))
        .sort((a, b) => b.count - a.count || b.stake - a.stake);
    };
  const countries = groups('countryName', (x) => ''),
    comps = groups('competition', (x) => legFields(x.l).competition),
    cats = groups('category', (x) => {
      const m = x.m;
      if (m.level === 'youth')
        return `${m.gender === 'women' ? 'Femminile' : 'Maschile'} · Giovanile${m.age ? ' ' + m.age : ''}`;
      if (m.gender) return `${m.gender === 'women' ? 'Femminile' : 'Maschile'} · Senior`;
      return '';
    });
  const renderBars = (title, data) => {
    const max = Math.max(1, ...data.slice(0, 8).map((x) => x.count));
    return `<div class="card geo-chart"><h2>${title}</h2>${
      data.length
        ? data
            .slice(0, 8)
            .map(
              (x) =>
                `<div class="geo-bar-row"><div class="geo-bar-head"><span>${U.esc(x.name)}</span><b>${x.count}</b></div><div class="geo-bar-track"><span style="width:${Math.max(4, (100 * x.count) / max)}%"></span></div><small>${U.money(x.stake)} puntati · ${U.money(x.profit)} profitto</small></div>`,
            )
            .join('')
        : '<div class="empty">Nessun dato nel periodo selezionato.</div>'
    }</div>`;
  };
  const female = legs.filter((x) => x.m.gender === 'women').length,
    male = legs.filter((x) => x.m.gender === 'men').length,
    youth = legs.filter((x) => x.m.level === 'youth').length;
  return `<section class="stats-geo-section"><div class="section stats-subtitle"><small>ANALISI CALCIO</small><h2>Nazioni, campionati e categorie</h2></div><div class="grid geo-kpis"><div class="card kpi-card"><small>Nazioni giocate</small><div class="value">${countries.filter((x) => x.name !== 'Non classificato').length}</div></div><div class="card kpi-card"><small>Campionati</small><div class="value">${comps.filter((x) => x.name !== 'Non classificato').length}</div></div><div class="card kpi-card"><small>Maschile / Femminile</small><div class="value geo-mini-value">${male} / ${female}</div></div><div class="card kpi-card"><small>Giovanili</small><div class="value">${youth}</div></div></div>${renderBars('Giocate per nazione', countries)}${renderBars('Giocate per campionato', comps)}${renderBars('Giocate per categoria', cats)}</section>`;
}
function filters() {
  return `<div class="card"><div class="filters"><select id="period" aria-label="Periodo">${[
    ['month', 'Questo mese'],
    ['week', 'Questa settimana'],
    ['year', 'Quest’anno'],
    ['all', 'Tutto lo storico'],
    ['day', 'Giorno / calendario'],
    ['custom', 'Intervallo personalizzato'],
  ]
    .map(([v, l]) => `<option value="${v}" ${filter.period === v ? 'selected' : ''}>${l}</option>`)
    .join(
      '',
    )}</select><select id="basis" aria-label="Data di riferimento"><option value="placed" ${filter.basis === 'placed' ? 'selected' : ''}>Giocate nel periodo</option><option value="settled" ${filter.basis === 'settled' ? 'selected' : ''}>Liquidate nel periodo</option></select></div>${
    filter.period === 'day'
      ? `<input id="day" type="date" aria-label="Giorno" value="${filter.day}">${U.calendar(
          filter.month,
          filter.day,
          (key) => {
            const rows = selectedBets(true).filter(
              (b) => dateFor(b) && U.local(new Date(dateFor(b))).slice(0, 10) === key,
            );
            return rows.length ? `${rows.length} · ${U.round(rows.reduce((n, b) => n + profit(b), 0))}€` : '';
          },
        )}`
      : ''
  }${filter.period === 'custom' ? `<div class="grid"><div><label>Dal</label><input id="from" type="date" value="${filter.from}"></div><div><label>Al</label><input id="to" type="date" value="${filter.to}"></div></div>` : ''}${
    tab === 'bets'
      ? `<label>Esito</label><select id="status"><option value="all">Tutti gli esiti</option>${Object.entries(labels)
          .map(([v, l]) => `<option value="${v}" ${filter.status === v ? 'selected' : ''}>${l}</option>`)
          .join('')}</select>`
      : ''
  }<label>Cerca evento o pronostico</label><input id="query" type="search" value="${U.esc(filter.query)}" placeholder="Squadra, evento, Over…">${filter.from && filter.to && filter.from > filter.to ? '<p class="error">La data iniziale deve precedere quella finale.</p>' : ''}</div>`;
}
function limitCard() {
  const rows = db.bets.filter((b) => U.inRange(b.date, U.bounds('month'))),
    used = U.round(rows.reduce((n, b) => n + b.stake, 0)),
    limit = db.settings.monthlyLimit;
  return limit
    ? `<div class="card"><b>Limite personale mensile</b><p class="${used > limit ? 'negative' : ''}">${U.money(used)} di ${U.money(limit)} puntati</p><small>${used > limit ? 'Limite superato.' : 'Disponibilità rispetto al limite: ' + U.money(Math.max(0, limit - used))} Non blocca l’inserimento.</small></div>`
    : '';
}
function render() {
  if (!['home', 'stats', 'tips', 'live', 'accounts'].includes(tab)) tab = 'tips';
  document.getElementById('title').textContent = {
    home: 'Saldo',
    stats: 'Statistiche',
    tips: 'Prepartita',
    live: 'Live',
    accounts: 'Altro',
  }[tab];
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  try {
    /* 4.5.0 — numero di OTTIME nuove sul tasto Live */
    const lb = document.querySelector('nav button[data-tab="live"]');
    if (lb && typeof tipLiveBadge === 'function') { const n = tipLiveBadge(); lb.dataset.badge = n ? String(n) : ''; }
  } catch (e) {
    /* ok */
  }
  const error = document.getElementById('storage-error');
  error.hidden = !storageError;
  error.textContent = storageError;
  let html = '';
  chartPoints = [];
  /* 4.5.0 — le statistiche del saldo sono dentro Saldo (Saldo · Andamento); la scheda Statistiche è dei pronostici */
  if (tab === 'home') html = homeViewSeg() + diaryPage(diaryUI.homeView === 'stats' ? 'stats' : 'home');
  if (tab === 'stats') html = typeof tipStatsTab === 'function' ? tipStatsTab() : diaryPage('stats');
  if (tab === 'tips' || tab === 'live') html = typeof tipsPage === 'function' ? tipsPage() : ''; /* 3.89.0 — Pronostici è la prima scheda: pronostici.js arriva dopo */
  if (tab === 'accounts') {
    /* 4.20.0 — ALTRO PIÙ PULITO: niente più "Saldo attuale" con Deposito e Prelievo (sono già in Saldo); saldo iniziale,
       depositi/prelievi e backup sono righe che si aprono e chiudono (come in Money), chiuse di base. */
    const s = startDate();
    const flows = realFlows().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const altOpen = (k) => (diaryUI.altOpen && diaryUI.altOpen[k] ? ' open' : '');
    html = `${window.SuiteTheme ? SuiteTheme.card({ cls: 'card' }) : ''}${window.SuiteSync && typeof syncBet !== 'undefined' && syncBet ? SuiteSync.cardHtml('bet', { cls: 'card' }) + '<div class="card suite-sync-card push-card" id="pushCard"></div>' : ''}<details class="card alt-sec" data-alt="conto"${altOpen('conto')}><summary><span class="alt-t"><b>Saldo iniziale, depositi e prelievi</b><small>${U.money(db.accounts[0].initial)}${s ? ' dal ' + U.esc(dLabel(s)) : ''} · ${flows.length} ${flows.length === 1 ? 'movimento' : 'movimenti'}</small></span></summary><div class="alt-body"><div class="acc-initial alt-initial"><span>Saldo iniziale <b>${U.money(db.accounts[0].initial)}</b>${s ? ' · dal ' + U.esc(dLabel(s)) : ''}</span><button type="button" id="initial">Modifica</button></div>${
      flows
        .map(
          (t) =>
            `<div class="flow-row alt-flow ${t.amount < 0 ? 'out' : 'in'}"><span class="flow-ic" aria-hidden="true">${t.amount < 0 ? '↑' : '↓'}</span><div class="flow-main"><b>${t.amount < 0 ? 'Prelievo' : 'Deposito'}</b><small>${U.date(t.date)}</small></div><strong class="${t.amount < 0 ? 'negative' : 'positive'}">${t.amount < 0 ? '−' : '+'}${U.money(Math.abs(t.amount))}</strong><div class="flow-actions"><button data-tx-edit="${t.id}">Modifica</button><button class="danger" data-tx-delete="${t.id}">Elimina</button></div></div>`,
        )
        .join('') || '<p class="muted alt-empty">Nessun deposito o prelievo.</p>'
    }</div></details><details class="card alt-sec" data-alt="backup"${altOpen('backup')}><summary><span class="alt-t"><b>Backup e ripristino</b><small>Ultima esportazione: ${db.settings.lastExport ? U.date(db.settings.lastExport) : 'mai'}</small></span></summary><div class="alt-body"><div class="actions"><button id="export">Esporta JSON</button><button id="import">Importa backup</button></div><input type="file" accept=".json,application/json" id="import-file" hidden></div></details>${memCardHtml()}<div class="card app-version-card"><h2>Versione app</h2><p class="muted">Bet Tracker ${APP_VERSION}</p><button type="button" id="check-app-update">Controlla aggiornamenti</button></div>`;
  }
  if (tab !== 'tips' && tab !== 'live') document.querySelector('header .tip-htools')?.remove(); /* 3.89.0 — pulsanti dei Pronostici solo nella loro scheda */
  main.innerHTML = html;
  bind();
  U.bindChart(main, chartPoints);
  if (tab === 'home') {
    bindDiary();
    main.querySelectorAll('[data-home-view]').forEach((b) => (b.onclick = () => { diaryUI.homeView = b.dataset.homeView; render(); window.scrollTo(0, 0); }));
  }
  if (tab === 'stats' && typeof tipStatsTabBind === 'function') tipStatsTabBind();
  else if (tab === 'stats') bindDiary();
  if ((tab === 'tips' || tab === 'live') && typeof bindTips === 'function') bindTips();
  if (tab === 'tips' || tab === 'live') { try { const gs = goalStripHtml(); if (gs) { main.insertAdjacentHTML('afterbegin', gs); bindGoal(main); } } catch (e) { /* ok */ } } /* 4.26.0 — striscia obiettivo */
  if (tab === 'accounts' && typeof renderPushCard === 'function') renderPushCard();
  try { cxEnhance(); } catch (e) { /* ok */ } /* 4.21.5 — riquadri a tendina */
}
function homeViewSeg() {
  const v = diaryUI.homeView === 'stats' ? 'stats' : 'home';
  return `<div class="diary-seg home-view-seg" role="tablist" aria-label="Saldo"><button type="button" role="tab" data-home-view="home" class="${v === 'home' ? 'active' : ''}" aria-selected="${v === 'home'}">Saldo</button><button type="button" role="tab" data-home-view="stats" class="${v === 'stats' ? 'active' : ''}" aria-selected="${v === 'stats'}">Andamento</button></div>`;
}
function sportsCard() {
  const info = sdbInfo(),
    on = sdbOnlineAllowed();
  return `<div class="card sports-card"><h2>Leghe e squadre</h2><p class="muted">Quando scegli campionato e squadre, l’elenco interno viene arricchito con i dati di TheSportsDB. Le risposte restano salvate sul telefono per 30 giorni e si usano anche offline.</p><label class="toggle-line"><input type="checkbox" id="sports-online"${on ? ' checked' : ''}> Aggiorna dai dati online</label><p class="muted">${on ? 'Ogni campionato viene chiesto online al massimo una volta al mese.' : 'Nessuna chiamata esterna: solo elenco interno e dati già salvati.'} ${info.count ? `Elenchi salvati: ${info.count} (${Math.max(1, Math.round(info.bytes / 1024))} KB).` : 'Nessun elenco salvato.'}</p>${info.count ? '<button type="button" id="sports-clear">Svuota dati salvati</button>' : ''}</div>`;
}
function undoBet(before, after) {
  U.toast('Esito registrato', () => {
    const current = db.bets.find((b) => b.id === before.id);
    if (JSON.stringify(current) !== JSON.stringify(after)) {
      U.toast('La scommessa è stata modificata: usa Altri esiti scommessa.');
      return;
    }
    mutate((n) => (n.bets = n.bets.map((b) => (b.id === before.id ? before : b))));
  });
}
function bind() {
  main.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => betForm()));
  main.querySelectorAll('[data-kpi]').forEach((b) => (b.onclick = () => kpiPanel(b.dataset.kpi, db.bets)));
  main.querySelectorAll('[data-money-kpi]').forEach((b) => (b.onclick = () => moneyKpiPanel(b.dataset.moneyKpi)));
  main.querySelectorAll('[data-roi]').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        sheetModal(
          sheetHead('Percentuale vinte') +
            '<div class="sheet-hero"><small>Come si calcola</small><b class="sheet-formula">vinte ÷ (vinte + perse) × 100</b></div><div class="sheet-box"><p>6 vinte e 4 perse = 60%. Ogni singola o multipla conta come una scommessa, indipendentemente da puntata e quota.</p><p>In corso, annullate e cash out sono escluse dal conteggio. In Statistiche si applicano i filtri selezionati.</p></div>',
        );
      }),
  );
  for (const key of ['period', 'basis', 'day', 'from', 'to', 'status', 'query'])
    document.getElementById(key)?.addEventListener('change', (e) => {
      filter[key] = e.target.value;
      if (key === 'day' && filter.day) filter.month = filter.day.slice(0, 7);
      render();
    });
  main.querySelectorAll('[data-month]').forEach(
    (b) =>
      (b.onclick = () => {
        filter.month = U.shiftMonth(filter.month, Number(b.dataset.month));
        render();
      }),
  );
  main.querySelectorAll('[data-day]').forEach(
    (b) =>
      (b.onclick = () => {
        filter.day = b.dataset.day;
        render();
      }),
  );
  main
    .querySelectorAll('[data-edit]')
    .forEach((b) => (b.onclick = () => betForm(db.bets.find((x) => x.id === b.dataset.edit))));
  main
    .querySelectorAll('[data-settle]')
    .forEach((b) => (b.onclick = () => settleForm(db.bets.find((x) => x.id === b.dataset.settle))));
  main.querySelectorAll('[data-delete]').forEach(
    (b) =>
      (b.onclick = () => {
        const bet = db.bets.find((x) => x.id === b.dataset.delete);
        if (!bet) return;
        U.confirm({
          title: 'Eliminare la scommessa?',
          text: 'Il saldo viene ricalcolato senza questa giocata.',
          detail: `${kpiLabel(bet)} · ${U.money(bet.stake)} · ${labels[bet.status]}`,
        }).then((ok) => {
          if (!ok) return;
          const before = U.clone(bet);
          if (mutate((n) => (n.bets = n.bets.filter((x) => x.id !== before.id))))
            U.toast('Scommessa eliminata', () => {
              if (db.bets.some((x) => x.id === before.id)) return;
              mutate((n) => n.bets.push(before));
            });
        });
      }),
  );
  main.querySelectorAll('[data-quick]').forEach(
    (btn) =>
      (btn.onclick = () => {
        const before = U.clone(db.bets.find((b) => b.id === btn.dataset.id));
        const after = {
          ...before,
          status: btn.dataset.quick,
          actualPayout: null,
          settledAt: new Date().toISOString(),
          legs: before.legs.map((l) =>
            btn.dataset.quick === 'won' && l.status !== 'void' ? { ...l, status: 'won' } : l,
          ),
        };
        if (mutate((n) => (n.bets = n.bets.map((b) => (b.id === after.id ? after : b))))) undoBet(before, after);
      }),
  );
  main
    .querySelectorAll('[data-tx]')
    .forEach((b) => (b.onclick = () => transactionForm(b.dataset.tx === 'withdraw' ? -1 : 1)));
  main.querySelectorAll('[data-tx-edit]').forEach(
    (b) =>
      (b.onclick = () => {
        const t = db.transactions.find((x) => x.id === b.dataset.txEdit);
        transactionForm(t.amount < 0 ? -1 : 1, t);
      }),
  );
  main.querySelectorAll('[data-tx-delete]').forEach(
    (b) =>
      (b.onclick = () => {
        const tx = db.transactions.find((t) => t.id === b.dataset.txDelete);
        if (!tx) return;
        U.confirm({
          title: 'Eliminare il movimento?',
          text: 'Il saldo viene ricalcolato senza questo movimento.',
          detail: `${tx.amount < 0 ? 'Prelievo' : 'Deposito'} · ${U.money(Math.abs(tx.amount))} · ${U.date(tx.date)}`,
        }).then((ok) => {
          if (!ok) return;
          const before = U.clone(tx);
          if (mutate((n) => (n.transactions = n.transactions.filter((t) => t.id !== before.id))))
            U.toast('Movimento eliminato', () => {
              if (db.transactions.some((t) => t.id === before.id)) return;
              mutate((n) => n.transactions.push(before));
            });
        });
      }),
  );
  document.getElementById('save-limit')?.addEventListener('click', () => {
    const v = Number(document.getElementById('monthly-limit').value);
    if (U.finite(v) && v >= 0) mutate((n) => (n.settings.monthlyLimit = U.round(v)));
  });
  document.getElementById('initial')?.addEventListener('click', initialForm);
  main.querySelectorAll('details.alt-sec').forEach((d) => d.addEventListener('toggle', () => { diaryUI.altOpen = diaryUI.altOpen || {}; diaryUI.altOpen[d.dataset.alt] = d.open; }));
  document.getElementById('export')?.addEventListener('click', exportData);
  document.getElementById('import')?.addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file')?.addEventListener('change', importData);
  document.getElementById('sports-online')?.addEventListener('change', (e) => {
    mutate((n) => (n.settings.sportsOnline = e.target.checked));
  });
  document.getElementById('sports-clear')?.addEventListener('click', () => {
    U.confirm({
      title: 'Svuotare i dati salvati?',
      text: 'Leghe e squadre verranno richieste di nuovo online alla prossima scelta.',
      ok: 'Svuota',
    }).then((ok) => {
      if (!ok) return;
      try {
        localStorage.removeItem(SDB_KEY);
      } catch {}
      render();
      U.toast('Dati di leghe e squadre svuotati');
    });
  });
  document.getElementById('mem-free')?.addEventListener('click', () => memFree());
  document.getElementById('check-app-update')?.addEventListener('click', () => {
    checkForAppUpdate();
    U.toast('Controllo in corso: se c’è una nuova versione compare l’avviso.');
  });
}
const OVER_VALUES = Array.from({ length: 21 }, (_, i) => (i + 0.5).toFixed(1));
const MINUTE_VALUES = Array.from({ length: 8 }, (_, i) => (i + 1) * 10);
const PICK_ROOT = [
  { id: 'goals', label: 'GOL' },
  { id: 'minutes', label: 'OVER A MINUTI' },
  { id: 'corners', label: 'ANGOLI' },
];
function pickGroupButton(id, label) {
  return `<button type="button" class="pick-group-button" data-pick-step="${U.esc(id)}"><span>${U.esc(label)}</span><span aria-hidden="true">›</span></button>`;
}
function pickValueButtons(items) {
  return `<div class="pick-panel-buttons">${items.map(({ value, label = value }) => `<button type="button" data-pick="${U.esc(value)}">${U.esc(label)}</button>`).join('')}</div>`;
}
function pickStep(step) {
  const [type, a, b] = step.split(':');
  if (type === 'goals' || type === 'corners') {
    const subject = type === 'goals' ? 'Gol' : 'Angoli';
    if (!a)
      return {
        title: subject,
        help: 'Scegli se il pronostico riguarda primo tempo o partita intera.',
        html: `<section class="pick-panel-section"><div class="pick-panel-section-title">Periodo</div><div class="pick-panel-groups">${pickGroupButton(`${type}:HT`, 'HT · Primo tempo')}${pickGroupButton(`${type}:FT`, 'FT · Partita intera')}</div></section>`,
      };
    if (!b)
      return {
        title: `${subject} · ${a}`,
        help: 'Scegli Over classico oppure Over Asiatico.',
        html: `<section class="pick-panel-section"><div class="pick-panel-section-title">Tipo Over</div><div class="pick-panel-groups">${pickGroupButton(`${type}:${a}:classic`, 'OVER')}${pickGroupButton(`${type}:${a}:asian`, 'OVER ASIATICO')}</div></section>`,
      };
    const asian = b === 'asian',
      items = OVER_VALUES.map((v) => ({
        value: `Over ${v}${asian ? ' Asiatico' : ''} ${subject} ${a}`,
        label: `Over ${v}${asian ? ' Asiatico' : ''} ${a}`,
      }));
    return {
      title: `${asian ? 'Over Asiatico' : 'Over'} ${subject} · ${a}`,
      help: 'Scegli la soglia desiderata.',
      html: `<section class="pick-panel-section pick-values-section"><div class="pick-panel-section-title">Soglia</div>${pickValueButtons(items)}</section>`,
    };
  }
  if (type === 'minutes') {
    if (!a)
      return {
        title: 'Over a minuti',
        help: 'Scegli entro quale minuto deve verificarsi il pronostico.',
        html: `<section class="pick-panel-section"><div class="pick-panel-section-title">Minuto</div><div class="pick-panel-groups">${MINUTE_VALUES.map((m) => pickGroupButton(`minutes:${m}`, `Entro ${m} minuti`)).join('')}</div></section>`,
      };
    if (!b)
      return {
        title: `Entro ${a} minuti`,
        help: 'Scegli Over classico oppure Over Asiatico.',
        html: `<section class="pick-panel-section"><div class="pick-panel-section-title">Tipo Over</div><div class="pick-panel-groups">${pickGroupButton(`minutes:${a}:classic`, 'OVER')}${pickGroupButton(`minutes:${a}:asian`, 'OVER ASIATICO')}</div></section>`,
      };
    const asian = b === 'asian',
      items = OVER_VALUES.map((v) => ({
        value: `Over ${v}${asian ? ' Asiatico' : ''} entro ${a} minuti`,
        label: `Over ${v}${asian ? ' Asiatico' : ''}`,
      }));
    return {
      title: `${asian ? 'Over Asiatico' : 'Over'} · entro ${a} minuti`,
      help: 'Scegli la soglia desiderata.',
      html: `<section class="pick-panel-section pick-values-section"><div class="pick-panel-section-title">Soglia</div>${pickValueButtons(items)}</section>`,
    };
  }
  return null;
}
function presetButtons() {
  const favorites = [...new Set(db.settings.favorites)],
    buttons = (rows) => rows.map((p) => `<button type="button" data-pick="${U.esc(p)}">${U.esc(p)}</button>`).join(''),
    groups = PICK_ROOT.map((g) => pickGroupButton(g.id, g.label)).join('');
  return `${favorites.length ? `<section class="pick-panel-section favorites-section"><div class="pick-panel-section-title"><span aria-hidden="true">★</span> Preferiti</div><div class="pick-panel-buttons">${buttons(favorites)}</div></section>` : ''}<section class="pick-panel-section pick-types-section"><div class="pick-panel-section-title">Tipo di pronostico</div><div class="pick-panel-groups">${groups}</div></section>`;
}

const FOOTBALL_COUNTRIES = [
  ['IT', '🇮🇹', 'Italia', 'Italy'],
  ['GB-ENG', '🏴', 'Inghilterra', 'England'],
  ['ES', '🇪🇸', 'Spagna', 'Spain'],
  ['FR', '🇫🇷', 'Francia', 'France'],
  ['DE', '🇩🇪', 'Germania', 'Germany'],
  ['PT', '🇵🇹', 'Portogallo', 'Portugal'],
  ['NL', '🇳🇱', 'Paesi Bassi', 'Netherlands'],
  ['BE', '🇧🇪', 'Belgio', 'Belgium'],
  ['GB-SCT', '🏴', 'Scozia', 'Scotland'],
  ['TR', '🇹🇷', 'Turchia', 'Turkey'],
  ['GR', '🇬🇷', 'Grecia', 'Greece'],
  ['AT', '🇦🇹', 'Austria', 'Austria'],
  ['CH', '🇨🇭', 'Svizzera', 'Switzerland'],
  ['DK', '🇩🇰', 'Danimarca', 'Denmark'],
  ['SE', '🇸🇪', 'Svezia', 'Sweden'],
  ['NO', '🇳🇴', 'Norvegia', 'Norway'],
  ['FI', '🇫🇮', 'Finlandia', 'Finland'],
  ['PL', '🇵🇱', 'Polonia', 'Poland'],
  ['CZ', '🇨🇿', 'Repubblica Ceca', 'Czech Republic'],
  ['HR', '🇭🇷', 'Croazia', 'Croatia'],
  ['RS', '🇷🇸', 'Serbia', 'Serbia'],
  ['RO', '🇷🇴', 'Romania', 'Romania'],
  ['HU', '🇭🇺', 'Ungheria', 'Hungary'],
  ['UA', '🇺🇦', 'Ucraina', 'Ukraine'],
  ['IE', '🇮🇪', 'Irlanda', 'Ireland'],
  ['GB-NIR', '🇬🇧', 'Irlanda del Nord', 'Northern Ireland'],
  ['GB-WLS', '🏴', 'Galles', 'Wales'],
  ['IS', '🇮🇸', 'Islanda', 'Iceland'],
  ['CY', '🇨🇾', 'Cipro', 'Cyprus'],
  ['IL', '🇮🇱', 'Israele', 'Israel'],
  ['SA', '🇸🇦', 'Arabia Saudita', 'Saudi Arabia'],
  ['AE', '🇦🇪', 'Emirati Arabi Uniti', 'United Arab Emirates'],
  ['QA', '🇶🇦', 'Qatar', 'Qatar'],
  ['US', '🇺🇸', 'Stati Uniti', 'United States'],
  ['CA', '🇨🇦', 'Canada', 'Canada'],
  ['MX', '🇲🇽', 'Messico', 'Mexico'],
  ['BR', '🇧🇷', 'Brasile', 'Brazil'],
  ['AR', '🇦🇷', 'Argentina', 'Argentina'],
  ['UY', '🇺🇾', 'Uruguay', 'Uruguay'],
  ['CO', '🇨🇴', 'Colombia', 'Colombia'],
  ['CL', '🇨🇱', 'Cile', 'Chile'],
  ['PE', '🇵🇪', 'Perù', 'Peru'],
  ['EC', '🇪🇨', 'Ecuador', 'Ecuador'],
  ['PY', '🇵🇾', 'Paraguay', 'Paraguay'],
  ['BO', '🇧🇴', 'Bolivia', 'Bolivia'],
  ['JP', '🇯🇵', 'Giappone', 'Japan'],
  ['KR', '🇰🇷', 'Corea del Sud', 'South Korea'],
  ['CN', '🇨🇳', 'Cina', 'China'],
  ['AU', '🇦🇺', 'Australia', 'Australia'],
  ['NZ', '🇳🇿', 'Nuova Zelanda', 'New Zealand'],
  ['MA', '🇲🇦', 'Marocco', 'Morocco'],
  ['DZ', '🇩🇿', 'Algeria', 'Algeria'],
  ['TN', '🇹🇳', 'Tunisia', 'Tunisia'],
  ['EG', '🇪🇬', 'Egitto', 'Egypt'],
  ['ZA', '🇿🇦', 'Sudafrica', 'South Africa'],
  ['NG', '🇳🇬', 'Nigeria', 'Nigeria'],
  ['GH', '🇬🇭', 'Ghana', 'Ghana'],
  ['SN', '🇸🇳', 'Senegal', 'Senegal'],
  ['AL', '🇦🇱', 'Albania', 'Albania'],
  ['AD', '🇦🇩', 'Andorra', 'Andorra'],
  ['AM', '🇦🇲', 'Armenia', 'Armenia'],
  ['AZ', '🇦🇿', 'Azerbaigian', 'Azerbaijan'],
  ['BY', '🇧🇾', 'Bielorussia', 'Belarus'],
  ['BA', '🇧🇦', 'Bosnia ed Erzegovina', 'Bosnia-Herzegovina'],
  ['BG', '🇧🇬', 'Bulgaria', 'Bulgaria'],
  ['EE', '🇪🇪', 'Estonia', 'Estonia'],
  ['GE', '🇬🇪', 'Georgia', 'Georgia'],
  ['KZ', '🇰🇿', 'Kazakistan', 'Kazakhstan'],
  ['XK', '🇽🇰', 'Kosovo', 'Kosovo'],
  ['LV', '🇱🇻', 'Lettonia', 'Latvia'],
  ['LT', '🇱🇹', 'Lituania', 'Lithuania'],
  ['LU', '🇱🇺', 'Lussemburgo', 'Luxembourg'],
  ['MT', '🇲🇹', 'Malta', 'Malta'],
  ['MD', '🇲🇩', 'Moldavia', 'Moldova'],
  ['ME', '🇲🇪', 'Montenegro', 'Montenegro'],
  ['MK', '🇲🇰', 'Macedonia del Nord', 'North Macedonia'],
  ['SI', '🇸🇮', 'Slovenia', 'Slovenia'],
  ['SK', '🇸🇰', 'Slovacchia', 'Slovakia'],
  ['CR', '🇨🇷', 'Costa Rica', 'Costa Rica'],
  ['PA', '🇵🇦', 'Panama', 'Panama'],
  ['HN', '🇭🇳', 'Honduras', 'Honduras'],
  ['GT', '🇬🇹', 'Guatemala', 'Guatemala'],
  ['SV', '🇸🇻', 'El Salvador', 'El Salvador'],
  ['JM', '🇯🇲', 'Giamaica', 'Jamaica'],
  ['VE', '🇻🇪', 'Venezuela', 'Venezuela'],
  ['IN', '🇮🇳', 'India', 'India'],
  ['ID', '🇮🇩', 'Indonesia', 'Indonesia'],
  ['MY', '🇲🇾', 'Malesia', 'Malaysia'],
  ['TH', '🇹🇭', 'Thailandia', 'Thailand'],
  ['VN', '🇻🇳', 'Vietnam', 'Vietnam'],
  ['SG', '🇸🇬', 'Singapore', 'Singapore'],
  ['IR', '🇮🇷', 'Iran', 'Iran'],
  ['IQ', '🇮🇶', 'Iraq', 'Iraq'],
  ['JO', '🇯🇴', 'Giordania', 'Jordan'],
  ['UZ', '🇺🇿', 'Uzbekistan', 'Uzbekistan'],
  ['KE', '🇰🇪', 'Kenya', 'Kenya'],
  ['CM', '🇨🇲', 'Camerun', 'Cameroon'],
  ['CI', '🇨🇮', 'Costa d’Avorio', 'Ivory Coast'],
  ['ML', '🇲🇱', 'Mali', 'Mali'],
  ['CD', '🇨🇩', 'RD Congo', 'DR Congo'],
  ['AO', '🇦🇴', 'Angola', 'Angola'],
].map(([code, flag, name, api]) => ({ code, flag, name, api }));
const FOOTBALL_FALLBACK = {
  IT: {
    men: { top: ['Serie A'], lower: ['Serie B', 'Serie C'] },
    women: { top: ['Serie A Femminile'], lower: ['Serie B Femminile'] },
    youth: ['Primavera 1', 'Primavera 2', 'Campionato U18', 'Campionato U17'],
  },
  'GB-ENG': {
    men: { top: ['Premier League'], lower: ['Championship', 'League One', 'League Two', 'National League'] },
    women: { top: ["Women's Super League"], lower: ["Women's Championship"] },
    youth: ['Premier League 2', 'U18 Premier League'],
  },
  ES: {
    men: { top: ['LaLiga'], lower: ['LaLiga 2', 'Primera Federación', 'Segunda Federación'] },
    women: { top: ['Liga F'], lower: ['Primera Federación Femenina'] },
    youth: ['División de Honor Juvenil'],
  },
  FR: {
    men: { top: ['Ligue 1'], lower: ['Ligue 2', 'National', 'National 2'] },
    women: { top: ['Première Ligue Féminine'], lower: ['Seconde Ligue Féminine'] },
    youth: ['Championnat National U19', 'Championnat National U17'],
  },
  DE: {
    men: { top: ['Bundesliga'], lower: ['2. Bundesliga', '3. Liga', 'Regionalliga'] },
    women: { top: ['Frauen-Bundesliga'], lower: ['2. Frauen-Bundesliga'] },
    youth: ['U19 DFB-Nachwuchsliga', 'U17 DFB-Nachwuchsliga'],
  },
  PT: {
    men: { top: ['Primeira Liga'], lower: ['Liga Portugal 2', 'Liga 3'] },
    women: { top: ['Campeonato Nacional Feminino'], lower: ['II Divisão Feminina'] },
    youth: ['Campeonato Nacional U19', 'Campeonato Nacional U17'],
  },
  NL: {
    men: { top: ['Eredivisie'], lower: ['Eerste Divisie', 'Tweede Divisie'] },
    women: { top: ['Vrouwen Eredivisie'], lower: ['Topklasse Vrouwen'] },
    youth: ['U21 Divisie', 'U18 Divisie'],
  },
  BE: {
    men: { top: ['Belgian Pro League'], lower: ['Challenger Pro League', 'National Division 1'] },
    women: { top: ['Super League Women'], lower: ['Division 1 Women'] },
    youth: ['U21 Pro League', 'Elite Youth'],
  },
  BR: {
    men: { top: ['Brasileirão Série A'], lower: ['Série B', 'Série C', 'Série D'] },
    women: { top: ['Brasileirão Feminino A1'], lower: ['Brasileirão Feminino A2'] },
    youth: ['Brasileirão U20', 'Copa do Brasil U20'],
  },
  AR: {
    men: { top: ['Primera División'], lower: ['Primera Nacional', 'Primera B Metropolitana'] },
    women: { top: ['Primera División Femenina'], lower: ['Primera B Femenina'] },
    youth: ['Torneo de Reserva', 'Juveniles AFA'],
  },
  US: {
    men: { top: ['Major League Soccer'], lower: ['USL Championship', 'USL League One'] },
    women: { top: ['NWSL'], lower: ['USL Super League'] },
    youth: ['MLS NEXT Pro', 'MLS NEXT U19'],
  },
  MX: {
    men: { top: ['Liga MX'], lower: ['Liga de Expansión MX', 'Liga Premier'] },
    women: { top: ['Liga MX Femenil'], lower: ['Liga TDP Femenil'] },
    youth: ['Liga MX Sub-23', 'Liga MX Sub-19'],
  },
  JP: {
    men: { top: ['J1 League'], lower: ['J2 League', 'J3 League'] },
    women: { top: ['WE League'], lower: ['Nadeshiko League'] },
    youth: ['Prince Takamado U18 Premier League'],
  },
  AU: {
    men: { top: ['A-League Men'], lower: ['National Premier Leagues'] },
    women: { top: ['A-League Women'], lower: ['NPL Women'] },
    youth: ['A-League Youth'],
  },
};
const NATIONAL_COMPETITIONS = {
  men: [
    'Coppa del Mondo FIFA',
    'Qualificazioni Mondiali',
    'Campionato Europeo UEFA',
    'Qualificazioni Europei',
    'UEFA Nations League',
    'Copa América',
    'CONCACAF Gold Cup',
    'Coppa d’Africa',
    'Coppa d’Asia AFC',
    'Amichevole internazionale',
  ],
  women: [
    'Coppa del Mondo Femminile FIFA',
    'Qualificazioni Mondiali Femminili',
    'Europeo Femminile UEFA',
    'Qualificazioni Europei Femminili',
    'UEFA Women’s Nations League',
    'Copa América Femenina',
    'CONCACAF W Championship',
    'Coppa d’Africa Femminile',
    'AFC Women’s Asian Cup',
    'Amichevole internazionale',
  ],
};
const YOUTH_AGES = ['U23', 'U21', 'U20', 'U19', 'U18', 'U17', 'U16', 'U15'];
const youthCompetitionOptions = (gender, age) => {
  const sex = gender === 'women' ? 'Femminile' : 'Maschile';
  const rows = [`Torneo internazionale ${sex} ${age}`, `Qualificazioni ${sex} ${age}`, `Amichevole ${sex} ${age}`];
  if (['U20', 'U17'].includes(age)) rows.unshift(`Coppa del Mondo FIFA ${sex} ${age}`);
  if (['U21', 'U19', 'U17'].includes(age)) rows.unshift(`Campionato Europeo UEFA ${sex} ${age}`);
  return rows;
};
const genericDivisions = (gender, level, age = '') => {
  if (level === 'youth') {
    const sex = gender === 'women' ? 'Femminile' : 'Maschile',
      tag = age || 'Giovanile';
    return [`Campionato ${sex} ${tag}`, `Divisione ${sex} ${tag}`, `Torneo ${sex} ${tag}`];
  }
  return gender === 'women'
    ? ['Prima divisione femminile', 'Seconda divisione femminile', 'Divisioni inferiori femminili']
    : ['Prima divisione', 'Seconda divisione', 'Terza divisione', 'Divisioni inferiori'];
};
function fallbackDivisions(code, gender, level, age = '') {
  const c = FOOTBALL_FALLBACK[code];
  if (level === 'youth') {
    const rows = c?.youth || [];
    if (gender === 'women') return genericDivisions(gender, level, age);
    return rows.length ? rows : genericDivisions(gender, level, age);
  }
  if (!c) return genericDivisions(gender, level, age);
  const block = c[gender] || {};
  return [...(block.top || []), ...(block.lower || [])];
}
function leagueBucket(name) {
  const n = String(name || '').toLowerCase();
  if (/u[- ]?\d{2}|under[- ]?\d{2}|youth|juven|primavera|academy|reserve|junior/.test(n)) return 'youth';
  if (/women|women's|fem|frauen|donna|damall|femen|nadeshiko|vrouwen|female|girls/.test(n)) return 'women';
  return 'men';
}
function leagueRank(name) {
  const n = String(name || '').toLowerCase();
  const rules = [
    [
      /serie a$|premier league$|laliga$|bundesliga$|ligue 1$|eredivisie$|primeira liga$|pro league$|super league$|liga mx$|major league soccer$|j1 league$|a-league men$|série a$|primera división$/,
      1,
    ],
    [
      /serie b$|championship$|laliga 2$|2\. bundesliga$|ligue 2$|eerst[e]? divisie$|liga portugal 2$|challenger pro league$|série b$|j2 league$/,
      2,
    ],
    [/serie c$|league one$|3\. liga$|national$|primera federación$|liga 3$|série c$|j3 league$/, 3],
    [/serie d$|league two$|national 2$|segunda federación$|série d$/, 4],
  ];
  for (const [re, r] of rules) if (re.test(n)) return r;
  return 50;
}
function leagueMatches(name, gender, level, age = '') {
  const bucket = leagueBucket(name),
    n = String(name || '').toLowerCase();
  if (level === 'youth') {
    if (bucket !== 'youth') return false;
    if (gender === 'women' && !/women|fem|frauen|femen|female|girls|donna|vrouwen/.test(n)) return false;
    if (gender === 'men' && /women|fem|frauen|femen|female|girls|donna|vrouwen/.test(n)) return false;
    if (age) {
      const ageNum = age.replace(/\D/g, '');
      const m = n.match(/(?:u|under)[- ]?(\d{2})/);
      if (m && m[1] !== ageNum) return false;
    }
    return true;
  }
  return bucket === gender;
}
/* 2.1.0 — Leghe e squadre salvate sul telefono.
   Le risposte di TheSportsDB restano in memoria 30 giorni: la stessa lega/paese viene chiesta
   online al massimo una volta al mese, e senza rete si usano i dati salvati (anche scaduti).
   Con "Solo dati salvati" (Altro) l'app non contatta mai il servizio esterno. */
var SDB_KEY = 'bet_sdb_cache_v1',
  SDB_TTL = 30 * 86400000,
  SDB_MAX = 120;
function sdbRead() {
  try {
    return JSON.parse(localStorage.getItem(SDB_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function sdbWrite(c) {
  const keys = Object.keys(c);
  if (keys.length > SDB_MAX)
    keys
      .sort((a, b) => c[a].t - c[b].t)
      .slice(0, keys.length - SDB_MAX)
      .forEach((k) => delete c[k]);
  try {
    localStorage.setItem(SDB_KEY, JSON.stringify(c));
  } catch {
    /* memoria piena: si continua senza salvare */
  }
}
function sdbOnlineAllowed() {
  return db.settings.sportsOnline !== false;
}
async function sdbGet(url, reduce) {
  const c = sdbRead(),
    hit = c[url];
  if (hit && Date.now() - hit.t < SDB_TTL) return hit.v;
  if (!sdbOnlineAllowed() || (typeof navigator !== 'undefined' && navigator.onLine === false))
    return hit ? hit.v : null;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw Error('network');
    const v = reduce(await r.json());
    c[url] = { t: Date.now(), v };
    sdbWrite(c);
    return v;
  } catch {
    return hit ? hit.v : null;
  }
}
function sdbInfo() {
  const c = sdbRead();
  return { count: Object.keys(c).length, bytes: (localStorage.getItem(SDB_KEY) || '').length };
}

async function onlineLeagueRecords(country, gender, level, age = '') {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/123/search_all_leagues.php?c=${encodeURIComponent(country.api)}&s=Soccer`;
    const rows =
      (await sdbGet(url, (data) =>
        (Array.isArray(data.countries) ? data.countries : []).map((x) => ({
          strLeague: x?.strLeague,
          idLeague: x?.idLeague,
        })),
      )) || [];
    return rows
      .filter((x) => x?.strLeague && leagueMatches(x.strLeague, gender, level, age))
      .map((x) => ({ name: x.strLeague, id: x.idLeague || '', online: true }))
      .sort((a, b) => leagueRank(a.name) - leagueRank(b.name) || a.name.localeCompare(b.name, 'it'));
  } catch {
    return [];
  }
}
async function onlineTeams(leagueName, country) {
  try {
    const byLeague = `https://www.thesportsdb.com/api/v1/json/123/search_all_teams.php?l=${encodeURIComponent(leagueName)}`;
    const rows =
      (await sdbGet(byLeague, (data) =>
        (Array.isArray(data.teams) ? data.teams : []).map((x) => ({ strTeam: x?.strTeam })),
      )) || [];
    return [...new Set(rows.map((x) => x?.strTeam).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'it'));
  } catch {
    return [];
  }
}
function countryOptions(selected = '') {
  return FOOTBALL_COUNTRIES.map(
    (c) =>
      `<option value="${U.esc(c.code)}" ${c.code === selected ? 'selected' : ''}>${c.flag} ${U.esc(c.name)}</option>`,
  ).join('');
}
function eventGroupButton(id, label, sub = '') {
  return `<button type="button" class="event-group-button" data-event-step="${U.esc(id)}"><span><b>${U.esc(label)}</b>${sub ? `<small>${U.esc(sub)}</small>` : ''}</span><span aria-hidden="true">›</span></button>`;
}

function legHTML(l = {}, index = 0) {
  const pick = U.esc(l.pick || ''),
    meta = encodeURIComponent(JSON.stringify(l.meta || {}));
  return `<details class="leg compact-leg" data-leg-status="${l.status || 'pending'}" data-event-meta="${U.esc(meta)}" ${index === 0 ? 'open' : ''}><summary><span class="leg-number">${index + 1}</span><span class="leg-summary"><b class="leg-title">${U.esc(l.event || 'Nuovo evento')}</b><small class="leg-pick">${U.esc(l.pick || 'Partita e pronostico')}</small></span><b class="leg-quote">${l.odds ? Number(l.odds).toFixed(2) : '—'}</b><span class="leg-chevron">⌄</span></summary><div class="leg-fields"><label>Partita / evento<input class="event" required maxlength="220" placeholder="Es. Inter – Milan" value="${U.esc(l.event || '')}"></label><button class="event-trigger" type="button"><span>⚽ Seleziona campionato / nazionale</span><span aria-hidden="true">›</span></button><small class="event-trigger-help"></small><div class="pick-odds-row"><label>Esito / pronostico<div class="pick-selector"><input class="pick" type="hidden" value="${pick}"><button class="pick-trigger" type="button" aria-haspopup="dialog"><span class="pick-trigger-text">${pick || 'Seleziona esito'}</span><span class="pick-trigger-arrow" aria-hidden="true">›</span></button></div></label><label>Quota<input class="odds" type="number" inputmode="decimal" min="1" max="10000" step="any" required placeholder="1.85" value="${l.odds || ''}"></label></div><div class="leg-tools"><button class="favorite-toggle" type="button" data-favorite aria-label="Aggiungi pronostico ai preferiti" title="Aggiungi ai preferiti" aria-pressed="false">☆</button><button class="danger" type="button" data-remove-leg aria-label="Rimuovi evento">✕ Rimuovi</button></div></div></details>`;
}
function betForm(b) {
  const title = b ? 'Modifica scommessa' : 'Nuova scommessa',
    saveLabel = b ? 'Salva modifiche' : 'Salva scommessa';
  const head = `<div class="row editor-head bet-editor-head"><h2>${U.esc(title)}</h2><button class="primary bet-save-icon" type="submit" form="bet-form" aria-label="${U.esc(saveLabel)}" title="${U.esc(saveLabel)}">✓</button></div>`;
  const d = U.modal(
    head +
      `<form id="bet-form"><div class="bet-meta"><label>Puntata (€)<input name="stake" min="0.01" step="0.01" inputmode="decimal" type="number" required placeholder="10,00" value="${b?.stake ?? '10.00'}"></label><details class="bet-date"><summary><span>Data e ora <span class="date-edit">Modifica</span></span><b id="date-summary"></b></summary><input name="date" aria-label="Data e ora della giocata" type="datetime-local" required value="${U.local(b ? new Date(b.date) : new Date())}"></details></div><div id="legs">${(b?.legs || [{}]).map(legHTML).join('')}</div><button type="button" id="add-leg">＋ Aggiungi evento alla multipla</button><p id="form-error" class="error" role="alert"></p><div class="bet-savebar"><div id="preview" aria-live="polite"></div></div><div id="event-panel" class="pick-panel-layer event-panel-layer" hidden><button class="pick-panel-scrim" type="button" data-close-event-panel aria-label="Chiudi selezione evento"></button><section class="pick-panel-card event-panel-card" role="dialog" aria-modal="true" aria-labelledby="event-panel-title"><div class="pick-panel-head"><small>SELEZIONE EVENTO</small><button type="button" id="event-back" class="pick-back" hidden>← Indietro</button><h3 id="event-panel-title">Tipo di partita</h3><p class="muted" id="event-panel-help">Scegli club oppure nazionali.</p></div><div id="event-panel-body"></div><p class="muted event-source">Campionati online: TheSportsDB quando disponibile · catalogo locale come fallback.</p><p class="error" id="event-panel-error" role="alert"></p></section></div><div id="pick-panel" class="pick-panel-layer" hidden><button class="pick-panel-scrim" type="button" data-close-pick-panel aria-label="Chiudi pannello esito"></button><section class="pick-panel-card" role="dialog" aria-modal="true" aria-labelledby="pick-panel-title"><div class="pick-panel-head"><small>${b ? 'MODIFICA SCOMMESSA' : 'NUOVA SCOMMESSA'}</small><button type="button" id="pick-back" class="pick-back" hidden aria-label="Torna alle tipologie di esito">← Indietro</button><h3 id="pick-panel-title">Scegli tipo di esito</h3><p class="muted" id="pick-panel-help">Scegli una categoria per vedere gli esiti disponibili.</p></div><div class="pick-panel-grid" id="pick-panel-grid"></div><div id="pick-custom-block"><label>Esito personalizzato<input id="pick-custom" maxlength="100" autocomplete="off" placeholder="Es. 1, X2, Goal, Over 2.5 FT"></label><div class="pick-panel-actions"><button type="button" class="primary" id="pick-confirm" aria-label="Conferma esito personalizzato">✓</button></div></div><p class="error" id="pick-panel-error" role="alert"></p></section></div></form>`,
    { backdropClose: true },
  );
  const form = d.querySelector('form'),
    panel = d.querySelector('#pick-panel'),
    custom = d.querySelector('#pick-custom'),
    customBlock = d.querySelector('#pick-custom-block'),
    panelGrid = d.querySelector('#pick-panel-grid'),
    panelTitle = d.querySelector('#pick-panel-title'),
    panelHelp = d.querySelector('#pick-panel-help'),
    back = d.querySelector('#pick-back'),
    eventPanel = d.querySelector('#event-panel'),
    eventBody = d.querySelector('#event-panel-body'),
    eventTitle = d.querySelector('#event-panel-title'),
    eventHelp = d.querySelector('#event-panel-help'),
    eventBack = d.querySelector('#event-back');
  let pickTarget = null,
    eventTarget = null,
    eventPath = [],
    eventState = {};
  const openLeg = (c) => {
    d.querySelectorAll('.leg').forEach((x) => {
      x.open = x === c;
    });
  };
  const closePickPanel = () => {
    panel.hidden = true;
    pickTarget = null;
    d.querySelector('#pick-panel-error').textContent = '';
  };
  const choosePick = (value) => {
    if (!pickTarget) return;
    const v = String(value || '').trim();
    if (!v) return;
    pickTarget.querySelector('.pick').value = v;
    pickTarget.querySelector('.pick-trigger-text').textContent = v;
    closePickPanel();
    preview();
  };
  let pickPath = [];
  const bindPickPanel = (step = '') => {
    const data = step ? pickStep(step) : null;
    if (data) {
      panelTitle.textContent = data.title;
      panelHelp.textContent = data.help;
      back.hidden = false;
      customBlock.hidden = true;
      panelGrid.innerHTML = data.html;
    } else {
      panelTitle.textContent = 'Scegli tipo di pronostico';
      panelHelp.textContent = 'Scegli Gol, Over a minuti oppure Angoli.';
      back.hidden = true;
      customBlock.hidden = false;
      panelGrid.innerHTML = presetButtons();
    }
    panelGrid.querySelectorAll('[data-pick]').forEach((btn) => (btn.onclick = () => choosePick(btn.dataset.pick)));
    panelGrid.querySelectorAll('[data-pick-step]').forEach(
      (btn) =>
        (btn.onclick = () => {
          pickPath.push(btn.dataset.pickStep);
          bindPickPanel(btn.dataset.pickStep);
        }),
    );
  };
  const openPickPanel = (c) => {
    pickTarget = c;
    pickPath = [];
    custom.value = c.querySelector('.pick').value;
    d.querySelector('#pick-panel-error').textContent = '';
    bindPickPanel();
    panel.hidden = false;
  };

  const closeEventPanel = () => {
    eventPanel.hidden = true;
    eventTarget = null;
    eventPath = [];
    eventState = {};
    d.querySelector('#event-panel-error').textContent = '';
  };
  const eventCountry = () => FOOTBALL_COUNTRIES.find((c) => c.code === eventState.country) || FOOTBALL_COUNTRIES[0];
  const bindEventButtons = () =>
    eventBody.querySelectorAll('[data-event-step]').forEach(
      (btn) =>
        (btn.onclick = () => {
          eventPath.push(btn.dataset.eventStep);
          renderEventStep(btn.dataset.eventStep);
        }),
    );
  function bindTeamAutocomplete(input, box, getValues) {
    const render = () => {
      const q = input.value.trim().toLocaleLowerCase('it'),
        all = [...new Set((getValues() || []).filter(Boolean))],
        rows = all.filter((v) => !q || v.toLocaleLowerCase('it').includes(q)).slice(0, 12);
      box.innerHTML = rows
        .map((v) => `<button type="button" class="team-suggestion" data-team-value="${U.esc(v)}">${U.esc(v)}</button>`)
        .join('');
      box.hidden = !rows.length;
      box.querySelectorAll('[data-team-value]').forEach(
        (btn) =>
          (btn.onpointerdown = (e) => {
            e.preventDefault();
            input.value = btn.dataset.teamValue;
            box.hidden = true;
            input.focus();
          }),
      );
    };
    input.addEventListener('focus', render);
    input.addEventListener('click', render);
    input.addEventListener('input', render);
    input.addEventListener('blur', () =>
      setTimeout(() => {
        box.hidden = true;
      }, 140),
    );
    return render;
  }
  const renderTeams = async (national = false) => {
    const country = eventCountry(),
      competition = eventState.competition || '',
      sex = eventState.gender === 'women' ? 'Femminile' : 'Maschile',
      youth = eventState.teamLevel === 'youth',
      age = eventState.age || '';
    eventTitle.textContent = national ? 'Nazionali · squadre' : 'Club · squadre';
    eventHelp.textContent =
      'Le squadre sono opzionali: puoi salvarle entrambe oppure tenere traccia solo del campionato/competizione.';
    eventBack.hidden = false;
    const category = youth ? `${sex} · ${age}` : `${sex} · Senior`;
    let teamOptions = national ? FOOTBALL_COUNTRIES.map((c) => c.name) : [];
    eventBody.innerHTML = `<div class="event-team-form"><label>${national ? 'Nazionale 1 (opzionale)' : 'Squadra casa (opzionale)'}<div class="team-autocomplete"><input id="event-team-a" autocomplete="off" placeholder="${national ? 'Italia' : 'Inter'}"><div id="event-team-a-suggestions" class="team-suggestions" hidden></div></div></label><label>${national ? 'Nazionale 2 (opzionale)' : 'Squadra ospite (opzionale)'}<div class="team-autocomplete"><input id="event-team-b" autocomplete="off" placeholder="${national ? 'Francia' : 'Milan'}"><div id="event-team-b-suggestions" class="team-suggestions" hidden></div></div></label><div class="event-selection-summary">${national ? `🌍 ${U.esc(competition)} · ${U.esc(category)}` : `${country.flag} ${U.esc(country.name)} · ${U.esc(competition)} · ${U.esc(category)}`}</div>${!national ? '<small id="event-team-source" class="muted">Caricamento squadre aggiornate…</small>' : ''}<button type="button" class="primary event-use" id="event-use">Usa questo evento</button></div>`;
    const inputA = d.querySelector('#event-team-a'),
      inputB = d.querySelector('#event-team-b'),
      renderA = bindTeamAutocomplete(inputA, d.querySelector('#event-team-a-suggestions'), () => teamOptions),
      renderB = bindTeamAutocomplete(inputB, d.querySelector('#event-team-b-suggestions'), () => teamOptions);
    d.querySelector('#event-use').textContent = national ? 'Usa evento / competizione' : 'Usa campionato / evento';
    d.querySelector('#event-use').onclick = () => {
      const a = inputA.value.trim(),
        bb = inputB.value.trim();
      if ((a && !bb) || (!a && bb))
        return (d.querySelector('#event-panel-error').textContent =
          'Inserisci entrambe le squadre oppure lasciale entrambe vuote.');
      const suffix = national
          ? `${competition} · Nazionali ${category}`
          : `${country.flag} ${competition} · ${category}`,
        event = a && bb ? `${a} – ${bb} · ${suffix}` : suffix;
      eventTarget.querySelector('.event').value = event;
      eventTarget.dataset.eventMeta = encodeURIComponent(
        JSON.stringify({
          mode: national ? 'national' : 'club',
          country: country.code,
          countryName: country.name,
          flag: country.flag,
          competition,
          gender: eventState.gender,
          level: eventState.level || eventState.teamLevel || 'senior',
          age: eventState.age || '',
          teamA: a,
          teamB: bb,
          match: a && bb ? `${a} – ${bb}` : '',
        }),
      );
      closeEventPanel();
      preview();
    };
    inputA.focus();
    renderA();
    if (!national) {
      const teams = await onlineTeams(competition, country);
      const src = d.querySelector('#event-team-source');
      if (teams.length) {
        teamOptions = teams;
        renderA();
        renderB();
      }
      if (src)
        src.textContent = teams.length
          ? `${teams.length} squadre caricate online per ${competition}`
          : 'Squadre: inserimento libero (elenco online non disponibile).';
    }
  };
  async function renderDivisions() {
    const country = eventCountry(),
      gender = eventState.gender,
      level = eventState.level;
    eventTitle.textContent = `${country.flag} ${country.name}`;
    eventHelp.textContent =
      level === 'youth'
        ? `Campionati giovanili ${gender === 'women' ? 'femminili' : 'maschili'}${eventState.age ? ' ' + eventState.age : ''}.`
        : `Campionati e divisioni ${gender === 'women' ? 'femminili' : 'maschili'} senior.`;
    eventBack.hidden = false;
    eventBody.innerHTML = '<div class="event-loading">Caricamento campionati aggiornati…</div>';
    const local = fallbackDivisions(country.code, gender, level, eventState.age),
      online = await onlineLeagueRecords(country, gender, level, eventState.age);
    const names = [...new Set([...online.map((x) => x.name), ...local])].sort(
      (a, b) => leagueRank(a) - leagueRank(b) || a.localeCompare(b, 'it'),
    );
    const onlineSet = new Set(online.map((x) => x.name));
    const rows = names
      .map((name) =>
        eventGroupButton(
          `competition:${encodeURIComponent(name)}`,
          name,
          onlineSet.has(name) ? 'Aggiornato online' : 'Catalogo locale / fallback',
        ),
      )
      .join('');
    eventBody.innerHTML = `<div class="event-division-list">${rows || '<p class="muted">Nessun campionato trovato.</p>'}${eventGroupButton('competition:__manual__', 'Altro / scrivi campionato', 'Inserimento manuale')}</div>`;
    bindEventButtons();
  }
  function renderEventStep(step = '') {
    const [type, a] = step.split(':');
    d.querySelector('#event-panel-error').textContent = '';
    if (!step) {
      eventTitle.textContent = 'Tipo di partita';
      eventHelp.textContent = 'Scegli club oppure nazionali.';
      eventBack.hidden = true;
      eventBody.innerHTML = `<div class="event-panel-groups">${eventGroupButton('club', 'Club', 'Campionati senior, divisioni e giovanili')}${eventGroupButton('national', 'Nazionali', 'Maschili e femminili, senior e giovanili')}</div>`;
      return bindEventButtons();
    }
    if (type === 'club') {
      eventState.mode = 'club';
      eventTitle.textContent = 'Calcio di club';
      eventHelp.textContent = 'Scegli maschile o femminile.';
      eventBack.hidden = false;
      eventBody.innerHTML = `<div class="event-panel-groups">${eventGroupButton('gender:men', 'Maschile')}${eventGroupButton('gender:women', 'Femminile')}</div>`;
      return bindEventButtons();
    }
    if (type === 'national') {
      eventState.mode = 'national';
      eventTitle.textContent = 'Nazionali';
      eventHelp.textContent = 'Scegli maschile o femminile.';
      eventBack.hidden = false;
      eventBody.innerHTML = `<div class="event-panel-groups">${eventGroupButton('nationalgender:men', 'Maschile')}${eventGroupButton('nationalgender:women', 'Femminile')}</div>`;
      return bindEventButtons();
    }
    if (type === 'gender') {
      eventState.gender = a;
      eventTitle.textContent = a === 'women' ? 'Club femminili' : 'Club maschili';
      eventHelp.textContent = 'Scegli campionati senior oppure settore giovanile.';
      eventBack.hidden = false;
      eventBody.innerHTML = `<div class="event-panel-groups">${eventGroupButton('clublevel:senior', 'Campionati senior', 'Serie A, B, C e altre divisioni disponibili')}${eventGroupButton('clublevel:youth', 'Campionati giovanili', 'U23, U21, U20, U19, U18, U17…')}</div>`;
      return bindEventButtons();
    }
    if (type === 'clublevel') {
      eventState.teamLevel = a;
      eventState.level = a;
      if (a === 'youth') {
        eventTitle.textContent = `Giovanili ${eventState.gender === 'women' ? 'femminili' : 'maschili'}`;
        eventHelp.textContent = 'Scegli la fascia d’età.';
        eventBack.hidden = false;
        eventBody.innerHTML = `<div class="event-division-list">${YOUTH_AGES.map((age) => eventGroupButton(`clubage:${age}`, age)).join('')}</div>`;
        return bindEventButtons();
      }
      eventTitle.textContent = 'Paese del campionato';
      eventHelp.textContent =
        'Seleziona il paese: al passaggio successivo verranno caricate le divisioni reali disponibili.';
      eventBack.hidden = false;
      eventBody.innerHTML = `<label>Paese<select id="event-country"><option value="">Seleziona…</option>${countryOptions()}</select></label><button type="button" class="primary event-continue" id="event-country-next">Carica divisioni</button>`;
      d.querySelector('#event-country-next').onclick = () => {
        const v = d.querySelector('#event-country').value;
        if (!v) return (d.querySelector('#event-panel-error').textContent = 'Seleziona un paese.');
        eventState.country = v;
        eventPath.push('level:senior');
        renderEventStep('level:senior');
      };
      return;
    }
    if (type === 'clubage') {
      eventState.age = a;
      eventState.level = 'youth';
      eventState.teamLevel = 'youth';
      eventTitle.textContent = 'Paese del campionato';
      eventHelp.textContent = `Seleziona il paese per il calcio ${eventState.gender === 'women' ? 'femminile' : 'maschile'} ${a}.`;
      eventBack.hidden = false;
      eventBody.innerHTML = `<label>Paese<select id="event-country"><option value="">Seleziona…</option>${countryOptions()}</select></label><button type="button" class="primary event-continue" id="event-country-next">Carica campionati</button>`;
      d.querySelector('#event-country-next').onclick = () => {
        const v = d.querySelector('#event-country').value;
        if (!v) return (d.querySelector('#event-panel-error').textContent = 'Seleziona un paese.');
        eventState.country = v;
        eventPath.push('level:youth');
        renderEventStep('level:youth');
      };
      return;
    }
    if (type === 'level') {
      eventState.level = a;
      return renderDivisions();
    }
    if (type === 'competition') {
      if (a === '__manual__') {
        eventTitle.textContent = 'Campionato';
        eventHelp.textContent = 'Scrivi il nome del campionato, divisione o torneo.';
        eventBody.innerHTML =
          '<label>Campionato / divisione<input id="event-manual-comp" maxlength="80" placeholder="Es. Serie D - Girone B"></label><button type="button" class="primary event-continue" id="event-manual-next">Continua</button>';
        d.querySelector('#event-manual-next').onclick = () => {
          const v = d.querySelector('#event-manual-comp').value.trim();
          if (!v) return (d.querySelector('#event-panel-error').textContent = 'Scrivi il campionato.');
          eventState.competition = v;
          renderTeams(false);
        };
        return;
      }
      eventState.competition = decodeURIComponent(a);
      return renderTeams(false);
    }
    if (type === 'nationalgender') {
      eventState.gender = a;
      eventTitle.textContent = a === 'women' ? 'Nazionali femminili' : 'Nazionali maschili';
      eventHelp.textContent = 'Scegli categoria senior oppure giovanile.';
      eventBack.hidden = false;
      eventBody.innerHTML = `<div class="event-panel-groups">${eventGroupButton('nationallevel:senior', 'Nazionali senior', 'Mondiali, Europei, Nations League, qualificazioni…')}${eventGroupButton('nationallevel:youth', 'Nazionali giovanili', 'U23, U21, U20, U19, U18, U17…')}</div>`;
      return bindEventButtons();
    }
    if (type === 'nationallevel') {
      eventState.teamLevel = a;
      if (a === 'youth') {
        eventTitle.textContent = `Nazionali giovanili ${eventState.gender === 'women' ? 'femminili' : 'maschili'}`;
        eventHelp.textContent = 'Scegli la fascia d’età.';
        eventBody.innerHTML = `<div class="event-division-list">${YOUTH_AGES.map((age) => eventGroupButton(`nationalage:${age}`, age)).join('')}</div>`;
        return bindEventButtons();
      }
      eventTitle.textContent = 'Competizione nazionali';
      eventHelp.textContent = 'Scegli il torneo o il tipo di partita.';
      eventBody.innerHTML = `<div class="event-division-list">${NATIONAL_COMPETITIONS[eventState.gender].map((name) => eventGroupButton(`nationalcomp:${encodeURIComponent(name)}`, name)).join('')}${eventGroupButton('nationalcomp:__manual__', 'Altro / scrivi competizione')}</div>`;
      return bindEventButtons();
    }
    if (type === 'nationalage') {
      eventState.age = a;
      eventTitle.textContent = `Nazionali ${eventState.gender === 'women' ? 'femminili' : 'maschili'} ${a}`;
      eventHelp.textContent = 'Scegli la competizione o il tipo di partita.';
      eventBody.innerHTML = `<div class="event-division-list">${youthCompetitionOptions(eventState.gender, a)
        .map((name) => eventGroupButton(`nationalcomp:${encodeURIComponent(name)}`, name))
        .join('')}${eventGroupButton('nationalcomp:__manual__', 'Altro / scrivi competizione')}</div>`;
      return bindEventButtons();
    }
    if (type === 'nationalcomp') {
      if (a === '__manual__') {
        eventTitle.textContent = 'Competizione nazionali';
        eventHelp.textContent = 'Scrivi il nome della competizione.';
        eventBody.innerHTML =
          '<label>Competizione<input id="event-manual-comp" maxlength="80" placeholder="Es. Torneo internazionale U18"></label><button type="button" class="primary event-continue" id="event-manual-next">Continua</button>';
        d.querySelector('#event-manual-next').onclick = () => {
          const v = d.querySelector('#event-manual-comp').value.trim();
          if (!v) return (d.querySelector('#event-panel-error').textContent = 'Scrivi la competizione.');
          eventState.competition = v;
          renderTeams(true);
        };
        return;
      }
      eventState.competition = decodeURIComponent(a);
      return renderTeams(true);
    }
  }
  const openEventPanel = (c) => {
    eventTarget = c;
    eventPath = [];
    eventState = {};
    renderEventStep();
    eventPanel.hidden = false;
  };
  function preview() {
    const legs = [...d.querySelectorAll('.leg')],
      q = legs.reduce((n, c) => n * (c.dataset.legStatus === 'void' ? 1 : Number(c.querySelector('.odds').value)), 1),
      valid = legs.every((c) => Number(c.querySelector('.odds').value) >= 1) && Number.isFinite(q);
    d.querySelector('#preview').innerHTML =
      `<span>${legs.length === 1 ? 'Singola' : legs.length + ' eventi'} · Quota <b>${valid ? q.toFixed(2) : '—'}</b></span><span>Incasso <b>${valid ? U.money(Number(form.elements.stake.value) * q) : '—'}</b></span>`;
    d.querySelector('#date-summary').textContent = U.validDate(form.elements.date.value)
      ? U.date(form.elements.date.value)
      : 'Seleziona data';
    legs.forEach((c, i) => {
      const inp = c.querySelector('.pick');
      c.querySelector('.leg-number').textContent = i + 1;
      c.querySelector('.leg-title').textContent = c.querySelector('.event').value.trim() || 'Nuovo evento';
      c.querySelector('.leg-pick').textContent = inp.value.trim() || 'Partita e pronostico';
      c.querySelector('.pick-trigger-text').textContent = inp.value.trim() || 'Seleziona esito';
      c.querySelector('.leg-quote').textContent =
        Number(c.querySelector('.odds').value) >= 1 ? Number(c.querySelector('.odds').value).toFixed(2) : '—';
      c.querySelector('summary').onclick = (e) => {
        e.preventDefault();
        if (c.open) c.open = false;
        else openLeg(c);
      };
      c.querySelector('.event-trigger').onclick = () => openEventPanel(c);
      const ev = c.querySelector('.event');
      if (!ev.dataset.metaBound) {
        ev.dataset.metaBound = '1';
        ev.addEventListener('input', () => {
          if (document.activeElement === ev) c.dataset.eventMeta = encodeURIComponent('{}');
        });
      }
      c.querySelector('.pick-trigger').onclick = () => openPickPanel(c);
      const star = c.querySelector('[data-favorite]'),
        favorite = db.settings.favorites.includes(inp.value.trim());
      star.textContent = favorite ? '★' : '☆';
      star.setAttribute('aria-pressed', String(favorite));
      star.setAttribute(
        'aria-label',
        favorite ? 'Rimuovi pronostico dai preferiti' : 'Aggiungi pronostico ai preferiti',
      );
      star.title = favorite ? 'Rimuovi dai preferiti' : 'Aggiungi ai preferiti';
      star.onclick = () => {
        const value = inp.value.trim();
        if (!value) {
          U.toast('Seleziona prima un esito da aggiungere ai preferiti.');
          return;
        }
        const wasFavorite = db.settings.favorites.includes(value),
          n = U.clone(db);
        n.settings.favorites = wasFavorite
          ? n.settings.favorites.filter((v) => v !== value)
          : [...n.settings.favorites, value];
        if (commit(n)) {
          U.toast(wasFavorite ? 'Rimosso dai preferiti' : 'Aggiunto ai preferiti');
          if (!panel.hidden) bindPickPanel();
          preview();
        }
      };
      const remove = c.querySelector('[data-remove-leg]');
      remove.hidden = legs.length === 1;
      remove.onclick = () => {
        const next = c.nextElementSibling || c.previousElementSibling;
        c.remove();
        if (next) openLeg(next);
        preview();
      };
    });
  }
  const invalidLeg = () =>
    [...d.querySelectorAll('.leg')].find(
      (c) =>
        !c.querySelector('.event').value.trim() ||
        !c.querySelector('.pick').value.trim() ||
        !c.querySelector('.odds').checkValidity() ||
        !c.querySelector('.odds').value.trim(),
    );
  form.addEventListener(
    'invalid',
    (e) => {
      const c = e.target.closest('.leg');
      if (c) openLeg(c);
      else if (e.target.name === 'date') d.querySelector('.bet-date').open = true;
    },
    true,
  );
  d.querySelector('[data-close-event-panel]').onclick = closeEventPanel;
  eventBack.onclick = () => {
    eventPath.pop();
    const prev = eventPath[eventPath.length - 1] || '';
    if (!prev) {
      renderEventStep('');
      return;
    }
    if (prev.startsWith('competition:') || prev.startsWith('nationalcomp:')) {
      eventPath.pop();
      renderEventStep(eventPath[eventPath.length - 1] || '');
      return;
    }
    renderEventStep(prev);
  };
  d.querySelector('[data-close-pick-panel]').onclick = closePickPanel;
  back.onclick = () => {
    pickPath.pop();
    bindPickPanel(pickPath[pickPath.length - 1] || '');
  };
  d.querySelector('#pick-confirm').onclick = () => {
    const value = custom.value.trim();
    if (!value)
      return (d.querySelector('#pick-panel-error').textContent = 'Scrivi un esito oppure scegli una categoria.');
    choosePick(value);
  };
  custom.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      d.querySelector('#pick-confirm').click();
    }
  };
  d.querySelector('.bet-save-icon').onclick = () => {
    if (!form.elements.stake.value.trim()) {
      form.elements.stake.value = '10.00';
      preview();
    }
  };
  d.querySelector('#add-leg').onclick = () => {
    const invalid = invalidLeg();
    if (invalid) {
      openLeg(invalid);
      d.querySelector('#form-error').textContent =
        'Completa partita, esito e quota prima di aggiungere un altro evento.';
      const target = !invalid.querySelector('.event').value.trim()
        ? invalid.querySelector('.event')
        : !invalid.querySelector('.pick').value.trim()
          ? invalid.querySelector('.pick-trigger')
          : invalid.querySelector('.odds');
      target.focus();
      return;
    }
    const holder = d.querySelector('#legs');
    holder.insertAdjacentHTML('beforeend', legHTML({}, holder.children.length));
    const added = holder.lastElementChild;
    openLeg(added);
    preview();
    added.querySelector('.event').focus();
  };
  form.oninput = (e) => {
    e.target.setCustomValidity?.('');
    d.querySelector('#form-error').textContent = '';
    preview();
  };
  form.onchange = preview;
  preview();
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!form.elements.stake.value.trim()) form.elements.stake.value = '10.00';
    if (!panel.hidden) closePickPanel();
    if (!eventPanel.hidden) closeEventPanel();
    const invalid = invalidLeg();
    if (invalid) {
      openLeg(invalid);
      d.querySelector('#form-error').textContent = 'Completa partita, esito e quota.';
      const target = !invalid.querySelector('.event').value.trim()
        ? invalid.querySelector('.event')
        : !invalid.querySelector('.pick').value.trim()
          ? invalid.querySelector('.pick-trigger')
          : invalid.querySelector('.odds');
      target.focus();
      return;
    }
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const f = new FormData(form),
      legs = [...d.querySelectorAll('.leg')].map((c) => ({
        event: c.querySelector('.event').value.trim(),
        pick: c.querySelector('.pick').value.trim(),
        odds: Number(c.querySelector('.odds').value),
        status: c.dataset.legStatus,
        meta: (() => {
          try {
            return JSON.parse(decodeURIComponent(c.dataset.eventMeta || '%7B%7D'));
          } catch {
            return {};
          }
        })(),
      })),
      obj = {
        ...(b || { id: U.uid(), status: 'pending' }),
        account: db.accounts[0].id,
        stake: Number(f.get('stake')),
        date: new Date(f.get('date')).toISOString(),
        legs,
      };
    const err = d.querySelector('#form-error');
    if (legs.some((l) => !l.event || !l.pick) || !Number.isFinite(obj.stake * odds(obj)))
      return (err.textContent = 'Controlla tutti i campi.');
    const available = balance() + (b ? b.stake - payout(b) : 0);
    if (obj.status === 'pending' && obj.stake > available)
      return (err.textContent = 'Saldo insufficiente. Registra un deposito in Altro.');
    const n = U.clone(db);
    n.bets = b ? n.bets.map((x) => (x.id === b.id ? obj : x)) : [...n.bets, obj];
    n.settings.recent = [...new Set([...legs.map((l) => l.pick), ...n.settings.recent])].slice(0, 12);
    if (commit(n)) {
      d.close();
      U.toast('Scommessa salvata');
    }
  };
}
function derivedStatus(legs) {
  if (legs.some((l) => l.status === 'lost')) return 'lost';
  if (legs.every((l) => l.status === 'void')) return 'void';
  if (legs.every((l) => l.status === 'won' || l.status === 'void')) return 'won';
  return 'pending';
}
function settleForm(b) {
  const d = sheetModal(
    sheetHead('Esito scommessa', { form: 'settle-form', sub: U.esc(kpiLabel(b)) + ' · ' + U.money(b.stake) }) +
      `<form id="settle-form" class="sheet-form"><h3 class="sheet-section">Esiti dei singoli eventi</h3><div class="sheet-group">${b.legs.map((l, i) => `<label class="sheet-field"><span>${U.esc(l.event)} · <b>${U.esc(l.pick)}</b> <em>@ ${Number(l.odds).toFixed(2)}</em></span><select data-leg-outcome="${i}">${['pending', 'won', 'lost', 'void'].map((v) => `<option value="${v}" ${l.status === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label>`).join('')}</div><h3 class="sheet-section">Esito complessivo</h3><div class="sheet-group"><label class="sheet-field"><span>Esito</span><select name="status"><option value="auto">Automatico dagli eventi</option>${Object.entries(
        labels,
      )
        .map(([v, l]) => `<option value="${v}" ${b.status === v ? 'selected' : ''}>${l}</option>`)
        .join(
          '',
        )}</select></label><p id="estimated" class="sheet-calc"></p><label class="sheet-field"><span>Data e ora dell’esito</span><input name="settled" type="datetime-local" value="${U.local(new Date(b.settledAt || Date.now()))}"></label><label class="sheet-field"><span>Incasso effettivo (€) · vuoto = calcolato</span><input name="actual" type="number" min="0" step="0.01" inputmode="decimal" value="${b.actualPayout ?? (b.status === 'cashout' ? b.cashout : '')}"></label></div><p class="sheet-note">Comprende la puntata restituita. Gli eventi annullati hanno quota effettiva 1, senza perdere la quota originale.</p><p class="error" id="error"></p></form>`,
  );
  const form = d.querySelector('form');
  const read = () => {
    const legs = b.legs.map((l, i) => ({ ...l, status: d.querySelector(`[data-leg-outcome="${i}"]`).value }));
    return {
      ...b,
      legs,
      status: form.elements.status.value === 'auto' ? derivedStatus(legs) : form.elements.status.value,
      actualPayout: null,
    };
  };
  const preview = () => {
    const n = read();
    d.querySelector('#estimated').textContent =
      `${labels[n.status]} · Quota effettiva ${odds(n).toFixed(2)} · Incasso calcolato ${U.money(payout(n))}`;
    form.elements.actual.disabled = ['pending', 'lost'].includes(n.status);
    form.elements.settled.disabled = n.status === 'pending';
    form.elements.settled.required = n.status !== 'pending';
  };
  d.querySelectorAll('[data-leg-outcome]').forEach(
    (el) =>
      (el.onchange = () => {
        form.elements.status.value = 'auto';
        form.elements.actual.value = '';
        preview();
      }),
  );
  form.elements.status.onchange = preview;
  preview();
  form.onsubmit = (e) => {
    e.preventDefault();
    const n = read(),
      val = form.elements.actual.value;
    n.actualPayout = ['pending', 'lost'].includes(n.status) ? null : val === '' ? null : U.round(Number(val));
    if (n.status === 'cashout' && n.actualPayout == null)
      return (d.querySelector('#error').textContent = 'Indica l’importo del cash out.');
    if (n.status === 'cashout') n.cashout = n.actualPayout;
    n.settledAt = n.status === 'pending' ? null : new Date(form.elements.settled.value).toISOString();
    if (n.status === 'won') n.legs = n.legs.map((l) => (l.status === 'void' ? l : { ...l, status: 'won' }));
    if (n.status === 'void') n.legs = n.legs.map((l) => ({ ...l, status: 'void' }));
    if (n.settledAt && new Date(n.settledAt) < new Date(n.date))
      return (d.querySelector('#error').textContent = 'L’esito non può precedere la giocata.');
    if (mutate((data) => (data.bets = data.bets.map((x) => (x.id === b.id ? n : x))))) {
      d.close();
      undoBet(b, n);
    }
  };
}
function transactionForm(sign, t, day) {
  return moneySheet(sign < 0 ? 'withdraw' : 'deposit', { t: t || null, date: day });
}
function initialForm() {
  const d = sheetModal(
    sheetHead('Saldo iniziale', { form: 'initial-form', sub: 'Il punto di partenza dei conti' }) +
      `<form id="initial-form" class="sheet-form"><div class="sheet-group sheet-amount"><label class="sheet-field"><span>Saldo iniziale (€)</span><input name="initial" type="number" min="0" step="0.01" inputmode="decimal" required value="${db.accounts[0].initial}"></label></div><div class="sheet-group"><label class="sheet-field"><span>Da quale giorno</span><input name="from" type="date" max="${dToday()}" value="${startDate() || (diarySeries()[0] ? dAdd(diarySeries()[0].date, -1) : dToday())}"></label></div><p class="sheet-note">È il saldo che avevi a fine di quel giorno, prima di segnare i giorni successivi. Depositi e prelievi fatti prima di quella data sono già compresi. Per nuovi versamenti usa Deposito.</p></form>`,
  );
  d.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      from = String(f.get('from') || '');
    if (
      mutate((n) => {
        n.accounts[0].initial = U.round(Number(f.get('initial')));
        if (/^\d{4}-\d{2}-\d{2}$/.test(from)) n.settings.initialDate = from;
        else delete n.settings.initialDate;
      })
    )
      d.close();
  };
}
function exportData() {
  const n = U.clone(db);
  n.settings.lastExport = new Date().toISOString();
  U.download('bet-tracker-backup-' + U.local().slice(0, 10) + '.json', n);
  if (!storageError) commit(n);
}
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (!validDB(raw)) throw Error();
    const n = normalize(raw),
      d = sheetModal(
        sheetHead('Ripristina backup') +
          `<div class="sheet-tiles"><div><small>Scommesse</small><b>${n.bets.length}</b></div><div><small>Movimenti</small><b>${n.transactions.length}</b></div></div><div class="sheet-box"><p>Il backup sostituirà i dati attuali. Puoi esportarli prima di proseguire.</p></div><div class="sheet-actions-row"><button type="button" class="sheet-wide" id="before-export">Esporta dati attuali</button><button type="button" class="sheet-wide primary" id="confirm-import">Ripristina</button></div>`,
      );
    d.querySelector('#before-export').onclick = exportData;
    d.querySelector('#confirm-import').onclick = () => {
      if (commit(n, { restore: true })) {
        d.close();
        U.toast('Backup ripristinato');
      }
    };
  } catch (err) {
    U.toast('Backup non valido. Nessun dato modificato.');
  } finally {
    e.target.value = '';
  }
}
// 3.0.0 — niente più inserimento scommesse

// 1.1.8 — navigazione bidirezionale con transizione coerente con il verso dello swipe.
const TAB_ORDER = ['tips', 'live', 'stats', 'home', 'accounts']; /* 4.8.0 — Statistiche prima di Saldo */
let swipeStart = null,
  tabTransitioning = false;
function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function setTab(next, { animate = false, direction = 0 } = {}) {
  if (!TAB_ORDER.includes(next) || next === tab || tabTransitioning) return;
  const finish = () => {
    tab = next;
    render();
    window.scrollTo(0, 0);
  };
  if (!animate || !direction || prefersReducedMotion()) {
    finish();
    return;
  }
  tabTransitioning = true;
  main.classList.remove('tab-exit-left', 'tab-exit-right', 'tab-enter-left', 'tab-enter-right');
  main.classList.add(direction > 0 ? 'tab-exit-left' : 'tab-exit-right');
  setTimeout(() => {
    finish();
    main.classList.remove('tab-exit-left', 'tab-exit-right');
    main.classList.add(direction > 0 ? 'tab-enter-right' : 'tab-enter-left');
    setTimeout(() => {
      main.classList.remove('tab-enter-left', 'tab-enter-right');
      tabTransitioning = false;
    }, 210);
  }, 135);
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

function swipeNavigationBlocked(target) {
  return !!target?.closest?.(
    'button,input,select,textarea,a,label,[contenteditable="true"],dialog,.pick-panel-layer,.pick-panel-card,.touch-chart,.pick-grid',
  );
}
function overlayOpen() {
  return !!document.querySelector('dialog[open],.pick-panel-layer:not([hidden])');
}
main.addEventListener(
  'touchstart',
  (e) => {
    if (tabTransitioning || e.touches.length !== 1 || overlayOpen() || swipeNavigationBlocked(e.target)) {
      swipeStart = null;
      return;
    }
    const t = e.touches[0];
    swipeStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  },
  { passive: true },
);
main.addEventListener(
  'touchend',
  (e) => {
    if (!swipeStart || tabTransitioning || e.changedTouches.length !== 1) {
      swipeStart = null;
      return;
    }
    const t = e.changedTouches[0],
      dx = t.clientX - swipeStart.x,
      dy = t.clientY - swipeStart.y,
      elapsed = Date.now() - swipeStart.time;
    swipeStart = null;
    const horizontal =
      Math.abs(dx) >= 70 && Math.abs(dx) >= Math.abs(dy) * 1.35 && Math.abs(dy) <= 100 && elapsed <= 900;
    if (!horizontal || overlayOpen()) return;
    const index = TAB_ORDER.indexOf(tab),
      direction = dx < 0 ? 1 : -1,
      next = TAB_ORDER[index + direction];
    if (!next) return;
    setTab(next, { animate: true, direction });
  },
  { passive: true },
);
main.addEventListener(
  'touchcancel',
  () => {
    swipeStart = null;
  },
  { passive: true },
);

/* =====================================================================
   2.0.0 — HOME: diario del saldo
   Ogni giorno segni il saldo che hai; la pagina mostra saldo attuale,
   andamento, variazioni giornaliere, statistiche e agenda del mese.

   Regole di sincronia con il resto dell'app:
   - Il saldo attuale è sempre balance(): saldo iniziale + movimenti + scommesse.
     Quindi una scommessa registrata cambia subito il saldo mostrato qui.
   - Quando segni il saldo del giorno più recente del diario (di solito oggi),
     l'app crea/aggiorna un "Allineamento saldo" (movimento con kind:'adjust')
     pari alla differenza: il saldo di Riepilogo e Altro diventa quel valore.
     Le scommesse non vengono toccate.
   - I giorni passati (con giorni più recenti già segnati) servono solo per lo
     storico e i grafici: non cambiano il saldo attuale.
   NB: qui si usa var (non let/const) per lo stato del modulo, perché render()
   viene chiamata all'avvio prima che questa parte del file sia eseguita.
   ===================================================================== */
var diaryUI = { range: 'all', month: null }; /* 4.23.0 — Andamento di base su Tutto */
var DIARY_RANGES = [
  ['7', '7G'],
  ['30', '30G'],
  ['90', '90G'],
  ['365', '1A'],
  ['all', 'Tutto'],
];

function dToday() {
  return U.local().slice(0, 10);
}
function dParse(iso) {
  return new Date(iso + 'T12:00:00');
}
function dAdd(iso, days) {
  var d = dParse(iso);
  d.setDate(d.getDate() + days);
  return U.local(d).slice(0, 10);
}
function dDays(a, b) {
  return Math.round((dParse(b) - dParse(a)) / 86400000);
}
function dLabel(iso, opts) {
  return dParse(iso).toLocaleDateString('it-IT', opts || { weekday: 'short', day: 'numeric', month: 'short' });
}
function dShort(iso) {
  return dParse(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
}
function sMoney(n) {
  var v = U.round(n);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + U.money(Math.abs(v));
}
function sClass(n) {
  return n > 0.004 ? 'positive' : n < -0.004 ? 'negative' : 'neutral';
}
function eurShort(n) {
  var a = Math.abs(n),
    s = n < 0 ? '−' : '';
  if (a >= 10000) return s + Math.round(a / 1000) + 'k';
  if (a >= 1000) return s + (a / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + 'k';
  if (a > 0 && a < 10) return s + a.toLocaleString('it-IT', { maximumFractionDigits: 1 });
  return s + Math.round(a).toLocaleString('it-IT');
}

/* Diario ordinato con variazione rispetto alla registrazione precedente */
function diarySeries(d) {
  var list = ((d || db).diary || []).slice().sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
  /* 2.6.2 — Depositi e prelievi non sono vincite o perdite: la variazione di un giorno è
     (saldo di oggi − saldo precedente) − (depositi − prelievi fatti nel frattempo).
     "perf" è il saldo depurato da tutti i versamenti fino a quel giorno: le differenze
     di perf sono il vero guadagno o la vera perdita. */
  var src = d || db,
    s0 = startDate(src);
  var flows = realFlows(src)
    .map(function (t) {
      return { day: dayKey(t.date), amount: t.amount };
    })
    .filter(function (f) {
      return !s0 || f.day >= s0;
    });
  var flowsUpTo = function (date) {
    return flows.reduce(function (n, f) {
      return f.day <= date ? n + f.amount : n;
    }, 0);
  };
  var out = list.map(function (e) {
    var cum = U.round(flowsUpTo(e.date));
    return Object.assign({}, e, { flows: cum, perf: U.round(e.balance - cum) });
  });
  // Con un saldo iniziale il primo giorno segnato ha già una variazione: rispetto al saldo iniziale.
  var start = null;
  if (out.length && hasStart(src)) {
    var ini = U.round(src.accounts[0].initial);
    start = { date: s0 || dAdd(out[0].date, -1), balance: ini, perf: ini, flows: 0, start: true };
  }
  var res = out.map(function (e, i) {
    var prev = i ? out[i - 1] : start;
    return Object.assign(e, {
      delta: prev ? U.round(e.perf - prev.perf) : null,
      moved: prev ? U.round(e.flows - prev.flows) : 0,
      prev: prev,
    });
  });
  res.start = start;
  return res;
}
function diaryLatest() {
  var s = diarySeries();
  return s[s.length - 1] || null;
}
function diaryOn(date) {
  return (
    (db.diary || []).find(function (e) {
      return e.date === date;
    }) || null
  );
}
function diaryIsLatest(date) {
  return !(db.diary || []).some(function (e) {
    return e.date > date;
  });
}

/* Variazione su una finestra: ultimo valore − valore all'inizio della finestra */
function diaryChange(series, days) {
  if (!series.length) return null;
  var last = series[series.length - 1];
  var first = series.start || series[0];
  if (days === 'all') return first === last ? null : { value: U.round(last.perf - first.perf), from: first };
  var start = dAdd(dToday(), -Number(days));
  var base = null;
  for (var i = series.length - 1; i >= 0; i--) {
    if (series[i].date <= start) {
      base = series[i];
      break;
    }
  }
  if (!base) base = series.start || series[0];
  if (base === last) return null;
  return { value: U.round(last.perf - base.perf), from: base };
}

/* Statistiche sul periodo scelto */
function diaryStats(points) {
  if (!points.length) return null;
  var max = points[0],
    min = points[0],
    peak = points[0],
    dd = 0,
    up = 0,
    down = 0,
    sum = 0,
    n = 0;
  points.forEach(function (p) {
    if (p.balance > max.balance) max = p;
    if (p.balance < min.balance) min = p;
    if (p.perf > peak.perf) peak = p;
    dd = Math.min(dd, p.perf - peak.perf);
    if (p.delta != null) {
      n++;
      sum += p.delta;
      if (p.delta > 0.004) up++;
      else if (p.delta < -0.004) down++;
    }
  });
  var last = points[points.length - 1],
    streak = 0,
    sign = 0;
  for (var i = points.length - 1; i >= 0; i--) {
    var dl = points[i].delta;
    if (dl == null) break;
    var sg = dl > 0.004 ? 1 : dl < -0.004 ? -1 : 0;
    if (!sg) break;
    if (!sign) sign = sg;
    if (sg !== sign) break;
    streak++;
  }
  var allMax = points.reduce(function (m, p) {
    return p.perf > m.perf ? p : m;
  }, points[0]);
  return {
    max: max,
    min: min,
    fromPeak: U.round(last.perf - allMax.perf),
    peak: allMax,
    maxDD: U.round(dd),
    up: up,
    down: down,
    avg: n ? U.round(sum / n) : null,
    streak: streak,
    sign: sign,
    count: points.length,
  };
}

function diaryRangePoints(series) {
  if (diaryUI.range === 'all') return series;
  var start = dAdd(dToday(), -Number(diaryUI.range));
  return series.filter(function (p) {
    return p.date >= start;
  });
}

/* ---------- Grafico: andamento del saldo (linea + area) ---------- */
function diaryLineChart(points, live) {
  if (!points.length)
    return '<div class="diary-empty-chart">Nessun giorno segnato.</div>';
  var W = 360,
    H = 190,
    L = 40,
    R = 12,
    T = 14,
    B = 26;
  var all = points.map(function (p) {
    return { date: p.date, v: p.balance, p: p };
  });
  if (live) all.push({ date: live.date, v: live.value, live: true });
  var vals = all.map(function (a) {
    return a.v;
  });
  var lo = Math.min.apply(null, vals),
    hi = Math.max.apply(null, vals);
  if (hi - lo < 1) {
    hi += 1;
    lo -= 1;
  }
  var pad = (hi - lo) * 0.12;
  hi += pad;
  lo -= pad;
  var d0 = all[0].date,
    d1 = all[all.length - 1].date,
    span = Math.max(1, dDays(d0, d1));
  var x = function (date) {
    return all.length === 1 ? (L + W - R) / 2 : L + ((W - L - R) * dDays(d0, date)) / span;
  };
  var y = function (v) {
    return T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  };
  var grid = [hi, (hi + lo) / 2, lo]
    .map(function (v) {
      return (
        '<line class="dc-grid" x1="' +
        L +
        '" x2="' +
        (W - R) +
        '" y1="' +
        y(v).toFixed(1) +
        '" y2="' +
        y(v).toFixed(1) +
        '"/><text class="dc-axis" x="' +
        (L - 6) +
        '" y="' +
        (y(v) + 4).toFixed(1) +
        '" text-anchor="end">' +
        eurShort(v) +
        '</text>'
      );
    })
    .join('');
  var real = all.filter(function (a) {
    return !a.live;
  });
  var line = real
    .map(function (a, i) {
      return (i ? 'L' : 'M') + x(a.date).toFixed(1) + ' ' + y(a.v).toFixed(1);
    })
    .join(' ');
  var area =
    real.length > 1
      ? line +
        ' L' +
        x(real[real.length - 1].date).toFixed(1) +
        ' ' +
        (H - B) +
        ' L' +
        x(real[0].date).toFixed(1) +
        ' ' +
        (H - B) +
        ' Z'
      : '';
  var liveSeg = '';
  if (live && real.length) {
    var lr = real[real.length - 1];
    liveSeg =
      '<path class="dc-live" d="M' +
      x(lr.date).toFixed(1) +
      ' ' +
      y(lr.v).toFixed(1) +
      ' L' +
      x(live.date).toFixed(1) +
      ' ' +
      y(live.value).toFixed(1) +
      '"/>';
  }
  var dots =
    all.length <= 45
      ? all
          .map(function (a) {
            return (
              '<circle class="' +
              (a.live ? 'dc-dot-live' : 'dc-dot') +
              '" cx="' +
              x(a.date).toFixed(1) +
              '" cy="' +
              y(a.v).toFixed(1) +
              '" r="4"/>'
            );
          })
          .join('')
      : '';
  var lastPt = all[all.length - 1];
  var endLabel =
    '<text class="dc-end" x="' +
    Math.min(x(lastPt.date), W - R).toFixed(1) +
    '" y="' +
    Math.max(12, y(lastPt.v) - 9).toFixed(1) +
    '" text-anchor="end">' +
    U.esc(U.money(lastPt.v)) +
    '</text>';
  var mid = all.length > 2 ? all[Math.floor(all.length / 2)].date : null;
  var xl =
    '<text class="dc-axis" x="' +
    L +
    '" y="' +
    (H - 6) +
    '">' +
    dShort(d0) +
    '</text>' +
    (mid && mid !== d0 && mid !== d1
      ? '<text class="dc-axis" x="' +
        x(mid).toFixed(1) +
        '" y="' +
        (H - 6) +
        '" text-anchor="middle">' +
        dShort(mid) +
        '</text>'
      : '') +
    (d1 !== d0
      ? '<text class="dc-axis" x="' +
        (W - R) +
        '" y="' +
        (H - 6) +
        '" text-anchor="end">' +
        (lastPt.live ? 'adesso' : dShort(d1)) +
        '</text>'
      : '');
  // zone di tocco: una colonna per punto
  var hits = all
    .map(function (a, i) {
      var prevX = i ? (x(all[i - 1].date) + x(a.date)) / 2 : L,
        nextX = i < all.length - 1 ? (x(a.date) + x(all[i + 1].date)) / 2 : W - R;
      return (
        '<rect class="dc-hit" data-dc-i="' +
        i +
        '" x="' +
        prevX.toFixed(1) +
        '" y="0" width="' +
        Math.max(2, nextX - prevX).toFixed(1) +
        '" height="' +
        H +
        '"/>'
      );
    })
    .join('');
  diaryUI.lineData = all.map(function (a) {
    var txt;
    if (a.live) txt = 'Adesso · ' + U.money(a.v) + ' · non ancora segnato (include scommesse e movimenti)';
    else
      txt =
        dLabel(a.date) +
        ' · ' +
        U.money(a.v) +
        (a.p.delta != null
          ? ' · ' + sMoney(a.p.delta) + ' rispetto al ' + dShort(a.p.prev.date)
          : ' · prima registrazione') +
        (a.p.note ? ' · ' + a.p.note : '');
    return { x: x(a.date), y: y(a.v), text: txt };
  });
  return (
    '<svg class="diary-chart dc-line" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="Andamento del saldo dal ' +
    dShort(d0) +
    ' a ' +
    (lastPt.live ? 'adesso' : dShort(d1)) +
    '">' +
    '<defs><linearGradient id="dcArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--bt-line-color)" stop-opacity=".28"/><stop offset="1" stop-color="var(--bt-line-color)" stop-opacity="0"/></linearGradient></defs>' +
    grid +
    (area ? '<path class="dc-area" d="' + area + '"/>' : '') +
    '<path class="dc-path" d="' +
    line +
    '"/>' +
    liveSeg +
    dots +
    endLabel +
    xl +
    '<g class="dc-cross" hidden><line class="dc-cross-line" x1="0" x2="0" y1="' +
    T +
    '" y2="' +
    (H - B) +
    '"/><circle class="dc-cross-dot" r="6"/></g>' +
    hits +
    '</svg>' +
    '<p class="diary-chart-detail" data-dc-detail="line" aria-live="polite"></p>'
  );
}

/* ---------- Grafico: variazioni giornaliere (barre su/giù) ---------- */
function diaryBarChart(points) {
  var bars = points.filter(function (p) {
    return p.delta != null;
  });
  if (!bars.length) return '<div class="diary-empty-chart">Servono almeno due giorni segnati.</div>';
  var W = 360,
    H = 150,
    L = 40,
    R = 12,
    T = 10,
    B = 22;
  var m = Math.max.apply(
    null,
    bars
      .map(function (b) {
        return Math.abs(b.delta);
      })
      .concat([1]),
  );
  var zero = T + (H - T - B) / 2;
  var y = function (v) {
    return zero - ((H - T - B) / 2) * (v / m);
  };
  var slot = (W - L - R) / bars.length,
    bw = Math.max(2, Math.min(22, slot - 2));
  var rects = bars
    .map(function (b, i) {
      var cx = L + slot * i + slot / 2,
        top = Math.min(y(b.delta), zero),
        h = Math.max(1.5, Math.abs(y(b.delta) - zero));
      var cls = b.delta > 0.004 ? 'db-up' : b.delta < -0.004 ? 'db-down' : 'db-flat';
      return (
        '<rect class="' +
        cls +
        '" x="' +
        (cx - bw / 2).toFixed(1) +
        '" y="' +
        top.toFixed(1) +
        '" width="' +
        bw.toFixed(1) +
        '" height="' +
        h.toFixed(1) +
        '" rx="' +
        Math.min(4, bw / 2).toFixed(1) +
        '"/>' +
        '<rect class="dc-hit" data-db-i="' +
        i +
        '" x="' +
        (L + slot * i).toFixed(1) +
        '" y="0" width="' +
        slot.toFixed(1) +
        '" height="' +
        H +
        '"/>'
      );
    })
    .join('');
  diaryUI.barData = bars.map(function (b) {
    return (
      dLabel(b.date) +
      ' · ' +
      sMoney(b.delta) +
      ' rispetto al ' +
      dShort(b.prev.date) +
      ' · saldo ' +
      U.money(b.balance)
    );
  });
  var axis =
    '<line class="dc-zero" x1="' +
    L +
    '" x2="' +
    (W - R) +
    '" y1="' +
    zero +
    '" y2="' +
    zero +
    '"/>' +
    '<text class="dc-axis" x="' +
    (L - 6) +
    '" y="' +
    (y(m) + 4).toFixed(1) +
    '" text-anchor="end">+' +
    eurShort(m) +
    '</text>' +
    '<text class="dc-axis" x="' +
    (L - 6) +
    '" y="' +
    (zero + 4) +
    '" text-anchor="end">0</text>' +
    '<text class="dc-axis" x="' +
    (L - 6) +
    '" y="' +
    (y(-m) + 4).toFixed(1) +
    '" text-anchor="end">−' +
    eurShort(m) +
    '</text>' +
    '<text class="dc-axis" x="' +
    L +
    '" y="' +
    (H - 5) +
    '">' +
    dShort(bars[0].date) +
    '</text>' +
    (bars.length > 1
      ? '<text class="dc-axis" x="' +
        (W - R) +
        '" y="' +
        (H - 5) +
        '" text-anchor="end">' +
        dShort(bars[bars.length - 1].date) +
        '</text>'
      : '');
  return (
    '<svg class="diary-chart dc-bars" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="Variazioni del saldo tra un giorno segnato e il precedente">' +
    axis +
    rects +
    '</svg>' +
    '<p class="diary-chart-detail" data-dc-detail="bar" aria-live="polite"></p>'
  );
}

/* ---------- 4.23.0 — ANDAMENTO RIFATTO ----------
   1) ANDAMENTO (in cima, di base "Risultato netto"): quanto hai vinto o perso dal primo giorno, senza depositi e prelievi,
      lo stesso numero di "Vinto in totale" nel Saldo. Sopra il grafico la lettura: valore, giorno e quanto è cambiato.
      Tocca o TRASCINA il dito sul grafico: la lettura segue il dito giorno per giorno (verde sopra lo zero, rosso sotto).
      Segnati il massimo e il minimo del periodo. "Saldo" mostra il saldo segnato (sale anche con i depositi).
   2) RISULTATO GIORNO PER GIORNO (seconda): barre per giorno, settimana o mese. "Auto" sceglie da solo: fino a 45 barre i
      giorni, poi le settimane, oltre le 30 settimane i mesi: con tanti giorni resta leggibile. Toccando (o trascinando)
      una barra la lettura in alto dice subito periodo, risultato e il resto (saldo, giorni ▲/▼, migliore e peggiore). */
var DIARY_BAR_UNITS = [['', 'Auto'], ['d', 'Giorni'], ['w', 'Settimane'], ['m', 'Mesi']];
function anVal(p, mode, ini) { return mode === 'saldo' ? p.balance : U.round(p.perf - ini); }
function anSpanLabel(points) {
  if (diaryUI.range === 'all') return points.length ? 'dal ' + dShort(points[0].date) : '';
  var r = DIARY_RANGES.find(function (x) { return x[0] === diaryUI.range; });
  return r ? ({ '7': 'in 7 giorni', '30': 'in 30 giorni', '90': 'in 90 giorni', '365': 'in un anno' })[r[0]] || '' : '';
}
function anReadHtml(main, mainCls, title, side, sideCls, sideLab, sel) {
  return '<div class="an-read' + (sel ? ' sel' : '') + '"' + (sel ? ' data-an-clear role="button" tabindex="0" aria-label="Torna al riepilogo"' : '') + '><div class="an-rl"><b class="' + (mainCls || '') + '">' + main + '</b><small>' + title + '</small></div>' +
    (side != null ? '<div class="an-rr"><b class="' + (sideCls || '') + '">' + side + '</b><small>' + sideLab + '</small></div>' : '') + '</div>';
}
function diaryNetChart(points, series) {
  var mode = diaryUI.chartMode === 'saldo' ? 'saldo' : 'risultato', ini = U.round((db.accounts[0] || {}).initial || 0);
  var pts = points.slice();
  if (mode === 'risultato' && diaryUI.range === 'all' && series.start) pts.unshift(series.start);
  if (!pts.length) return '<div class="diary-empty-chart">Nessun giorno segnato.</div>';
  var vals = pts.map(function (p) { return anVal(p, mode, ini); });
  var W = 360, H = 200, L = 8, R = 48, T = 14, B = 24;
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (mode === 'risultato') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  var pad = (hi - lo) * 0.1; hi += pad; lo -= mode === 'risultato' && lo >= 0 ? 0 : pad;
  var d0 = pts[0].date, d1 = pts[pts.length - 1].date, span = Math.max(1, dDays(d0, d1));
  var X = function (date) { return pts.length === 1 ? (L + W - R) / 2 : L + (W - L - R) * dDays(d0, date) / span; };
  var Y = function (v) { return T + (H - T - B) * (1 - (v - lo) / (hi - lo)); };
  var xs = pts.map(function (p) { return Math.round(X(p.date) * 10) / 10; }), ys = vals.map(function (v) { return Math.round(Y(v) * 10) / 10; });
  var line = xs.map(function (x, i) { return (i ? 'L' : 'M') + x + ' ' + ys[i]; }).join(' ');
  var y0 = mode === 'risultato' ? Math.round(Y(0) * 10) / 10 : H - B;
  var area = pts.length > 1 ? line + ' L' + xs[xs.length - 1] + ' ' + y0 + ' L' + xs[0] + ' ' + y0 + ' Z' : '';
  var ticks = [hi - pad, (hi + lo) / 2, lo + (mode === 'risultato' && lo >= 0 ? 0 : pad)];
  if (mode === 'risultato') ticks = [Math.max.apply(null, vals), 0, Math.min.apply(null, vals)].filter(function (v, i, a) { return a.indexOf(v) === i; });
  var grid = ticks.map(function (v) {
    var y = Y(v).toFixed(1);
    return '<line class="an-grid' + (mode === 'risultato' && v === 0 ? ' zero' : '') + '" x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '"/><text class="an-ax" x="' + (W - R + 6) + '" y="' + (Number(y) + 4) + '">' + (mode === 'risultato' && v > 0 ? '+' : '') + eurShort(v) + '</text>';
  }).join('');
  var mid = pts.length > 2 ? pts[Math.floor(pts.length / 2)].date : null;
  var xl = '<text class="an-ax" x="' + L + '" y="' + (H - 6) + '">' + dShort(d0) + '</text>' +
    (mid && mid !== d0 && mid !== d1 ? '<text class="an-ax" x="' + X(mid).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + dShort(mid) + '</text>' : '') +
    (d1 !== d0 ? '<text class="an-ax" x="' + (W - R) + '" y="' + (H - 6) + '" text-anchor="end">' + dShort(d1) + '</text>' : '');
  var iMax = vals.indexOf(Math.max.apply(null, vals)), iMin = vals.lastIndexOf(Math.min.apply(null, vals)), last = pts.length - 1;
  var mark = function (i, cls, lab) {
    if (pts.length < 4 || i === last) return '';
    var up = cls === 'max', ty = up ? Math.max(10, ys[i] - 8) : Math.min(H - B - 2, ys[i] + 14);
    var anchor = xs[i] < L + 30 ? 'start' : xs[i] > W - R - 30 ? 'end' : 'middle';
    return '<circle class="an-mk ' + cls + '" cx="' + xs[i] + '" cy="' + ys[i] + '" r="3"/><text class="an-mkt ' + cls + '" x="' + xs[i] + '" y="' + ty + '" text-anchor="' + anchor + '">' + lab + '</text>';
  };
  var fmtV = function (v) { return mode === 'risultato' ? sMoney(v) : U.money(v); };
  var marks = (iMax !== iMin ? mark(iMax, 'max', 'max ' + (mode === 'risultato' && vals[iMax] > 0 ? '+' : '') + eurShort(vals[iMax])) + mark(iMin, 'min', 'min ' + eurShort(vals[iMin])) : '');
  var clip = mode === 'risultato' ? '<clipPath id="anUp"><rect x="0" y="0" width="' + W + '" height="' + y0 + '"/></clipPath><clipPath id="anDn"><rect x="0" y="' + y0 + '" width="' + W + '" height="' + (H - y0) + '"/></clipPath>' : '';
  var body = mode === 'risultato'
    ? (area ? '<path class="an-area up" clip-path="url(#anUp)" d="' + area + '"/><path class="an-area dn" clip-path="url(#anDn)" d="' + area + '"/>' : '') +
      '<path class="an-line up" clip-path="url(#anUp)" d="' + line + '"/><path class="an-line dn" clip-path="url(#anDn)" d="' + line + '"/>'
    : (area ? '<path class="an-area sal" d="' + area + '"/>' : '') + '<path class="an-line sal" d="' + line + '"/>';
  var lastDot = '<circle class="an-last ' + (mode === 'saldo' ? 'sal' : vals[last] >= 0 ? 'up' : 'dn') + '" cx="' + xs[last] + '" cy="' + ys[last] + '" r="4"/>';
  /* lettura per ogni punto */
  var first = vals[0], tot = U.round(vals[last] - first), sideLab = anSpanLabel(pts);
  /* su Tutto il cambio del periodo sarebbe uguale al valore: a destra il mese in corso */
  if (diaryUI.range === 'all') {
    var mStart = d1.slice(0, 8) + '01', bi = -1;
    for (var q = pts.length - 1; q >= 0; q--) if (pts[q].date < mStart) { bi = q; break; }
    tot = U.round(vals[last] - (bi >= 0 ? vals[bi] : vals[0]));
    sideLab = 'questo mese';
  }
  diaryUI.netData = { W: W, H: H, T: T, B: B, xs: xs, ys: ys, mode: mode,
    def: anReadHtml(fmtV(vals[last]), mode === 'risultato' ? sClass(vals[last]) : '', (mode === 'risultato' ? (vals[last] >= 0 ? 'Vinto in totale' : 'Perso in totale') : 'Saldo') + ' · ' + U.esc(dLabel(d1)),
      pts.length > 1 ? sMoney(tot) : null, sClass(tot), U.esc(sideLab), false),
    rows: pts.map(function (p, i) {
      var dl = p.start ? null : p.delta;
      var side = i === 0 && !p.start ? null : p.start ? '—' : dl != null ? sMoney(dl) : '—';
      var lab = p.start ? 'saldo iniziale' : dl != null ? 'quel giorno' + (p.moved && Math.abs(p.moved) >= 0.005 ? ' · ' + (p.moved > 0 ? 'depositati ' : 'prelevati ') + U.money(Math.abs(p.moved)) : '') : 'primo giorno';
      return anReadHtml(fmtV(vals[i]), mode === 'risultato' ? sClass(vals[i]) : '', U.esc(p.start ? 'Inizio · ' + dLabel(p.date) : dLabel(p.date, { weekday: 'long', day: 'numeric', month: 'long' })) + (p.note ? ' · ' + U.esc(p.note) : ''),
        side, dl != null ? sClass(dl) : '', lab, true);
    }) };
  return '<div class="an-wrap" data-an-wrap="net">' + diaryUI.netData.def +
    '<svg class="an-chart" data-scrub="net" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + (mode === 'risultato' ? 'Risultato netto' : 'Saldo') + ' dal ' + dShort(d0) + ' al ' + dShort(d1) + '">' +
    '<defs>' + clip + '<linearGradient id="anGU" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--bt-up)" stop-opacity=".38"/><stop offset="1" stop-color="var(--bt-up)" stop-opacity=".04"/></linearGradient>' +
    '<linearGradient id="anGD" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="var(--bt-down)" stop-opacity=".38"/><stop offset="1" stop-color="var(--bt-down)" stop-opacity=".04"/></linearGradient>' +
    '<linearGradient id="anGS" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--bt-line-color)" stop-opacity=".3"/><stop offset="1" stop-color="var(--bt-line-color)" stop-opacity="0"/></linearGradient></defs>' +
    grid + body + marks + lastDot + xl +
    '<g class="an-cross" hidden><line x1="0" x2="0" y1="' + T + '" y2="' + (H - B) + '"/><circle r="5.5"/></g>' +
    '<rect class="an-hit" x="0" y="0" width="' + W + '" height="' + H + '"/></svg></div>';
}
/* barre: giorni, settimane o mesi */
function anWeekStart(iso) { var d = dParse(iso), k = (d.getDay() + 6) % 7; return dAdd(iso, -k); }
function diaryDayBars(points) {
  var days = points.filter(function (p) { return p.delta != null; });
  if (!days.length) return '<div class="diary-empty-chart">Servono almeno due giorni segnati.</div>';
  var unit = diaryUI.barUnit || '';
  if (!unit) { var nw = {}; days.forEach(function (p) { nw[anWeekStart(p.date)] = 1; }); unit = days.length <= 45 ? 'd' : Object.keys(nw).length <= 30 ? 'w' : 'm'; }
  var buckets = [], by = {};
  days.forEach(function (p) {
    var k = unit === 'd' ? p.date : unit === 'w' ? anWeekStart(p.date) : p.date.slice(0, 7);
    var b = by[k];
    if (!b) { b = by[k] = { k: k, v: 0, n: 0, up: 0, dn: 0, best: null, worst: null, last: p, first: p }; buckets.push(b); }
    b.v = U.round(b.v + p.delta); b.n++; if (p.delta > 0.004) b.up++; else if (p.delta < -0.004) b.dn++;
    if (!b.best || p.delta > b.best.delta) b.best = p; if (!b.worst || p.delta < b.worst.delta) b.worst = p; b.last = p;
  });
  var W = 360, H = 170, L = 8, R = 44, T = 12, B = 22;
  var vs = buckets.map(function (b) { return b.v; }), mx = Math.max(0, Math.max.apply(null, vs)), mn = Math.min(0, Math.min.apply(null, vs));
  if (mx - mn < 1) { mx += 0.5; mn -= 0.5; }
  var Y = function (v) { return T + (H - T - B) * (mx - v) / (mx - mn); }, y0 = Y(0);
  var slot = (W - L - R) / buckets.length, bw = Math.max(1.5, Math.min(26, slot * (buckets.length > 60 ? 0.9 : 0.72)));
  var xs = [];
  var rects = buckets.map(function (b, i) {
    var cx = L + slot * i + slot / 2, top = Math.min(Y(b.v), y0), h = Math.max(1.5, Math.abs(Y(b.v) - y0));
    xs.push(Math.round(cx * 10) / 10);
    return '<rect class="an-bar ' + (b.v > 0.004 ? 'up' : b.v < -0.004 ? 'dn' : 'flat') + '" data-an-bar="' + i + '" x="' + (cx - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="' + Math.min(3, bw / 2).toFixed(1) + '"/>';
  }).join('');
  var lab = function (b, long) {
    if (unit === 'd') return long ? dLabel(b.k, { weekday: 'long', day: 'numeric', month: 'long' }) : dShort(b.k);
    if (unit === 'w') { var e = dAdd(b.k, 6); return (long ? 'Settimana ' : '') + dParse(b.k).getDate() + (b.k.slice(5, 7) !== e.slice(5, 7) ? ' ' + dShort(b.k).split(' ')[1] : '') + '–' + dShort(e); }
    var t = dParse(b.k + '-01').toLocaleDateString('it-IT', long ? { month: 'long', year: 'numeric' } : { month: 'short' }).replace('.', '');
    return long ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  };
  var axis = '<line class="an-grid zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"/>' +
    (mx > 0.6 ? '<text class="an-ax" x="' + (W - R + 6) + '" y="' + (Y(mx) + 4).toFixed(1) + '">+' + eurShort(mx) + '</text>' : '') +
    (mn < -0.6 ? '<text class="an-ax" x="' + (W - R + 6) + '" y="' + (Y(mn) + 4).toFixed(1) + '">' + eurShort(mn) + '</text>' : '') +
    '<text class="an-ax" x="' + (W - R + 6) + '" y="' + (y0 + 4).toFixed(1) + '">0</text>' +
    '<text class="an-ax" x="' + L + '" y="' + (H - 5) + '">' + U.esc(lab(buckets[0])) + '</text>' +
    (buckets.length > 1 ? '<text class="an-ax" x="' + (W - R) + '" y="' + (H - 5) + '" text-anchor="end">' + U.esc(lab(buckets[buckets.length - 1])) + '</text>' : '');
  /* lettura: riepilogo del periodo (di base) e una per barra */
  var tot = U.round(vs.reduce(function (s, v) { return s + v; }, 0)), up = days.filter(function (p) { return p.delta > 0.004; }).length, dn = days.filter(function (p) { return p.delta < -0.004; }).length;
  var best = days.reduce(function (a, p) { return !a || p.delta > a.delta ? p : a; }, null), worst = days.reduce(function (a, p) { return !a || p.delta < a.delta ? p : a; }, null);
  var unitName = { d: 'giorni', w: 'settimane', m: 'mesi' }[unit];
  var streak = function (p) {
    var i = days.indexOf(p), s = p.delta > 0.004 ? 1 : p.delta < -0.004 ? -1 : 0, n = 0;
    if (!s) return '';
    while (i - n >= 0 && (days[i - n].delta > 0.004 ? 1 : days[i - n].delta < -0.004 ? -1 : 0) === s) n++;
    return n > 1 ? ' · ' + n + '° di fila in ' + (s > 0 ? 'aumento' : 'calo') : '';
  };
  diaryUI.barsData = { W: W, H: H, T: T, B: B, xs: xs, ys: null,
    def: anReadHtml(sMoney(tot), sClass(tot), buckets.length + ' ' + unitName + ' · ' + U.esc(anSpanLabel(days)), up + ' ▲ · ' + dn + ' ▼', '', 'migliore ' + sMoney(best.delta).replace(/,\d\d\s*€$/, '') + ' · peggiore ' + sMoney(worst.delta).replace(/,\d\d\s*€$/, ''), false),
    rows: buckets.map(function (b) {
      if (unit === 'd') return anReadHtml(sMoney(b.v), sClass(b.v), U.esc(lab(b, true)) + (b.last.note ? ' · ' + U.esc(b.last.note) : ''), U.money(b.last.balance), '', 'saldo' + U.esc(streak(b.last)), true);
      return anReadHtml(sMoney(b.v), sClass(b.v), U.esc(lab(b, true)), b.up + ' ▲ · ' + b.dn + ' ▼', '', 'migliore ' + sMoney(b.best.delta).replace(/,\d\d\s*€$/, '') + ' (' + U.esc(dShort(b.best.date)) + ') · peggiore ' + sMoney(b.worst.delta).replace(/,\d\d\s*€$/, '') + ' (' + U.esc(dShort(b.worst.date)) + ')', true);
    }) };
  var units = '<div class="an-units" role="group" aria-label="Raggruppa">' + DIARY_BAR_UNITS.map(function (u) {
    var on = (diaryUI.barUnit || '') === u[0];
    var eff = !diaryUI.barUnit && u[0] === unit; /* in Auto si vede anche l'unità scelta da sola */
    return '<button type="button" class="' + (on ? 'on' : '') + (eff ? ' eff' : '') + '" data-bar-unit="' + u[0] + '" aria-pressed="' + on + '">' + u[1] + '</button>';
  }).join('') + '</div>';
  return units + '<div class="an-wrap" data-an-wrap="bars">' + diaryUI.barsData.def +
    '<svg class="an-chart an-bars" data-scrub="bars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Risultato per ' + unitName + '">' + axis + rects +
    '<rect class="an-hit" x="0" y="0" width="' + W + '" height="' + H + '"/></svg></div>';
}
/* interazione: tocca o trascina sul grafico, la lettura in alto segue il dito; tocca la lettura per tornare al riepilogo */
function diaryScrubShow(kind, i) {
  var D = kind === 'net' ? diaryUI.netData : diaryUI.barsData, wrap = main.querySelector('[data-an-wrap="' + kind + '"]');
  if (!D || !wrap) return;
  var read = wrap.querySelector('.an-read'), svg = wrap.querySelector('svg');
  if (i == null) {
    if (read) read.outerHTML = D.def;
    if (svg) { svg.classList.remove('has-sel'); svg.querySelectorAll('.an-bar.sel').forEach(function (x) { x.classList.remove('sel'); }); var g0 = svg.querySelector('.an-cross'); if (g0) g0.setAttribute('hidden', ''); }
    return;
  }
  if (read && D.rows[i]) read.outerHTML = D.rows[i];
  if (!svg) return;
  if (kind === 'net') {
    var g = svg.querySelector('.an-cross');
    if (g) { g.removeAttribute('hidden'); g.querySelector('line').setAttribute('x1', D.xs[i]); g.querySelector('line').setAttribute('x2', D.xs[i]); g.querySelector('circle').setAttribute('cx', D.xs[i]); g.querySelector('circle').setAttribute('cy', D.ys[i]); }
  } else {
    svg.classList.add('has-sel');
    svg.querySelectorAll('.an-bar.sel').forEach(function (x) { x.classList.remove('sel'); });
    var b = svg.querySelector('[data-an-bar="' + i + '"]'); if (b) b.classList.add('sel');
  }
}
function diaryScrubBind() {
  main.querySelectorAll('[data-scrub]').forEach(function (svg) {
    var kind = svg.getAttribute('data-scrub'), down = false;
    var pick = function (ev) {
      var D = kind === 'net' ? diaryUI.netData : diaryUI.barsData;
      if (!D || !D.xs.length) return;
      var r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * D.W, best = 0, bd = Infinity;
      D.xs.forEach(function (v, i) { var d = Math.abs(v - x); if (d < bd) { bd = d; best = i; } });
      if (svg._anI !== best) { svg._anI = best; diaryScrubShow(kind, best); try { if (down && ev.pointerType === 'touch' && navigator.vibrate) navigator.vibrate(3); } catch (e) { /* ok */ } }
    };
    svg.addEventListener('pointerdown', function (ev) { down = true; try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* ok */ } pick(ev); });
    svg.addEventListener('pointermove', function (ev) { if (down || ev.pointerType === 'mouse') pick(ev); });
    ['pointerup', 'pointercancel'].forEach(function (n) { svg.addEventListener(n, function () { down = false; }); });
  });
  main.querySelectorAll('[data-an-wrap]').forEach(function (w) {
    w.addEventListener('click', function (ev) {
      if (!(ev.target.closest && ev.target.closest('[data-an-clear]'))) return;
      var svg = w.querySelector('svg'); if (svg) svg._anI = null;
      diaryScrubShow(w.getAttribute('data-an-wrap'), null);
    });
  });
  main.querySelectorAll('[data-bar-unit]').forEach(function (b) {
    b.onclick = function () { diaryUI.barUnit = b.getAttribute('data-bar-unit'); render(); };
  });
}
/* ---------- 4.23.0 — CALENDARIO RIFATTO ----------
   - In alto i mesi in una striscia (dal primo mese segnato a oggi), ognuno con il suo risultato: un tocco e ci sei.
     Si apre sul mese scelto, sempre visibile. Niente più menu a tendina (il testo "questo mese" faceva slittare le righe).
   - ‹ › accanto al nome del mese e, sul calendario, scorri col dito a sinistra o a destra per cambiare mese.
   - Una griglia sola: intestazione L M M G V S D una volta, sette giorni per riga e a destra il totale della settimana.
   - Sotto: giorni segnati e risultato del mese. */
function calMonthRes(series, key) {
  var inM = series.filter(function (p) { return p.date.slice(0, 7) === key; });
  if (!inM.length) return null;
  var before = series.filter(function (p) { return p.date < key + '-01'; });
  var base = before.length ? before[before.length - 1].perf : series.start ? series.start.perf : inM[0].perf;
  return U.round(inM[inM.length - 1].perf - base);
}
function calMonthsList(series) {
  var now = dToday().slice(0, 7), first = series.length ? series[0].date.slice(0, 7) : now;
  if (series.start && series.start.date && series.start.date.slice(0, 7) < first) first = series.start.date.slice(0, 7);
  var d = dParse(first + '-01'), lim = dParse(now + '-01'), out = [];
  var six = new Date(lim.getFullYear(), lim.getMonth() - 5, 1);
  if (d > six) d = six;
  while (d <= lim && out.length < 60) { out.push(U.local(d).slice(0, 7)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  return out;
}
function diaryCalendar2(series) {
  var today = dToday(), nowM = today.slice(0, 7), month = diaryUI.month || nowM;
  if (month > nowM) month = nowM;
  var first = dParse(month + '-01'), y = first.getFullYear(), m = first.getMonth();
  var offset = (first.getDay() + 6) % 7, count = new Date(y, m + 1, 0).getDate();
  var byDate = {};
  series.forEach(function (p) { byDate[p.date] = p; });
  var inMonth = series.filter(function (p) { return p.date.slice(0, 7) === month; });
  var maxAbs = Math.max.apply(null, [1].concat(inMonth.map(function (p) { return Math.abs(p.delta || 0); })));
  var months = calMonthsList(series), curYear = nowM.slice(0, 4);
  var strip = '<div class="cal2-strip" data-cal-strip role="tablist" aria-label="Mese">' + months.map(function (k) {
    var r = calMonthRes(series, k), on = k === month, dd = dParse(k + '-01');
    var name = dd.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '') + (k.slice(0, 4) !== curYear ? ' ' + k.slice(2, 4) : '');
    return '<button type="button" role="tab" aria-selected="' + on + '" class="cal2-m' + (on ? ' on' : '') + (k === nowM ? ' now' : '') + '" data-cal-m="' + k + '"><b>' + U.esc(name) + '</b><small class="' + (r == null ? '' : sClass(r)) + '">' + (r == null ? '—' : (r > 0.004 ? '+' : '') + eurShort(r)) + '</small></button>';
  }).join('') + '</div>';
  var cells = [];
  for (var k = 0; k < offset; k++) cells.push(null);
  for (var i = 1; i <= count; i++) {
    var key = month + '-' + String(i).padStart(2, '0'), p = byDate[key];
    cells.push({ i: i, key: key, p: p, d: p && p.delta != null ? p.delta : null, today: key === today, future: key > today });
  }
  while (cells.length % 7) cells.push(null);
  var dayBtn = function (x) {
    if (!x) return '<span class="cal2-d empty" aria-hidden="true"></span>';
    var tone = x.d > 0.004 ? 'up' : x.d < -0.004 ? 'down' : x.p ? 'flat' : '';
    var a = x.d != null ? Math.round(18 + 52 * Math.min(1, Math.abs(x.d) / maxAbs)) : 0;
    var val = x.p ? (x.d != null ? (x.d > 0.004 ? '+' : x.d < -0.004 ? '−' : '') + eurShort(Math.abs(x.d)) : '•') : '';
    var mv = !x.future && dayHasMovements(x.key);
    return '<button type="button" class="wk-day cal2-d' + (x.p ? ' has' : '') + (mv ? ' mv mv-' + dayFlowSign(x.key) : '') + (tone ? ' ' + tone : '') + (x.today ? ' today' : '') + (x.future ? ' future' : '') +
      '" style="--a:' + a + '%" data-dcal="' + x.key + '"' + (x.future ? ' disabled' : '') +
      ' aria-label="' + dLabel(x.key, { weekday: 'long', day: 'numeric', month: 'long' }) + (x.p ? ', saldo ' + U.money(x.p.balance) : ', non segnato') + (mv ? ', con movimenti' : '') + '"><b>' + x.i + '</b><span>' + val + '</span></button>';
  };
  /* 4.24.4 — CALENDARIO PIÙ LEGGIBILE: sette colonne piene (niente colonna "sett." stretta), giorni più alti con numero e
     cifra grandi; sopra il riepilogo del mese (risultato, giorni ▲/▼, migliore e peggiore); sotto le settimane in righe
     intere con il loro totale e una barra. */
  var WD = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
  var grid = '<div class="cal2-grid cal2-head" aria-hidden="true">' + WD.map(function (w) { return '<i>' + w + '</i>'; }).join('') + '</div>';
  var weeks = [];
  for (var w = 0; w < cells.length; w += 7) {
    var wk = cells.slice(w, w + 7), withD = wk.filter(function (x) { return x && x.d != null; });
    var tot = U.round(withD.reduce(function (s, x) { return s + x.d; }, 0)), cur = wk.some(function (x) { return x && x.today; });
    var real = wk.filter(Boolean);
    grid += '<div class="cal2-grid' + (cur ? ' cur' : '') + '">' + wk.map(dayBtn).join('') + '</div>';
    if (withD.length) weeks.push({ from: real[0].i, to: real[real.length - 1].i, tot: tot, n: withD.length, cur: cur });
  }
  var mon3 = first.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '');
  var wMax = Math.max.apply(null, [1].concat(weeks.map(function (x) { return Math.abs(x.tot); })));
  var weekList = weeks.length ? '<div class="cal2-weeks"><p class="cal2-wh">Settimane</p>' + weeks.map(function (x) {
    var wPct = Math.round(6 + 94 * Math.min(1, Math.abs(x.tot) / wMax));
    return '<div class="cal2-wk' + (x.cur ? ' cur' : '') + '"><span class="cal2-wk-d">' + (x.from === x.to ? x.from : x.from + '–' + x.to) + ' ' + U.esc(mon3) + (x.cur ? ' <em>questa</em>' : '') + '</span>' +
      '<span class="cal2-wk-bar ' + sClass(x.tot) + '"><i style="width:' + wPct + '%"></i></span>' +
      '<b class="' + sClass(x.tot) + '">' + sMoney(x.tot) + '</b></div>';
  }).join('') + '</div>' : '';
  var dz = inMonth.filter(function (p) { return p.delta != null; });
  var nUp = dz.filter(function (p) { return p.delta > 0.004; }).length, nDn = dz.filter(function (p) { return p.delta < -0.004; }).length;
  var best = dz.length ? dz.reduce(function (a, b) { return b.delta > a.delta ? b : a; }) : null, worst = dz.length ? dz.reduce(function (a, b) { return b.delta < a.delta ? b : a; }) : null;
  var dShort = function (p) { return Number(p.date.slice(8, 10)) + ' ' + mon3; };
  var eurS = function (v) { return (v > 0.004 ? '+' : v < -0.004 ? '−' : '') + eurShort(Math.abs(v)) + ' €'; };
  var stBox = function (lbl, v, p) { var ok = p && (v > 0 ? p.delta > 0.004 : p.delta < -0.004); return '<div class="cal2-st"><small>' + lbl + '</small><b class="' + (ok ? sClass(p.delta) : '') + '">' + (ok ? eurS(p.delta) : '—') + '</b><em>' + (ok ? dShort(p) : '&nbsp;') + '</em></div>'; };
  var sumRow = dz.length ? '<div class="cal2-sum">' +
    '<div class="cal2-st"><small>Giorni</small><b><span class="positive">' + nUp + ' ▲</span> <span class="negative">' + nDn + ' ▼</span></b><em>' + dz.length + ' segnati</em></div>' +
    stBox('Migliore', 1, best) + stBox('Peggiore', -1, worst) + '</div>' : '';
  var isCurrent = month === nowM, iM = months.indexOf(month), prevM = iM > 0 ? months[iM - 1] : '', nextM = iM >= 0 && iM < months.length - 1 ? months[iM + 1] : '';
  var res = calMonthRes(series, month), monName = first.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  var nav = '<div class="cal2-nav">' +
    '<button type="button" class="cal2-arr" aria-label="Mese prima"' + (prevM ? ' data-cal-m="' + prevM + '"' : ' disabled') + '>‹</button>' +
    '<div class="cal2-title"><b>' + U.esc(monName.charAt(0).toUpperCase() + monName.slice(1)) + '</b>' +
    '<small class="' + (res == null ? '' : sClass(res)) + '">' + (res == null ? 'nessun giorno segnato' : sMoney(res) + ' · ' + dz.length + (dz.length === 1 ? ' giorno' : ' giorni')) + '</small></div>' +
    '<button type="button" class="cal2-arr" aria-label="Mese dopo"' + (nextM ? ' data-cal-m="' + nextM + '"' : ' disabled') + '>›</button></div>';
  return '<div class="cal2 cal3">' + strip + nav +
    sumRow + '<div class="cal2-body" data-cal-swipe>' + grid + '</div>' + weekList +
    (isCurrent ? '' : '<button type="button" class="cal2-today" data-cal-m="' + nowM + '">Torna a questo mese</button>') + '</div>';
}
function calBind() {
  main.querySelectorAll('[data-cal-m]').forEach(function (b) {
    b.onclick = function () { diaryUI.month = b.getAttribute('data-cal-m'); render(); };
  });
  var strip = main.querySelector('[data-cal-strip]');
  if (strip) { var on = strip.querySelector('.cal2-m.on'); if (on) strip.scrollLeft = Math.max(0, on.offsetLeft - strip.clientWidth / 2 + on.offsetWidth / 2); }
  var body = main.querySelector('[data-cal-swipe]');
  if (!body) return;
  var x0 = null, y0 = 0, swiped = 0;
  body.addEventListener('pointerdown', function (ev) { x0 = ev.clientX; y0 = ev.clientY; });
  body.addEventListener('pointerup', function (ev) {
    if (x0 == null) return;
    var dx = ev.clientX - x0, dy = ev.clientY - y0; x0 = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    var cur = diaryUI.month || dToday().slice(0, 7), dt = dParse(cur + '-01');
    dt.setMonth(dt.getMonth() + (dx < 0 ? 1 : -1));
    var next = U.local(dt).slice(0, 7), list = calMonthsList(diarySeries());
    if (next > dToday().slice(0, 7) || next < list[0]) return;
    swiped = Date.now();
    diaryUI.month = next;
    render();
  });
  body.addEventListener('pointercancel', function () { x0 = null; });
  body.addEventListener('click', function (ev) { if (Date.now() - swiped < 400) { ev.stopPropagation(); ev.preventDefault(); } }, true);
}
/* ---------- Agenda del mese ---------- */
function diaryCalendar(series) {
  /* 2.5.0 — Agenda a settimane: un blocco per settimana con il totale, dentro i 7 giorni.
     Il colore del giorno è più intenso quanto più grande è la variazione (verde aumento, rosso calo). */
  var month = diaryUI.month || dToday().slice(0, 7);
  var first = dParse(month + '-01'),
    y = first.getFullYear(),
    m = first.getMonth();
  var offset = (first.getDay() + 6) % 7,
    count = new Date(y, m + 1, 0).getDate(),
    today = dToday();
  var byDate = {};
  series.forEach(function (p) {
    byDate[p.date] = p;
  });
  var inMonth = series.filter(function (p) {
    return p.date.slice(0, 7) === month;
  });
  var maxAbs = Math.max.apply(
    null,
    [1].concat(
      inMonth.map(function (p) {
        return Math.abs(p.delta || 0);
      }),
    ),
  );
  var WD = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];
  var shortM = first.toLocaleDateString('it-IT', { month: 'short' }).replace('.', '');
  var cells = [];
  for (var k = 0; k < offset; k++) cells.push(null);
  for (var i = 1; i <= count; i++) {
    var key = month + '-' + String(i).padStart(2, '0'),
      p = byDate[key],
      d = p && p.delta != null ? p.delta : null;
    cells.push({ i: i, key: key, p: p, d: d, today: key === today, future: key > today });
  }
  while (cells.length % 7) cells.push(null);

  var dayBtn = function (x, wd) {
    if (!x) return '<span class="wk-day wk-empty" aria-hidden="true"></span>';
    var tone = x.d > 0.004 ? 'up' : x.d < -0.004 ? 'down' : x.p ? 'flat' : '';
    var a = x.d != null ? Math.round(18 + 52 * Math.min(1, Math.abs(x.d) / maxAbs)) : 0;
    var val = x.p ? (x.d != null ? (x.d > 0.004 ? '+' : x.d < -0.004 ? '−' : '') + eurShort(Math.abs(x.d)) : 'Saldo') : '';
    return (
      '<button type="button" class="wk-day' +
      (x.p ? ' has' : '') +
      (!x.future && dayHasMovements(x.key) ? ' mv mv-' + dayFlowSign(x.key) : '') +
      (tone ? ' ' + tone : '') +
      (x.today ? ' today' : '') +
      (x.future ? ' future' : '') +
      '" style="--a:' +
      a +
      '%" data-dcal="' +
      x.key +
      '"' +
      (x.future ? ' disabled' : '') +
      ' aria-label="' +
      dLabel(x.key, { weekday: 'long', day: 'numeric', month: 'long' }) +
      (x.p ? ', saldo ' + U.money(x.p.balance) : ', non segnato') +
      (!x.future && dayHasMovements(x.key) ? ', con movimenti' : '') +
      '"><small>' +
      wd +
      '</small><b>' +
      x.i +
      '</b><span>' +
      val +
      '</span></button>'
    );
  };

  var weeks = '';
  for (var w = 0; w < cells.length; w += 7) {
    var wk = cells.slice(w, w + 7),
      real = wk.filter(Boolean),
      a0 = real[0],
      b0 = real[real.length - 1];
    var withD = real.filter(function (x) {
      return x.d != null;
    });
    var tot = withD.reduce(function (s, x) {
      return s + x.d;
    }, 0);
    var allFuture = real.every(function (x) {
      return x.future;
    });
    var hasToday = real.some(function (x) {
      return x.today;
    });
    weeks +=
      '<div class="wk' +
      (allFuture ? ' future' : '') +
      (hasToday ? ' current' : '') +
      '"><div class="wk-head"><span>' +
      (a0.i === b0.i ? a0.i : a0.i + '–' + b0.i) +
      ' ' +
      shortM +
      (hasToday ? ' · questa settimana' : '') +
      '</span><b class="' +
      (withD.length ? sClass(tot) : '') +
      '">' +
      (withD.length ? sMoney(tot) : '—') +
      '</b></div><div class="wk-days">' +
      wk
        .map(function (x, j) {
          return dayBtn(x, WD[j]);
        })
        .join('') +
      '</div></div>';
  }

  var before = series.filter(function (p) {
    return p.date < month + '-01';
  });
  var startVal = before.length
    ? before[before.length - 1].perf
    : series.start
      ? series.start.perf
      : inMonth[0]
        ? inMonth[0].perf
        : null;
  var endP = inMonth[inMonth.length - 1];
  var monthDelta = endP && startVal != null ? endP.perf - startVal : null;
  var isCurrent = month >= today.slice(0, 7);
  var monthLabel = first.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });

  return (
    '<div class="wkcal">' +
    '<div class="wkcal-head"><button type="button" class="wkcal-title" data-dcal-pick aria-label="' +
    monthLabel +
    ': tocca o tieni premuto per scegliere il mese">' +
    monthLabel +
    ' <span aria-hidden="true">▾</span></button><div class="wkcal-nav"><button type="button" data-dcal-month="-1" aria-label="Mese precedente">‹</button><button type="button" data-dcal-month="1" aria-label="Mese successivo"' +
    (isCurrent ? ' disabled' : '') +
    '>›</button></div></div>' +
    '<div class="wkcal-weeks">' +
    weeks +
    '</div>' +
    '<div class="wkcal-scale" aria-hidden="true"><span>Calo</span><i></i><span>Aumento</span></div>' +
    '<div class="wkcal-foot"><span>' +
    (inMonth.length
      ? inMonth.length + (inMonth.length === 1 ? ' giorno segnato' : ' giorni segnati')
      : 'Nessun saldo segnato: tocca un giorno') +
    '</span><b class="' +
    sClass(monthDelta) +
    '">' +
    (monthDelta == null ? '—' : sMoney(monthDelta)) +
    '</b></div>' +
    '</div>'
  );
}

/* ---------- Pagina ---------- */
/* 4.8.0 — SALDO A MODULI. Saldo totale = soldi versati (saldo iniziale + depositi). Le vincite/perdite dei giorni segnati
   e i prelievi sono moduli a parte: versi 100, vinci 15 e prelevi i 15 → versato 100, vinto +15, prelevato 15, sul conto 100.
   I prelievi si tolgono prima dalle vincite: solo la parte oltre le vincite riduce il capitale. */
function saldoParts() {
  var s = startDate(),
    fl = realFlows().filter(function (t) {
      return !s || dayKey(t.date) >= s;
    });
  var dep = U.round(db.accounts[0].initial + fl.filter(function (t) { return t.amount > 0; }).reduce(function (n, t) { return n + t.amount; }, 0)),
    wd = U.round(fl.filter(function (t) { return t.amount < 0; }).reduce(function (n, t) { return n - t.amount; }, 0)),
    cur = balance(),
    res = U.round(cur - dep + wd),
    wdWin = U.round(Math.min(wd, Math.max(res, 0)));
  return { dep: dep, wd: wd, cur: cur, res: res, wdWin: wdWin, wdCap: U.round(wd - wdWin), capital: U.round(dep - (wd - wdWin)) };
}
function diaryPage(which) {
  /* 3.0.0 — Home: saldo, segna il giorno, depositi/prelievi, calendario e quattro numeri.
     Statistiche: tutto il resto, solo sul saldo. */
  var series = diarySeries(),
    today = dToday(),
    cur = balance(),
    last = series[series.length - 1] || null;
  var todayEntry =
    series.find(function (p) {
      return p.date === today;
    }) || null;

  if (which !== 'stats') {
    var kpi = function (label, ch) {
      return (
        '<div class="card diary-kpi"><small>' +
        label +
        '</small><b class="' +
        (ch ? sClass(ch.value) : '') +
        '">' +
        (ch ? sMoney(ch.value) : '—') +
        '</b><span>' +
        (ch ? (ch.from.start ? 'dal saldo iniziale' : 'dal ' + dShort(ch.from.date)) : 'servono più giorni') +
        '</span></div>'
      );
    };
    var todayCh = todayEntry && todayEntry.delta != null ? { value: todayEntry.delta, from: todayEntry.prev } : null;
    var monthStart = today.slice(0, 8) + '01';
    var mBase = null;
    for (var mi = series.length - 1; mi >= 0; mi--)
      if (series[mi].date < monthStart) {
        mBase = series[mi];
        break;
      }
    if (!mBase) mBase = series.start || series[0] || null;
    var monthCh = last && mBase && mBase !== last ? { value: U.round(last.perf - mBase.perf), from: mBase } : null;
    var kpis =
      '<div class="diary-kpis">' +
      kpi('Oggi', todayCh) +
      kpi('7 giorni', diaryChange(series, 7)) +
      kpi('Questo mese', monthCh) +
      kpi('Dall’inizio', diaryChange(series, 'all')) +
      '</div>';
    /* 4.21.5 — Calendario sopra Oggi, senza la riga di spiegazione */
    var agenda = '<section class="card diary-card" data-cx="calendario"><h2>Calendario</h2>' + diaryCalendar2(series) + '</section>'; /* 4.23.0 */
    var H = saldoHomeHtml();
    return goalCardHtml() + H.hero + agenda + H.day + kpis; /* 4.26.0 — obiettivo in cima */
  }

  /* ---------- Statistiche ---------- */
  var points = diaryRangePoints(series);
  /* 4.23.0 — Andamento in cima, di base Risultato netto (via "I tuoi soldi": ripeteva la carta del Saldo) */
  var mode = diaryUI.chartMode === 'saldo' ? 'saldo' : 'risultato';
  var seg =
    '<div class="diary-seg an-range" role="group" aria-label="Periodo">' +
    DIARY_RANGES.map(function (r) {
      return '<button type="button" data-diary-range="' + r[0] + '" class="' + (diaryUI.range === r[0] ? 'active' : '') + '" aria-pressed="' + (diaryUI.range === r[0]) + '">' + r[1] + '</button>';
    }).join('') +
    '</div>';
  var modeSeg =
    '<div class="diary-seg diary-mode an-mode" role="group" aria-label="Cosa mostrare"><button type="button" data-chart-mode="risultato" class="' +
    (mode === 'risultato' ? 'active' : '') + '">Risultato netto</button><button type="button" data-chart-mode="saldo" class="' +
    (mode === 'saldo' ? 'active' : '') + '">Saldo</button></div>';
  var chart = '<section class="card diary-card an-card" data-cx="andamento"><h2>Andamento</h2>' + modeSeg + diaryNetChart(points, series) + seg + '</section>';
  var bars = '<section class="card diary-card an-card" data-cx="giorno-per-giorno"><h2>Risultato giorno per giorno</h2>' + diaryDayBars(points) + '</section>';
  var st = diaryStats(points),
    stats = '';
  if (st) {
    var cell = function (label, value, note, cls) {
      return (
        '<div class="diary-stat"><small>' +
        label +
        '</small><b class="' +
        (cls || '') +
        '">' +
        value +
        '</b>' +
        (note ? '<span>' + note + '</span>' : '') +
        '</div>'
      );
    };
    stats =
      '<section class="card diary-card"><h2>Statistiche del periodo</h2><div class="diary-stats">' +
      cell('Massimo', U.money(st.max.balance), dShort(st.max.date)) +
      cell('Minimo', U.money(st.min.balance), dShort(st.min.date)) +
      cell(
        'Dal massimo',
        st.fromPeak ? sMoney(st.fromPeak) : 'Al massimo',
        st.fromPeak ? 'picco ' + dShort(st.peak.date) : 'nuovo record',
        sClass(st.fromPeak),
      ) +
      cell('Calo massimo', st.maxDD ? sMoney(st.maxDD) : '—', 'dal picco al minimo successivo', sClass(st.maxDD)) +
      cell('Giorni ▲ / ▼', st.up + ' / ' + st.down, 'in aumento / in calo') +
      cell('Media per giorno', st.avg != null ? sMoney(st.avg) : '—', 'tra giorni segnati', sClass(st.avg || 0)) +
      cell(
        'Serie attuale',
        st.streak ? st.streak + (st.sign > 0 ? ' ▲' : ' ▼') : '—',
        st.streak
          ? (st.streak === 1 ? 'giorno di fila' : 'giorni di fila') + (st.sign > 0 ? ' in aumento' : ' in calo')
          : '',
        st.sign > 0 ? 'positive' : st.sign < 0 ? 'negative' : '',
      ) +
      cell(
        'Giorni segnati',
        String(st.count),
        DIARY_RANGES.find(function (r) {
          return r[0] === diaryUI.range;
        })[1] === 'Tutto'
          ? 'in totale'
          : 'nel periodo',
      ) +
      '</div></section>';
  }

  var month = diaryUI.month || today.slice(0, 7);
  var rows = series
    .filter(function (p) {
      return p.date.slice(0, 7) === month;
    })
    .reverse();
  var log =
    '<section class="card diary-card"><h2>Registro · ' +
    dParse(month + '-01').toLocaleDateString('it-IT', { month: 'long' }) +
    '</h2>' +
    (rows.length
      ? '<div class="diary-log">' +
        rows
          .map(function (p) {
            return (
              '<button type="button" class="diary-row" data-diary-edit="' +
              p.date +
              '"><span class="diary-row-date"><b>' +
              dParse(p.date).getDate() +
              '</b><small>' +
              dParse(p.date).toLocaleDateString('it-IT', { weekday: 'short' }) +
              '</small></span><span class="diary-row-main"><b>' +
              U.money(p.balance) +
              '</b>' +
              (p.note ? '<small>' + U.esc(p.note) + '</small>' : '') +
              (p.moved && Math.abs(p.moved) >= 0.005
                ? '<small>' + (p.moved > 0 ? 'depositati ' : 'prelevati ') + U.money(Math.abs(p.moved)) + ', non contano</small>'
                : '') +
              '</span><span class="diary-row-delta ' +
              (p.delta != null ? sClass(p.delta) : '') +
              '">' +
              (p.delta != null ? sMoney(p.delta) : 'inizio') +
              '</span></button>'
            );
          })
          .join('') +
        '</div>'
      : '<p class="muted">Nessun giorno segnato in questo mese.</p>') +
    '</section>';

  var months = {};
  series.forEach(function (p) {
    months[p.date.slice(0, 7)] = p;
  });
  var mkeys = Object.keys(months).sort().slice(-6);
  var monthly = '';
  if (mkeys.length) {
    monthly =
      '<section class="card diary-card"><h2>Mese per mese</h2><table class="diary-table"><thead><tr><th>Mese</th><th>Fine mese</th><th>Risultato</th></tr></thead><tbody>' +
      mkeys
        .slice()
        .reverse()
        .map(function (k) {
          var end = months[k],
            prevEnd = series
              .filter(function (p) {
                return p.date < k + '-01';
              })
              .pop();
          var firstIn = series.find(function (p) {
            return p.date.slice(0, 7) === k;
          });
          var base = prevEnd ? prevEnd.perf : series.start ? series.start.perf : firstIn.perf,
            ch = U.round(end.perf - base);
          var pct = '';
          return (
            '<tr><td>' +
            dParse(k + '-01').toLocaleDateString('it-IT', { month: 'short', year: '2-digit' }) +
            '</td><td>' +
            U.money(end.balance) +
            '</td><td class="' +
            sClass(ch) +
            '">' +
            sMoney(ch) +
            pct +
            '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table></section>';
  }


  if (!series.length)
    return '<section class="card diary-card"><p class="muted">Nessun giorno segnato.</p></section>';
  var weekday =
    '<section class="card diary-card"><h2>Per giorno della settimana</h2><p class="muted diary-hint">Risultato medio nel periodo scelto, per giorno.</p>' +
    diaryWeekdayChart(points) +
    '</section>';
  return chart + bars + diaryBubCard() + stats + weekday + monthly + log;
}

/* ---------- 2.1.0 — Per giorno della settimana ---------- */
var WD_NAMES = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
function diaryWeekdayStats(points) {
  var rows = WD_NAMES.map(function (n) {
    return { name: n, sum: 0, n: 0, up: 0, down: 0 };
  });
  points.forEach(function (p) {
    if (p.delta == null) return;
    var w = (dParse(p.date).getDay() + 6) % 7,
      r = rows[w];
    r.sum += p.delta;
    r.n++;
    if (p.delta > 0.004) r.up++;
    else if (p.delta < -0.004) r.down++;
  });
  rows.forEach(function (r) {
    r.avg = r.n ? U.round(r.sum / r.n) : null;
  });
  return rows;
}
function diaryWeekdayChart(points) {
  var rows = diaryWeekdayStats(points),
    used = rows.filter(function (r) {
      return r.n;
    });
  if (used.length < 2)
    return '<div class="diary-empty-chart">Servono più giorni segnati.</div>';
  var W = 360,
    H = 170,
    L = 12,
    R = 12,
    T = 6,
    B = 22;
  var m = Math.max.apply(
    null,
    used
      .map(function (r) {
        return Math.abs(r.avg);
      })
      .concat([1]),
  );
  var zero = T + (H - T - B) / 2,
    half = (H - T - B) / 2;
  var slot = (W - L - R) / 7,
    bw = Math.min(30, slot - 8);
  var marks = rows
    .map(function (r, i) {
      var cx = L + slot * i + slot / 2,
        out = '';
      if (r.n) {
        var h = Math.max(1.5, (Math.abs(r.avg) / m) * (half - 16)),
          top = r.avg >= 0 ? zero - h : zero; // 16px liberi per il valore
        var cls = r.avg > 0.004 ? 'db-up' : r.avg < -0.004 ? 'db-down' : 'db-flat';
        out +=
          '<rect class="' +
          cls +
          '" x="' +
          (cx - bw / 2).toFixed(1) +
          '" y="' +
          top.toFixed(1) +
          '" width="' +
          bw.toFixed(1) +
          '" height="' +
          h.toFixed(1) +
          '" rx="4"/>';
        var ty = r.avg >= 0 ? top - 4 : top + h + 11;
        out +=
          '<text class="dc-val" x="' +
          cx.toFixed(1) +
          '" y="' +
          ty.toFixed(1) +
          '" text-anchor="middle">' +
          (r.avg > 0 ? '+' : r.avg < 0 ? '−' : '') +
          eurShort(Math.abs(r.avg)) +
          '</text>';
      }
      out +=
        '<text class="dc-axis" x="' +
        cx.toFixed(1) +
        '" y="' +
        (H - 6) +
        '" text-anchor="middle">' +
        r.name.slice(0, 3) +
        '</text>';
      out +=
        '<rect class="dc-hit" data-wd-i="' +
        i +
        '" x="' +
        (L + slot * i).toFixed(1) +
        '" y="0" width="' +
        slot.toFixed(1) +
        '" height="' +
        H +
        '"/>';
      return out;
    })
    .join('');
  diaryUI.wdData = rows.map(function (r) {
    return r.n
      ? r.name +
          ' · media ' +
          sMoney(r.avg) +
          ' su ' +
          r.n +
          (r.n === 1 ? ' giorno' : ' giorni') +
          ' (' +
          r.up +
          ' in aumento, ' +
          r.down +
          ' in calo)'
      : r.name + ' · nessun giorno segnato';
  });
  var best = used.reduce(function (a, b) {
      return b.avg > a.avg ? b : a;
    }),
    worst = used.reduce(function (a, b) {
      return b.avg < a.avg ? b : a;
    });
  return (
    '<svg class="diary-chart dc-wd" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="Variazione media del saldo per giorno della settimana">' +
    '<line class="dc-zero" x1="' +
    L +
    '" x2="' +
    (W - R) +
    '" y1="' +
    zero +
    '" y2="' +
    zero +
    '"/>' +
    marks +
    '</svg>' +
    '<p class="diary-chart-detail" data-dc-detail="wd" aria-live="polite">Giorno migliore: <b>' +
    best.name.toLowerCase() +
    '</b> (' +
    sMoney(best.avg) +
    ' in media) · peggiore: <b>' +
    worst.name.toLowerCase() +
    '</b> (' +
    sMoney(worst.avg) +
    ').</p>'
  );
}

/* ---------- 2.1.0 — Saldo segnato e scommesse ---------- */
function localDay(iso) {
  return U.local(new Date(iso)).slice(0, 10);
}
function diaryExplained(fromDate, toDate) {
  // scommesse liquidate e depositi/prelievi (non gli allineamenti) nei giorni (fromDate, toDate]
  var bets = db.bets.filter(function (b) {
    return b.status !== 'pending' && b.settledAt && localDay(b.settledAt) > fromDate && localDay(b.settledAt) <= toDate;
  });
  var txs = db.transactions.filter(function (t) {
    return t.kind !== 'adjust' && localDay(t.date) > fromDate && localDay(t.date) <= toDate;
  });
  return {
    profit: U.round(
      bets.reduce(function (n, b) {
        return n + profit(b);
      }, 0),
    ),
    moves: U.round(
      txs.reduce(function (n, t) {
        return n + t.amount;
      }, 0),
    ),
    count: bets.length,
  };
}
function diaryVsBets(points) {
  if (points.length < 2) return '<div class="diary-empty-chart">Servono almeno due giorni segnati nel periodo.</div>';
  var base = points[0],
    last = points[points.length - 1];
  var tot = diaryExplained(base.date, last.date);
  var change = U.round(last.balance - base.balance),
    expl = U.round(tot.profit + tot.moves),
    gap = U.round(change - expl);
  // serie cumulative dal primo giorno del periodo
  var A = points.map(function (p) {
    return { date: p.date, v: U.round(p.balance - base.balance) };
  });
  var Bs = points.map(function (p) {
    var e = diaryExplained(base.date, p.date);
    return { date: p.date, v: U.round(e.profit + e.moves) };
  });
  var W = 360,
    H = 180,
    L = 40,
    R = 12,
    T = 14,
    B = 24;
  var vals = A.concat(Bs)
    .map(function (x) {
      return x.v;
    })
    .concat([0]);
  var lo = Math.min.apply(null, vals),
    hi = Math.max.apply(null, vals);
  if (hi - lo < 1) {
    hi += 1;
    lo -= 1;
  }
  var pad = (hi - lo) * 0.12;
  hi += pad;
  lo -= pad;
  var span = Math.max(1, dDays(base.date, last.date));
  var x = function (d) {
    return L + ((W - L - R) * dDays(base.date, d)) / span;
  };
  var y = function (v) {
    return T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  };
  var path = function (s) {
    return s
      .map(function (p, i) {
        return (i ? 'L' : 'M') + x(p.date).toFixed(1) + ' ' + y(p.v).toFixed(1);
      })
      .join(' ');
  };
  var grid = [hi, 0, lo]
    .map(function (v) {
      return (
        '<line class="' +
        (v === 0 ? 'dc-zero' : 'dc-grid') +
        '" x1="' +
        L +
        '" x2="' +
        (W - R) +
        '" y1="' +
        y(v).toFixed(1) +
        '" y2="' +
        y(v).toFixed(1) +
        '"/><text class="dc-axis" x="' +
        (L - 6) +
        '" y="' +
        (y(v) + 4).toFixed(1) +
        '" text-anchor="end">' +
        (v > 0 ? '+' : '') +
        eurShort(v) +
        '</text>'
      );
    })
    .join('');
  var hits = points
    .map(function (p, i) {
      var x0 = i ? (x(points[i - 1].date) + x(p.date)) / 2 : L,
        x1 = i < points.length - 1 ? (x(p.date) + x(points[i + 1].date)) / 2 : W - R;
      return (
        '<rect class="dc-hit" data-vs-i="' +
        i +
        '" x="' +
        x0.toFixed(1) +
        '" y="0" width="' +
        Math.max(2, x1 - x0).toFixed(1) +
        '" height="' +
        H +
        '"/>'
      );
    })
    .join('');
  diaryUI.vsData = points.map(function (p, i) {
    return (
      dLabel(p.date) +
      ' · saldo segnato ' +
      sMoney(A[i].v) +
      ' · scommesse e movimenti ' +
      sMoney(Bs[i].v) +
      ' (dal ' +
      dShort(base.date) +
      ')'
    );
  });
  var svg =
    '<svg class="diary-chart dc-vs" viewBox="0 0 ' +
    W +
    ' ' +
    H +
    '" role="img" aria-label="Confronto tra la variazione del saldo segnato e il risultato di scommesse e movimenti">' +
    grid +
    '<path class="vs-a" d="' +
    path(A) +
    '"/><path class="vs-b" d="' +
    path(Bs) +
    '"/>' +
    '<text class="dc-axis" x="' +
    L +
    '" y="' +
    (H - 6) +
    '">' +
    dShort(base.date) +
    '</text><text class="dc-axis" x="' +
    (W - R) +
    '" y="' +
    (H - 6) +
    '" text-anchor="end">' +
    dShort(last.date) +
    '</text>' +
    hits +
    '</svg>';
  var legend =
    '<div class="vs-legend"><span><i class="vs-key a"></i>Saldo segnato <b>' +
    sMoney(change) +
    '</b></span><span><i class="vs-key b"></i>Scommesse e movimenti <b>' +
    sMoney(expl) +
    '</b></span></div>';
  var table =
    '<div class="vs-rows">' +
    '<div><span>Variazione del saldo segnato</span><b class="' +
    sClass(change) +
    '">' +
    sMoney(change) +
    '</b></div>' +
    '<div><span>Profitto scommesse liquidate (' +
    tot.count +
    ')</span><b class="' +
    sClass(tot.profit) +
    '">' +
    sMoney(tot.profit) +
    '</b></div>' +
    '<div><span>Depositi − prelievi</span><b class="' +
    sClass(tot.moves) +
    '">' +
    sMoney(tot.moves) +
    '</b></div>' +
    '<div class="vs-gap"><span>Differenza non spiegata</span><b class="' +
    sClass(gap) +
    '">' +
    (Math.abs(gap) < 0.005 ? 'Nessuna' : sMoney(gap)) +
    '</b></div></div>' +
    '<p class="muted vs-note">' +
    (Math.abs(gap) < 0.005
      ? 'Il saldo che hai segnato coincide con scommesse e movimenti registrati.'
      : 'La differenza può venire da giocate non registrate, bonus, commissioni o un saldo segnato per errore.') +
    '</p>';
  return (
    legend +
    svg +
    '<p class="diary-chart-detail" data-dc-detail="vs" aria-live="polite"></p>' +
    table
  );
}
function bindDiaryExtra() {
  main.querySelectorAll('[data-wd-i]').forEach(function (r) {
    var f = function () {
      var d = main.querySelector('[data-dc-detail="wd"]');
      if (d && diaryUI.wdData) d.textContent = diaryUI.wdData[Number(r.dataset.wdI)];
    };
    r.addEventListener('click', f);
    r.addEventListener('mouseenter', f);
  });
  main.querySelectorAll('[data-vs-i]').forEach(function (r) {
    var f = function () {
      var d = main.querySelector('[data-dc-detail="vs"]');
      if (d && diaryUI.vsData) d.textContent = diaryUI.vsData[Number(r.dataset.vsI)];
    };
    r.addEventListener('click', f);
    r.addEventListener('mouseenter', f);
  });
}

/* ---------- Segna / correggi un giorno ---------- */
/* =====================================================================
   4.9.0 — SALDO RIPENSATO: un solo pannello per Aggiorna saldo, Prelievo e Deposito.
   - Il prelievo chiede anche "quanto resta sul conto": se resta lo stesso saldo di prima i soldi tolti erano vincite.
     Il saldo del giorno viene aggiornato subito, così puoi prelevare più volte nella stessa giornata
     (100 € → vinci 30 → prelevi 30 → resta 100: oggi +30; di nuovo +30 → prelevi → resta 100: oggi +60).
   - Il deposito, se il giorno ha già un saldo segnato, lo alza della stessa cifra (non è una vincita).
   - Il risultato del giorno si vede mentre scrivi.
   ===================================================================== */
function msDayFlows(day, skipId) {
  return U.round(
    realFlows()
      .filter(function (t) {
        return dayKey(t.date) === day && t.id !== skipId;
      })
      .reduce(function (n, t) {
        return n + t.amount;
      }, 0),
  );
}
/* saldo di riferimento del giorno prima (ultimo segnato prima di "day", o saldo iniziale) e movimenti nel mezzo */
function msPrevOf(day) {
  var ser = diarySeries(),
    prev = null;
  for (var k = ser.length - 1; k >= 0; k--)
    if (ser[k].date < day) {
      prev = ser[k];
      break;
    }
  if (!prev && ser.start && ser.start.date < day) prev = ser.start;
  if (!prev && hasStart() && startDate() < day) prev = { date: startDate(), balance: U.round(db.accounts[0].initial), start: true };
  return prev;
}
function msBetween(prev, day, skipId) {
  var s = startDate();
  return U.round(
    realFlows()
      .filter(function (t) {
        var k = dayKey(t.date);
        return t.id !== skipId && (!prev || k > prev.date) && k < day && (!s || k >= s);
      })
      .reduce(function (n, t) {
        return n + t.amount;
      }, 0),
  );
}
/* saldo sul conto in quel giorno prima del movimento: saldo segnato del giorno, altrimenti quello calcolato */
function msBalanceOn(day, skip) {
  var e = diaryOn(day);
  if (e) return U.round(e.balance);
  if (day >= dToday() || diaryIsLatest(day)) return U.round(balance() - (skip ? skip.amount : 0));
  var prev = msPrevOf(day);
  return prev ? U.round(prev.balance + msBetween(prev, day) + msDayFlows(day, skip && skip.id)) : U.round(balance());
}
function msDayLabel(day) {
  var t = dToday();
  if (day === t) return 'oggi';
  if (day === dAdd(t, -1)) return 'ieri';
  return dLabel(day);
}
function moneySheet(kind, o) {
  o = o || {};
  var today = dToday(),
    t = o.t || null,
    isSaldo = kind === 'saldo',
    isWd = kind === 'withdraw',
    day = t ? dayKey(t.date) : o.date && o.date <= today ? o.date : today;
  var existing = isSaldo ? diaryOn(day) : null;
  var startBal = isSaldo ? null : msBalanceOn(day, t);
  var title = isSaldo ? (existing ? 'Correggi il saldo' : 'Aggiorna il saldo') : t ? (isWd ? 'Modifica prelievo' : 'Modifica deposito') : isWd ? 'Prelievo' : 'Deposito';
  var del = (isSaldo && existing) || t ? 'ms-del' : '';
  var amtLbl = isSaldo ? 'Quanto hai sul conto?' : isWd ? 'Quanto hai prelevato?' : 'Quanto hai versato?';
  var amtVal = isSaldo ? (existing ? existing.balance : msBalanceOn(day)) : t ? Math.abs(t.amount) : '';
  var leftVal = isWd ? (t && U.finite(t.left) ? t.left : t ? (diaryOn(day) || {}).balance : startBal) : null;
  var dayChip = function (d, lbl) {
    return '<button type="button" class="ms-chip' + (day === d ? ' on' : '') + '" data-ms-day="' + d + '">' + lbl + '</button>';
  };
  var yest = dAdd(today, -1);
  var otherOn = day !== today && day !== yest;
  var html =
    sheetHead(title, { form: 'ms-form', del: del }) +
    '<form id="ms-form" class="ms ms-' + kind + '" autocomplete="off">' +
    '<label class="ms-amt"><span>' + amtLbl + '</span><span class="ms-amt-row">' + (isSaldo ? '' : '<em>' + (isWd ? '−' : '+') + '</em>') +
    '<input name="amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" required value="' + (amtVal === '' ? '' : U.round(amtVal)) + '"><i>€</i></span></label>' +
    (isWd
      ? '<div class="ms-left"><span class="ms-lbl">Quanto resta sul conto?</span>' +
        '<div class="ms-opts"><button type="button" class="ms-opt" data-ms-left="win"><b>Erano vincite</b><small>resta ' + U.money(startBal) + '</small></button>' +
        '<button type="button" class="ms-opt" data-ms-left="cap"><b>Tolti dal saldo</b><small data-ms-capv>resta ' + U.money(startBal) + '</small></button></div>' +
        '<label class="ms-line"><span>Resta sul conto</span><input name="left" type="number" inputmode="decimal" step="0.01" min="0" required value="' + U.round(leftVal) + '"><i>€</i></label></div>'
      : '') +
    '<div class="ms-when"><span class="ms-lbl">Giorno</span><div class="ms-chips">' + dayChip(today, 'Oggi') + dayChip(yest, 'Ieri') +
    '<button type="button" class="ms-chip' + (otherOn ? ' on' : '') + '" data-ms-other>' + (otherOn ? dShort(day) : 'Altro…') + '</button></div>' +
    '<input type="date" name="day" class="ms-date" max="' + today + '" value="' + day + '"' + (otherOn ? '' : ' hidden') + '></div>' +
    (isSaldo ? '<label class="ms-line ms-note"><span>Nota</span><input name="note" type="text" maxlength="140" placeholder="facoltativa" value="' + U.esc((existing && existing.note) || '') + '"></label>' : '') +
    '<div class="ms-out" id="ms-out"></div><p class="error" id="ms-err"></p></form>';
  var d = sheetModal(html);
  d.classList.add('ms-sheet');
  var f = d.querySelector('form'),
    out = d.querySelector('#ms-out'),
    err = d.querySelector('#ms-err');
  var curDay = function () {
    return f.elements.day.value || today;
  };
  var leftMode = null;
  /* l'importo grande è largo quanto le cifre, con l'€ subito accanto */
  var fit = function () {
    var v = String(f.elements.amt.value || f.elements.amt.placeholder || '0');
    f.elements.amt.style.setProperty('width', Math.max(1.6, v.length * 0.62 + 0.5) + 'em', 'important');
  };
  var refresh = function () {
    fit();
    var dd = curDay(),
      a = Number(f.elements.amt.value),
      ok = f.elements.amt.value !== '' && U.finite(a) && a >= 0;
    if (!isSaldo) startBal = msBalanceOn(dd, t);
    if (isWd) {
      d.querySelector('[data-ms-left="win"] small').textContent = 'resta ' + U.money(startBal);
      d.querySelector('[data-ms-capv]').textContent = 'resta ' + U.money(Math.max(0, startBal - (ok ? a : 0)));
      if (leftMode === 'win') f.elements.left.value = U.round(startBal);
      if (leftMode === 'cap') f.elements.left.value = U.round(Math.max(0, startBal - (ok ? a : 0)));
      var lv = Number(f.elements.left.value);
      d.querySelectorAll('[data-ms-left]').forEach(function (b) {
        var target = b.dataset.msLeft === 'win' ? startBal : Math.max(0, startBal - (ok ? a : 0));
        b.classList.toggle('on', ok && Math.abs(lv - target) < 0.005);
      });
    }
    if (!ok) {
      out.innerHTML = '';
      return;
    }
    /* risultato del giorno dopo il salvataggio */
    var prev = msPrevOf(dd),
      flowsDay = msDayFlows(dd, t && t.id) + (isSaldo ? 0 : (isWd ? -1 : 1) * a),
      dayBal;
    if (isSaldo) dayBal = a;
    else if (isWd) dayBal = Number(f.elements.left.value);
    else {
      var e0 = diaryOn(dd);
      dayBal = e0 ? U.round(e0.balance + a - (t ? Math.abs(t.amount) : 0)) : null;
    }
    var lbl = msDayLabel(dd);
    if (!prev || dayBal == null || !U.finite(dayBal)) {
      out.innerHTML = isSaldo
        ? ''
        : '<div class="ms-res"><span>Sul conto dopo</span><b>' + U.money(U.round(startBal + (isWd ? -a : a))) + '</b></div>';
      return;
    }
    var res = U.round(dayBal - prev.balance - msBetween(prev, dd, t && t.id) - flowsDay);
    var dayTx = realFlows().filter(function (x) { return dayKey(x.date) === dd && (!t || x.id !== t.id); });
    var wdD = U.round(dayTx.filter(function (x) { return x.amount < 0; }).reduce(function (n, x) { return n - x.amount; }, 0) + (isWd ? a : 0)),
      depD = U.round(dayTx.filter(function (x) { return x.amount > 0; }).reduce(function (n, x) { return n + x.amount; }, 0) + (kind === 'deposit' ? a : 0));
    out.innerHTML =
      '<div class="ms-res ' + sClass(res) + '"><span>Risultato di ' + lbl + '</span><b>' + sMoney(res) + '</b></div>' +
      '<p class="ms-ref">' + (prev.start ? 'Rispetto al saldo iniziale' : 'Rispetto a ' + (prev.date === dAdd(dd, -1) ? 'ieri' : dShort(prev.date))) + ' (' + U.money(prev.balance) + ')' +
      (wdD || depD ? '; non contano ' + [wdD ? 'prelievi ' + U.money(wdD) : '', depD ? 'depositi ' + U.money(depD) : ''].filter(Boolean).join(' e ') : '') + '.</p>';
  };
  d.querySelectorAll('[data-ms-day]').forEach(function (b) {
    b.onclick = function () {
      f.elements.day.value = b.dataset.msDay;
      f.elements.day.hidden = true;
      d.querySelectorAll('.ms-chip').forEach(function (x) {
        x.classList.toggle('on', x === b);
      });
      d.querySelector('[data-ms-other]').textContent = 'Altro…';
      if (isSaldo) {
        var ex = diaryOn(b.dataset.msDay);
        f.elements.amt.value = U.round(ex ? ex.balance : msBalanceOn(b.dataset.msDay));
      }
      refresh();
    };
  });
  d.querySelector('[data-ms-other]').onclick = function () {
    var inp = f.elements.day;
    inp.hidden = false;
    d.querySelectorAll('.ms-chip').forEach(function (x) {
      x.classList.toggle('on', x.hasAttribute('data-ms-other'));
    });
    try {
      inp.showPicker();
    } catch (e) {
      inp.focus();
    }
  };
  f.elements.day.addEventListener('change', function () {
    var v = f.elements.day.value;
    d.querySelector('[data-ms-other]').textContent = v ? dShort(v) : 'Altro…';
    refresh();
  });
  d.querySelectorAll('[data-ms-left]').forEach(function (b) {
    b.onclick = function () {
      leftMode = b.dataset.msLeft;
      refresh();
    };
  });
  f.addEventListener('input', function (ev) {
    if (ev.target && ev.target.name === 'left') leftMode = null;
    refresh();
  });
  if (isWd && !t) leftMode = 'win';
  refresh();
  if (!t && !existing)
    setTimeout(function () {
      try {
        f.elements.amt.focus();
        f.elements.amt.select();
      } catch (e) {
        /* ok */
      }
    }, 60);
  f.onsubmit = function (ev) {
    ev.preventDefault();
    err.textContent = '';
    var dd = curDay(),
      a = U.round(Number(f.elements.amt.value));
    if (!dd || dd > today) return (err.textContent = 'Scegli oggi o un giorno passato.');
    if (!U.finite(a) || a < 0 || (!isSaldo && a <= 0)) return (err.textContent = 'Scrivi un importo valido.');
    if (isSaldo) {
      var other = diaryOn(dd);
      if (diarySave(other || existing || null, dd, a, String(f.elements.note.value || '').trim().slice(0, 140))) {
        d.close();
        U.toast('Saldo aggiornato');
      }
      return;
    }
    var left = isWd ? U.round(Number(f.elements.left.value)) : null;
    if (isWd && (!U.finite(left) || left < 0)) return (err.textContent = 'Scrivi quanto resta sul conto.');
    var when = t && dayKey(t.date) === dd ? new Date(t.date) : dd === today ? new Date() : new Date(dd + 'T20:00:00');
    var ok = mutate(function (n) {
      var old = t ? n.transactions.find(function (x) { return x.id === t.id; }) : null;
      var obj = { id: t ? t.id : U.uid(), account: n.accounts[0].id, amount: isWd ? -a : a, date: when.toISOString() };
      if (isWd) obj.left = left;
      n.transactions = t ? n.transactions.map(function (x) { return x.id === t.id ? obj : x; }) : n.transactions.concat([obj]);
      n.diary = n.diary || [];
      var e = n.diary.find(function (x) { return x.date === dd; });
      if (isWd) {
        /* il saldo del giorno diventa quello rimasto sul conto */
        if (!e) n.diary.push((e = { id: U.uid(), date: dd, balance: 0 }));
        e.balance = left;
        e.updatedAt = new Date().toISOString();
      } else if (e) {
        /* deposito in un giorno già segnato: il saldo sale della stessa cifra */
        e.balance = U.round(e.balance + a - (old && dayKey(old.date) === dd ? old.amount : 0));
        e.updatedAt = new Date().toISOString();
      }
    });
    if (ok) {
      d.close();
      U.toast(isWd ? 'Prelievo segnato' : 'Deposito segnato');
    }
  };
  var delB = d.querySelector('#ms-del');
  if (delB)
    delB.onclick = async function () {
      if (isSaldo) {
        if (!(await U.confirm({ title: 'Eliminare il saldo di questo giorno?', text: 'Depositi e prelievi restano.' }))) return;
        if (mutate(function (n) { n.diary = (n.diary || []).filter(function (x) { return x.id !== existing.id; }); })) {
          d.close();
          U.toast('Saldo del giorno eliminato');
        }
        return;
      }
      if (!(await U.confirm({ title: 'Eliminare questo movimento?', text: 'Il saldo segnato del giorno non cambia.', detail: (isWd ? 'Prelievo' : 'Deposito') + ' · ' + U.money(Math.abs(t.amount)) + ' · ' + U.date(t.date) }))) return;
      if (mutate(function (n) { n.transactions = n.transactions.filter(function (x) { return x.id !== t.id; }); })) {
        d.close();
        U.toast('Movimento eliminato');
      }
    };
  return d;
}
function diaryForm(date) {
  return moneySheet('saldo', { date: date });
}
/* 4.9.0 — pagina Saldo: in alto quanto hai sul conto e il risultato di oggi, sotto i tre numeri (versato, vinto/perso,
   prelevato) in una riga, tre pulsanti, poi i movimenti di oggi in ordine di orario.
   4.21.5 — RIQUADRO "SUL CONTO" RIFATTO: carta a colori (verde petrolio) con la cifra grande (centesimi più piccoli),
   le pastiglie Oggi e 7 giorni, l'andamento degli ultimi 30 giorni disegnato sotto la cifra, i tre numeri in caselle con
   l'icona e i pulsanti. Chiuso a tendina resta una riga: "Sul conto" e la cifra. Restituisce { hero, day }: la pagina
   mette il Calendario tra i due. */
function sdSpark(series) {
  var pts = series.filter(function (p) { return U.finite(p.balance); }).slice(-30);
  if (pts.length < 2) return '';
  var W = 300, H = 56, vals = pts.map(function (p) { return p.balance; }), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), rg = hi - lo || 1;
  var xy = pts.map(function (p, i) { return [Math.round(i / (pts.length - 1) * W * 10) / 10, Math.round((H - 6 - (p.balance - lo) / rg * (H - 14)) * 10) / 10]; });
  var line = xy.map(function (q, i) { return (i ? 'L' : 'M') + q[0] + ' ' + q[1]; }).join(' ');
  var last = xy[xy.length - 1];
  return '<svg class="sd-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sdSparkG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + line + ' L' + W + ' ' + H + ' L0 ' + H + ' Z" fill="url(#sdSparkG)"/><path d="' + line + '" fill="none" stroke="#fff" stroke-opacity=".85" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.2" fill="#fff"/></svg>';
}
/* 4.22.3 — ANDAMENTO DEL VINTO IN TOTALE (dal primo giorno a oggi): per ogni giorno segnato saldo − saldo iniziale −
   depositi + prelievi fino a quel giorno (perf della serie meno il saldo iniziale), lo stesso numero di "Vinto in totale".
   Linea tratteggiata sullo zero: sopra sei in vincita, sotto in perdita. */
function sdSparkRes(series) {
  var ini = U.round((db.accounts[0] || {}).initial || 0);
  var pts = series.filter(function (p) { return U.finite(p.perf); }).map(function (p) { return U.round(p.perf - ini); });
  if (series.start) pts.unshift(0);
  if (pts.length > 120) { var step = (pts.length - 1) / 119, smp = []; for (var k = 0; k < 120; k++) smp.push(pts[Math.round(k * step)]); pts = smp; }
  if (pts.length < 2) return '';
  var W = 300, H = 52, lo = Math.min(0, Math.min.apply(null, pts)), hi = Math.max(0, Math.max.apply(null, pts)), rg = hi - lo || 1;
  var Y = function (v) { return Math.round((H - 5 - (v - lo) / rg * (H - 12)) * 10) / 10; };
  var xy = pts.map(function (v, i) { return [Math.round(i / (pts.length - 1) * W * 10) / 10, Y(v)]; });
  var line = xy.map(function (q, i) { return (i ? 'L' : 'M') + q[0] + ' ' + q[1]; }).join(' '), y0 = Y(0), last = xy[xy.length - 1];
  return '<svg class="sd-spark sd-spark-res" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="sdResG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".3"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>' +
    '<path d="' + line + ' L' + W + ' ' + y0 + ' L0 ' + y0 + ' Z" fill="url(#sdResG)"/>' +
    '<path d="M0 ' + y0 + ' L' + W + ' ' + y0 + '" stroke="#fff" stroke-opacity=".45" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>' +
    '<path d="' + line + '" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.2" fill="#fff"/></svg>';
}
function sdMoneyBig(n) {
  var t = U.money(n), m = /^(.*?)([,.]\d{2})(\s*€.*)$/.exec(t);
  return m ? '<span class="sd-int">' + U.esc(m[1]) + '</span><span class="sd-dec">' + U.esc(m[2] + m[3]) + '</span>' : '<span class="sd-int">' + U.esc(t) + '</span>';
}
function saldoHomeHtml() {
  var P = saldoParts(),
    today = dToday(),
    series = diarySeries(),
    te = series.find(function (p) { return p.date === today; }) || null,
    last = series[series.length - 1] || null;
  var todayRes = te && te.delta != null ? te.delta : null;
  var mv = dayMovements(today);
  var wdToday = U.round(mv.filter(function (x) { return x.t.amount < 0; }).reduce(function (n, x) { return n - x.t.amount; }, 0));
  var hm = function (iso) { return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }); };
  var w7 = diaryChange(series, 7);
  var pill = function (label, v) {
    var c = v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero';
    return '<span class="sd-pill ' + c + '"><i aria-hidden="true">' + (v > 0 ? '▲' : v < 0 ? '▼' : '●') + '</i><b>' + U.money(Math.abs(v)) + '</b><small>' + label + '</small></span>';
  };
  var pills = (todayRes != null ? pill('oggi', todayRes) : '<span class="sd-pill wait"><small>' + (last ? 'ultimo saldo ' + (last.date === dAdd(today, -1) ? 'ieri' : dShort(last.date)) : 'segna il primo saldo per iniziare') + '</small></span>') +
    (w7 ? pill('7 giorni', w7.value) : '') + (wdToday ? '<span class="sd-pill out"><i aria-hidden="true">↑</i><b>' + U.money(wdToday) + '</b><small>prelevati oggi</small></span>' : '');
  var chip = te ? '<span class="sd-chip ok"><i aria-hidden="true">✓</i>' + (te.updatedAt ? 'Aggiornato alle ' + hm(te.updatedAt) : 'Aggiornato oggi') + '</span>' : '<span class="sd-chip todo"><i aria-hidden="true"></i>Da aggiornare</span>';
  var tile = function (cls, ic, label, val, vcls) { return '<div class="sd-tile ' + cls + '"><small><i class="sd-tic" aria-hidden="true">' + ic + '</i>' + label + '</small><b class="' + (vcls || '') + '">' + val + '</b></div>'; };
  /* 4.22.3 — VINTO / PERSO IN EVIDENZA, CARTA COMPATTA: la cifra sul conto e il vinto (o perso) in totale nella stessa riga,
     il risultato in una pastiglia colorata (bianca con la cifra verde se sei sopra, rossa se sei sotto); il grafico mostra
     l'andamento del vinto in totale dal primo giorno (sdSparkRes). */
  var rc = P.res > 0.004 ? 'up' : P.res < -0.004 ? 'dn' : 'eq';
  var resBox = '<div class="sd-res ' + rc + '"><small>' + (rc === 'up' ? 'Vinto in totale' : rc === 'dn' ? 'Perso in totale' : 'In pari') + '</small>' +
    '<b class="sd-res-v"><i aria-hidden="true">' + (rc === 'up' ? '▲' : rc === 'dn' ? '▼' : '●') + '</i>' + sdMoneyBig(Math.abs(P.res)).replace('<span class="sd-int">', '<span class="sd-int">' + (rc === 'up' ? '+' : rc === 'dn' ? '−' : '')) + '</b></div>';
  var spark = sdSparkRes(series);
  var hero =
    '<section class="card sd-hero sd-hero2' + (todayRes != null && todayRes < 0 ? ' down' : '') + '" data-cx="saldo-hero">' +
    '<div class="sd-top"><span class="sd-lab">Sul conto</span><b class="sd-mini">' + U.money(P.cur) + ' <span class="sd-mini-r ' + rc + '">' + sMoney(P.res) + '</span></b>' + chip + '</div>' +
    '<div class="sd-row"><div class="sd-big">' + sdMoneyBig(P.cur) + '</div>' + resBox + '</div>' +
    '<div class="sd-pills">' + pills + '</div>' +
    (spark ? '<div class="sd-sparkw">' + spark + '<small class="sd-spark-l">' + (rc === 'dn' ? 'Perso' : 'Vinto') + ' in totale' + (series.length ? ' dal ' + U.esc(dShort((series.start || series[0]).date)) : '') + '</small></div>' : '') +
    '<div class="sd-tiles sd-tiles2">' + tile('dep', '↓', 'Versato', U.money(P.dep)) + tile('wd', '↑', 'Prelevato', U.money(P.wd)) + '</div>' +
    '<div class="sd-actions"><button type="button" class="sd-main" data-ms="saldo"><span aria-hidden="true">✎</span> Aggiorna saldo</button><button type="button" class="sd-btn out" data-ms="withdraw"><span aria-hidden="true">↑</span>Prelievo</button><button type="button" class="sd-btn in" data-ms="deposit"><span aria-hidden="true">↓</span>Deposito</button></div></section>';
  /* movimenti di oggi */
  var items = mv.map(function (x) {
    var a = x.t.amount, out = a < 0;
    var note = out && U.finite(x.t.left) ? 'resta ' + U.money(x.t.left) : '';
    return { at: x.at, html: '<button type="button" class="sd-ev ' + (out ? 'out' : 'in') + '" data-ms-tx="' + x.t.id + '"><span class="sd-ev-ic" aria-hidden="true">' + (out ? '↑' : '↓') + '</span><span class="sd-ev-m"><b>' + (out ? 'Prelievo' : 'Deposito') + '</b><small>' + hm(x.at) + (note ? ' · ' + note : '') + '</small></span><strong>' + (out ? '−' : '+') + U.money(Math.abs(a)) + '</strong></button>' };
  });
  if (te) items.push({ at: te.updatedAt || today + 'T23:59:00', html: '<button type="button" class="sd-ev bal" data-ms="saldo"><span class="sd-ev-ic" aria-hidden="true">✎</span><span class="sd-ev-m"><b>Saldo di oggi</b><small>' + (te.updatedAt ? 'aggiornato alle ' + hm(te.updatedAt) : 'segnato') + (te.note ? ' · ' + U.esc(te.note) : '') + '</small></span><strong>' + U.money(te.balance) + '</strong></button>' });
  items.sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
  /* 4.21.5 — senza la frase di spiegazione quando oggi non c'è niente */
  var day =
    '<section class="card sd-day" data-cx="oggi"><div class="sd-day-h"><h2>Oggi</h2>' + (todayRes != null ? '<b class="' + sClass(todayRes) + '">' + sMoney(todayRes) + '</b>' : '') + '</div>' +
    (items.length ? '<div class="sd-evs">' + items.map(function (x) { return x.html; }).join('') + '</div>' : '<p class="muted sd-empty">Nessun movimento oggi.</p>') +
    '</section>';
  return { hero: hero, day: day };
}

/* =========================================================================================================
   4.26.0 — OBIETTIVO DEL MESE (Saldo, in cima). Es. 900 € al mese = 30 € al giorno.
   - Ogni giorno segni il risultato ("Segna il risultato di oggi": vinto/perso) oppure aggiorni il saldo come prima:
     il risultato del giorno è sempre quello del diario (depositi e prelievi non contano).
   - Obiettivo di oggi = quanto manca al mese diviso i giorni rimasti, MAI più dell'obiettivo al giorno (30 €):
     se un giorno fai di più, nei giorni dopo ti serve meno; se sei indietro non ti chiede di più (niente rincorse).
   - Raggiunto l'obiettivo di oggi, o persa la cifra di stop del giorno, l'app ti dice di fermarti (anche in
     Prepartita e Live, nella striscia in alto).
   db.settings.goal = { month: 900, day: 30, stop: 30 }  (month 0 = obiettivo spento)
   ========================================================================================================= */
function goalCfg() {
  var g = (db.settings && db.settings.goal) || {};
  var num = function (v, d) { return U.finite(Number(v)) && Number(v) >= 0 ? U.round(Number(v)) : d; };
  return { month: num(g.month, 900), day: num(g.day, 30), stop: num(g.stop, 30) };
}
function goalState() {
  var cfg = goalCfg(), today = dToday(), key = today.slice(0, 7);
  var y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)), D = new Date(y, m, 0).getDate(), t = Number(today.slice(8, 10));
  var series = diarySeries(), byDay = {};
  series.forEach(function (p) { if (p.date.slice(0, 7) === key && p.delta != null) byDay[p.date] = p.delta; });
  /* giorno per giorno: obiettivo del giorno (con quanto fatto prima) e risultato */
  var run = 0, days = [], todayTarget = 0, before = 0;
  for (var d = 1; d <= D; d++) {
    var iso = key + '-' + String(d).padStart(2, '0');
    var target = cfg.month > 0 ? Math.max(0, Math.min(cfg.day || Infinity, (cfg.month - run) / (D - d + 1))) : cfg.day;
    target = U.round(target);
    var r = Object.prototype.hasOwnProperty.call(byDay, iso) ? byDay[iso] : null;
    if (iso === today) { todayTarget = target; before = U.round(run); }
    var cls = iso > today ? 'fut' : r == null ? (iso === today ? 'none' : 'none') : r < -0.004 ? 'loss' : target > 0 && r >= target - 0.004 ? 'win' : r > 0.004 ? 'part' : target <= 0 ? 'win' : 'zero';
    days.push({ iso: iso, d: d, r: r, target: target, cls: cls, today: iso === today });
    if (r != null && iso <= today) run += r;
  }
  var res = U.round(run), todayRes = Object.prototype.hasOwnProperty.call(byDay, today) ? byDay[today] : null;
  var left = U.round(cfg.month - res), daysLeft = D - t + 1;
  var plan = cfg.month > 0 ? U.round((cfg.month * (t - 1)) / D) : 0;
  var status = 'todo';
  if (cfg.month > 0 && res >= cfg.month - 0.004) status = 'month';
  else if (todayRes != null && cfg.stop > 0 && todayRes <= -cfg.stop + 0.004) status = 'stop';
  else if (todayRes != null && todayTarget > 0 && todayRes >= todayTarget - 0.004) status = 'done';
  var tr = todayRes == null ? 0 : todayRes;
  return {
    cfg: cfg, key: key, D: D, t: t, days: days, res: res, before: before, left: left, daysLeft: daysLeft,
    ahead: U.round(before - plan), todayRes: todayRes, todayTarget: todayTarget, status: status,
    proj: U.round(res + Math.max(0, cfg.day) * (daysLeft - (todayRes != null && status !== 'todo' ? 1 : 0)) - (status === 'todo' ? tr : 0)),
    win: days.filter(function (x) { return x.cls === 'win' && !x.today; }).length + (status === 'done' || status === 'month' ? 1 : 0),
    loss: days.filter(function (x) { return x.cls === 'loss'; }).length,
    part: days.filter(function (x) { return (x.cls === 'part' || x.cls === 'zero') && !(x.today && status !== 'todo'); }).length,
  };
}
function goalMsg(G) {
  var tr = G.todayRes == null ? 0 : G.todayRes;
  if (G.status === 'month') return { cls: 'done', ic: '🎉', txt: 'Obiettivo del mese raggiunto. Per questo mese basta.' };
  if (G.status === 'done') return { cls: 'done', ic: '✓', txt: 'Obiettivo di oggi raggiunto: fermati qui, si riprende domani.' };
  if (G.status === 'stop') return { cls: 'stop', ic: '⛔', txt: 'Hai perso ' + U.money(-tr) + ' oggi: per oggi fermati.' };
  if (G.todayRes == null) return { cls: 'todo', ic: '', txt: 'Ti fermi a +' + U.money(G.todayTarget) + (G.cfg.stop > 0 ? ' o a −' + U.money(G.cfg.stop) : '') + '.' };
  return { cls: 'todo', ic: '', txt: 'Mancano ' + U.money(Math.max(0, U.round(G.todayTarget - tr))) + (G.cfg.stop > 0 ? ' · stop a −' + U.money(G.cfg.stop) : '') };
}
function goalCardHtml() {
  var G = goalState(), cfg = G.cfg;
  if (!(cfg.month > 0)) return '<section class="card gl-card gl-off" data-cx-off><div class="gl-h"><h2>Obiettivo del mese</h2><button type="button" class="gl-set" data-goal-set>Imposta</button></div><p class="muted gl-p">Spento. Imposta quanto vuoi fare al mese e al giorno.</p></section>';
  var mon = new Date(G.key + '-01T12:00:00').toLocaleDateString('it-IT', { month: 'long' });
  var pc = Math.max(0, Math.min(100, (G.res / cfg.month) * 100)), planPc = Math.min(100, ((G.t - 1) / G.D) * 100);
  var tr = G.todayRes == null ? 0 : G.todayRes, tp = G.todayTarget > 0 ? Math.max(0, Math.min(100, (tr / G.todayTarget) * 100)) : 100;
  var msg = goalMsg(G);
  var sub = G.status === 'month'
    ? 'Fatto ' + U.money(G.res) + ' su ' + U.money(cfg.month)
    : (G.ahead >= 0.5 ? 'Avanti di ' + U.money(G.ahead) : G.ahead <= -0.5 ? 'Indietro di ' + U.money(-G.ahead) : 'In linea') + ' sul piano (' + U.money(cfg.day) + ' al giorno) · ' + G.daysLeft + (G.daysLeft === 1 ? ' giorno' : ' giorni') +
      ' · così chiudi a ' + U.money(G.proj);
  var dots = G.days.map(function (x) {
    var tt = x.r == null ? (x.cls === 'fut' ? '' : 'non segnato') : sMoney(x.r) + (x.target > 0 ? ' su ' + U.money(x.target) : '');
    return '<span class="gl-dot ' + x.cls + (x.today ? ' today' : '') + '" title="' + x.d + ' ' + mon + (tt ? ': ' + tt : '') + '">' + x.d + '</span>';
  }).join('');
  return '<section class="card gl-card" data-cx-off>' +
    '<div class="gl-h"><h2>Obiettivo di ' + U.esc(mon) + '</h2><button type="button" class="gl-set" data-goal-set aria-label="Modifica l\'obiettivo">Modifica</button></div>' +
    '<div class="gl-month"><b class="' + sClass(G.res) + '">' + sMoney(G.res) + '</b><span>di ' + U.money(cfg.month) + '</span><em>' + (G.left > 0.004 ? 'mancano ' + U.money(G.left) : 'fatto ✓') + '</em></div>' +
    '<div class="gl-bar" aria-hidden="true"><i style="width:' + pc.toFixed(1) + '%"></i><em style="left:' + planPc.toFixed(1) + '%"></em></div>' +
    '<p class="gl-sub">' + sub + '</p>' +
    '<div class="gl-today ' + msg.cls + '">' +
    '<div class="gl-tl"><small>Oggi' + (G.todayTarget > 0 && G.status !== 'month' ? ' · obiettivo ' + U.money(G.todayTarget) : '') + '</small><b class="' + (G.todayRes == null ? '' : sClass(tr)) + '">' + (G.todayRes == null ? '—' : sMoney(tr)) + '</b></div>' +
    (G.status === 'month' ? '' : '<div class="gl-tbar" aria-hidden="true"><i class="' + (tr < 0 ? 'neg' : '') + '" style="width:' + (tr < 0 ? Math.min(100, (-tr / (cfg.stop || cfg.day || 1)) * 100) : tp).toFixed(1) + '%"></i></div>') +
    '<p class="gl-msg">' + (msg.ic ? '<i aria-hidden="true">' + msg.ic + '</i> ' : '') + msg.txt + '</p>' +
    '<button type="button" class="gl-btn" data-goal-res>' + (G.todayRes == null ? 'Segna il risultato di oggi' : 'Correggi il risultato di oggi') + '</button></div>' +
    '<div class="gl-days" aria-label="Giorni del mese">' + dots + '</div>' +
    '<p class="gl-leg"><span class="gl-dot win"></span>' + G.win + ' a obiettivo <span class="gl-dot part"></span>' + G.part + ' sotto <span class="gl-dot loss"></span>' + G.loss + ' in perdita</p>' +
    '</section>';
}
/* striscia in Prepartita e Live: com'è oggi, e "fermati" quando serve */
function goalStripHtml() {
  var G = goalState();
  if (!(G.cfg.month > 0)) return '';
  var msg = goalMsg(G), tr = G.todayRes == null ? null : G.todayRes;
  if (msg.cls !== 'todo') return '<button type="button" class="gl-strip ' + msg.cls + '" data-goal-go><i aria-hidden="true">' + msg.ic + '</i><span>' + msg.txt + '</span></button>';
  return '<button type="button" class="gl-strip todo" data-goal-go><span>Oggi <b class="' + (tr == null ? '' : sClass(tr)) + '">' + (tr == null ? '—' : sMoney(tr)) + '</b> / ' + U.money(G.todayTarget) + '</span><span>Mese <b class="' + sClass(G.res) + '">' + sMoney(G.res) + '</b> / ' + U.money(G.cfg.month) + '</span></button>';
}
function goalSettingsSheet() {
  var c = goalCfg();
  var row = function (name, lbl, v, hint) {
    return '<label class="ms-line gl-line"><span>' + lbl + (hint ? '<small>' + hint + '</small>' : '') + '</span><input name="' + name + '" type="number" inputmode="decimal" step="1" min="0" value="' + (v || '') + '" placeholder="0"><i>€</i></label>';
  };
  var d = sheetModal(sheetHead('Obiettivo', { form: 'gl-set-form' }) +
    '<form id="gl-set-form" class="ms" autocomplete="off">' +
    row('month', 'Al mese', c.month, '0 = obiettivo spento') +
    row('day', 'Al giorno', c.day, 'il massimo che ti chiede in un giorno') +
    row('stop', 'Stop perdita al giorno', c.stop, 'oltre questa perdita ti dice di fermarti') +
    '<p class="error" id="gl-set-err"></p></form>');
  d.classList.add('ms-sheet');
  var f = d.querySelector('form');
  f.onsubmit = function (ev) {
    ev.preventDefault();
    var v = function (n) { var x = Number(f.elements[n].value || 0); return U.finite(x) && x >= 0 ? U.round(x) : NaN; };
    var g = { month: v('month'), day: v('day'), stop: v('stop') };
    if (![g.month, g.day, g.stop].every(U.finite)) return (d.querySelector('#gl-set-err').textContent = 'Scrivi importi validi.');
    if (g.month > 0 && !(g.day > 0)) g.day = U.round(g.month / 30);
    if (mutate(function (n) { n.settings.goal = g; })) { d.close(); U.toast('Obiettivo salvato'); }
  };
  return d;
}
function goalResultSheet() {
  var today = dToday(), prev = msPrevOf(today), e = diaryOn(today);
  if (!prev) { U.toast('Per il primo giorno scrivi quanto hai sul conto'); return moneySheet('saldo'); }
  var G = goalState(), cur = G.todayRes, sign = cur != null && cur < 0 ? -1 : 1;
  var base = U.round(prev.balance + msBetween(prev, today) + msDayFlows(today));
  var d = sheetModal(sheetHead('Risultato di oggi', { form: 'gl-res-form', sub: G.todayTarget > 0 ? 'obiettivo ' + U.money(G.todayTarget) : '' }) +
    '<form id="gl-res-form" class="ms" autocomplete="off">' +
    '<div class="gl-seg" role="group"><button type="button" data-sign="1">Vinto</button><button type="button" data-sign="-1">Perso</button></div>' +
    '<label class="ms-amt"><span>Quanto?</span><span class="ms-amt-row"><em data-sign-ic>+</em><input name="amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0" required value="' + (cur != null ? U.round(Math.abs(cur)) : '') + '"><i>€</i></span></label>' +
    '<p class="ms-ref" id="gl-res-out"></p><p class="error" id="gl-res-err"></p></form>');
  d.classList.add('ms-sheet');
  var f = d.querySelector('form'), out = d.querySelector('#gl-res-out');
  var paint = function () {
    d.querySelectorAll('[data-sign]').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.sign) === sign); });
    d.querySelector('[data-sign-ic]').textContent = sign > 0 ? '+' : '−';
    var a = Number(f.elements.amt.value);
    var ok = f.elements.amt.value !== '' && U.finite(a) && a >= 0;
    out.textContent = ok ? 'Il saldo di oggi diventa ' + U.money(U.round(base + sign * a)) + ' (rispetto a ' + (prev.start ? 'saldo iniziale' : prev.date === dAdd(today, -1) ? 'ieri' : dShort(prev.date)) + ': ' + U.money(prev.balance) + ').' : '';
  };
  d.querySelectorAll('[data-sign]').forEach(function (b) { b.onclick = function () { sign = Number(b.dataset.sign); paint(); }; });
  f.addEventListener('input', paint);
  paint();
  setTimeout(function () { try { f.elements.amt.focus(); f.elements.amt.select(); } catch (e) { /* ok */ } }, 60);
  f.onsubmit = function (ev) {
    ev.preventDefault();
    var a = U.round(Number(f.elements.amt.value)), err = d.querySelector('#gl-res-err');
    if (!U.finite(a) || a < 0) return (err.textContent = 'Scrivi un importo valido.');
    var bal = U.round(base + sign * a);
    if (bal < 0) return (err.textContent = 'Il saldo verrebbe sotto zero: controlla la cifra.');
    if (diarySave(e || null, today, bal, (e && e.note) || '')) { d.close(); U.toast('Risultato di oggi segnato'); }
  };
  return d;
}
function bindGoal(root) {
  (root || main).querySelectorAll('[data-goal-set]').forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); goalSettingsSheet(); }; });
  (root || main).querySelectorAll('[data-goal-res]').forEach(function (b) { b.onclick = function (ev) { ev.stopPropagation(); goalResultSheet(); }; });
  (root || main).querySelectorAll('[data-goal-go]').forEach(function (b) { b.onclick = function () { diaryUI.homeView = 'home'; setTab('home'); window.scrollTo(0, 0); }; });
}

function diarySave(existing, date, value, note) {
  return mutate(function (n) {
    n.diary = n.diary || [];
    var e = existing
      ? n.diary.find(function (x) {
          return x.id === existing.id;
        })
      : null;
    if (!e) {
      e = { id: U.uid(), date: date, balance: 0 };
      n.diary.push(e);
    }
    var oldDate = e.date;
    e.date = date;
    e.balance = U.round(value);
    e.updatedAt = new Date().toISOString();
    if (note) e.note = note;
    else delete e.note;
    // 3.0.0 — il saldo dell'app viene dal diario: niente più movimenti di allineamento.
    void oldDate;
  });
}

/* ---------- Agenda: scelta rapida del mese (come nelle altre app) ----------
   Tocca o tieni premuto il nome del mese: si apre l'elenco con i 3 mesi prima e i 3 dopo.
   I mesi futuri restano visibili ma spenti, come la freccia ›. */
function closeMonthPicker() {
  var p = document.getElementById('dcalMonthPop');
  if (p) p.remove();
  document.removeEventListener('pointerdown', monthPickerOutside, true);
  window.removeEventListener('scroll', closeMonthPicker, true);
}
function monthPickerOutside(e) {
  if (!e.target.closest('#dcalMonthPop') && !e.target.closest('[data-dcal-pick]')) closeMonthPicker();
}
function openMonthPicker(anchor) {
  closeMonthPicker();
  var cur = diaryUI.month || dToday().slice(0, 7),
    nowM = dToday().slice(0, 7),
    base = dParse(cur + '-01');
  var rows = '';
  for (var i = -3; i <= 3; i++) {
    var d = new Date(base.getFullYear(), base.getMonth() + i, 1),
      key = U.local(d).slice(0, 7),
      future = key > nowM;
    rows +=
      '<button type="button" class="mp-row' +
      (i === 0 ? ' active' : '') +
      '" data-mp="' +
      key +
      '"' +
      (future ? ' disabled' : '') +
      '><b>' +
      d.toLocaleDateString('it-IT', { month: 'long' }) +
      '</b><small>' +
      (key === nowM ? 'questo mese · ' : '') +
      d.getFullYear() +
      '</small></button>';
  }
  var pop = document.createElement('div');
  pop.id = 'dcalMonthPop';
  pop.className = 'lp-popup mp-popup';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Scegli il mese');
  pop.innerHTML = '<div class="lp-head">Scegli il mese</div><div class="mp-list">' + rows + '</div>';
  document.body.appendChild(pop);
  pop.querySelectorAll('[data-mp]').forEach(function (b) {
    b.onclick = function () {
      diaryUI.month = b.dataset.mp;
      closeMonthPicker();
      render();
    };
  });
  var r = anchor.getBoundingClientRect(),
    vw = window.innerWidth,
    vh = window.innerHeight,
    w = Math.min(230, vw - 24);
  pop.style.width = w + 'px';
  pop.style.left = Math.min(Math.max(12, r.left), vw - w - 12) + 'px';
  var ph = pop.offsetHeight,
    top = r.bottom + 8;
  if (top + ph > vh - 90) top = Math.max(12, r.top - ph - 8);
  pop.style.top = top + 'px';
  requestAnimationFrame(function () {
    pop.classList.add('show');
  });
  setTimeout(function () {
    document.addEventListener('pointerdown', monthPickerOutside, true);
    window.addEventListener('scroll', closeMonthPicker, true);
  }, 0);
}
function bindMonthPicker(el) {
  var timer = null,
    x = 0,
    y = 0,
    fired = false;
  var cancel = function () {
    clearTimeout(timer);
    timer = null;
    el.classList.remove('lp-pressing');
  };
  el.addEventListener('pointerdown', function (e) {
    if (e.button) return;
    x = e.clientX;
    y = e.clientY;
    fired = false;
    el.classList.add('lp-pressing');
    timer = setTimeout(function () {
      timer = null;
      fired = true;
      el.classList.remove('lp-pressing');
      try {
        navigator.vibrate && navigator.vibrate(12);
      } catch (_) {}
      openMonthPicker(el);
    }, 450);
  });
  el.addEventListener('pointermove', function (e) {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
    el.addEventListener(ev, cancel);
  });
  el.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
  el.addEventListener('click', function () {
    if (fired) {
      fired = false;
      return;
    }
    if (document.getElementById('dcalMonthPop')) closeMonthPicker();
    else openMonthPicker(el);
  });
}

/* ---------- 2.6.0 — Agenda: tocca un giorno ----------
   Se quel giorno ci sono movimenti (depositi, prelievi, scommesse giocate o chiuse) si apre
   il riepilogo del giorno, una scheda per movimento in ordine di orario. Dal riepilogo si può
   segnare o correggere il saldo. Se non c'è niente, si apre direttamente "Segna saldo". */
function dayKey(iso) {
  return iso ? U.local(new Date(iso)).slice(0, 10) : '';
}
function dayMovements(date) {
  return realFlows()
    .filter(function (t) {
      return dayKey(t.date) === date;
    })
    .map(function (t) {
      return { at: t.date, kind: t.amount >= 0 ? 'dep' : 'wd', t: t };
    })
    .sort(function (a, b) {
      return new Date(a.at) - new Date(b.at);
    });
}
function dayHasMovements(date) {
  return dayMovements(date).length > 0;
}
function dayFlowSign(date) {
  var n = dayMovements(date).reduce(function (s, x) {
    return s + x.t.amount;
  }, 0);
  return n > 0.004 ? 'in' : n < -0.004 ? 'out' : dayHasMovements(date) ? 'mix' : '';
}
function openDayPanel(date) {
  /* 4.9.0 — giorno del calendario: risultato in grande, poi saldo e movimenti in elenco (niente riquadri) */
  var list = dayMovements(date);
  var entry =
    diarySeries().find(function (p) {
      return p.date === date;
    }) || null;
  if (!list.length && !entry) return moneySheet('saldo', { date: date });
  var hm = function (iso) {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };
  var res = entry && entry.delta != null ? entry.delta : null;
  var rows = list
    .map(function (x) {
      var a = x.t.amount,
        out = a < 0;
      return (
        '<button type="button" class="sd-ev ' + (out ? 'out' : 'in') + '" data-day-tx="' + x.t.id + '"><span class="sd-ev-ic" aria-hidden="true">' + (out ? '↑' : '↓') + '</span><span class="sd-ev-m"><b>' + (out ? 'Prelievo' : 'Deposito') + '</b><small>' + hm(x.at) + (out && U.finite(x.t.left) ? ' · resta ' + U.money(x.t.left) : '') + '</small></span><strong>' + (out ? '−' : '+') + U.money(Math.abs(a)) + '</strong></button>'
      );
    })
    .join('');
  if (entry)
    rows =
      '<button type="button" class="sd-ev bal" id="day-diary"><span class="sd-ev-ic" aria-hidden="true">✎</span><span class="sd-ev-m"><b>Saldo del giorno</b><small>' + (entry.note ? U.esc(entry.note) : 'tocca per correggere') + '</small></span><strong>' + U.money(entry.balance) + '</strong></button>' + rows;
  var title = dParse(date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  var d = sheetModal(
    sheetHead(title.charAt(0).toUpperCase() + title.slice(1)) +
      '<div class="ms day-ms">' +
      (res != null
        ? '<div class="ms-res ' + sClass(res) + '"><span>Risultato del giorno</span><b>' + sMoney(res) + '</b></div><p class="ms-ref">Rispetto a ' + (entry.prev.start ? 'saldo iniziale' : dShort(entry.prev.date)) + ' (' + U.money(entry.prev.balance) + ')</p>'
        : (entry ? '' : '<p class="ms-ref">Saldo del giorno non segnato.</p>')) +
      '<div class="sd-evs">' + rows + '</div>' +
      '<div class="sd-actions">' + (entry ? '' : '<button type="button" class="sd-main" id="day-diary2">✎ Segna il saldo del giorno</button>') +
      '<button type="button" class="sd-btn out" id="day-wd"><span aria-hidden="true">↑</span>Prelievo</button><button type="button" class="sd-btn in" id="day-dep"><span aria-hidden="true">↓</span>Deposito</button></div></div>',
  );
  d.classList.add('day-sheet', 'ms-sheet');
  var go = function (fn) {
    return function () {
      d.close();
      fn();
    };
  };
  ['#day-diary', '#day-diary2'].forEach(function (q) {
    var b = d.querySelector(q);
    if (b) b.onclick = go(function () { moneySheet('saldo', { date: date }); });
  });
  d.querySelector('#day-dep').onclick = go(function () { moneySheet('deposit', { date: date }); });
  d.querySelector('#day-wd').onclick = go(function () { moneySheet('withdraw', { date: date }); });
  d.querySelectorAll('[data-day-tx]').forEach(function (b) {
    b.onclick = function () {
      var t = db.transactions.find(function (x) {
        return x.id === b.dataset.dayTx;
      });
      if (!t) return;
      d.close();
      moneySheet(t.amount < 0 ? 'withdraw' : 'deposit', { t: t });
    };
  });
}

/* ---------- Eventi ---------- */
function bindDiary() {
  bindDiaryExtra();
  bindGoal(); /* 4.26.0 */
  diaryScrubBind(); /* 4.23.0 — grafici dell'Andamento: tocca o trascina */
  calBind(); /* 4.23.0 — calendario: mesi in striscia e scorrimento */
  /* 4.9.0 — pannello unico Aggiorna saldo / Prelievo / Deposito */
  main.querySelectorAll('[data-ms]').forEach(function (b) {
    b.onclick = function () {
      moneySheet(b.dataset.ms);
    };
  });
  main.querySelectorAll('[data-ms-tx]').forEach(function (b) {
    b.onclick = function () {
      var t = db.transactions.find(function (x) {
        return x.id === b.dataset.msTx;
      });
      if (t) moneySheet(t.amount < 0 ? 'withdraw' : 'deposit', { t: t });
    };
  });
  main.querySelectorAll('[data-diary-edit]').forEach(function (b) {
    b.onclick = function () {
      diaryForm(b.dataset.diaryEdit);
    };
  });
  main.querySelectorAll('[data-dcal]').forEach(function (b) {
    b.onclick = function () {
      openDayPanel(b.dataset.dcal);
    };
  });
  main.querySelectorAll('[data-chart-mode]').forEach(function (b) {
    b.onclick = function () {
      diaryUI.chartMode = b.dataset.chartMode;
      render();
    };
  });
  main.querySelectorAll('[data-diary-range]').forEach(function (b) {
    b.onclick = function () {
      diaryUI.range = b.dataset.diaryRange;
      render();
    };
  });
  main.querySelectorAll('[data-dcal-pick]').forEach(function (b) {
    bindMonthPicker(b);
  });
  main.querySelectorAll('[data-dcal-month]').forEach(function (b) {
    b.onclick = function () {
      var m = diaryUI.month || dToday().slice(0, 7),
        dt = dParse(m + '-01');
      dt.setMonth(dt.getMonth() + Number(b.dataset.dcalMonth));
      var next = U.local(dt).slice(0, 7);
      if (next > dToday().slice(0, 7)) return;
      diaryUI.month = next;
      render();
    };
  });
  var showLine = function (i) {
    var p = diaryUI.lineData && diaryUI.lineData[i];
    if (!p) return;
    var svg = main.querySelector('.dc-line'),
      g = svg && svg.querySelector('.dc-cross');
    if (g) {
      g.hidden = false;
      g.querySelector('line').setAttribute('x1', p.x);
      g.querySelector('line').setAttribute('x2', p.x);
      g.querySelector('circle').setAttribute('cx', p.x);
      g.querySelector('circle').setAttribute('cy', p.y);
    }
    var det = main.querySelector('[data-dc-detail="line"]');
    if (det) det.textContent = p.text;
  };
  main.querySelectorAll('[data-dc-i]').forEach(function (r) {
    var i = Number(r.dataset.dcI);
    r.addEventListener('click', function () {
      showLine(i);
    });
    r.addEventListener('mouseenter', function () {
      showLine(i);
    });
  });
  var showBar = function (i, el) {
    main.querySelectorAll('.dc-bars .sel').forEach(function (x) {
      x.classList.remove('sel');
    });
    if (el && el.previousElementSibling) el.previousElementSibling.classList.add('sel');
    var det = main.querySelector('[data-dc-detail="bar"]');
    if (det && diaryUI.barData) det.textContent = diaryUI.barData[i];
  };
  main.querySelectorAll('[data-db-i]').forEach(function (r) {
    var i = Number(r.dataset.dbI);
    r.addEventListener('click', function () {
      showBar(i, r);
    });
    r.addEventListener('mouseenter', function () {
      showBar(i, r);
    });
  });
}

/* =====================================================================
   2.0.0 — Infrastruttura comune alla suite
   ===================================================================== */
/* Sincronizzazione online (stesso accesso delle altre app, tabella app_data, app 'bet') */
var syncBet = window.SuiteSync
  ? SuiteSync.register({
      app: 'bet',
      name: 'Bet Tracker',
      scope: 'personal',
      getLocal: function () {
        return db;
      },
      hasLocalData: function () {
        return (
          db.bets.length > 0 ||
          db.transactions.length > 0 ||
          (db.diary || []).length > 0 ||
          (db.predictions || []).length > 0 ||
          db.accounts[0].initial > 0
        );
      },
      onStatus: function () {
        if (typeof pushOnSyncStatus === 'function') pushOnSyncStatus();
      },
      localUpdatedAt: function () {
        return db.updatedAt || null;
      },
      setLocal: function (data) {
        var n = JSON.parse(JSON.stringify(data));
        if (!validDB(n)) throw Error('Dati online non validi');
        var norm = normalize(unpackDB(n));
        storeLocal(norm); /* 4.24.5 — stesso salvataggio compatto (prima: copia intera, falliva a memoria piena) */
        db = norm;
        storageError = '';
        render();
      },
    })
  : null;

/* Service worker: funziona offline e avvisa quando c'è una nuova versione */
var swRegistrationPromise = null,
  swRefreshPending = false;
function showUpdateBanner(reg) {
  var apply = function () {
    var waiting = reg && reg.waiting;
    if (waiting) {
      swRefreshPending = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    } else location.reload();
  };
  if (window.SuiteUpdate) SuiteUpdate.show('Bet Tracker', apply);
  else apply();
}
function watchServiceWorkerRegistration(reg) {
  if (!reg) return reg;
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg);
  reg.addEventListener('updatefound', function () {
    var worker = reg.installing;
    if (!worker) return;
    worker.addEventListener('statechange', function () {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(reg);
    });
  });
  return reg;
}
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!swRegistrationPromise)
    swRegistrationPromise = navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then(function (reg) {
        watchServiceWorkerRegistration(reg);
        return reg;
      })
      .catch(function () {
        return null;
      });
  return swRegistrationPromise;
}
function checkForAppUpdate() {
  registerServiceWorker().then(function (reg) {
    if (reg && reg.update) reg.update().catch(function () {});
  });
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (swRefreshPending) location.reload();
  });
  registerServiceWorker();
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkForAppUpdate();
  });
}

/* =====================================================================
   2.1.0 — Promemoria serale "Segna il saldo di oggi" (notifiche push)
   Stesso schema di Bilancio, Noi Due e RecompApp: il telefono si iscrive
   (tabella push_subscriptions, app='bet'); un cron orario su Supabase chiama
   la funzione notify-bet, che avvisa all'ora scelta solo se oggi il saldo
   non è ancora segnato. Guida: GUIDA_NOTIFICHE.txt
   NB: var (non let/const), perché render() gira all'avvio prima di questa parte.
   ===================================================================== */
var PUSH_VAPID_PUBLIC = 'BI-EgXLcLu6JXfmEESiMZ0f9pfo1DSmaNIn2_9-uikVjf7oWuJw9lpx3_bHKEUJbRZ3rIzbZvRJU4q7Au83fYu8';
var PUSH_FN = '/functions/v1/notify-bet';
var pushState = { sub: null, row: null, busy: false, msg: '', err: false, loaded: false };
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function pushIsIOS() {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}
function pushStandalone() {
  return (
    window.navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches)
  );
}
function b64uToUint8(str) {
  var pad = '='.repeat((4 - (str.length % 4)) % 4),
    b = atob((str + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, function (c) {
    return c.charCodeAt(0);
  });
}
function pushErrText(e) {
  var t = String((e && e.message) || e || '');
  if (/push_subscriptions/.test(t) && /(does not exist|42P01|PGRST205|schema cache)/.test(t))
    return 'Su Supabase manca la tabella delle notifiche: vedi GUIDA_NOTIFICHE.';
  if (/notify-bet|404/.test(t) && /function|not found|NOT_FOUND/i.test(t))
    return 'Su Supabase manca la funzione notify-bet: esegui il passo 3 della guida.';
  if (e && e.auth) return 'Rifai l’accesso alla sincronizzazione qui sopra.';
  return t.replace(/^Errore \d+:\s*/, '').slice(0, 160) || 'Qualcosa non ha funzionato.';
}
async function pushRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
}
async function refreshPushState() {
  if (!pushSupported()) {
    pushState.loaded = true;
    renderPushCard();
    return;
  }
  try {
    var reg = await pushRegistration();
    pushState.sub = reg ? await reg.pushManager.getSubscription() : null;
    pushState.row = null;
    if (pushState.sub && window.SuiteSync && SuiteSync.signedIn) {
      var rows = await SuiteSync.api(
        '/rest/v1/push_subscriptions?select=*&app=eq.bet&endpoint=eq.' + encodeURIComponent(pushState.sub.endpoint),
      );
      pushState.row = rows[0] || null;
    }
  } catch (e) {
    pushState.msg = pushErrText(e);
    pushState.err = true;
  }
  pushState.loaded = true;
  renderPushCard();
}
function pushHourOptions(sel) {
  var h = '';
  for (var i = 18; i <= 23; i++)
    h +=
      '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + String(i).padStart(2, '0') + ':00</option>';
  return h;
}
function renderPushCard() {
  var card = document.getElementById('pushCard');
  if (!card) return;
  if (card.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return;
  var on = !!(pushState.sub && pushState.row && pushState.row.enabled !== false);
  var dot = 'off',
    status,
    inner = '';
  if (!pushSupported()) {
    status =
      pushIsIOS() && !pushStandalone()
        ? 'Apri Bet Tracker dall’icona sulla Home.'
        : 'Notifiche non supportate da questo browser.';
  } else if (!(window.SuiteSync && SuiteSync.signedIn)) {
    status =
      'Sincronizzazione non collegata.';
  } else if (!pushState.loaded) {
    status = 'Controllo…';
    dot = 'busy';
  } else if (on) {
    dot = 'on';
    var hour = Number(pushState.row.notify_hour != null ? pushState.row.notify_hour : 21);
    status =
      'Promemoria alle ' + String(hour).padStart(2, '0') + ':00';
    inner =
      '<div class="push-settings"><label class="push-line"><span>Ora del promemoria</span><select id="pushHourSelect" aria-label="Ora del promemoria">' +
      pushHourOptions(hour) +
      '</select></label></div>' +
      '<div class="suite-sync-actions"><button type="button" class="suite-sync-primary primary" id="pushTestBtn"' +
      (pushState.busy ? ' disabled' : '') +
      '>Invia una prova</button><button type="button" id="pushOffBtn"' +
      (pushState.busy ? ' disabled' : '') +
      '>Disattiva</button></div>';
  } else {
    status =
      Notification.permission === 'denied'
        ? 'Notifiche bloccate nelle Impostazioni del telefono.'
        : 'Promemoria spento.';
    inner =
      '<button type="button" class="suite-sync-primary primary push-on-btn" id="pushOnBtn"' +
      (pushState.busy || Notification.permission === 'denied' ? ' disabled' : '') +
      '>🔔 Attiva promemoria</button>';
  }
  var msg = pushState.msg
    ? '<p class="push-msg' + (pushState.err ? ' err' : '') + '">' + U.esc(pushState.msg) + '</p>'
    : '';
  card.innerHTML =
    '<h2>Notifiche</h2><p class="suite-sync-status"><span class="suite-sync-dot ' +
    dot +
    '" aria-hidden="true"></span>' +
    U.esc(status) +
    '</p>' +
    inner +
    msg;
}
function pushSay(text, err) {
  pushState.msg = text;
  pushState.err = !!err;
  renderPushCard();
}
async function pushSaveRow(extra) {
  var j = pushState.sub.toJSON();
  await SuiteSync.api('/rest/v1/push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    json: Object.assign(
      {
        user_id: SuiteSync.userId,
        app: 'bet',
        endpoint: j.endpoint,
        p256dh: j.keys.p256dh,
        auth: j.keys.auth,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome',
        device: navigator.userAgent.slice(0, 120),
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      extra || {},
    ),
  });
}
async function pushEnable() {
  if (pushState.busy) return;
  pushState.busy = true;
  pushSay('');
  try {
    var perm = await Notification.requestPermission(); // va chiesto subito dopo il tocco (regola di iOS)
    if (perm !== 'granted') {
      pushState.busy = false;
      pushSay(
        perm === 'denied'
          ? 'Permesso negato. Puoi riattivarlo in Impostazioni › Notifiche › Bet Tracker.'
          : 'Permesso non concesso.',
        true,
      );
      return;
    }
    var reg = await pushRegistration();
    if (!reg) throw new Error('Service worker non attivo: riapri l’app e riprova.');
    pushState.sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64uToUint8(PUSH_VAPID_PUBLIC),
      }));
    await pushSaveRow({ notify_hour: 21 });
    pushState.row = { enabled: true, notify_hour: 21 };
    pushState.busy = false;
    pushSay('Fatto. Tocca "Invia una prova" per controllare che arrivi.');
  } catch (e) {
    pushState.busy = false;
    pushSay(pushErrText(e), true);
  }
}
async function pushDisable() {
  if (pushState.busy || !pushState.sub) return;
  pushState.busy = true;
  renderPushCard();
  var endpoint = pushState.sub.endpoint;
  try {
    await SuiteSync.api('/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(endpoint), {
      method: 'DELETE',
    });
  } catch (e) {}
  try {
    await pushState.sub.unsubscribe();
  } catch (e) {}
  pushState.sub = null;
  pushState.row = null;
  pushState.busy = false;
  pushSay('Promemoria disattivato su questo telefono.');
}
async function pushUpdate(patch) {
  if (!pushState.sub || !pushState.row) return;
  var prev = Object.assign({}, pushState.row);
  Object.assign(pushState.row, patch);
  pushState.msg = '';
  renderPushCard();
  try {
    await SuiteSync.api('/rest/v1/push_subscriptions?endpoint=eq.' + encodeURIComponent(pushState.sub.endpoint), {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      json: Object.assign({ updated_at: new Date().toISOString() }, patch),
    });
  } catch (e) {
    pushState.row = prev;
    pushSay(pushErrText(e), true);
  }
}
async function pushTest() {
  if (pushState.busy) return;
  pushState.busy = true;
  pushSay('Invio la prova…');
  try {
    if (syncBet) await syncBet.sync('push-test'); // la funzione legge i dati online: prima li aggiorno
    var r = await SuiteSync.api(PUSH_FN, { method: 'POST', json: { test: true } });
    pushState.busy = false;
    pushSay(
      r && r.sent
        ? 'Prova inviata: dovrebbe arrivare tra pochi secondi.'
        : 'La prova non è partita: disattiva e riattiva il promemoria.',
      !(r && r.sent),
    );
  } catch (e) {
    pushState.busy = false;
    pushSay(pushErrText(e), true);
  }
}
document.addEventListener('click', function (e) {
  if (!(e.target.closest && e.target.closest('#pushCard'))) return;
  var b = e.target.closest('button'),
    id = b && b.id;
  if (id === 'pushOnBtn') pushEnable();
  else if (id === 'pushOffBtn') pushDisable();
  else if (id === 'pushTestBtn') pushTest();
});
document.addEventListener('change', function (e) {
  if (e.target && e.target.id === 'pushHourSelect') pushUpdate({ notify_hour: Number(e.target.value) });
});
setTimeout(refreshPushState, 1500);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') refreshPushState();
});

/* Aperta dal promemoria: va in Home e apre "Segna saldo" (?diary=today o messaggio dal service worker) */
function openDiaryFromNotification() {
  setTab('home');
  render();
  setTimeout(function () {
    diaryForm(dToday());
  }, 150);
}
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'open-diary') openDiaryFromNotification();
  });
setTimeout(function () {
  try {
    if (new URLSearchParams(location.search).get('diary') === 'today') {
      history.replaceState(null, '', location.pathname);
      openDiaryFromNotification();
    }
  } catch (e) {}
}, 400);
var pushLastSigned = null;
function pushOnSyncStatus() {
  var signed = !!(window.SuiteSync && SuiteSync.signedIn);
  if (signed !== pushLastSigned) {
    pushLastSigned = signed;
    refreshPushState();
  } else renderPushCard();
}

/* Promemoria backup uguale alle altre app (dopo 30 giorni, al massimo una volta a settimana) */
setTimeout(function () {
  if (window.SuiteBackup)
    SuiteBackup.maybe({
      app: 'Bet Tracker',
      key: 'bet',
      last: db.settings.lastExport,
      hasData: db.bets.length > 0 || (db.diary || []).length > 0,
      onExport: exportData,
    });
}, 2500);

document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
render();
requestAnimationFrame(() => {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 350);
  }
});
/* 4.8.0 — BARRA IN BASSO ALL'APERTURA. Su iPhone (app sulla Home) al primo avvio Safari calcola l'altezza dello schermo
   prima di aver sistemato la zona sotto (indicatore Home): la barra fissa restava più in alto, con una striscia di
   un altro colore sotto, finché un cambio scheda (che ridisegna e torna in cima) non la rimetteva a posto.
   Ora lo stesso "riallineamento" si fa da solo all'avvio, al ritorno nell'app e quando cambia la dimensione dello schermo. */
function fixBottomBar() {
  const nav = document.querySelector('nav.tabbar'),
    ae = document.activeElement;
  if (!nav || (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) return; /* con la tastiera aperta non si tocca */
  const y = window.scrollY;
  window.scrollTo(0, y + 1);
  window.scrollTo(0, y);
  nav.style.display = 'none';
  void nav.offsetHeight;
  nav.style.display = '';
}
try {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
} catch {
  /* ok */
}
[0, 60, 300, 800, 1600].forEach((ms) => setTimeout(fixBottomBar, ms));
window.addEventListener('load', () => setTimeout(fixBottomBar, 50));
window.addEventListener('pageshow', () => setTimeout(fixBottomBar, 50));
window.addEventListener('orientationchange', () => setTimeout(fixBottomBar, 300));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) setTimeout(fixBottomBar, 80);
});
if (window.visualViewport) {
  let vvT = 0;
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(vvT);
    vvT = setTimeout(fixBottomBar, 120);
  });
}

// Feedback for mouse, touch and keyboard, including dynamically created controls.
document.addEventListener(
  'click',
  (e) => {
    const button = e.target.closest?.('button');
    if (!button || button.disabled) return;
    button.classList.remove('button-tap');
    void button.offsetWidth;
    button.classList.add('button-tap');
    setTimeout(() => button.classList.remove('button-tap'), 240);
  },
  true,
);
/* ===== BOLLE "ANALISI" (comuni alle app) =====
   Cerchi con l'area proporzionale al valore, impaccati attorno al centro (stile app della banca): il più grande al
   centro, gli altri appoggiati vicino. Un valore a zero resta una bolla piccola e spenta. Senza librerie. */
function bubPack(items, W, H) {
  var vals = items.map(function (it) { return Math.max(0, Number(it.value) || 0); });
  var max = Math.max.apply(null, vals.concat([0]));
  var R = Math.min(W, H) * 0.34, Rmin = R * 0.36, gap = Math.min(W, H) * 0.025;
  var C = items.map(function (it, i) { return { i: i, r: vals[i] > 0 && max > 0 ? Math.max(Rmin, R * Math.sqrt(vals[i] / max)) : Rmin * 0.92 }; });
  var order = C.slice().sort(function (a, b) { return b.r - a.r; }), placed = [];
  order.forEach(function (c, n) {
    if (!n) { c.x = 0; c.y = 0; placed.push(c); return; }
    var best = null, A = 0, gx = 0, gy = 0;
    placed.forEach(function (q) { var w = q.r * q.r; A += w; gx += q.x * w; gy += q.y * w; });
    gx /= A; gy /= A;
    placed.forEach(function (p) {
      for (var k = 0; k < 72; k++) {
        var a = (k / 72) * Math.PI * 2, d = p.r + c.r + gap, x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
        var ok = placed.every(function (q) { return Math.hypot(q.x - x, q.y - y) >= q.r + c.r + gap - 0.01; });
        if (!ok) continue;
        /* vicino al baricentro (gruppo compatto); la seconda va in alto a destra come nella banca */
        var score = Math.hypot((x - gx) * (H / W), (y - gy)) + (n === 1 ? Math.abs(Math.atan2(y, x) + 0.55) * 4 : 0);
        if (!best || score < best.s) best = { x: x, y: y, s: score };
      }
    });
    c.x = best ? best.x : 0; c.y = best ? best.y : 0; placed.push(c);
  });
  var x0 = Math.min.apply(null, C.map(function (c) { return c.x - c.r; })), x1 = Math.max.apply(null, C.map(function (c) { return c.x + c.r; }));
  var y0 = Math.min.apply(null, C.map(function (c) { return c.y - c.r; })), y1 = Math.max.apply(null, C.map(function (c) { return c.y + c.r; }));
  var pad = Math.min(W, H) * 0.04, s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0), 1.25);
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return C.map(function (c) { return { x: W / 2 + (c.x - cx) * s, y: H / 2 + (c.y - cy) * s, r: c.r * s }; });
}
/* items: [{key, label, value, text (cifra già scritta), color, ink?}] → bolle; attr(it) = attributo per il tocco */
function bubChartHtml(items, o) {
  o = o || {};
  var W = 340, H = o.h || 260, P = bubPack(items, W, H), esc = o.esc || function (s) { return String(s); };
  return '<div class="bub-wrap" style="aspect-ratio:' + W + '/' + H + '">' + items.map(function (it, i) {
    var p = P[i], zero = !(Number(it.value) > 0), d = p.r * 2, fs = Math.max(11, Math.min(26, p.r * 0.3)), ls = Math.max(9, Math.min(14, p.r * 0.15));
    var small = p.r < 34;
    return '<button type="button" class="bub' + (zero ? ' zero' : '') + (it.on ? ' on' : '') + '" ' + (o.attr ? o.attr(it) : '') +
      ' style="left:' + ((p.x - p.r) / W * 100).toFixed(2) + '%;top:' + ((p.y - p.r) / H * 100).toFixed(2) + '%;width:' + (d / W * 100).toFixed(2) + '%;--bc:' + (zero ? 'var(--bub-zero)' : it.color) + ';--bi:' + (it.ink || (zero ? 'var(--bub-zero-ink)' : '#0b0d0c')) + ';animation-delay:' + (i * 60) + 'ms" aria-label="' + esc(it.label + ': ' + it.text) + '">' +
      '<b style="font-size:' + fs.toFixed(1) + 'px">' + esc(it.text) + '</b>' + (small ? '' : '<small style="font-size:' + ls.toFixed(1) + 'px">' + esc(it.label) + '</small>') + '</button>';
  }).join('') + '</div>';
}
/* legenda come nella banca: pallino, nome, cifra sotto */
function bubLegendHtml(items, o) {
  o = o || {};
  var esc = o.esc || function (s) { return String(s); };
  return '<div class="bub-leg">' + (o.title ? '<p class="bub-leg-t">' + esc(o.title) + '</p>' : '') + items.map(function (it) {
    var zero = !(Number(it.value) > 0);
    return '<' + (o.attr ? 'button type="button" ' + o.attr(it) : 'div') + ' class="bub-li' + (o.attr ? ' tap' : '') + '"><i style="--bc:' + (zero ? 'var(--bub-zero)' : it.color) + '"></i><span><b>' + esc(it.label) + '</b><small>' + esc(it.sub || it.text) + '</small></span>' + (it.side ? '<em>' + esc(it.side) + '</em>' : '') + (o.attr ? '<u aria-hidden="true">›</u>' : '') + '</' + (o.attr ? 'button' : 'div') + '>';
  }).join('') + '</div>';
}
/* mesi in alto (set · ott · nov): months = [{key, label}] */
function bubMonthsHtml(months, sel, attrName) {
  return '<div class="bub-months" role="tablist">' + months.map(function (m) {
    return '<button type="button" role="tab" aria-selected="' + (m.key === sel) + '" class="' + (m.key === sel ? 'on' : '') + '" ' + attrName + '="' + m.key + '">' + m.label + '</button>';
  }).join('') + '</div>';
}
function bubLastMonths(n, endIso) {
  var MS = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'], d = endIso ? new Date(endIso + '-01T12:00:00') : new Date(), out = [];
  for (var i = n - 1; i >= 0; i--) { var x = new Date(d.getFullYear(), d.getMonth() - i, 1); out.push({ key: x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0'), label: MS[x.getMonth()], long: x.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }) }); }
  return out;
}

/* 4.21.0 — ANALISI A BOLLE nel Saldo (Andamento): mesi in alto (set · ott · nov), bolle Vinto / Perso / Depositi /
   Prelievi del mese (versamenti esclusi da vinto e perso), elenco sotto; un tocco apre i giorni o i movimenti. */
function diaryBubData(ym) {
  var series = diarySeries(), days = series.filter(function (p) { return p.date.slice(0, 7) === ym && p.delta != null; });
  var up = days.filter(function (p) { return p.delta > 0; }), dn = days.filter(function (p) { return p.delta < 0; });
  var fl = realFlows().filter(function (t) { return dayKey(t.date).slice(0, 7) === ym; });
  var dep = fl.filter(function (t) { return t.amount > 0; }), wd = fl.filter(function (t) { return t.amount < 0; });
  var sum = function (a, f) { return a.reduce(function (s, x) { return s + Math.abs(f(x)); }, 0); };
  var money = function (v) { return Math.round(v).toLocaleString('it-IT') + ' €'; };
  var W = sum(up, function (p) { return p.delta; }), L = sum(dn, function (p) { return p.delta; }), D = sum(dep, function (t) { return t.amount; }), P = sum(wd, function (t) { return t.amount; });
  return [
    { key: 'win', label: 'Vinto', value: W, text: money(W), sub: U.money(W) + ' · ' + up.length + (up.length === 1 ? ' giorno in aumento' : ' giorni in aumento'), color: 'var(--bub-in)', days: up },
    { key: 'loss', label: 'Perso', value: L, text: money(L), sub: U.money(L) + ' · ' + dn.length + (dn.length === 1 ? ' giorno in calo' : ' giorni in calo'), color: 'var(--bub-loss)', days: dn },
    { key: 'dep', label: 'Depositi', value: D, text: money(D), sub: U.money(D) + ' · ' + dep.length + (dep.length === 1 ? ' versamento' : ' versamenti'), color: 'var(--bub-dep)', flows: dep },
    { key: 'wd', label: 'Prelievi', value: P, text: money(P), sub: U.money(P) + ' · ' + wd.length + (wd.length === 1 ? ' prelievo' : ' prelievi'), color: 'var(--bub-save)', flows: wd },
  ];
}
function diaryBubCard() {
  var months = bubLastMonths(3), sel = diaryUI.bubM && months.some(function (m) { return m.key === diaryUI.bubM; }) ? diaryUI.bubM : months[2].key;
  var items = diaryBubData(sel), mo = months.find(function (m) { return m.key === sel; }), net = items[0].value - items[1].value;
  var has = items.some(function (i) { return i.value > 0; });
  return '<section class="card diary-card bub-card"><div class="bub-head"><div><h2>Analisi</h2><p>' + (has ? 'Risultato del mese <b class="' + sClass(net) + '">' + sMoney(U.round(net)) + '</b> · ' : '') + U.esc(mo.long) + '</p></div></div>' +
    bubMonthsHtml(months, sel, 'data-bubm') +
    (has ? bubChartHtml(items, { esc: U.esc, attr: function (it) { return 'data-bubk="' + it.key + '"'; } }) + bubLegendHtml(items, { esc: U.esc, title: 'Riepilogo', attr: function (it) { return 'data-bubk="' + it.key + '"'; } })
      : '<p class="bub-empty">Nessun giorno segnato a ' + U.esc(mo.long) + '.</p>') + '</section>';
}
document.addEventListener('click', function (ev) {
  var m = ev.target.closest && ev.target.closest('.diary-card.bub-card [data-bubm]');
  if (m) { diaryUI.bubM = m.getAttribute('data-bubm'); render(); return; }
  var k = ev.target.closest && ev.target.closest('.diary-card.bub-card [data-bubk]');
  if (!k) return;
  var months = bubLastMonths(3), sel = diaryUI.bubM || months[2].key, it = diaryBubData(sel).find(function (x) { return x.key === k.getAttribute('data-bubk'); });
  if (!it) return;
  var rows = it.days ? it.days.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (p) { return '<div class="bub-srow"><span>' + U.esc(dLabel(p.date)) + '</span><b class="' + sClass(p.delta) + '">' + sMoney(p.delta) + '</b></div>'; })
    : it.flows.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (t) { return '<div class="bub-srow"><span>' + U.esc(U.date(t.date)) + '</span><b class="' + (t.amount < 0 ? 'negative' : 'positive') + '">' + (t.amount < 0 ? '−' : '+') + U.money(Math.abs(t.amount)) + '</b></div>'; });
  sheetModal(sheetHead(it.label, { sub: (months.find(function (x) { return x.key === sel; }) || {}).long || '' }) + '<div class="bub-slist">' + (rows.join('') || '<p class="muted">Niente in questo mese.</p>') + '</div>');
});


/* ---------- 4.21.5 — RIQUADRI A TENDINA IN TUTTE LE SEZIONI ----------
   Ogni riquadro (.card con un titolo) si chiude e si riapre toccando il titolo o la freccia a destra; resta come l'hai
   lasciato (anche dopo gli aggiornamenti del Live e alla riapertura dell'app). Chiuso resta visibile solo il titolo.
   Fuori: i riquadri che sono pulsanti (Home dei pronostici), quelli già a tendina (<details>, sezioni .tip-top / .tip-markets
   della 3.30.0) e le caselle piccole (.diary-kpi). Un riquadro senza titolo non ha la freccia. */
var CX_KEY = 'bet_cx_v1', cxClosed = null;
function cxLoad() {
  if (cxClosed) return cxClosed;
  try { cxClosed = JSON.parse(localStorage.getItem(CX_KEY) || '{}') || {}; } catch (e) { cxClosed = {}; }
  return cxClosed;
}
function cxSave() { try { localStorage.setItem(CX_KEY, JSON.stringify(cxClosed || {})); } catch (e) { /* memoria piena o privata: resta per questa sessione */ } }
var CX_HEAD_SEL = 'h1,h2,h3,.st2-h,.bub-head,.sd-top,.sd-day-h,.diary-card-head,.tip-top-head,.cx-h';
function cxHead(card) {
  var k = card.firstElementChild;
  while (k && (k.hidden || k.tagName === 'INPUT' || k.tagName === 'SCRIPT' || k.classList.contains('cx-skip'))) k = k.nextElementSibling;
  if (!k) return null;
  if (k.matches(CX_HEAD_SEL) || k.hasAttribute('data-cx-head')) return k;
  /* primo figlio piccolo con un titolo dentro (es. intestazione con titolo e sottotitolo) */
  if (k.children.length <= 4 && k.querySelector('h2,h3,.st2-h') && !k.querySelector('.lv2-list,table,svg,.pr-list,.st2-tab,.pst-tab,button')) return k;
  return null;
}
function cxKeyOf(card, head) {
  var own = card.getAttribute('data-cx');
  if (own) return tab + '|' + own;
  var t = String(head.textContent || '').split('·')[0].toLowerCase().replace(/[^a-zà-ÿ ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ');
  return t ? tab + '|' + t : '';
}
function cxApply(card, closed) {
  card.classList.toggle('cx-closed', !!closed);
  var h = card.querySelector(':scope > .cx-head');
  if (h) h.setAttribute('aria-expanded', closed ? 'false' : 'true');
}
function cxEnhance() {
  var root = document.getElementById('main');
  if (!root) return;
  var C = cxLoad();
  root.querySelectorAll('.card, .st2-list').forEach(function (card) {
    if (card.hasAttribute('data-cx-ok')) { var k0 = card.getAttribute('data-cx-ok'); cxApply(card, !!C[k0]); return; }
    if (card.tagName === 'BUTTON' || card.tagName === 'DETAILS' || card.tagName === 'A' || card.hasAttribute('data-cx-off')) return;
    if (card.classList.contains('diary-kpi') || card.classList.contains('tip-top') || card.classList.contains('tip-markets') || card.classList.contains('tip-fold')) return;
    if (card.parentElement && card.parentElement.closest('.card, .st2-list, dialog')) return; /* solo i riquadri esterni */
    var head = cxHead(card);
    if (!head) return;
    var key = cxKeyOf(card, head);
    if (!key) return;
    card.setAttribute('data-cx-ok', key);
    card.classList.add('cx-card');
    head.classList.add('cx-head');
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    if (!head.querySelector(':scope > .cx-ic')) head.insertAdjacentHTML('beforeend', '<span class="cx-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>');
    cxApply(card, !!C[key]);
  });
}
function cxToggle(card) {
  var key = card.getAttribute('data-cx-ok');
  if (!key) return;
  var C = cxLoad(), closed = !card.classList.contains('cx-closed');
  if (closed) C[key] = 1; else delete C[key];
  cxSave();
  cxApply(card, closed);
}
document.addEventListener('click', function (ev) {
  var h = ev.target.closest && ev.target.closest('.cx-head');
  if (!h) return;
  var card = h.parentElement;
  if (!card || !card.hasAttribute('data-cx-ok')) return;
  /* i pulsanti e i campi dentro il titolo fanno il loro lavoro; la freccia chiude sempre */
  if (!ev.target.closest('.cx-ic') && ev.target.closest('button,a,input,select,label,[data-ms],[data-bubm],[role="tab"]')) return;
  ev.preventDefault();
  cxToggle(card);
});
document.addEventListener('keydown', function (ev) {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList && ev.target.classList.contains('cx-head')) { ev.preventDefault(); cxToggle(ev.target.parentElement); }
});
/* il Live e le altre schede a volte ridisegnano solo un pezzo della pagina: si riapplica da solo */
(function () {
  var root = document.getElementById('main');
  if (!root || typeof MutationObserver === 'undefined') return;
  var queued = false;
  new MutationObserver(function () {
    if (queued) return;
    queued = true;
    (window.requestAnimationFrame || setTimeout)(function () { queued = false; try { cxEnhance(); } catch (e) { /* ok */ } });
  }).observe(root, { childList: true, subtree: true });
})();
