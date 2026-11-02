# Bet Tracker — traccia completa 20/10–2/11 (analisi del 2/11, versione 4.21.5)

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
