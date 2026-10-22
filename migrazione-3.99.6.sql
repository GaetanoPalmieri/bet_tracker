-- Bet Tracker 3.99.6 — STORICO QUOTE TOTALCORNER (per il backtest e per costruire filtri nuovi).
-- Supabase > SQL Editor > New query > incolla tutto > Run. Si può rieseguire senza danni.

-- Una riga per partita già finita: finali (gol, angoli, anche all'intervallo, rossi) e quote bet365 minuto per minuto.
-- gl/glh = linea gol partita / 1° tempo, cl/clh = linea angoli partita / 1° tempo:
--   ogni riga [minuto, linea, over, under, gol casa, gol ospite] (una per minuto).
-- x12 / ah = prima riga di 1X2 e handicap asiatico (prepartita).
create table if not exists public.pronostici_storico_quote (
  af_id text primary key,
  league text,
  home text,
  away text,
  kickoff timestamptz,
  goals jsonb,
  ht jsonb,
  corners jsonb,
  ht_corners jsonb,
  red jsonb,
  gl jsonb,
  glh jsonb,
  cl jsonb,
  clh jsonb,
  x12 jsonb,
  ah jsonb,
  created_at timestamptz not null default now()
);
create index if not exists pronostici_storico_quote_ko on public.pronostici_storico_quote (kickoff);
create index if not exists pronostici_storico_quote_lg on public.pronostici_storico_quote (league);
create index if not exists pronostici_storico_quote_at on public.pronostici_storico_quote (created_at);

-- Solo la funzione (chiave di servizio) legge e scrive.
alter table public.pronostici_storico_quote enable row level security;

-- Per controllare l'avanzamento:
--   select count(*), min(kickoff), max(kickoff) from public.pronostici_storico_quote;
--   select v from public.pronostici_stato where k = 'histBF';
