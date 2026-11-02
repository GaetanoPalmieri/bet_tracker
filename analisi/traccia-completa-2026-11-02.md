# Bet Tracker — traccia completa 20/10–2/11

> **Parte 2 (versione 4.21.6, server 4.15.4)** è in fondo: è la ricalibrazione fatta sulla traccia intera.
> La parte 1 qui sotto è quella fatta sul file troncato (4.21.5).

## Parte 1 — file troncato (analisi del 2/11 mattina, versione 4.21.5)

## 1. Il file è incompleto: 1.000 righe al giorno

| Giorno | Righe | Ore coperte | Partite |
|---|---|---|---|
| 20/10 | 1.000 | 02:14–15:08 | 72 |
| 21/10 | 1.000 | 01:00–12:30 | 80 |
| 24/10 | 1.000 | 01:00–04:52 | 44 |
| 25/10 | 1.000 | 01:00–02:20 | 68 |
| 28/10 | 0 | — | — |
| 2/11 | 607 | 01:04–11:40 | 40 |

- Ogni giorno si ferma a **esattamente 1.000 righe**, quasi sempre nelle prime ore della notte.
- In tutto ci sono **765 partite in 13 giorni**. Il server ne registra migliaia: una riga ogni ~5 minuti per ogni partita live.
- Il campione è quasi tutto **Americhe e Asia**: Liga MX, Colombia, MLS, J-League, Brasile, Argentina.
- **Causa:** l'export chiedeva pagine da 2.000 righe, ma Supabase ne restituisce al massimo 1.000. La prima pagina tornava quindi "non piena" e il giorno finiva lì.
- **Correzione (server 4.15.3 + app 4.21.5):**
  - pagine da 1.000 righe, con il passaggio alla pagina dopo;
  - l'app tiene una riga ogni 4 minuti per partita, e sempre quando cambia il punteggio o il tempo;
  - se un giorno torna con esattamente 1.000 righe, l'export avvisa che la funzione sul server è vecchia.
- **Dato nuovo:** la traccia ora salva anche le **quote 1X2 prepartita** (colonna `x12`). Senza di queste non si poteva controllare il gol 1T favorita.

I finali (6.378 partite con i minuti dei gol) invece sono completi.

## 2. Filtri rigiocati sulla traccia

Ho rigiocato i filtri con il motore vero (`tipTargetPlays` di pronostici.js) partita per partita. L'esito viene dai finali: gol entro l'intervallo per il 1T, entro la fine per il 2T.

| Filtro | Vinte | Stima mostrata | Decisione |
|---|---|---|---|
| 🔥 Gol 1T partita da gol | 36/48 (75%) | 77% | **stima a 75%** |
| 🔥 Gol 2T partita da gol, campionati principali | 26/31 (84%) | 86% | resta |
| 🎯 Prossimo gol 2T | 6/6 | ~80% | resta (pochi casi) |
| 🎯 Gol 1T favorita | — | — | non verificabile: mancavano le quote 1X2 |

**🔥 1T:**
- Per periodo: 20–27/10 28/35 (80%), 29/10–2/11 7/12 (58%).
- La finestra 10'–19' va bene: 10'–14' 73%, 15'–19' 75%, 20'–24' 69%, 25'–29' 39%.

**🔥 2T:**
- Con tutti i campionati tranne i femminili sarebbe 113/129 (88%).
- La regola "solo campionati principali" della 4.21.1 resta. Unendo i due export, i principali fanno 62/68 (91%) e gli altri 171/200 (85,5%), cioè circa al prezzo.
- Per minuto: 46'–50' 89%, 51'–54' 85%, 55'–60' 82%, 61'–66' 78%, 67'–72' 69%.

## 3. Da seguire, senza regole nuove (pochi casi)

- **🔥 2T sull'1-1:** con linea prepartita 3.25 o più, 9/14 (64%) contro l'84% del mercato. Con 1-0 / 0-1 si arriva al 90%, sullo 0-0 al 92%. Se si conferma con la traccia completa, il 🔥 2T non dovrebbe partire sull'1-1.
- **2T con una squadra avanti di 1, 46'–60':** 177/208 (85%) contro il 78% del mercato. Qui però il mercato è ricavato dalla sola linea gol: con le quote vere bet365 (archivio 4.13.0) il vantaggio non c'era. Non si riaccende niente.

## 4. Prossimo passo

1. Ripubblica `pronostici-avvisi` (4.15.3).
2. Tra 5–7 giorni rifai l'export da Statistiche › Live › "⬇︎ Traccia completa" con **7 giorni**.
3. Con la traccia intera e le quote 1X2 si possono ritarare il gol 1T favorita e la regola dell'1-1.

---

## Parte 2 — traccia intera (2/11 pomeriggio, versione 4.21.6 · server 4.15.4)

