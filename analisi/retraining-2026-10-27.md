# Bet Tracker — retraining del 27/10/2026 (versione 4.13.1)

Dati:
- **export del 27/10**: segnali veri dalla 4.12.0, dalle 18:28 del 26/10 alle 9:00 del 27/10;
- **archivio bet365**: è arrivata una settimana nuova (24/9-1/10, 2.780 partite). L'archivio ora copre 4 settimane, dal 24/9 al 22/10, per 10.500 partite;
- **storico prepartita** dell'app (16-26/10).

I filtri sull'archivio sono simulati con il motore vero dell'app. Nel 1T l'archivio non ha i tiri in porta, quindi lì vale soprattutto il dal vivo.

---

## 1. Segnali dalla 4.12.0 (26/10 sera – 27/10 mattina)

| Filtro | Vinte | Stima |
|---|---|---|
| Prossimo gol 2T OTTIMA | 11/11 | 90,9% |
| Prossimo gol 2T DA VALUTARE | 53/59 (89,8%) | 81,2% |
| Gol 2T sull'1-0 | stabile 6/6, in prova 1/2 | 85,3% |
| Avanti di 1 a quota | 6/10 | 77,6% |
| ⭐ Prossimo gol 1T | 13/16 (81,2%) | 81,0% |
| Prossimo gol 1T | 5/7 | 77,9% |
| ⏳ Quota raggiunta 1T / 2T | 12/17 (70,6%) / 16/24 (66,7%) | 61,3% |

Sono pochi segnali, una sera e una mattina: servono come controllo, non per decidere.

---

## 2. La settimana nuova (24/9-1/10) con le regole 4.12.0

| Filtro | Segnali | Vinte | Stima | Prezzo |
|---|---|---|---|---|
| Prossimo gol 2T OTTIMA | 387 | 88,6% | 90,3% | 90,3% |
| Prossimo gol 2T DA VALUTARE | 1.187 | 84,2% | 81,1% | 82,6% |
| Gol 2T sull'1-0 stabile | 258 | 82,6% | 86,8% | 82,3% |
| Gol 2T sull'1-0 in prova | 74 | 81,1% | 82,6% | 83,1% |
| Avanti di 1 a quota | 75 | 74,7% | 76,5% | 73,7% |

- **La taratura di base del prezzo regge**: 1T 74,3% vinte contro 74,9% stimato, 2T 81,0% contro 80,0%.
- **Le correzioni per gruppo di campionato nel 2T non reggono**. Erano state calcolate su una sola settimana (16-22/10) e fuori da quella sbagliano. Su tutte e 4 le settimane, per esempio, le OTTIME nei minori dei Paesi forti fanno 86% contro 90% stimato.

---

## 3. Cosa cambia nella 4.13.0 e nella 4.13.1

**a) Correzioni del 2T per gruppo e punteggio, ricalcolate su tutte e 4 le settimane.** Per la prova, ogni settimana è stata usata a turno come controllo e calcolata con le altre tre.

| | Prima | 4.13.0 |
|---|---|---|
| Prossimo gol 2T OTTIMA (archivio) | 1.261 al 88,7% (stima 90,2%) | **1.455 al 90,0%** (stima 90,2%) |
| OTTIME minori dei Paesi forti | 86,2% | 89,7% |
| OTTIME con una squadra avanti di 1 | 84,1% | 87,5% |
| Gol 2T sull'1-0: stima contro vinte | 86,7% contro 84,6% | 84,7% contro 84,6% |
| OTTIME del 2T dal vivo 23-27/10 | 421 al 89,8% | **470 al 90,0%** |

In pratica ci sono più OTTIME, e vincono quanto prima o un filo di più.

**b) Americhe nel 2T.** Correzioni di prima: −7 con una squadra avanti di 1 e −3 negli altri casi. Ora:

| Punteggio | Vinte contro prezzo (archivio) | Correzione |
|---|---|---|
| Avanti di 1 | −4,1, sotto in tutte e 4 le settimane | −4 (era −7) |
| Avanti di 2 o più | +0,9 (dal vivo +3,6) | 0 (era −3) |
| Pari | −1,7 | −3, invariata |

**c) Americhe nel 1T: tolto il +3.** Sull'archivio le Americhe nel 1T vincono come il prezzo (73,9% contro 74,3%) e come gli altri campionati. I segnali che il +3 faceva partire hanno fatto 66% sull'archivio (50) e 76% dal vivo (17).

**d) Prepartita: Goal / No goal di nuovo attivo.** La sospensione di ieri nasceva da un **mio errore di conto**: i "No goal" vinti erano stati contati come persi. Il conto giusto (16-25/10):

| Mercato | Vinti | % mostrata |
|---|---|---|
| Goal | 7/10 | 73,7% |
| No goal | 14/19 | 74,7% |

Il mercato è in linea con quello che mostra l'app.

**e) 4.13.1 — "⚡ gol prima" su Avanti di 1 a quota abbassato.** Su questo filtro la % era troppo alta: dal vivo 28,9% contro 33,9% mostrato (398 segnali), sull'archivio 30,0% contro 34,0% (263). La correzione dipende dalla soglia di quota: −4 punti fino a 1.45, −5 a 1.50, poi cala fino a 0 a 1.80. Negli altri filtri il calcolo è giusto, e anche il minuto in cui arriva la quota: scarto mediano 0', 99% entro 5'.

**Restano come sono:**
- **Avanti di 1 a quota.** Tiene le sue correzioni: dal vivo 338 segnali al 78,4% contro 78,8% stimato. Con le correzioni nuove avrebbe perso un quarto dei segnali senza vincere di più.
- **Prossimo gol 1T.** Restano la soglia del 75%, la ⭐ da 80% e il −4 nei minori dei Paesi forti.
- **Correzioni fisse del prepartita.** Sulla settimana nuova le % ricavate dalla linea gol sono ancora troppo alte: Over 1.5 da −1 a −10 a seconda della fascia, Over 0.5 1T −3 / −4.

---

## 4. Prepartita dell'app (16-26/10)

| Mercato | Pronostici | Vinti | % mostrata |
|---|---|---|---|
| Over 1.5 | 157 | 80,9% | 83,0% |
| Over 0.5 1T | 130 | 78,5% | 78,4% |
| Goal / No goal | 29 | 72,4% | 74,4% |
| Over 2.5 | 11 | 63,6% | 72,6% |

---

## Da fare

1. Sostituisci nella cartella bet_tracker: `pronostici.js`, `pronostici-avvisi.txt`, `app.js`, `index.html`, `sw.js`. `pronostici.css` non cambia.
2. Ridistribuisci la funzione Supabase `pronostici-avvisi` (server 4.13.1).
3. Pubblica l'app.
