-- Bet Tracker 3.49.0 — AVVISI LIVE e PRONOSTICI AUTOMATICI: tabelle + giro ogni 2 minuti della funzione pronostici-avvisi.
-- Da eseguire DOPO aver pubblicato la funzione pronostici-avvisi (passo 2 di GUIDA_AVVISI.txt).
-- Supabase > SQL Editor > New query > incolla tutto > Run. Si può rieseguire senza danni.
-- Non serve incollare nessuna password: il segreto del giro lo crea lo script stesso.

-- Segnali trovati dal server (uno per partita e punteggio): l'app li importa nella traccia.
create table if not exists public.pronostici_segnali (
  id bigserial primary key,
  user_id uuid not null,
  key text not null,
  tier text not null,
  data jsonb not null,
  pushed text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);
create index if not exists pronostici_segnali_user_upd on public.pronostici_segnali (user_id, updated_at);
-- Stato del motore (statistiche delle scansioni precedenti, per l'andamento degli ultimi minuti).
create table if not exists public.pronostici_stato (
  k text primary key,
  v jsonb,
  updated_at timestamptz not null default now()
);
-- Solo la funzione (chiave di servizio) legge e scrive: nessuna regola = nessun accesso dall'esterno.
alter table public.pronostici_segnali enable row level security;
alter table public.pronostici_stato enable row level security;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Segreto del giro: lo crea questo script (una volta sola) e lo conserva nella tabella pronostici_stato,
-- dove la funzione lo rilegge. Nessuna password da copiare, nessun segreto da aggiungere su Supabase.
insert into public.pronostici_stato (k, v)
values ('cron_secret', to_jsonb(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')))
on conflict (k) do nothing;

do $$
declare segreto text;
begin
  select v #>> '{}' into segreto from public.pronostici_stato where k = 'cron_secret';
  if segreto is null or length(segreto) < 20 then
    raise exception 'Segreto del giro non creato: riesegui lo script';
  end if;

  perform cron.unschedule('bet-avvisi-live')
  where exists (select 1 from cron.job where jobname = 'bet-avvisi-live');

  perform cron.schedule('bet-avvisi-live', '*/2 * * * *', format(
    $f$ select net.http_post(
          url     := 'https://thdlzqhqdktbkpnplxdm.supabase.co/functions/v1/pronostici-avvisi',
          headers := %L::jsonb,
          body    := '{}'::jsonb,
          timeout_milliseconds := 60000); $f$,
    json_build_object('Content-Type','application/json','x-cron-secret',segreto)::text));
end $$;

-- Per controllare:
--   select jobname, schedule from cron.job where jobname = 'bet-avvisi-live';
--   select status_code, content from net._http_response order by created desc limit 5;
-- Per spegnere del tutto il giro:  select cron.unschedule('bet-avvisi-live');
