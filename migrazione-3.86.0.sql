-- Bet Tracker 3.86.0 — minuti dei gol nel registro dei finali (servono a chiudere "aspetta unico" e il gol 1T presto).
-- Supabase > SQL Editor > New query > incolla > Run. Si può rieseguire. Le funzioni funzionano anche senza, ma senza minuti.
alter table public.pronostici_finali add column if not exists goal_list jsonb;
