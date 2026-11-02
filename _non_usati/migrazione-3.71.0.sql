-- Bet Tracker 3.71.0 — angoli all'intervallo nei finali (storico angoli 1° tempo delle squadre).
-- Supabase > SQL Editor > New query > incolla > Run, PRIMA di aggiornare la funzione pronostici-avvisi. Si può rieseguire.
-- (Se non l'hai ancora fatto, esegui prima migrazione-3.69.0.sql.)
alter table public.pronostici_finali add column if not exists ht_corners jsonb;
