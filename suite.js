/* Parti comuni a RecompApp e Style, uguali a Bilancio e Noi Due:
   - tema Sistema / Chiaro / Scuro;
   - popup centrale "Nuova versione disponibile".
   Caricato nel <head> prima dei fogli di stile: imposta data-theme sull'html senza lampeggi. */
(function () {
  var root = document.documentElement;
  // Bilancio e Noi Due gestiscono il tema da sole: qui il tema si attiva solo se la pagina ha data-theme-key.
  var THEMED = root.hasAttribute('data-theme-key');
  var KEY = root.getAttribute('data-theme-key') || 'app_theme';
  var mode = 'system';
  try { mode = localStorage.getItem(KEY) || 'system'; } catch (e) {}
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effective() { return mode === 'system' ? (mq && mq.matches ? 'dark' : 'light') : mode; }
  function apply() {
    if (!THEMED) return;
    var t = effective();
    root.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#12181f' : '#f1f2ed');
    var btns = document.querySelectorAll('[data-suite-theme]');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-suite-theme') === mode;
      btns[i].classList.toggle('active', on);
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  apply();
  if (mq) (mq.addEventListener ? mq.addEventListener('change', function () { if (mode === 'system') apply(); }) : mq.addListener(function () { if (mode === 'system') apply(); }));
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (e) {
    var b = THEMED && e.target.closest && e.target.closest('[data-suite-theme]');
    if (!b) return;
    mode = b.getAttribute('data-suite-theme');
    try { localStorage.setItem(KEY, mode); } catch (err) {}
    apply();
  });
  var ICONS = {
    system: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    dark: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
  };
  window.SuiteTheme = {
    mode: function () { return mode; },
    card: function (opts) {
      opts = opts || {};
      var seg = ['system', 'light', 'dark'].map(function (m) {
        var label = m === 'system' ? 'Sistema' : m === 'light' ? 'Chiaro' : 'Scuro';
        return '<button type="button" class="suite-seg-opt' + (m === mode ? ' active' : '') + '" data-suite-theme="' + m + '" aria-pressed="' + (m === mode) + '">' + ICONS[m] + '<span>' + label + '</span></button>';
      }).join('');
      return '<div class="' + (opts.cls || 'card') + ' suite-theme-card"><' + (opts.h || 'h2') + '>Aspetto</' + (opts.h || 'h2') + '><div class="suite-seg" role="group" aria-label="Tema">' + seg + '</div><p class="muted suite-theme-hint">Sistema segue il tema chiaro o scuro del telefono.</p></div>';
    }
  };
  window.SuiteUpdate = {
    show: function (appName, onUpdate) {
      var panel = document.getElementById('appUpdatePrompt');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'appUpdatePrompt';
        panel.className = 'app-update-modal';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'appUpdateTitle');
        panel.innerHTML = '<div class="app-update-card"><div class="app-update-icon" aria-hidden="true">↻</div><h3 id="appUpdateTitle">Nuova versione disponibile</h3><p>Vuoi aggiornare ' + appName + ' adesso? I tuoi dati restano salvati sul telefono.</p><div class="app-update-actions"><button type="button" class="app-update-later">Più tardi</button><button type="button" class="app-update-now">Aggiorna</button></div></div>';
        document.body.appendChild(panel);
      }
      requestAnimationFrame(function () { panel.classList.add('show'); });
      var later = panel.querySelector('.app-update-later'), now = panel.querySelector('.app-update-now');
      later.onclick = function () { panel.classList.remove('show'); };
      now.disabled = false; now.textContent = 'Aggiorna';
      now.onclick = function () {
        now.disabled = true; now.textContent = 'Aggiorno…';
        try { onUpdate(); } catch (e) { location.reload(); }
        setTimeout(function () { location.reload(); }, 4000);
      };
    }
  };
  /* Promemoria backup uguale nelle 4 app: dopo 30 giorni senza backup, al massimo una volta a settimana. */
  window.SuiteBackup = {
    show: function (o) {
      var panel = document.getElementById('appBackupPrompt');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'appBackupPrompt';
        panel.className = 'app-update-modal suite-backup-modal';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.innerHTML = '<div class="app-update-card"><div class="app-update-icon" aria-hidden="true">⤓</div><h3>Backup consigliato</h3><p class="suite-backup-text"></p><div class="app-update-actions"><button type="button" class="app-update-later">Più tardi</button><button type="button" class="app-update-now">Esporta</button></div></div>';
        document.body.appendChild(panel);
      }
      var days = o.days;
      panel.querySelector('.suite-backup-text').textContent = (isFinite(days) ? 'L’ultimo backup di ' + o.app + ' è di ' + days + ' giorni fa.' : 'Non hai ancora esportato un backup di ' + o.app + '.') + ' I dati sono salvati solo su questo telefono.';
      requestAnimationFrame(function () { panel.classList.add('show'); });
      panel.querySelector('.app-update-later').onclick = function () { panel.classList.remove('show'); };
      panel.querySelector('.app-update-now').onclick = function () { panel.classList.remove('show'); try { o.onExport(); } catch (e) {} };
    },
    maybe: function (o) {
      try {
        if (!o.hasData) return;
        var last = o.last ? new Date(o.last).getTime() : NaN;
        var days = isFinite(last) ? Math.floor((Date.now() - last) / 86400000) : Infinity;
        if (days < 30) return;
        var k = 'suite_backup_prompt_' + o.key, prev = Number(localStorage.getItem(k) || 0);
        if (Date.now() - prev < 7 * 86400000) return;
        localStorage.setItem(k, String(Date.now()));
        o.days = days;
        this.show(o);
      } catch (e) {}
    }
  };
})();

