const APP_VERSION = '3.20.0';
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
  tab = 'home',
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
try {
  const raw = localStorage.getItem(KEY);
  if (raw) {
    const data = JSON.parse(raw);
    if (!validDB(data)) throw Error('Dati non validi');
    db = normalize(data);
  }
} catch (e) {
  storageError = 'Dati non leggibili: usa Altro → Importa backup. I dati originali non saranno sovrascritti.';
}
function commit(next, { restore = false } = {}) {
  if (storageError && !restore) {
    U.toast('Ripristina un backup valido dalla sezione Altro.');
    return false;
  }
  try {
    next.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(next);
    if (!validDB(next)) throw Error('Dati non validi');
    localStorage.setItem(KEY, serialized);
    db = next;
    storageError = '';
    render();
    if (typeof syncBet !== 'undefined' && syncBet) syncBet.changed();
    return true;
  } catch (e) {
    U.toast('Salvataggio non riuscito. Esporta un backup; le modifiche non sono state applicate.');
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
  }<label>Cerca evento o pronostico</label><input id="query" type="search" value="${U.esc(filter.query)}" placeholder="Squadra, evento, Over…"><small>Il risultato giornaliero usa il riferimento data selezionato.</small>${filter.from && filter.to && filter.from > filter.to ? '<p class="error">La data iniziale deve precedere quella finale.</p>' : ''}</div>`;
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
  if (!['home', 'stats', 'tips', 'accounts'].includes(tab)) tab = 'home';
  document.getElementById('title').textContent = {
    home: 'Home',
    stats: 'Statistiche',
    tips: 'Pronostici',
    accounts: 'Altro',
  }[tab];
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const error = document.getElementById('storage-error');
  error.hidden = !storageError;
  error.textContent = storageError;
  let html = '';
  chartPoints = [];
  if (tab === 'home') html = diaryPage('home');
  if (tab === 'stats') html = diaryPage('stats');
  if (tab === 'tips') html = tipsPage();
  if (tab === 'accounts') {
    const s = startDate();
    html = `${window.SuiteTheme ? SuiteTheme.card({ cls: 'card' }) : ''}${window.SuiteSync && typeof syncBet !== 'undefined' && syncBet ? SuiteSync.cardHtml('bet', { cls: 'card' }) + '<div class="card suite-sync-card push-card" id="pushCard"></div>' : ''}<div class="card hero acc-hero"><small>SALDO ATTUALE</small><div class="big">${U.money(balance())}</div><div class="acc-initial"><span>Saldo iniziale <b>${U.money(db.accounts[0].initial)}</b>${s ? ' · dal ' + U.esc(dLabel(s)) : ''}</span><button type="button" id="initial">Modifica</button></div><div class="hero-flow-btns"><button type="button" class="flow-btn in" data-tx="deposit"><span aria-hidden="true">↓</span>Deposito</button><button type="button" class="flow-btn out" data-tx="withdraw"><span aria-hidden="true">↑</span>Prelievo</button></div></div><h2 class="section">Depositi e prelievi</h2>${
      realFlows()
        .slice()
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(
          (t) =>
            `<div class="card flow-row ${t.amount < 0 ? 'out' : 'in'}"><span class="flow-ic" aria-hidden="true">${t.amount < 0 ? '↑' : '↓'}</span><div class="flow-main"><b>${t.amount < 0 ? 'Prelievo' : 'Deposito'}</b><small>${U.date(t.date)}</small></div><strong class="${t.amount < 0 ? 'negative' : 'positive'}">${t.amount < 0 ? '−' : '+'}${U.money(Math.abs(t.amount))}</strong><div class="flow-actions"><button data-tx-edit="${t.id}">Modifica</button><button class="danger" data-tx-delete="${t.id}">Elimina</button></div></div>`,
        )
        .join('') || '<div class="card empty">Nessun deposito o prelievo.</div>'
    }<div class="card"><h2>Backup e ripristino</h2><p class="muted">Dati salvati sul telefono e, se colleghi la sincronizzazione, anche online. Ultima esportazione richiesta: ${db.settings.lastExport ? U.date(db.settings.lastExport) : 'mai'}.</p><div class="actions"><button id="export">Esporta JSON</button><button id="import">Importa backup</button></div><input type="file" accept=".json,application/json" id="import-file" hidden></div><div class="card app-version-card"><h2>Versione app</h2><p class="muted">Bet Tracker ${APP_VERSION} · gli aggiornamenti vengono controllati automaticamente.</p><button type="button" id="check-app-update">Controlla aggiornamenti</button></div>`;
  }
  main.innerHTML = html;
  bind();
  U.bindChart(main, chartPoints);
  if (tab === 'home' || tab === 'stats') bindDiary();
  if (tab === 'tips') bindTips();
  if (tab === 'accounts' && typeof renderPushCard === 'function') renderPushCard();
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
  return `<details class="leg compact-leg" data-leg-status="${l.status || 'pending'}" data-event-meta="${U.esc(meta)}" ${index === 0 ? 'open' : ''}><summary><span class="leg-number">${index + 1}</span><span class="leg-summary"><b class="leg-title">${U.esc(l.event || 'Nuovo evento')}</b><small class="leg-pick">${U.esc(l.pick || 'Partita e pronostico')}</small></span><b class="leg-quote">${l.odds ? Number(l.odds).toFixed(2) : '—'}</b><span class="leg-chevron">⌄</span></summary><div class="leg-fields"><label>Partita / evento<input class="event" required maxlength="220" placeholder="Es. Inter – Milan" value="${U.esc(l.event || '')}"></label><button class="event-trigger" type="button"><span>⚽ Seleziona campionato / nazionale</span><span aria-hidden="true">›</span></button><small class="event-trigger-help">Oppure continua a scrivere liberamente l’evento nel campo sopra.</small><div class="pick-odds-row"><label>Esito / pronostico<div class="pick-selector"><input class="pick" type="hidden" value="${pick}"><button class="pick-trigger" type="button" aria-haspopup="dialog"><span class="pick-trigger-text">${pick || 'Seleziona esito'}</span><span class="pick-trigger-arrow" aria-hidden="true">›</span></button></div></label><label>Quota<input class="odds" type="number" inputmode="decimal" min="1" max="10000" step="any" required placeholder="1.85" value="${l.odds || ''}"></label></div><div class="leg-tools"><button class="favorite-toggle" type="button" data-favorite aria-label="Aggiungi pronostico ai preferiti" title="Aggiungi ai preferiti" aria-pressed="false">☆</button><button class="danger" type="button" data-remove-leg aria-label="Rimuovi evento">✕ Rimuovi</button></div></div></details>`;
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
    eventBody.innerHTML = `<div class="event-division-list">${rows || '<p class="muted">Nessun campionato trovato.</p>'}${eventGroupButton('competition:__manual__', 'Altro / scrivi campionato', 'Inserimento manuale')}</div><small class="muted">Le leghe online vengono lette da TheSportsDB; il catalogo locale resta disponibile in assenza di rete.</small>`;
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
  const when = t ? new Date(t.date) : day && day !== dToday() ? new Date(day + 'T12:00:00') : new Date();
  const d = sheetModal(
    sheetHead(t ? 'Modifica movimento' : sign < 0 ? 'Prelievo' : 'Deposito', { form: 'tx-form', sub: sign < 0 ? 'Soldi tolti dal conto di gioco' : 'Soldi versati sul conto di gioco' }) +
      `<form id="tx-form" class="sheet-form"><div class="sheet-group sheet-amount ${sign < 0 ? 'tone-out' : 'tone-in'}"><label class="sheet-field"><span>Importo (€)</span><div class="sheet-amount-row"><em aria-hidden="true">${sign < 0 ? '−' : '+'}</em><input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0,00" value="${t ? Math.abs(t.amount) : ''}"></div></label></div><div class="sheet-group"><label class="sheet-field"><span>Data e ora</span><input name="date" type="datetime-local" required value="${U.local(when)}"></label>${sign < 0 ? `<p class="sheet-calc">Disponibile ora: <b>${U.money(balance() - (t?.amount || 0))}</b></p>` : ''}</div><p class="error" id="error"></p></form>`,
  );
  d.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target),
      amount = U.round(sign * Number(f.get('amount')));
    if (sign < 0 && balance() - (t?.amount || 0) + amount < 0)
      return (d.querySelector('#error').textContent = 'Saldo insufficiente.');
    const obj = {
      id: t?.id || U.uid(),
      account: db.accounts[0].id,
      amount,
      date: new Date(f.get('date')).toISOString(),
    };
    if (
      mutate(
        (n) => (n.transactions = t ? n.transactions.map((x) => (x.id === t.id ? obj : x)) : [...n.transactions, obj]),
      )
    )
      d.close();
  };
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
const TAB_ORDER = ['home', 'stats', 'tips', 'accounts'];
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
var diaryUI = { range: '30', month: null };
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
    return '<div class="diary-empty-chart">Segna il saldo per qualche giorno: qui vedrai l’andamento.</div>';
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
    '<p class="diary-chart-detail" data-dc-detail="line" aria-live="polite">Tocca il grafico per vedere il dettaglio di un giorno.</p>'
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
    '<p class="diary-chart-detail" data-dc-detail="bar" aria-live="polite">Verde: giorni in aumento · Rosso: giorni in calo. Tocca una barra.</p>'
  );
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
  var flowsAfter = last
    ? U.round(
        realFlows()
          .filter(function (t) {
            return dayKey(t.date) > last.date;
          })
          .reduce(function (n, t) {
            return n + t.amount;
          }, 0),
      )
    : 0;

  if (which !== 'stats') {
    var chip = todayEntry
      ? '<span class="diary-chip ok">✓ Segnato oggi</span>'
      : '<span class="diary-chip todo">Da segnare oggi</span>';
    var sub = '';
    if (todayEntry && todayEntry.delta != null)
      sub +=
        '<span>Oggi <b class="' +
        sClass(todayEntry.delta) +
        '">' +
        sMoney(todayEntry.delta) +
        '</b>' +
        (todayEntry.moved ? ' · ' + (todayEntry.moved > 0 ? 'depositati ' : 'prelevati ') + U.money(Math.abs(todayEntry.moved)) + ' esclusi' : '') +
        '</span>';
    else if (last)
      sub += '<span>Ultimo segnato: <b>' + dLabel(last.date) + '</b> · ' + U.money(last.balance) + '</span>';
    else sub += '<span>Segna ogni sera il saldo che hai: vedrai se la giornata è andata in positivo o in negativo.</span>';
    if (Math.abs(flowsAfter) >= 0.005)
      sub +=
        '<span>Dopo l’ultimo saldo: ' +
        (flowsAfter > 0 ? 'depositati <b>' : 'prelevati <b>') +
        U.money(Math.abs(flowsAfter)) +
        '</b> (non contano come vincita o perdita)</span>';
    var hero =
      '<section class="card hero diary-hero"><div class="row"><small>SALDO ATTUALE</small>' +
      chip +
      '</div><div class="big">' +
      U.money(cur) +
      '</div><div class="diary-hero-sub">' +
      sub +
      '</div><button type="button" class="primary diary-record" data-diary-edit="' +
      today +
      '">' +
      (todayEntry ? '✎ Aggiorna il saldo di oggi' : '＋ Segna il saldo di oggi') +
      '</button><div class="hero-flow-btns"><button type="button" class="flow-btn in" data-tx="deposit"><span aria-hidden="true">↓</span>Deposito</button><button type="button" class="flow-btn out" data-tx="withdraw"><span aria-hidden="true">↑</span>Prelievo</button></div></section>';

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
    var agenda =
      '<section class="card diary-card"><h2>Calendario</h2><p class="muted diary-hint">Verde guadagno, rosso perdita: depositi e prelievi sono già esclusi. ↓ deposito · ↑ prelievo. Tocca un giorno per i dettagli.</p>' +
      diaryCalendar(series) +
      '</section>';
    return hero + agenda + kpis;
  }

  /* ---------- Statistiche ---------- */
  var flows = realFlows();
  var dep = U.round(flows.filter((t) => t.amount > 0).reduce((n, t) => n + t.amount, 0)),
    wd = U.round(flows.filter((t) => t.amount < 0).reduce((n, t) => n - t.amount, 0)),
    ini = U.round(db.accounts[0].initial),
    netIn = U.round(ini + dep - wd),
    allCh = diaryChange(series, 'all');
  var money =
    '<section class="card diary-card money-card"><h2>I tuoi soldi</h2><div class="money-grid">' +
    '<div><small>Saldo iniziale</small><b>' +
    U.money(ini) +
    '</b><span>' +
    (startDate() ? 'dal ' + dLabel(startDate()) : 'non impostato') +
    '</span></div>' +
    '<div><small>Depositi</small><b class="' + (dep ? 'positive' : '') + '">' + (dep ? '+' : '') +
    U.money(dep) +
    '</b><span>' +
    flows.filter((t) => t.amount > 0).length +
    ' versamenti</span></div>' +
    '<div><small>Prelievi</small><b class="' + (wd ? 'negative' : '') + '">' + (wd ? '−' : '') +
    U.money(wd) +
    '</b><span>' +
    flows.filter((t) => t.amount < 0).length +
    ' prelievi</span></div>' +
    '<div><small>Messi in gioco</small><b>' +
    U.money(netIn) +
    '</b><span>iniziale + depositi − prelievi</span></div>' +
    '<div class="wide"><small>Saldo attuale</small><b>' +
    U.money(cur) +
    '</b></div>' +
    '<div class="wide"><small>Risultato netto</small><b class="' +
    (allCh ? sClass(allCh.value) : '') +
    '">' +
    (allCh ? sMoney(allCh.value) : '—') +
    '</b><span>' +
    (allCh ? (allCh.from.start ? 'dal saldo iniziale, versamenti esclusi' : 'dal primo giorno segnato, versamenti esclusi') : 'servono più giorni') +
    '</span></div></div></section>';

  var points = diaryRangePoints(series);
  var mode = diaryUI.chartMode || 'saldo';
  var chartPts =
    mode === 'risultato'
      ? points.map(function (p) {
          var base = (series.start || series[0]).perf;
          return Object.assign({}, p, { balance: U.round(p.perf - base) });
        })
      : points;
  var seg =
    '<div class="diary-seg" role="group" aria-label="Periodo">' +
    DIARY_RANGES.map(function (r) {
      return (
        '<button type="button" data-diary-range="' +
        r[0] +
        '" class="' +
        (diaryUI.range === r[0] ? 'active' : '') +
        '" aria-pressed="' +
        (diaryUI.range === r[0]) +
        '">' +
        r[1] +
        '</button>'
      );
    }).join('') +
    '</div>';
  var modeSeg =
    '<div class="diary-seg diary-mode" role="group" aria-label="Cosa mostrare"><button type="button" data-chart-mode="saldo" class="' +
    (mode === 'saldo' ? 'active' : '') +
    '">Saldo</button><button type="button" data-chart-mode="risultato" class="' +
    (mode === 'risultato' ? 'active' : '') +
    '">Risultato netto</button></div>';
  var chart =
    '<section class="card diary-card"><div class="diary-card-head"><h2>Andamento</h2></div>' +
    seg +
    modeSeg +
    diaryLineChart(chartPts, null) +
    (mode === 'risultato'
      ? '<p class="muted diary-hint">Quanto hai guadagnato o perso in totale, senza depositi e prelievi.</p>'
      : '<p class="muted diary-hint">Il saldo che hai segnato: sale anche quando depositi e scende quando prelevi.</p>') +
    '</section>';
  var bars = '<section class="card diary-card"><h2>Risultato giorno per giorno</h2>' + diaryBarChart(points) + '</section>';
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
    return money + '<section class="card diary-card"><p class="muted">Segna il saldo per qualche giorno: qui compariranno grafici e statistiche.</p></section>';
  var weekday =
    '<section class="card diary-card"><h2>Per giorno della settimana</h2><p class="muted diary-hint">Risultato medio nel periodo scelto, per giorno.</p>' +
    diaryWeekdayChart(points) +
    '</section>';
  return money + chart + bars + stats + weekday + monthly + log;
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
    return '<div class="diary-empty-chart">Servono più giorni segnati per confrontare i giorni della settimana.</div>';
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
    '<p class="diary-chart-detail" data-dc-detail="vs" aria-live="polite">Tocca il grafico per il dettaglio di un giorno.</p>' +
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
function diaryForm(date) {
  var today = dToday();
  if (!date || date > today) date = today;
  var existing = diaryOn(date);
  var latestIfSaved = diaryIsLatest(date);
  var suggested = existing
    ? existing.balance
    : latestIfSaved
      ? balance()
      : (
          diarySeries()
            .filter(function (p) {
              return p.date < date;
            })
            .pop() || {}
        ).balance || balance();
  var d = sheetModal(
    sheetHead(existing ? 'Correggi saldo' : 'Segna saldo', { form: 'diary-form', del: existing ? 'diary-delete' : '' }) +
      '<form id="diary-form" class="diary-form sheet-form"><div class="sheet-group sheet-amount"><label class="sheet-field" for="diary-value"><span>Saldo a fine giornata (€)</span><input id="diary-value" name="value" type="number" inputmode="decimal" step="0.01" required value="' +
      U.round(suggested) +
      '"></label></div><div class="sheet-group"><label class="sheet-field" for="diary-date"><span>Giorno</span><input id="diary-date" name="date" type="date" max="' +
      today +
      '" required value="' +
      date +
      '"></label>' +
      '<label class="sheet-field" for="diary-note"><span>Nota (facoltativa)</span><input id="diary-note" name="note" type="text" maxlength="140" placeholder="es. giornata di Champions" value="' +
      U.esc((existing && existing.note) || '') +
      '"></label></div>' +
      '<div class="diary-effect sheet-box" id="diary-effect"></div><p class="error" id="diary-error"></p>' +
      '</form>',
  );
  var f = d.querySelector('form'),
    eff = d.querySelector('#diary-effect');
  var explain = function () {
    /* 3.0.0 — anteprima del risultato del giorno, depositi e prelievi esclusi */
    var dt = f.elements.date.value,
      v = Number(f.elements.value.value);
    if (!dt || dt > today || !U.finite(v) || f.elements.value.value === '') {
      eff.innerHTML = '';
      return;
    }
    var ser = diarySeries(),
      prev = null;
    for (var k = ser.length - 1; k >= 0; k--)
      if (ser[k].date < dt && (!existing || ser[k].id !== existing.id)) {
        prev = ser[k];
        break;
      }
    if (!prev && ser.start && ser.start.date < dt) prev = ser.start;
    if (!prev) {
      eff.innerHTML = '<p class="muted">Primo giorno segnato: da qui partono i conti. Se avevi un saldo di partenza, impostalo in Altro › Saldo iniziale.</p>';
      return;
    }
    var moved = U.round(
      realFlows()
        .filter(function (t) {
          var k2 = dayKey(t.date);
          return k2 > prev.date && k2 <= dt && (!startDate() || k2 >= startDate());
        })
        .reduce(function (n, t) {
          return n + t.amount;
        }, 0),
    );
    var res = U.round(v - prev.balance - moved);
    eff.innerHTML =
      '<p>Risultato ' +
      (dt === today ? 'di oggi' : 'del giorno') +
      ': <b class="' +
      sClass(res) +
      '">' +
      sMoney(res) +
      '</b></p><p class="muted">' +
      (prev.start ? 'Rispetto al saldo iniziale ' : 'Rispetto al ' + dShort(prev.date) + ' ') +
      '(' +
      U.money(prev.balance) +
      ')' +
      (Math.abs(moved) >= 0.005 ? ', ' + (moved > 0 ? 'depositi ' : 'prelievi ') + U.money(Math.abs(moved)) + ' esclusi.' : '.') +
      '</p>';
  };
  f.addEventListener('input', explain);
  explain();
  f.onsubmit = function (e) {
    e.preventDefault();
    var dt = f.elements.date.value,
      v = Number(f.elements.value.value),
      note = String(f.elements.note.value || '')
        .trim()
        .slice(0, 140);
    var err = d.querySelector('#diary-error');
    if (!dt || dt > today) {
      err.textContent = 'Scegli oggi o un giorno passato.';
      return;
    }
    if (!U.finite(v)) {
      err.textContent = 'Scrivi un importo valido.';
      return;
    }
    var other = diaryOn(dt);
    if (existing && other && other.id !== existing.id) {
      err.textContent = 'Quel giorno è già segnato: aprilo dall’agenda per correggerlo.';
      return;
    }
    if (diarySave(existing, dt, v, note)) {
      d.close();
      U.toast('Saldo segnato');
    }
  };
  var del = d.querySelector('#diary-delete');
  if (del)
    del.onclick = async function () {
      var latest = diaryIsLatest(existing.date);
      var ok = await U.confirm({
        title: 'Eliminare il saldo di questo giorno?',
        text: 'Depositi e prelievi restano.',
      });
      if (!ok) return;
      if (
        mutate(function (n) {
          n.diary = (n.diary || []).filter(function (x) {
            return x.id !== existing.id;
          });
          if (latest)
            n.transactions = n.transactions.filter(function (t) {
              return !(t.kind === 'adjust' && t.diaryId === existing.id);
            });
        })
      ) {
        d.close();
        U.toast('Giorno eliminato');
      }
    };
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
  var list = dayMovements(date);
  var ser = diarySeries(),
    entry =
      ser.find(function (p) {
        return p.date === date;
      }) || null;
  if (!list.length && !entry) return diaryForm(date);
  var time = function (iso) {
    return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  };
  var dep = 0,
    wd = 0;
  var cards = list
    .map(function (x) {
      var a = x.t.amount;
      if (a >= 0) dep += a;
      else wd += -a;
      return (
        '<div class="day-card ' +
        (a >= 0 ? 'tone-in' : 'tone-out') +
        '"><div class="day-card-top"><span class="day-ic" aria-hidden="true">' +
        (a >= 0 ? '↓' : '↑') +
        '</span><div class="day-card-title"><b>' +
        (a >= 0 ? 'Deposito' : 'Prelievo') +
        '</b><small>' +
        time(x.at) +
        '</small></div><strong class="' +
        (a >= 0 ? 'positive' : 'negative') +
        '">' +
        (a >= 0 ? '+' : '−') +
        U.money(Math.abs(a)) +
        '</strong><button type="button" class="day-edit" data-day-tx="' +
        x.t.id +
        '" aria-label="Modifica">✎</button></div></div>'
      );
    })
    .join('');
  var res = entry && entry.delta != null ? entry.delta : null;
  var tiles =
    '<div class="sheet-tiles three"><div><small>Saldo segnato</small><b>' +
    (entry ? U.money(entry.balance) : '—') +
    '</b></div><div><small>Depositi / prelievi</small><b class="' +
    (dep - wd > 0.004 ? 'positive' : dep - wd < -0.004 ? 'negative' : '') +
    '">' +
    (dep || wd ? (dep - wd >= 0 ? '+' : '−') + U.money(Math.abs(dep - wd)) : '—') +
    '</b></div><div><small>Risultato</small><b class="' +
    (res != null ? (res < 0 ? 'negative' : res > 0 ? 'positive' : '') : '') +
    '">' +
    (res != null ? sMoney(res) : '—') +
    '</b></div></div>';
  var expl =
    entry && entry.prev
      ? '<p class="sheet-note">Risultato = ' +
        U.money(entry.balance) +
        ' − ' +
        U.money(entry.prev.balance) +
        (entry.prev.start ? ' (saldo iniziale)' : ' (' + dShort(entry.prev.date) + ')') +
        (Math.abs(entry.moved) >= 0.005 ? ' ' + (entry.moved > 0 ? '−' : '+') + ' ' + U.money(Math.abs(entry.moved)) + (entry.moved > 0 ? ' depositati' : ' prelevati') : '') +
        '</p>'
      : '';
  var title = dParse(date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  var d = sheetModal(
    sheetHead(title.charAt(0).toUpperCase() + title.slice(1), {
      sub: entry ? (entry.note ? U.esc(entry.note) : 'Saldo segnato') : 'Saldo non segnato',
    }) +
      tiles +
      expl +
      (cards ? '<h3 class="sheet-section">Depositi e prelievi</h3><div class="day-list">' + cards + '</div>' : '') +
      '<button type="button" class="sheet-wide day-diary-btn primary" id="day-diary">' +
      IC('edit', '✎') +
      '<span>' +
      (entry ? 'Correggi il saldo del giorno' : 'Segna il saldo del giorno') +
      '</span></button><div class="sheet-actions-row"><button type="button" class="sheet-wide" id="day-dep">↓ Deposito</button><button type="button" class="sheet-wide" id="day-wd">↑ Prelievo</button></div>',
  );
  d.classList.add('day-sheet');
  d.querySelector('#day-diary').onclick = function () {
    d.close();
    diaryForm(date);
  };
  d.querySelector('#day-dep').onclick = function () {
    d.close();
    transactionForm(1, null, date);
  };
  d.querySelector('#day-wd').onclick = function () {
    d.close();
    transactionForm(-1, null, date);
  };
  d.querySelectorAll('[data-day-tx]').forEach(function (b) {
    b.onclick = function () {
      var t = db.transactions.find(function (x) {
        return x.id === b.dataset.dayTx;
      });
      if (!t) return;
      d.close();
      transactionForm(t.amount < 0 ? -1 : 1, t);
    };
  });
}

/* ---------- Eventi ---------- */
function bindDiary() {
  bindDiaryExtra();
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
        var norm = normalize(n);
        localStorage.setItem(KEY, JSON.stringify(norm));
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
        ? 'Per ricevere le notifiche apri Bet Tracker dall’icona sulla schermata Home (iPhone con iOS 16.4 o successivo).'
        : 'Questo browser non supporta le notifiche push.';
  } else if (!(window.SuiteSync && SuiteSync.signedIn)) {
    status =
      'Collega prima la sincronizzazione qui sopra: il promemoria parte dal server e controlla se hai già segnato il saldo.';
  } else if (!pushState.loaded) {
    status = 'Controllo…';
    dot = 'busy';
  } else if (on) {
    dot = 'on';
    var hour = Number(pushState.row.notify_hour != null ? pushState.row.notify_hour : 21);
    status =
      'Attive su questo telefono: alle ' +
      String(hour).padStart(2, '0') +
      ':00 ti ricordo di segnare il saldo, solo se non l’hai ancora fatto.';
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
        ? 'Notifiche bloccate per Bet Tracker: riattivale in Impostazioni › Notifiche › Bet Tracker, poi torna qui.'
        : 'Ricevi la sera un promemoria per segnare il saldo del giorno (solo se non l’hai già segnato).';
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
