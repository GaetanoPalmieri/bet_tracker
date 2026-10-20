-- Eseguire prima di aggiornare pronostici-avvisi.
-- I vecchi finali restano disponibili ma non sono considerati verificati.
alter table public.pronostici_finali add column if not exists confirmed boolean not null default false;
alter table public.pronostici_finali add column if not exists confirmed_at timestamptz;
alter table public.pronostici_finali add column if not exists source text;
alter table public.pronostici_finali add column if not exists model_version text;
create index if not exists pronostici_finali_confirmed_league
  on public.pronostici_finali (league, kickoff desc) where confirmed = true;