/* ===================== Sincronizzazione online (Supabase) =====================
   Ogni app continua a salvare sul telefono (funziona anche offline) e in più tiene una copia
   nel database online. Accesso con email e password, una volta per app.
   - Bilancio, RecompApp, Style: tabella app_data (una riga per persona e per app).
   - Noi Due: tabella noidue_data (una riga per coppia, condivisa dai due telefoni).
   Regole: all'apertura, al ritorno nell'app, quando torna la rete e poco dopo ogni modifica.
   Se nel frattempo l'altro telefono ha cambiato qualcosa, i dati vengono uniti, non sovrascritti. */
(function () {
  var SB_URL = 'https://thdlzqhqdktbkpnplxdm.supabase.co';
  var SB_KEY = 'sb_publishable_47TpIhmNLOgojOKddeH1ZQ_b4PZamyG';
  try { var t = localStorage.getItem('suite_sb_url_test'); if (t) SB_URL = t; } catch (e) {}
  var SKEY = 'suite_sb_session';
  function now() { return new Date().toISOString(); }
  function readJSON(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var session = readJSON(SKEY, null);
  function saveSession(j) {
    session = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600), user: { id: j.user && j.user.id, email: j.user && j.user.email } };
    writeJSON(SKEY, session);
  }
  async function authCall(grant, body) {
    var r = await fetch(SB_URL + '/auth/v1/token?grant_type=' + grant, { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) { var e = new Error(j.error_description || j.msg || j.message || ('Errore ' + r.status)); e.status = r.status; e.code = j.error_code; throw e; }
    saveSession(j);
    return session;
  }
  var refreshing = null;
  async function token() {
    if (!session) return null;
    if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    if (!refreshing) refreshing = authCall('refresh_token', { refresh_token: session.refresh_token }).catch(function (e) {
      if (e.status === 400 || e.status === 401) { session = null; try { localStorage.removeItem(SKEY); } catch (x) {} }
      throw e;
    }).finally(function () { refreshing = null; });
    await refreshing;
    return session && session.access_token;
  }
  async function api(path, opts) {
    opts = opts || {};
    var tk = await token();
    if (!tk) { var e = new Error('Non hai fatto l’accesso'); e.auth = true; throw e; }
    var h = { apikey: SB_KEY, Authorization: 'Bearer ' + tk };
    for (var k in (opts.headers || {})) h[k] = opts.headers[k];
    if (opts.json !== undefined) { h['Content-Type'] = 'application/json'; }
    var r = await fetch(SB_URL + path, { method: opts.method || 'GET', headers: h, body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body });
    if (r.status === 401) { session && (session.expires_at = 0); }
    if (!r.ok) { var t2 = await r.text().catch(function () { return ''; }); var er = new Error('Errore ' + r.status + (t2 ? ': ' + t2.slice(0, 160) : '')); er.status = r.status; throw er; }
    var ct = r.headers.get('content-type') || '';
    if (opts.raw) return r;
    return ct.indexOf('json') >= 0 ? r.json() : r.text();
  }

  /* Unione generica: le liste con "id" vengono unite elemento per elemento (vince la copia più recente),
     il resto viene dalla copia più recente. */
  function mergeById(newer, older) {
    if (Array.isArray(newer) && Array.isArray(older)) {
      var withId = newer.concat(older).every(function (x) { return x && typeof x === 'object' && x.id != null; });
      if (!withId) return newer;
      var seen = {}, out = [];
      newer.forEach(function (x) { seen[x.id] = 1; out.push(x); });
      older.forEach(function (x) { if (!seen[x.id]) out.push(x); });
      return out;
    }
    if (newer && older && typeof newer === 'object' && typeof older === 'object' && !Array.isArray(newer) && !Array.isArray(older)) {
      var o = {};
      Object.keys(older).forEach(function (k) { o[k] = older[k]; });
      Object.keys(newer).forEach(function (k) { o[k] = k in older ? mergeById(newer[k], older[k]) : newer[k]; });
      return o;
    }
    return newer;
  }

  /* Copia dell'ultima versione sincronizzata ("base"): serve a capire cosa è stato cancellato
     su un dispositivo, così un elemento eliminato non ricompare unendo i dati. */
  var baseDbP = null;
  function baseDb() {
    if (!window.indexedDB) return Promise.reject(new Error('no idb'));
    if (!baseDbP) baseDbP = new Promise(function (res, rej) { var r = indexedDB.open('suite_sync', 1); r.onupgradeneeded = function () { r.result.createObjectStore('base'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; });
    return baseDbP;
  }
  function baseGet(app) { return baseDb().then(function (d) { return new Promise(function (res) { var q = d.transaction('base').objectStore('base').get(app); q.onsuccess = function () { res(q.result || null); }; q.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function basePut(app, data) { return baseDb().then(function (d) { return new Promise(function (res) { var t = d.transaction('base', 'readwrite'); t.objectStore('base').put(JSON.parse(JSON.stringify(data)), app); t.oncomplete = res; t.onerror = res; }); }).catch(function () {}); }
  function idsOf(a) { var s = {}; (a || []).forEach(function (x) { if (x && x.id != null) s[x.id] = 1; }); return s; }
  function isIdArray(a) { return Array.isArray(a) && a.length > 0 && a.every(function (x) { return x && typeof x === 'object' && x.id != null; }); }
  /* Toglie dal risultato gli elementi che c'erano nella base ma mancano in una delle due copie (= cancellati). */
  function pruneDeleted(res, local, remote, base) {
    if (Array.isArray(res) && Array.isArray(base) && (isIdArray(res) || isIdArray(base))) {
      var b = idsOf(base), l = Array.isArray(local) ? idsOf(local) : null, r = Array.isArray(remote) ? idsOf(remote) : null;
      return res.filter(function (x) { if (!x || x.id == null || !b[x.id]) return true; return !((l && !l[x.id]) || (r && !r[x.id])); });
    }
    if (res && base && typeof res === 'object' && typeof base === 'object' && !Array.isArray(res)) {
      Object.keys(res).forEach(function (k) { if (k in base) res[k] = pruneDeleted(res[k], local && local[k], remote && remote[k], base[k]); });
    }
    return res;
  }

  var apps = {};
  /* opts: { app, name, scope:'personal'|'couple', getLocal(), setLocal(data, info), merge(local, remote, remoteIsNewer),
             hasLocalData(), localUpdatedAt(), afterPush(ctx), onStatus() } */
  function register(opts) {
    var A = {
      o: opts, rev: 0, metaKey: 'suite_sync_meta_' + opts.app, timer: null, busy: null, status: 'idle', error: '', coupleId: null,
      meta: function () { return readJSON(this.metaKey, { remoteAt: null, dirty: false, lastSync: null, linked: false }); },
      setMeta: function (m) { writeJSON(this.metaKey, m); },
    };
    apps[opts.app] = A;
    function setStatus(s, err) { A.status = s; A.error = err || ''; refreshCards(); if (opts.onStatus) try { opts.onStatus(s, err); } catch (e) {} }
    async function rowRef() {
      if (opts.scope === 'couple') {
        if (!A.coupleId) {
          var rows = await api('/rest/v1/couple_members?select=couple_id&user_id=eq.' + encodeURIComponent(session.user.id));
          if (!rows.length) { var e = new Error('Questo account non è collegato a una coppia (vedi la guida, passo 5).'); e.nocouple = true; throw e; }
          A.coupleId = rows[0].couple_id;
        }
        return { table: 'noidue_data', filter: 'couple_id=eq.' + encodeURIComponent(A.coupleId), insert: { couple_id: A.coupleId } };
      }
      return { table: 'app_data', filter: 'app=eq.' + encodeURIComponent(opts.app) + '&user_id=eq.' + encodeURIComponent(session.user.id), insert: { app: opts.app } };
    }
    A.rowRef = rowRef;
    async function syncOnce() {
      var ref = await rowRef();
      if (opts.scope === 'couple' && A.coupleId && !A.rt) startRealtime(A);
      var m = A.meta();
      var rows = await api('/rest/v1/' + ref.table + '?select=data,updated_at&' + ref.filter);
      var row = rows[0] || null;
      if (row && row.updated_at !== m.remoteAt) {
        var first = !m.linked;
        if ((m.dirty || first) && opts.hasLocalData()) {
          var localAt = opts.localUpdatedAt ? opts.localUpdatedAt() : null;
          var remoteNewer = !localAt || String(row.updated_at) > String(localAt);
          var loc = await opts.getLocal();
          var merged = opts.merge ? opts.merge(loc, row.data, remoteNewer) : (remoteNewer ? mergeById(row.data, loc) : mergeById(loc, row.data));
          if (!opts.noPrune) { var base = await baseGet(opts.app); if (base) merged = pruneDeleted(JSON.parse(JSON.stringify(merged)), loc, row.data, base); }
          await opts.setLocal(merged, { merged: true });
          m.dirty = true; A.setMeta(m);
        } else {
          await opts.setLocal(row.data, { merged: false });
          m.remoteAt = row.updated_at; m.dirty = false; m.linked = true; m.lastSync = now();
          A.setMeta(m);
          await basePut(opts.app, row.data);
          return 'pulled';
        }
      }
      if (!row || m.dirty || !m.linked) {
        if (!row && !opts.hasLocalData()) { m.linked = true; m.dirty = false; m.lastSync = now(); A.setMeta(m); return 'empty'; }
        var rev0 = A.rev;
        var body = { data: await opts.getLocal(), updated_at: now() };
        if (opts.scope === 'couple' && typeof opts.editorTag === 'function') {
          try { body.updated_by_person = opts.editorTag() || null; } catch (e) {}
        }
        var res;
        if (row) {
          res = await api('/rest/v1/' + ref.table + '?' + ref.filter + '&updated_at=eq.' + encodeURIComponent(row.updated_at), { method: 'PATCH', json: body, headers: { Prefer: 'return=representation' } });
          if (!res.length) return 'conflict';
        } else {
          var ins = {}; for (var k in ref.insert) ins[k] = ref.insert[k]; ins.data = body.data; ins.updated_at = body.updated_at;
          if (body.updated_by_person !== undefined) ins.updated_by_person = body.updated_by_person;
          try { res = await api('/rest/v1/' + ref.table, { method: 'POST', json: ins, headers: { Prefer: 'return=representation' } }); }
          catch (e) { if (e.status === 409) return 'conflict'; throw e; }
        }
        m.remoteAt = res[0].updated_at; m.dirty = A.rev !== rev0; m.linked = true; m.lastSync = now();
        A.setMeta(m);
        await basePut(opts.app, body.data);
        if (m.dirty) A.again = true;
        if (opts.afterPush) try { await opts.afterPush(A); } catch (e) { console.warn('foto', e); }
        return 'pushed';
      }
      m.lastSync = now(); A.setMeta(m);
      if (opts.afterPush && !A._photosChecked) { A._photosChecked = true; try { await opts.afterPush(A); } catch (e) {} }
      return 'same';
    }
    A.sync = function (why) {
      if (!session) { setStatus('off'); return Promise.resolve('off'); }
      if (!navigator.onLine) { setStatus('offline'); return Promise.resolve('offline'); }
      if (A.busy) { A.again = true; return A.busy; }
      setStatus('syncing');
      A.busy = (async function () {
        try {
          var r;
          for (var i = 0; i < 4; i++) { r = await syncOnce(); if (r !== 'conflict') break; }
          setStatus('ok');
          return r;
        } catch (e) {
          console.warn('sync', e);
          setStatus(e.auth ? 'off' : 'error', e.message);
          return 'error';
        } finally {
          A.busy = null;
          if (A.again) { A.again = false; setTimeout(function () { A.sync('again'); }, 300); }
        }
      })();
      return A.busy;
    };
    A.changed = function () {
      A.rev++;
      var m = A.meta(); if (!m.dirty) { m.dirty = true; A.setMeta(m); }
      clearTimeout(A.timer);
      if (session) A.timer = setTimeout(function () { A.sync('change'); }, 2500);
    };
    A.uploadPhoto = async function (path, blob) {
      await api('/storage/v1/object/foto/' + path, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' } });
    };
    A.downloadPhoto = async function (path) {
      var r = await api('/storage/v1/object/authenticated/foto/' + path, { raw: true });
      return r.blob();
    };
    // avvio e richiami automatici
    setTimeout(function () { A.sync('start'); }, 1200);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') A.sync('visible'); });
    window.addEventListener('online', function () { A.sync('online'); });
    setInterval(function () { if (document.visibilityState === 'visible' && session) A.sync('timer'); }, opts.scope === 'couple' ? 45000 : 120000);
    return A;
  }

  function statusText(A) {
    if (!session) return 'Non collegato: i dati restano solo su questo telefono.';
    var m = A.meta();
    var last = m.lastSync ? new Date(m.lastSync).toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'mai';
    if (A.status === 'syncing') return 'Sincronizzo…';
    if (A.status === 'offline') return 'Offline: sincronizzo appena torna la rete. Ultima: ' + last + '.';
    if (A.status === 'error') return 'Non riuscita: ' + A.error;
    return 'Collegato come ' + session.user.email + '. Ultima sincronizzazione: ' + last + (m.dirty ? ' (modifiche da inviare)' : '') + '.';
  }
  function cardHtml(appKey, o) {
    o = o || {};
    var A = apps[appKey]; if (!A) return '';
    var H = o.h || 'h2', cls = o.cls || 'card';
    var inner;
    if (!session) {
      inner = '<form class="suite-sync-form" data-suite-sync-login="' + appKey + '" autocomplete="on">' +
        '<input type="email" name="email" placeholder="Email" autocomplete="username" required inputmode="email">' +
        '<input type="password" name="password" placeholder="Password" autocomplete="current-password" required>' +
        '<button type="submit" class="suite-sync-primary primary">Accedi e sincronizza</button>' +
        '<button type="button" class="suite-sync-link" data-suite-sync-forgot="' + appKey + '">Password dimenticata?</button></form>';
    } else {
      inner = '<div class="suite-sync-actions"><button type="button" class="suite-sync-primary primary" data-suite-sync-now="' + appKey + '">↻ Sincronizza ora</button><button type="button" data-suite-sync-out="' + appKey + '">Esci</button></div>' +
        '<div class="suite-sync-more"><button type="button" data-suite-sync-history="' + appKey + '">🕘 Versioni precedenti</button><button type="button" data-suite-sync-pw="' + appKey + '">🔑 Cambia password</button></div>';
    }
    var dot = !session ? 'off' : A.status === 'error' ? 'err' : A.status === 'syncing' ? 'busy' : 'on';
    return '<div class="' + cls + ' suite-sync-card" data-suite-sync-card="' + appKey + '" data-h="' + H + '" data-cls="' + esc(cls) + '"><' + H + '>Sincronizzazione</' + H + '>' +
      '<p class="suite-sync-status"><span class="suite-sync-dot ' + dot + '" aria-hidden="true"></span>' + esc(statusText(A)) + '</p>' + inner + '</div>';
  }
  function refreshCards() {
    var cards = document.querySelectorAll('[data-suite-sync-card]');
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i], key = c.getAttribute('data-suite-sync-card');
      var focusInside = c.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      if (focusInside) continue;
      var tmp = document.createElement('div'); tmp.innerHTML = cardHtml(key, { h: c.getAttribute('data-h'), cls: c.getAttribute('data-cls') });
      c.replaceWith(tmp.firstChild);
    }
  }
  document.addEventListener('submit', async function (e) {
    var f = e.target.closest && e.target.closest('[data-suite-sync-login]'); if (!f) return;
    e.preventDefault();
    var key = f.getAttribute('data-suite-sync-login'), btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Accesso…';
    try {
      await authCall('password', { email: f.email.value.trim(), password: f.password.value });
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      var A = apps[key]; refreshCards(); A.sync('login');
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Accedi e sincronizza';
      var p = f.parentNode.querySelector('.suite-sync-status');
      if (p) p.textContent = err.code === 'invalid_credentials' || err.status === 400 ? 'Email o password non corrette.' : 'Accesso non riuscito: ' + err.message;
    }
  });
  document.addEventListener('click', function (e) {
    var hi = e.target.closest && e.target.closest('[data-suite-sync-history]');
    if (hi) { openHistory(apps[hi.getAttribute('data-suite-sync-history')]); return; }
    var pw = e.target.closest && e.target.closest('[data-suite-sync-pw]');
    if (pw) { openChangePassword(); return; }
    var fg = e.target.closest && e.target.closest('[data-suite-sync-forgot]');
    if (fg) { var f = fg.closest('form'); sendRecovery(f.email.value.trim(), f.parentNode.querySelector('.suite-sync-status')); return; }
    var n = e.target.closest && e.target.closest('[data-suite-sync-now]');
    if (n) { apps[n.getAttribute('data-suite-sync-now')].sync('button'); return; }
    var o = e.target.closest && e.target.closest('[data-suite-sync-out]');
    if (o) {
      var key = o.getAttribute('data-suite-sync-out');
      session = null; try { localStorage.removeItem(SKEY); } catch (x) {}
      var A = apps[key]; var m = A.meta(); m.linked = false; m.remoteAt = null; A.setMeta(m); A.coupleId = null;
      if (A.rt) { A.rt.stop(); A.rt = null; }
      refreshCards();
    }
  });
  /* ---------- Finestra semplice (stesso stile del popup di aggiornamento) ---------- */
  function modal(html, onReady) {
    var wrap = document.createElement('div');
    wrap.className = 'app-update-modal suite-modal';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML = '<div class="app-update-card suite-modal-card">' + html + '</div>';
    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('show'); });
    function close() { wrap.classList.remove('show'); setTimeout(function () { wrap.remove(); }, 220); }
    wrap.addEventListener('click', function (e) { if (e.target === wrap || (e.target.closest && e.target.closest('[data-suite-close]'))) close(); });
    if (onReady) onReady(wrap, close);
    return close;
  }
  function fmtWhen(iso) { try { return new Date(iso).toLocaleString('it-IT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (e) { return iso; } }

  /* ---------- Versioni precedenti (tabelle *_history, salvate dal database) ---------- */
  async function historyTable(A) {
    var ref = await A.rowRef();
    return ref.table === 'noidue_data'
      ? { t: 'noidue_data_history', filter: 'couple_id=eq.' + encodeURIComponent(A.coupleId), ins: { couple_id: A.coupleId } }
      : { t: 'app_data_history', filter: 'app=eq.' + encodeURIComponent(A.o.app) + '&user_id=eq.' + encodeURIComponent(session.user.id), ins: { app: A.o.app, user_id: session.user.id } };
  }
  function openHistory(A) {
    modal('<h3>Versioni precedenti</h3><p class="suite-modal-text">Carico…</p><div class="suite-history-list"></div><div class="app-update-actions one"><button type="button" data-suite-close>Chiudi</button></div>', async function (wrap, close) {
      var text = wrap.querySelector('.suite-modal-text'), list = wrap.querySelector('.suite-history-list');
      try {
        var H = await historyTable(A);
        var rows = await api('/rest/v1/' + H.t + '?select=id,saved_at&' + H.filter + '&order=saved_at.desc&limit=40');
        if (!rows.length) { text.textContent = 'Non ci sono ancora versioni salvate. Il database ne tiene una all’ora mentre usi l’app (fino a 60).'; return; }
        text.textContent = 'Tocca una versione e poi conferma. I dati di adesso vengono prima salvati come nuova versione, quindi puoi sempre tornare indietro.';
        list.innerHTML = rows.map(function (r) { return '<button type="button" class="suite-history-row" data-id="' + esc(r.id) + '" data-when="' + esc(fmtWhen(r.saved_at)) + '"><span>' + esc(fmtWhen(r.saved_at)) + '</span><span>›</span></button>'; }).join('');
        list.querySelectorAll('[data-id]').forEach(function (b) {
          b.addEventListener('click', async function () {
            if (!b.classList.contains('confirm')) {
              list.querySelectorAll('.confirm').forEach(function (x) { x.classList.remove('confirm'); x.firstChild.textContent = x.getAttribute('data-when'); });
              b.classList.add('confirm'); b.firstChild.textContent = 'Tocca di nuovo per tornare al ' + b.getAttribute('data-when'); return;
            }
            b.disabled = true; text.textContent = 'Ripristino…';
            try {
              var got = await api('/rest/v1/' + H.t + '?select=data&id=eq.' + encodeURIComponent(b.getAttribute('data-id')));
              if (!got.length) throw new Error('versione non trovata');
              var cur = {}; for (var k in H.ins) cur[k] = H.ins[k]; cur.data = await A.o.getLocal(); cur.saved_at = now();
              await api('/rest/v1/' + H.t, { method: 'POST', json: cur, headers: { Prefer: 'return=minimal' } }).catch(function () {});
              await A.o.setLocal(got[0].data, { merged: true, restored: true });
              A.changed(); await A.sync('restore');
              text.textContent = 'Fatto: dati ripristinati.';
              setTimeout(close, 900);
            } catch (e) { text.textContent = 'Ripristino non riuscito: ' + e.message; b.disabled = false; }
          });
        });
      } catch (e) {
        text.textContent = e.status === 404 || /history|relation|schema cache/i.test(e.message) ? 'Le versioni non sono ancora attive: esegui il passo 10 della guida Supabase.' : 'Non riesco a leggere le versioni: ' + e.message;
      }
    });
  }

  /* ---------- Password: cambio e recupero ---------- */
  function openChangePassword(title, after) {
    modal('<h3>' + esc(title || 'Cambia password') + '</h3><form class="suite-sync-form suite-pw-form"><input type="password" name="p1" placeholder="Nuova password (min. 8 caratteri)" autocomplete="new-password" minlength="8" required><input type="password" name="p2" placeholder="Ripeti la password" autocomplete="new-password" minlength="8" required><p class="suite-modal-text"></p><div class="app-update-actions"><button type="button" data-suite-close>Annulla</button><button type="submit" class="app-update-now">Salva</button></div></form>', function (wrap, close) {
      var f = wrap.querySelector('form'), msg = wrap.querySelector('.suite-modal-text');
      f.addEventListener('submit', async function (e) {
        e.preventDefault();
        if (f.p1.value !== f.p2.value) { msg.textContent = 'Le due password non coincidono.'; return; }
        try { await api('/auth/v1/user', { method: 'PUT', json: { password: f.p1.value } }); msg.textContent = 'Password aggiornata.'; setTimeout(close, 900); if (after) after(); }
        catch (err) { msg.textContent = /same/i.test(err.message) ? 'È uguale a quella attuale.' : /weak|short|least/i.test(err.message) ? 'Password troppo semplice: usane una più lunga.' : 'Non riuscito: ' + err.message; }
      });
    });
  }
  async function sendRecovery(email, statusEl) {
    if (!email) { statusEl.textContent = 'Scrivi prima la tua email qui sotto.'; return; }
    try {
      var back = location.href.split('#')[0];
      var r = await fetch(SB_URL + '/auth/v1/recover?redirect_to=' + encodeURIComponent(back), { method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email }) });
      statusEl.textContent = r.ok ? 'Ti ho mandato un’email con il link per scegliere una nuova password (controlla anche lo spam).' : r.status === 429 ? 'Troppe richieste: riprova tra qualche minuto.' : 'Invio non riuscito (' + r.status + ').';
    } catch (e) { statusEl.textContent = 'Invio non riuscito: controlla la connessione.'; }
  }
  // Ritorno dal link dell'email di recupero: #access_token=…&type=recovery
  (function handleRecovery() {
    var h = location.hash || '';
    if (h.indexOf('access_token=') < 0) return;
    var q = {}; h.slice(1).split('&').forEach(function (kv) { var i = kv.indexOf('='); q[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1)); });
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    if (q.type !== 'recovery' && q.type !== 'magiclink' && q.type !== 'signup') return;
    session = { access_token: q.access_token, refresh_token: q.refresh_token, expires_at: Number(q.expires_at) || Math.floor(Date.now() / 1000) + Number(q.expires_in || 3600), user: { id: null, email: '' } };
    fetch(SB_URL + '/auth/v1/user', { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + q.access_token } }).then(function (r) { return r.json(); }).then(function (u) {
      session.user = { id: u.id, email: u.email }; writeJSON(SKEY, session); refreshCards();
      if (q.type === 'recovery') setTimeout(function () { openChangePassword('Scegli la nuova password'); }, 600);
      Object.keys(apps).forEach(function (k) { apps[k].sync('recovery'); });
    }).catch(function () {});
  })();

  /* ---------- Tempo reale (Noi Due): avviso immediato quando l'altro telefono salva ---------- */
  function startRealtime(A) {
    if (A.rt || !window.WebSocket || /^http:\/\/localhost/.test(SB_URL)) return;
    var ws, ref = 0, hb = null, retry = 0, topic = 'realtime:noidue-' + A.coupleId, closedByUs = false;
    A.rt = { stop: function () { closedByUs = true; try { ws && ws.close(); } catch (e) {} } };
    function send(o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
    function connect() {
      if (!session) return;
      ws = new WebSocket(SB_URL.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(SB_KEY) + '&vsn=1.0.0');
      ws.onopen = async function () {
        retry = 0;
        var tk = await token().catch(function () { return null; });
        send({ topic: topic, event: 'phx_join', ref: String(++ref), join_ref: String(ref), payload: { config: { broadcast: { self: false }, presence: { key: '' }, postgres_changes: [{ event: '*', schema: 'public', table: 'noidue_data', filter: 'couple_id=eq.' + A.coupleId }] }, access_token: tk } });
        clearInterval(hb);
        hb = setInterval(async function () {
          send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) });
          var t2 = await token().catch(function () { return null; });
          if (t2 && t2 !== A.rtToken) { A.rtToken = t2; send({ topic: topic, event: 'access_token', payload: { access_token: t2 }, ref: String(++ref) }); }
        }, 25000);
        A.rtToken = tk;
      };
      ws.onmessage = function (ev) {
        var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.event === 'postgres_changes') { clearTimeout(A.rtTimer); A.rtTimer = setTimeout(function () { A.sync('realtime'); }, 400); }
      };
      ws.onclose = function () {
        clearInterval(hb);
        if (closedByUs || !session) { A.rt = null; return; }
        retry = Math.min(retry + 1, 6);
        setTimeout(function () { if (document.visibilityState === 'visible') connect(); else A.rt = null; }, 1000 * Math.pow(2, retry));
      };
    }
    connect();
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && ws && ws.readyState > 1 && !closedByUs) connect(); });
  }

  window.SuiteSync = {
    register: register,
    cardHtml: cardHtml,
    refreshCards: refreshCards,
    mergeById: mergeById,
    get signedIn() { return !!session; },
    get userId() { return session && session.user.id; },
    app: function (k) { return apps[k]; },
    api: api,
    modal: modal,
  };
})();