**Dati:** 6.498 partite, 122.527 righe (una ogni 4' per partita), 6.382 finali.
- Il 28/10 non ha righe (server fermo).
- Le quote 1X2 ci sono solo dalle 13 del 2/11 (28 righe).

**Metodo:**
- I filtri sono rigiocati con il motore vero (`tipTargetPlays`). L'esito viene dai finali: gol entro l'intervallo per il 1T, entro la fine per il 2T.
- Ogni scelta è controllata su due metà: **A** = 20–27/10, **B** = 29/10–2/11.
- Il "mercato" è la % del book in quel momento: quote bet365 quando ci sono, altrimenti la linea gol live.
- Le soglie sono scelte su questi dati, quindi dal vivo aspettati 1–2 punti in meno.

**Keep** = gol che il book si aspetta ancora (linea live − gol fatti) diviso i gol attesi prima per il tempo che resta (linea prepartita × minuti rimasti / 94). Sotto 1 vuol dire che la partita è più lenta del previsto.

### 🔥 Gol 2T partita da gol (campionati principali, linea 3.25+)

| | Vinte | Mercato | A | B |
|---|---|---|---|---|
| Regola di prima (47'–54') | 282/326 (86,5%) | 84% | 86,2% | 87,1% |
| keep ≥ 1 | 190/211 (90,0%) | 85% | 90,6% | 89,0% |
| keep < 1 | 92/115 (80,0%) | 82% | 77,8% | 83,7% |

Con keep ≥ 1, per minuto:

| Minuti | Vinte | Mercato |
|---|---|---|
| 47'–50' | 122/132 (92%) | 87% |
| 51'–54' | 86% | 83% |
| 55'–58' | 121/139 (87%) | 80% |
| 59'–62' | 78% | 77% |

- Con linea 3.0–3.25 e keep ≥ 1 fa 83%, uguale al mercato.
- Fuori dai campionati principali la metà B fa 80,6%.

**4.21.6:**
- keep ≥ 1, finestra **47'–58'**, stima **91% fino al 50', poi 86%**.
- Rigiocato col motore nuovo: **188/214 (87,9%)** contro una stima di 87,7% e un mercato all'83%. A 88,6%, B 86,6%. Circa 16 segnali al giorno.

### 🔥 Gol 1T partita da gol (12'–19', linea 3.5+, tiro in porta recente)

| | Vinte | Mercato |
|---|---|---|
| Regola di prima | 308/424 (72,6%) | 71% (A 75,5% · B 68,3%) |
| keep ≥ 1 | 267/357 (74,8%) | 71% (A 77% · B 71,5%) |
| keep < 1 | — | B 52% |
| Giovanili dei Paesi forti | 25/40 (62,5%) | 72% |

- Il tiro in porta recente quasi non conta: senza tiri 71%.
- Finestra: 8'–11' 78,5% (mercato 77%), 20'–23' 67%, 24'–27' 60%.

**4.21.6:**
- keep ≥ 1 e fuori le giovanili dei Paesi forti, stima 75%.
- Rigiocato: **213/284 (75,0%)**, mercato 71,4%. A 76,0%, B 73,5%. Resta **in prova**: il vantaggio sul mercato è di 3–4 punti.

### 🎯 Prossimo gol 2T (top campionati e prime divisioni)

| Mercato | Vinte |
|---|---|
| 75–80% | 79% (= mercato) |
| 80–82% | 80% (= mercato) |
| 82–85% | 84% (= mercato) |
| **85–88%** | **68/71 (95,8%)** — A 95,7% · B 95,8% |
| 88–92% | 26/28 (93%) |
| 92%+ | 11/12 (92%) |

- **Da 85% in su:** 92/97 (94,8%) contro un mercato all'88%. Mostravamo 85,6%.
- Negli altri campionati da 85% in su fa 89,6%, uguale al mercato: il vantaggio c'è solo nei principali.

**4.21.6:**
- Stima **94%**, oppure mercato + 2 punti se è più alto (al massimo 97%). La soglia dell'85% resta.
- Rigiocato: 57/60 (95%) contro una stima di 94,1%. Circa 5 segnali al giorno.

### 📊 Controlli a +5 / +10 / +15' senza gol

**1° tempo** (513 segnali tipo gol 1T e 🔥 1T, ancora senza gol):

| | Ritmo ≥ media | 70–100% | Sotto 70% | Book |
|---|---|---|---|---|
| +5' | 73% | 66% | 69% | 65% |
| +10' | 58% | 61% | 65% | 57% |
| +15' | 49% | 52% | 57% | 47% |

- Solo a +5' col ritmo che tiene c'è un vantaggio chiaro: A 75%, B 71%.
- Dopo, nella metà B la % è uguale al book.

**2° tempo** (223 segnali prossimo gol 2T e 🔥 2T keep ≥ 1):

| | Vinte | Book |
|---|---|---|
| +5' | 87% | 80% |
| +10' | 84% | 74% |
| +15' | 78% | 65% |

- Uguale nelle due metà.
- Il ritmo non distingue: chi rallenta va uguale o meglio.

**Tabella nuova (app e server):**
- 1T: 73 / 67 / 67 a +5', 59 a +10', 49 a +15'.
- 2T: 86, 82, 75 per tutti i ritmi.
- Book: 1T 65 / 57 / 47, 2T 80 / 74 / 65.
- **In pratica:**
  - nel 2T i controlli diranno quasi sempre 🟢 "tiene ancora", con la quota da cui entrare;
  - nel 1T 🟢 solo a +5' col ritmo che tiene, altrimenti 🟡.

### Ancora da fare

- **Gol 1T favorita:** con le quote 1X2 nella traccia (da oggi) si rifà tra 5–7 giorni.
  - Indizio: le condizioni di base del segnale (10'–38', tiro in porta recente, mercato ≥ 70%), anche senza la favorita, fanno 279/356 (78,4%) contro un mercato al 75%.
- **🔥 2T sull'1-1:** con il keep la regola non serve più. 1-1 con keep ≥ 1: 18/21.
