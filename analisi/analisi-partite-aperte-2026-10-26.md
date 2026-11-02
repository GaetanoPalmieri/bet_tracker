# Bet Tracker — partite con tanti gol (26/10/2026)

Domanda: nelle partite con tanti gol (es. ZFK Crvena Zvezda (F) – Vojvodina (F), Serbia femminile, 26/10) il gol successivo si poteva prevedere meglio del book? E perché l'app non ha dato segnali sul 3-2 e sul 4-2?

Dati: file `retraining-live-2026-10-26_2.json` (export dell'app 4.11.0):
- **traccia del server** del 26/10 (stato delle partite ogni ~6 minuti, con le quote bet365 della linea gol);
- **archivio bet365 minuto per minuto** del 1-3 ottobre: 1.260 partite (l'archivio completo sul server ne ha ~10.600).

Probabilità di "un altro gol" = ricavata dalla linea gol live di bet365 (Over/Under, margine tolto, distribuzione di Poisson), come fa l'app.

---

## 1. La partita: Crvena Zvezda (F) – Vojvodina (F)

| Momento | Risultato | Gol in partita | Linea bet365 (Over / Under) | Prob. altro gol | Quota ~ | Cosa ha fatto l'app |
|---|---|---|---|---|---|---|
| 46' | 2-2 | 4 | — | 88% | 1.08 | **Segnale "Prossimo gol 2T"** all'88%, vinto (3-2 al 60') |
| 50' | 2-2 | 4 | 6 (1.85 / 1.95) | 89% | 1.07 | — |
| 62' | 3-2 | 5 | 6.5 (1.875 / 1.925) | **82%** | 1.16 | niente: oltre il limite dei 4 gol |
| 68' | 4-2 | 6 | 7.25 (2.025 / 1.775) | **74%** | 1.29 | niente: oltre il limite dei 4 gol e sotto la soglia del 75% |
| 80' | 5-2 | 7 | 7.5 (1.83 / 1.83) | ~52% | 1.83 | niente: il filtro chiude all'80' |

Poi è arrivato anche il 6-2 (~82').

**Perché nessun segnale dal 60' in poi:**
- **Prossimo gol 2T:** parte dal 46' all'80' solo con **al massimo 4 gol** in partita. Sul 3-2 (5 gol) e sul 4-2 (6 gol) era escluso.
- **Avanti di 1 a quota:** solo nei campionati minori maschili (questo è femminile) e non nei 6 minuti dopo un gol.
- **Gol 2T sull'1-0:** solo con un gol in tutto.
- **Partita da gol 2T:** spento, e comunque dopo il 60' accetta al massimo 4 gol.

**Era evidente?** Sul 4-2 al 68' il book dava un altro gol al 74% circa: probabile, ma non sicuro (una volta su quattro non arriva). Sul 3-2 all'82%: qui l'app avrebbe potuto dare un segnale, se non ci fosse stato il limite dei 4 gol.

---

## 2. Archivio: le partite con tanti gol battono il book?

Segnale simulato come il "Prossimo gol 2T": prezzo bet365 ≥75%, dal 46' all'85', una volta per partita e punteggio. Archivio 1-3 ottobre (1.260 partite).

| Situazione | Segnali | Vinte | Prezzo book | Differenza | Resa a quota book |
|---|---|---|---|---|---|
| Tutti | 1.139 | 84,0% | 83,1% | +0,9 | −4,0% |
| Fino a 4 gol (regola attuale) | 1.080 | 83,9% | 83,1% | +0,8 | −4,2% |
| **5 o più gol** | **59** | **86,4%** | 83,1% | **+3,3** | −1,1% |
| 5 gol | 40 | 82,5% | 82,7% | −0,2 | −5,0% |
| 6 o più gol | 19 | 94,7% | 84,1% | +10,6 | +7,0% |
| 5+ gol, scarto 0-1 | 21 | 81,0% | 81,9% | −0,9 | −5,6% |
| 5+ gol, scarto 2 | 5 | 80,0% | 81,5% | −1,5 | −7,1% |
| 5+ gol, scarto 3 o più | 33 | 90,9% | 84,2% | +6,7 | +2,6% |
| 6 gol con 2 di scarto (come il 4-2) | 4 | 3 su 4 | 81,9% | — | — |
| 5+ gol, femminili | 7 | 6 su 7 | 88,5% | — | — |
| Fino a 4 gol, femminili | 121 | 82,6% | 83,3% | −0,7 | −5,8% |

"Resa a quota book" = guadagno medio per puntata alla quota bet365 (margine ~5% compreso).

Nel finale, con la linea esatta "gol attuali + 0,5" (prezzo intorno al 45-50%): fino a 4 gol 46,0% contro 45,8%; 5 o più gol 45,6% contro 45,0%. Anche lì nessun vantaggio.

---

## 3. Conclusioni

1. **Più gol non vuol dire battere il book.** Con 5 o più gol il gol successivo arriva più o meno quanto dice bet365 (86% contro 83%, su 59 segnali: differenza dentro l'incertezza). La sensazione di "evidente" viene dal risultato finale.
2. **Il limite dei 4 gol non è giustificato dai dati.** Le partite con 5 o più gol vanno almeno come le altre: il limite toglie segnali buoni, come quello sul 3-2 di oggi (82%).
3. **Il "6 o più gol" (95%) è un campione troppo piccolo** (19 segnali) per farne una regola.
4. **Le quote in queste situazioni sono basse** (1.10-1.20): si gioca solo con il 💰, quando la quota vera supera la minima.

## 4. Proposta

- Nuovo filtro in prova (🧪) **"Prossimo gol 2T · partita aperta"**: stesse regole del prossimo gol 2T (46'-80', prezzo ≥75%, linea che tiene), ma con **5 o più gol** in partita. Statistiche a parte, notifiche solo quando i numeri dal vivo lo confermano.
- Verifica sull'**archivio completo** del server (~10.600 partite) prima di passarlo a stabile.