/* ===================== Formato importi unico per tutta la suite =====================
   1.234,56 € — simbolo dopo, punto per le migliaia, sempre due decimali, spazio non
   separabile prima di € (l'importo non va a capo). Usato da Bilancio, Noi Due, Style e
   Bet Tracker, e uguale nelle notifiche. */
(function () {
  function group(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  window.SuiteFmt = {
    money: function (n) {
      var v = Math.round((Number(n) || 0) * 100) / 100;
      var neg = v <= -0.005, p = Math.abs(v).toFixed(2).split('.');
      return (neg ? '-' : '') + group(p[0]) + ',' + p[1] + ' €';
    },
    /* Etichette compatte per gli assi dei grafici: 950 €, 1,5k €, 12k € */
    short: function (n) {
      var a = Math.abs(Number(n) || 0), s = n < 0 ? '-' : '';
      if (a >= 10000) return s + Math.round(a / 1000) + 'k €';
      if (a >= 1000) return s + (a / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '') + 'k €';
      return s + group(String(Math.round(a))) + ' €';
    },
    /* Legge un importo scritto a mano: "1.234,56", "1234.56", "€ 12,5", "12,50 €" */
    parse: function (str) {
      var t = String(str == null ? '' : str).replace(/[€\s ]/g, '');
      if (!t) return NaN;
      if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.');
      else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
      return parseFloat(t);
    }
  };
})();
