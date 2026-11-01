-- Bet Tracker 4.14.3 — DATABASE PIÙ LEGGERO (una volta sola).
-- Supabase > SQL Editor > New query > incolla tutto > Run. Si può rieseguire senza danni.
-- Ordine consigliato: prima questo, poi ridistribuisci la funzione pronostici-avvisi (4.14.3).

-- 1) Indici per leggere la traccia per partita e per data (export del retraining senza "statement timeout").
create index if not exists pronostici_traccia_at    on public.pronostici_traccia (created_at);
create index if not exists pronostici_traccia_af_at on public.pronostici_traccia (af_id, created_at);
create index if not exists pronostici_finali_at     on public.pronostici_finali (created_at);

-- 2) La traccia si tiene 14 giorni (prima 45). Se questa riga va in timeout, rieseguila:
--    ogni volta cancella quello che riesce e alla fine finisce.
delete from public.pronostici_traccia where created_at < now() - interval '14 days';

-- 3) FACOLTATIVO, in una query a parte e da sola: restituisce subito lo spazio liberato al conteggio di Supabase
--    (senza, lo spazio viene riusato dalle righe nuove ma il numero in alto scende piano).
--    Blocca la tabella per qualche secondo: meglio farlo quando ci sono poche partite live.
-- vacuum full public.pronostici_traccia;

-- 4) Quanto pesa (ultima riga: è il risultato che vedi sotto) ogni tabella adesso.
select relname as tabella, pg_size_pretty(pg_total_relation_size(relid)) as peso, n_live_tup as righe
from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 10;
